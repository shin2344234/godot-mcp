/**
 * JUnit XML reports from GUT and GdUnit4, parsed into one structured shape.
 *
 * Both frameworks write "JUnit-style" XML but fill it differently (formats
 * checked against real runs on Godot 4.7.2, GUT 9.7.1 and GdUnit4 6.2.2, and
 * against their exporters: addons/gut/junit_xml_export.gd and
 * addons/gdUnit4/src/reporters/xml/JUnitXmlReportWriter.gd):
 *
 * GUT
 *   <testsuites name="GutTests" failures="2" tests="6">
 *     <testsuite name="test/unit/test_math.gd.TestInner" tests skipped failures time>
 *       <testcase name="test_x" assertions status="pass|fail|pending" classname="test/unit/test_math.gd.TestInner" time>
 *         <failure message="failed"><![CDATA[text\n      at line 17]]></failure>
 *         <skipped message="pending"><![CDATA[reason]]></skipped>
 *   - "res://" is stripped from suite/class names; an inner test class is appended
 *     to the script path as ".ClassName";
 *   - the source line is only in the failure text ("at line N"; -1 = unknown,
 *     e.g. for engine errors caught by GUT's error tracking);
 *   - there is no <error> element: engine errors are failures ("Unexpected Errors:").
 *
 * GdUnit4
 *   <testsuites id name="report_1" tests failures skipped flaky time>  (no errors total; time is 0.000 in 6.2.2)
 *     <testsuite id name="math_test" package="test/unit" tests failures errors skipped flaky time ...>
 *       <testcase name="test_x" classname="math_test" time>
 *         <failure message="FAILED: res://test/unit/math_test.gd:7" type="FAILURE"><![CDATA[...]]></failure>
 *         <error message="ERROR: res://test/other_test.gd:8" type="ABORT"><![CDATA[...]]></error>
 *         <skipped message="SKIPPED: res://test/unit/math_test.gd:9"><![CDATA[...]]></skipped>
 *   - file and line are in the element's `message` attribute;
 *   - only test names are XML-escaped; other attribute values are written raw.
 *
 * The parser below is a small, tolerant XML reader (no dependency): it keeps
 * elements, attributes and text/CDATA, which is all a JUnit report needs.
 */

// ---------------------------------------------------------------------------
// Minimal XML reader
// ---------------------------------------------------------------------------

export interface XmlNode {
  name: string;
  attrs: Record<string, string>;
  children: XmlNode[];
  /** Concatenated text and CDATA directly inside this element. */
  text: string;
}

const ENTITIES: Record<string, string> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };

/** Decode the five XML entities plus numeric character references. Unknown entities stay as-is. */
export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z]+);/g, (whole, ent: string) => {
    if (ent[0] === '#') {
      const code = ent[1] === 'x' || ent[1] === 'X' ? parseInt(ent.slice(2), 16) : parseInt(ent.slice(1), 10);
      return Number.isFinite(code) && code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    return ENTITIES[ent] ?? whole;
  });
}

/**
 * Parse an XML document into a tree. Returns a synthetic root ("#document")
 * whose children are the top-level elements. Tolerant on purpose: unclosed
 * tags are closed at the end, a stray closing tag pops up to its match, and
 * attribute values may contain raw `<`, `>` or `&` (GdUnit4 writes them
 * unescaped).
 */
export function parseXml(xml: string): XmlNode {
  const root: XmlNode = { name: '#document', attrs: {}, children: [], text: '' };
  const stack: XmlNode[] = [root];
  let i = 0;
  const n = xml.length;
  const top = () => stack[stack.length - 1]!;

  while (i < n) {
    const lt = xml.indexOf('<', i);
    if (lt < 0) {
      top().text += decodeEntities(xml.slice(i));
      break;
    }
    if (lt > i) top().text += decodeEntities(xml.slice(i, lt));

    if (xml.startsWith('<![CDATA[', lt)) {
      const end = xml.indexOf(']]>', lt + 9);
      const stop = end < 0 ? n : end;
      top().text += xml.slice(lt + 9, stop);
      i = end < 0 ? n : end + 3;
      continue;
    }
    if (xml.startsWith('<!--', lt)) {
      const end = xml.indexOf('-->', lt + 4);
      i = end < 0 ? n : end + 3;
      continue;
    }
    if (xml.startsWith('<?', lt) || xml.startsWith('<!', lt)) {
      // XML declaration, processing instruction or DOCTYPE: skip.
      const end = xml.indexOf('>', lt + 2);
      i = end < 0 ? n : end + 1;
      continue;
    }
    if (xml[lt + 1] === '/') {
      const end = xml.indexOf('>', lt + 2);
      const name = xml.slice(lt + 2, end < 0 ? n : end).trim();
      // Pop to the matching open element (ignore a closing tag nothing matches).
      const idx = stack.map((s) => s.name).lastIndexOf(name);
      if (idx > 0) stack.length = idx;
      i = end < 0 ? n : end + 1;
      continue;
    }

    // Start tag: name, then attributes, then ">" or "/>". Quoted values are
    // skipped as a whole so a ">" inside one doesn't end the tag.
    let j = lt + 1;
    while (j < n && !/[\s/>]/.test(xml[j]!)) j++;
    const node: XmlNode = { name: xml.slice(lt + 1, j), attrs: {}, children: [], text: '' };
    let selfClosing = false;
    while (j < n) {
      while (j < n && /\s/.test(xml[j]!)) j++;
      if (xml[j] === '>') {
        j++;
        break;
      }
      if (xml[j] === '/' && xml[j + 1] === '>') {
        selfClosing = true;
        j += 2;
        break;
      }
      let k = j;
      while (k < n && !/[\s=/>]/.test(xml[k]!)) k++;
      const attrName = xml.slice(j, k);
      j = k;
      while (j < n && /\s/.test(xml[j]!)) j++;
      let value = '';
      if (xml[j] === '=') {
        j++;
        while (j < n && /\s/.test(xml[j]!)) j++;
        const q = xml[j];
        if (q === '"' || q === "'") {
          const close = xml.indexOf(q, j + 1);
          value = xml.slice(j + 1, close < 0 ? n : close);
          j = close < 0 ? n : close + 1;
        } else {
          let e = j;
          while (e < n && !/[\s>]/.test(xml[e]!)) e++;
          value = xml.slice(j, e);
          j = e;
        }
      }
      if (attrName) node.attrs[attrName] = decodeEntities(value);
      else j++; // defensive: never loop on an unexpected character
    }
    top().children.push(node);
    if (!selfClosing) stack.push(node);
    i = j;
  }
  return root;
}

/** All descendants (depth-first, document order) with the given element name. */
function findAll(node: XmlNode, name: string, out: XmlNode[] = []): XmlNode[] {
  for (const c of node.children) {
    if (c.name === name) out.push(c);
    findAll(c, name, out);
  }
  return out;
}

// ---------------------------------------------------------------------------
// JUnit -> structured results
// ---------------------------------------------------------------------------

export type Framework = 'gut' | 'gdunit4';

export type CaseStatus = 'passed' | 'failed' | 'error' | 'skipped';

export interface TestCaseResult {
  /** Suite name as the report gives it (GUT: script path incl. inner class; GdUnit4: suite name). */
  suite: string;
  name: string;
  status: CaseStatus;
  /** Seconds. */
  time: number;
  /** res:// path of the test script, when known. */
  file?: string;
  /** 1-based line of the failing assert/error, when known. */
  line?: number;
  /** Trimmed failure / error / skip text. */
  message?: string;
}

export interface JUnitSummary {
  totals: { tests: number; passed: number; failed: number; errors: number; skipped: number; duration_s: number };
  cases: TestCaseResult[];
}

/** Longest failure message we pass on (characters). Stack traces beyond that are noise to the model. */
export const MAX_MESSAGE = 600;

/**
 * Tidy a failure text: drop blank lines and indentation, remove the location
 * lines both frameworks append (we report file/line separately), and cap the
 * length.
 */
export function cleanMessage(text: string, max = MAX_MESSAGE): string {
  const lines = text
    .replace(/\r/g, '')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '')
    // GUT: "at line 7" / "at line -1". GdUnit4: "at 'test_x' in res://path.gd:7".
    .filter((l) => !/^at line -?\d+$/.test(l) && !/^at '[^']*' in res:\/\/\S+:\d+$/.test(l));
  let out = lines.join('\n');
  if (out.length > max) out = out.slice(0, max - 3).trimEnd() + '...';
  return out;
}

const num = (v: string | undefined): number => {
  const x = Number(v);
  return Number.isFinite(x) ? x : 0;
};

/** "test/unit/test_math.gd.TestInner" -> "res://test/unit/test_math.gd" (GUT class names). */
export function gutScriptPath(classname: string): string | undefined {
  const m = /^(?:res:\/\/)?(.*?\.gd)(?:\.[A-Za-z_]\w*)?$/.exec(classname.trim());
  return m ? `res://${m[1]}` : undefined;
}

/** "FAILED: res://test/a_test.gd:7" -> { file, line } (GdUnit4 message attributes). */
export function gdunitLocation(message: string | undefined): { file?: string; line?: number } {
  const m = /(res:\/\/.+?):(-?\d+)\s*$/.exec(message ?? '');
  if (!m) return {};
  const line = Number(m[2]);
  return { file: m[1], ...(line > 0 ? { line } : {}) };
}

/**
 * Parse a JUnit report written by `framework` into totals plus one entry per
 * test case. Totals are counted from the test cases themselves (the root
 * attributes are incomplete: GUT has no skipped/errors totals, GdUnit4 no
 * errors total and a zero time).
 */
export function parseJUnit(xml: string, framework: Framework): JUnitSummary {
  const doc = parseXml(xml);
  const suites = findAll(doc, 'testsuite');
  const cases: TestCaseResult[] = [];
  let suiteTime = 0;

  for (const suite of suites) {
    suiteTime += num(suite.attrs.time);
    for (const tc of findAll(suite, 'testcase')) {
      const failure = tc.children.find((c) => c.name === 'failure');
      const error = tc.children.find((c) => c.name === 'error');
      const skipped = tc.children.find((c) => c.name === 'skipped');
      const status: CaseStatus = error ? 'error' : failure ? 'failed' : skipped ? 'skipped' : 'passed';
      const detail = error ?? failure ?? skipped;
      const entry: TestCaseResult = {
        suite: suite.attrs.name ?? tc.attrs.classname ?? '',
        name: tc.attrs.name ?? '',
        status,
        time: num(tc.attrs.time),
      };

      if (framework === 'gut') {
        const file = gutScriptPath(tc.attrs.classname ?? suite.attrs.name ?? '');
        if (file) entry.file = file;
        if (detail) {
          const m = /at line (-?\d+)\s*$/.exec(detail.text.trim());
          if (m && Number(m[1]) > 0) entry.line = Number(m[1]);
        }
      } else {
        const loc = gdunitLocation(detail?.attrs.message);
        if (loc.file) entry.file = loc.file;
        if (loc.line) entry.line = loc.line;
      }

      if (detail) {
        // GUT puts the text in the body and a fixed word ("failed"/"pending") in
        // `message`; GdUnit4 puts the location in `message` and the text in the body.
        const body = cleanMessage(detail.text);
        if (body) entry.message = body;
        else if (framework === 'gut' && detail.attrs.message && !/^(failed|pending)$/.test(detail.attrs.message)) entry.message = detail.attrs.message;
      }
      cases.push(entry);
    }
  }

  const rootTime = num(findAll(doc, 'testsuites')[0]?.attrs.time);
  const count = (s: CaseStatus) => cases.filter((c) => c.status === s).length;
  return {
    totals: {
      tests: cases.length,
      passed: count('passed'),
      failed: count('failed'),
      errors: count('error'),
      skipped: count('skipped'),
      duration_s: Math.round(Math.max(rootTime, suiteTime) * 1000) / 1000,
    },
    cases,
  };
}
