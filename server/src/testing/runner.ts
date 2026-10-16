/**
 * test.run: run GUT or GdUnit4 tests in a separate headless Godot process and
 * turn the framework's JUnit XML report into structured results.
 *
 * Flow:
 *   1. detect the installed framework(s) (addons/gut, addons/gdUnit4) and pick one;
 *   2. resolve what to run (all tests, a folder, a file, and/or a test name) and
 *      check it exists, with "did you mean" help for test names;
 *   3. import the project once if the framework's class_names are not in
 *      Godot's class cache yet (both frameworks need them; GUT refuses to run);
 *   4. run `godot --headless --path P ...` with the framework's CLI, streaming
 *      output into MCP progress ("test 7: test_jump"), honouring the timeout
 *      and client cancellation (the process is killed);
 *   5. parse the JUnit report (written under .godot/godot_mcp/test_runs/<id>/,
 *      deleted afterwards) plus compile errors seen in the output.
 *
 * Nothing is downloaded or installed: without a framework the tool explains
 * which ones are supported and how the user can add one.
 */

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, rm, rmdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { OpError } from '../errors.js';
import { findGodot, GODOT_NOT_FOUND_HINT } from '../godot/binary.js';
import { importArgs } from '../godot/headless.js';
import { log } from '../log.js';
import type { OpContext } from '../ops/types.js';
import { PathError, resolveProjectPathStrict } from '../project/paths.js';
import {
  detectFrameworks,
  findTestScripts,
  gdunitArgs,
  gutArgs,
  SUPPORTED_HINT,
  type FrameworkInfo,
  type Selection,
  type TestScript,
} from './frameworks.js';
import { parseJUnit, type Framework, type JUnitSummary, type TestCaseResult } from './junit.js';

export interface TestRunArgs {
  framework: 'auto' | Framework;
  path?: string;
  test?: string;
  timeout_s: number;
}

const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g;
const SESSION_REL = path.join('.godot', 'godot_mcp', 'session.json');
const RUNS_REL = '.godot/godot_mcp/test_runs';
/** Most failures listed in one result; the rest are counted. */
const MAX_FAILURES = 30;
const MAX_SKIPPED = 10;
/** Cap for the one-time import of a never-opened project. */
const IMPORT_TIMEOUT_MS = 300_000;

// ---------------------------------------------------------------------------
// Process handling
// ---------------------------------------------------------------------------

export interface TrackedProcess {
  code: number | null;
  timedOut: boolean;
  cancelled: boolean;
  /** Last lines of output (ANSI codes removed), stdout and stderr interleaved. */
  lines: string[];
}

/**
 * Run a process to completion, calling `onLine` for each output line. Kills it
 * (SIGTERM, then SIGKILL after 5 s) on timeout or when `signal` aborts. Keeps
 * the last `keep` lines for error messages.
 */
export function spawnTracked(
  file: string,
  args: string[],
  opts: { cwd: string; timeoutMs: number; signal?: AbortSignal; onLine?: (line: string) => void; keep?: number },
): Promise<TrackedProcess> {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { cwd: opts.cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const out: TrackedProcess = { code: null, timedOut: false, cancelled: false, lines: [] };
    const keep = opts.keep ?? 400;
    const onLine = (raw: string) => {
      const text = raw.replace(ANSI, '').replace(/\r/g, '').trimEnd();
      if (!text.trim()) return;
      out.lines.push(text);
      if (out.lines.length > keep) out.lines.shift();
      opts.onLine?.(text);
    };
    const attach = (stream: NodeJS.ReadableStream) => {
      let buf = '';
      // setEncoding: decode UTF-8 across chunk boundaries (a character split between two
      // chunks was decoded as two U+FFFD replacement characters; Codex review of 0.1.0).
      stream.setEncoding('utf8');
      stream.on('data', (d: string) => {
        buf += d;
        let nl: number;
        while ((nl = buf.indexOf('\n')) >= 0) {
          onLine(buf.slice(0, nl));
          buf = buf.slice(nl + 1);
        }
      });
      stream.on('end', () => buf && onLine(buf));
    };
    attach(child.stdout);
    attach(child.stderr);

    const kill = () => {
      child.kill('SIGTERM');
      setTimeout(() => child.exitCode === null && child.signalCode === null && child.kill('SIGKILL'), 5000).unref();
    };
    const timer = setTimeout(() => {
      out.timedOut = true;
      kill();
    }, opts.timeoutMs);
    const onAbort = () => {
      out.cancelled = true;
      kill();
    };
    opts.signal?.addEventListener('abort', onAbort, { once: true });
    if (opts.signal?.aborted) onAbort();
    const done = () => {
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
    };
    child.on('error', (err) => {
      done();
      reject(err);
    });
    child.on('close', (code) => {
      done();
      out.code = code;
      resolve(out);
    });
  });
}

// ---------------------------------------------------------------------------
// Output scanning: progress, compile errors, error locations
// ---------------------------------------------------------------------------

export interface ScriptError {
  file: string;
  line: number;
  message: string;
}

/**
 * Watches Godot's output while tests run. Both frameworks print one line per
 * test as it starts, which drives MCP progress:
 *   GUT:     "* test_name" (after a line with the script path)
 *   GdUnit4: "res://test/a_test.gd > test_name STARTED"
 * Godot itself prints compile errors as
 *   "SCRIPT ERROR: Parse Error: ..." + "   at: GDScript::reload (res://x.gd:4)"
 * (GUT then skips the broken script with only a warning, so we surface them),
 * and runtime errors as "at: test_fn (res://x.gd:12)", which gives a line for
 * failures whose report has none (GUT writes "at line -1" for engine errors).
 */
export class OutputScanner {
  started = 0;
  readonly scriptErrors: ScriptError[] = [];
  /** "<function>|<res path>" -> first line seen in an "at:" line. */
  private readonly locations = new Map<string, number>();
  private pendingError: string | undefined;
  private currentScript = '';

  constructor(
    private readonly framework: Framework,
    private readonly progress?: (progress: number, total?: number, message?: string) => void,
  ) {}

  onLine(text: string): void {
    const trimmed = text.trim();
    // Compile errors: remember the message until the location line arrives.
    const se = /^SCRIPT ERROR:\s*(.*)$/.exec(trimmed);
    if (se) {
      this.pendingError = se[1];
      return;
    }
    const at = /^at:\s+(\S+)\s+\((res:\/\/[^)]+?):(\d+)\)$/.exec(trimmed);
    if (at) {
      const [, fn, file, line] = at as unknown as [string, string, string, string];
      if (this.pendingError !== undefined && fn === 'GDScript::reload' && /parse error|compile error/i.test(this.pendingError)) {
        if (!this.scriptErrors.some((e) => e.file === file && e.line === Number(line))) {
          this.scriptErrors.push({ file, line: Number(line), message: this.pendingError.replace(/^Parse Error:\s*/i, '') });
        }
      }
      const key = `${fn}|${file}`;
      if (!this.locations.has(key) && this.locations.size < 1000) this.locations.set(key, Number(line));
      this.pendingError = undefined;
      return;
    }
    this.pendingError = undefined;

    if (this.framework === 'gut') {
      if (/^res:\/\/\S+\.gd(\.\w+)?$/.test(trimmed)) this.currentScript = trimmed.replace(/^res:\/\//, '');
      const m = /^\* (test\w*)$/.exec(trimmed);
      if (m) this.tick(`${this.currentScript ? this.currentScript + ' > ' : ''}${m[1]}`);
    } else {
      const m = /^(res:\/\/\S+) > (\S+) STARTED$/.exec(trimmed);
      if (m) this.tick(`${m[1]!.replace(/^res:\/\//, '')} > ${m[2]}`);
    }
  }

  private tick(label: string): void {
    this.started++;
    this.progress?.(this.started, undefined, `test ${this.started}: ${label}`.slice(0, 120));
  }

  /** Line of `fn` in `file` from a runtime "at:" line, if one was printed. */
  lineFor(fn: string, file: string | undefined): number | undefined {
    return file ? this.locations.get(`${fn}|${file}`) : undefined;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Sørensen–Dice similarity on bigrams (0..1), for "did you mean" lists. */
function similarity(a: string, b: string): number {
  const grams = (s: string) => {
    const g: string[] = [];
    const l = s.toLowerCase();
    for (let i = 0; i < l.length - 1; i++) g.push(l.slice(i, i + 2));
    return g;
  };
  const ga = grams(a);
  const gb = grams(b);
  if (!ga.length || !gb.length) return a.toLowerCase() === b.toLowerCase() ? 1 : 0;
  let hits = 0;
  const pool = [...gb];
  for (const g of ga) {
    const i = pool.indexOf(g);
    if (i >= 0) {
      hits++;
      pool.splice(i, 1);
    }
  }
  return (2 * hits) / (ga.length + gb.length);
}

/** Edit distance (insert/delete/substitute), for typos like "fials" -> "fails". */
function levenshtein(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[b.length]!;
}

/**
 * Up to `max` candidates most similar to `query`, best first. The shared
 * "test_" prefix of test functions is ignored, or every name would look alike.
 */
export function suggest(query: string, candidates: string[], max = 5): string[] {
  const core = (s: string) => s.toLowerCase().replace(/^test_/, '');
  const q = core(query);
  return [...new Set(candidates)]
    .map((c) => {
      const cc = core(c);
      // Bigrams catch shared word parts, edit distance catches typos; a substring match wins.
      const edit = 1 - levenshtein(q, cc) / Math.max(q.length, cc.length, 1);
      return { c, s: Math.max(similarity(q, cc), edit >= 0.5 ? edit : 0) + (q && cc.includes(q) ? 0.5 : 0) };
    })
    .filter((x) => x.s >= 0.3)
    .sort((a, b) => b.s - a.s || a.c.length - b.c.length)
    .slice(0, max)
    .map((x) => x.c);
}

/** Does Godot's class cache list the framework's base test class (i.e. was the addon imported)? */
async function classesImported(projectPath: string, framework: Framework): Promise<boolean> {
  const cache = await readFile(path.join(projectPath, '.godot', 'global_script_class_cache.cfg'), 'utf8').catch(() => '');
  return cache.includes(framework === 'gut' ? '&"GutTest"' : '&"GdUnitTestSuite"');
}

/** First .xml file under `dir` (GdUnit4 nests it in report_1/; GUT may add a timestamp to the name). */
async function findReport(dir: string): Promise<string | undefined> {
  const entries = await readdir(dir, { withFileTypes: true, recursive: true }).catch(() => []);
  const xml = entries.filter((e) => e.isFile() && e.name.endsWith('.xml')).map((e) => path.join(e.parentPath, e.name));
  xml.sort((a, b) => (path.basename(a) === 'results.xml' ? -1 : 0) - (path.basename(b) === 'results.xml' ? -1 : 0) || a.localeCompare(b));
  return xml[0];
}

function pickFramework(installed: FrameworkInfo[], requested: TestRunArgs['framework'], scripts: TestScript[]): FrameworkInfo {
  const names = { gut: 'GUT (addons/gut)', gdunit4: 'GdUnit4 (addons/gdUnit4)' };
  if (!installed.length) {
    throw new OpError('NOT_FOUND', `No supported test framework is installed in this project. ${SUPPORTED_HINT}`);
  }
  if (requested !== 'auto') {
    const hit = installed.find((f) => f.framework === requested);
    if (!hit) {
      throw new OpError(
        'NOT_FOUND',
        `${names[requested]} is not installed in this project; installed: ${installed.map((f) => names[f.framework]).join(', ')}. ` +
          `Pass "framework": "${installed[0]!.framework}" or omit it. ${SUPPORTED_HINT}`,
      );
    }
    return hit;
  }
  if (installed.length === 1) return installed[0]!;
  // Both installed: go by which kind of test scripts exist in the selection.
  const used = installed.filter((f) => scripts.some((s) => s.framework === f.framework));
  if (used.length === 1) return used[0]!;
  throw new OpError(
    'BAD_PARAMS',
    `Both GUT and GdUnit4 are installed${used.length ? ' and both have tests here' : ''}; pass "framework": "gut" or "gdunit4" to choose.`,
  );
}

/** Compact failure entry for the result. */
function failureEntry(c: TestCaseResult, framework: Framework, scanner: OutputScanner) {
  const line = c.line ?? scanner.lineFor(c.name, c.file);
  // GUT suite names carry an inner test class after the script path.
  const cls = framework === 'gut' ? /\.gd\.(\w+)$/.exec(c.suite)?.[1] : undefined;
  return {
    test: c.name,
    ...(cls ? { class: cls } : {}),
    ...(c.file ? { file: c.file } : {}),
    ...(line ? { line } : {}),
    ...(c.status === 'error' ? { error: true } : {}),
    ...(c.message ? { message: c.message } : {}),
  };
}

// ---------------------------------------------------------------------------
// test.run
// ---------------------------------------------------------------------------

export async function runTests(args: TestRunArgs, ctx: OpContext) {
  const projectPath = ctx.config.projectPath;

  // What to run.
  const sel: Selection = {};
  let scopeRel = '';
  if (args.path && args.path.trim() !== '' && args.path.trim() !== 'res://') {
    let p;
    try {
      p = await resolveProjectPathStrict(projectPath, args.path);
    } catch (err) {
      if (err instanceof PathError) throw new OpError('BAD_PARAMS', err.message);
      throw err;
    }
    const st = await stat(p.abs).catch(() => undefined);
    if (!st) throw new OpError('NOT_FOUND', `"${args.path}" does not exist. Pass a test folder (e.g. "res://test") or a test script (e.g. "res://test/test_player.gd"), or omit "path" to run all tests.`);
    if (st.isFile() && !p.rel.endsWith('.gd')) throw new OpError('BAD_PARAMS', `"${p.res}" is not a GDScript test file; pass a .gd test script or a folder.`);
    if (p.rel === '.godot' || p.rel.startsWith('.godot/')) throw new OpError('BAD_PARAMS', 'Tests cannot live in .godot/; pass a test folder such as "res://test".');
    sel.path = p.res;
    sel.isFile = st.isFile();
    scopeRel = p.rel;
  }
  if (args.test?.trim()) sel.test = args.test.trim();

  const installed = await detectFrameworks(projectPath);
  const scripts = await findTestScripts(projectPath, scopeRel);
  const info = pickFramework(installed, args.framework, scripts);
  const own = sel.isFile ? scripts : scripts.filter((s) => s.framework === info.framework);

  // A test name must exist somewhere in scope; otherwise say what does.
  if (sel.test) {
    const matching = own.filter((s) => s.tests.some((t) => t.includes(sel.test!)));
    if (!matching.length) {
      const all = own.flatMap((s) => s.tests);
      const similar = suggest(sel.test, all);
      throw new OpError(
        'NOT_FOUND',
        `No test function containing "${sel.test}" in ${sel.path ?? 'the project'}${all.length ? '' : ' (no test scripts found there)'}.` +
          (similar.length ? ` Did you mean: ${similar.join(', ')}?` : all.length ? ` Tests there: ${all.slice(0, 15).join(', ')}${all.length > 15 ? ', ...' : ''}.` : ''),
      );
    }
    if (info.framework === 'gdunit4') own.splice(0, own.length, ...matching);
  }

  const hasGutConfig = existsSync(path.join(projectPath, '.gutconfig.json'));
  if (!sel.path && !own.length && !(info.framework === 'gut' && hasGutConfig)) {
    const kind = info.framework === 'gut' ? 'scripts that extend GutTest' : 'scripts that extend GdUnitTestSuite';
    throw new OpError('NOT_FOUND', `No ${info.framework === 'gut' ? 'GUT' : 'GdUnit4'} tests found in the project (looked for ${kind} outside addons/). Write a test script first, e.g. res://test/${info.framework === 'gut' ? 'test_example.gd' : 'example_test.gd'}.`);
  }

  const godot = await findGodot(ctx.config.godotPath);
  if (!godot) throw new OpError('GODOT_NOT_FOUND', GODOT_NOT_FOUND_HINT);

  // Running a second Godot (and especially --import, which starts an editor with the
  // project's plugins) must not disturb the live editor's session file.
  const sessionFile = path.join(projectPath, SESSION_REL);
  const sessionBefore = await readFile(sessionFile, 'utf8').catch(() => undefined);
  const runId = randomUUID().slice(0, 8);
  const runDirRel = `${RUNS_REL}/${runId}`;
  const runDirAbs = path.join(projectPath, ...runDirRel.split('/'));
  const started = Date.now();

  try {
    // Never-imported project, or a freshly copied addon: import once so class_names exist.
    if (!(await classesImported(projectPath, info.framework))) {
      ctx.progress?.(0, undefined, 'Importing the project (first run; registers the test framework classes)');
      log.info(`test.run: importing ${projectPath} first`);
      const imp = await spawnTracked(godot.path, importArgs(projectPath), {
        cwd: projectPath,
        timeoutMs: IMPORT_TIMEOUT_MS,
        signal: ctx.signal,
        keep: 30,
      });
      if (imp.cancelled) throw new OpError('CANCELLED', 'Test run cancelled during the project import; the Godot process was stopped.');
      if (!(await classesImported(projectPath, info.framework))) {
        throw new OpError(
          'GODOT_ERROR',
          `Godot could not register the ${info.framework === 'gut' ? 'GUT' : 'GdUnit4'} classes (import ${imp.timedOut ? 'timed out' : `exit code ${imp.code}`}). ` +
            `Open the project in the Godot editor once (and enable the plugin), then retry. Last output:\n${imp.lines.slice(-10).join('\n')}`,
        );
      }
    }

    // Reports go inside .godot/ (which Godot's file scan ignores) and are deleted afterwards.
    await mkdir(runDirAbs, { recursive: true });
    const cliArgs = [
      '--headless',
      '--path',
      projectPath,
      ...(info.framework === 'gut'
        ? gutArgs(info, sel, { junitFile: `res://${runDirRel}/gut_results.xml`, hasConfig: hasGutConfig, scripts: own, projectPath })
        : gdunitArgs(info, sel, { reportDir: `res://${runDirRel}`, scripts: own, projectPath })),
    ];
    log.info(`test.run: ${godot.path} ${cliArgs.join(' ')}`);
    const scanner = new OutputScanner(info.framework, ctx.progress);
    const proc = await spawnTracked(godot.path, cliArgs, {
      cwd: projectPath,
      timeoutMs: args.timeout_s * 1000,
      signal: ctx.signal,
      onLine: (l) => scanner.onLine(l),
    });

    const reportFile = await findReport(runDirAbs);
    let summary: JUnitSummary | undefined;
    if (reportFile) summary = parseJUnit(await readFile(reportFile, 'utf8'), info.framework);
    // Noise from the remote-debug trick GdUnit4's runtest uses; never useful.
    const tail = proc.lines.filter((l) => !/127\.0\.0\.1:0|remote port number|connect_to_host|remote_debugger_peer/.test(l)).slice(-30);

    const base = {
      framework: info.framework,
      ...(info.version ? { version: info.version } : {}),
      ...(sel.path ? { path: sel.path } : {}),
      ...(sel.test ? { test: sel.test } : {}),
      exit_code: proc.code,
      wall_s: Math.round((Date.now() - started) / 100) / 10,
    };
    const partial = { ...base, tests_started: scanner.started, ...(scanner.scriptErrors.length ? { script_errors: scanner.scriptErrors } : {}), tail };

    if (proc.cancelled) throw new OpError('CANCELLED', 'Test run cancelled; the Godot process was stopped.', partial);
    if (proc.timedOut) {
      throw new OpError('TIMEOUT', `Tests did not finish within ${args.timeout_s} s and were stopped after ${scanner.started} test(s) started. A test may hang (awaiting a signal that never comes); raise timeout_s or run a smaller set with "path"/"test".`, partial);
    }
    if (!summary) {
      if (scanner.scriptErrors.length) {
        const list = scanner.scriptErrors.slice(0, 10).map((e) => `${e.file}:${e.line}: ${e.message}`).join('\n');
        throw new OpError('GODOT_ERROR', `Tests did not run because scripts failed to compile; fix these first:\n${list}`, partial);
      }
      if (info.framework === 'gdunit4' && proc.code === 0 && tail.some((l) => /No test cases found/.test(l))) {
        return { data: { ...base, status: 'no_tests', totals: { tests: 0, passed: 0, failed: 0, errors: 0, skipped: 0, duration_s: 0 }, note: 'GdUnit4 found no test cases in the selection.' } };
      }
      throw new OpError(
        'GODOT_ERROR',
        `The ${info.framework === 'gut' ? 'GUT' : 'GdUnit4'} run exited with code ${proc.code} without writing a report. Last output:\n${tail.slice(-15).join('\n')}`,
        partial,
      );
    }

    const bad = summary.cases.filter((c) => c.status === 'failed' || c.status === 'error');
    const skipped = summary.cases.filter((c) => c.status === 'skipped');
    const t = summary.totals;
    const status = t.tests === 0 ? 'no_tests' : bad.length || scanner.scriptErrors.length ? 'failed' : 'passed';
    const data: Record<string, unknown> = {
      ...base,
      status,
      totals: t,
      failures: bad.slice(0, MAX_FAILURES).map((c) => failureEntry(c, info.framework, scanner)),
    };
    if (bad.length > MAX_FAILURES) data.failures_not_shown = bad.length - MAX_FAILURES;
    if (skipped.length) {
      data.skipped = skipped.slice(0, MAX_SKIPPED).map((c) => ({ test: c.name, ...(c.file ? { file: c.file } : {}), ...(c.message ? { reason: c.message.split('\n').slice(-1)[0] } : {}) }));
    }
    if (scanner.scriptErrors.length) {
      data.script_errors = scanner.scriptErrors;
      data.script_errors_note = 'These scripts failed to compile, so their tests did not run. Fix them and run again.';
    }
    if (t.tests === 0) data.note = 'No tests ran. Check "path"/"test", and for GUT that test files start with "test_" (or the prefix in .gutconfig.json).';
    else if (info.framework === 'gdunit4' && proc.code === 101) data.note = 'GdUnit4 reported orphan nodes (exit code 101); the tests themselves passed. Free nodes created in tests (auto_free()).';
    return { data };
  } finally {
    await rm(runDirAbs, { recursive: true, force: true }).catch(() => undefined);
    await rmdir(path.dirname(runDirAbs)).catch(() => undefined); // only succeeds when empty
    if (sessionBefore !== undefined) {
      const after = await readFile(sessionFile, 'utf8').catch(() => undefined);
      if (after !== sessionBefore) await writeFile(sessionFile, sessionBefore, { encoding: 'utf8', mode: 0o600 }).catch(() => undefined);
    }
  }
}
