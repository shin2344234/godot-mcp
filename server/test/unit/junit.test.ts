/**
 * JUnit report parsing for test.run (src/testing/junit.ts).
 *
 * The GUT and GdUnit4 samples below are real reports written on Godot 4.7.2 by
 * GUT 9.7.1 (addons/gut/junit_xml_export.gd) and GdUnit4 6.2.2
 * (addons/gdUnit4/src/reporters/xml/JUnitXmlReportWriter.gd), plus the example
 * from GUT's documentation (documentation/docs/Export-Test-Results.md), whose
 * older shape has no CDATA and keeps "res://" in class names.
 */

import { describe, expect, it } from 'vitest';
import { cleanMessage, gdunitLocation, gutScriptPath, labelGutAssert, parseJUnit, parseXml } from '../../src/testing/junit.js';

// GUT 9.7.1, real run: passes, a failure, a pending test, an inner test class.
const GUT_REAL = `<?xml version="1.0" encoding="UTF-8"?>
<testsuites name="GutTests" failures="2" tests="6" >
  <testsuite name="test/test_other.gd" tests="1" failures="0" skipped="0" time="0.000194" >
      <testcase name="test_other_ok" assertions="1" status="pass" classname="test/test_other.gd" time="0.000194" >
      </testcase>
  </testsuite>
  <testsuite name="test/unit/test_math.gd" tests="3" failures="1" skipped="1" time="0.000514" >
      <testcase name="test_adds" assertions="1" status="pass" classname="test/unit/test_math.gd" time="0.000186" >
      </testcase>
      <testcase name="test_fails" assertions="1" status="fail" classname="test/unit/test_math.gd" time="0.000221" >
      <failure message="failed"><![CDATA[[1] expected to equal [2]:  one is not two
            at line 7]]></failure></testcase>
      <testcase name="test_pending_one" assertions="0" status="pending" classname="test/unit/test_math.gd" time="0.000107" >
      <skipped message="pending"><![CDATA[later]]></skipped></testcase>
  </testsuite>
  <testsuite name="test/unit/test_math.gd.TestInner" tests="2" failures="1" skipped="0" time="0.000293" >
      <testcase name="test_inner_ok" assertions="1" status="pass" classname="test/unit/test_math.gd.TestInner" time="0.000115" >
      </testcase>
      <testcase name="test_inner_bad" assertions="1" status="fail" classname="test/unit/test_math.gd.TestInner" time="0.000178" >
      <failure message="failed"><![CDATA[inner broken
            at line 17]]></failure></testcase>
  </testsuite>
</testsuites>`;

// GUT 9.7.1, real run: engine errors caught by GUT's error tracking ("at line -1").
const GUT_ENGINE_ERRORS = `<?xml version="1.0" encoding="UTF-8"?>
<testsuites name="GutTests" failures="2" tests="2" >
  <testsuite name="test/test_errors.gd" tests="2" failures="2" skipped="0" time="0.001633" >
      <testcase name="test_runtime_error" assertions="1" status="fail" classname="test/test_errors.gd" time="0.001047" >
      <failure message="failed"><![CDATA[Unexpected Errors:
      [1] <engine-2>Invalid call. Nonexistent function 'nope (via call)' in base 'Nil'.
            at line -1]]></failure></testcase>
      <testcase name="test_push_error" assertions="2" status="fail" classname="test/test_errors.gd" time="0.000586" >
      <failure message="failed"><![CDATA[Unexpected Errors:
      [1] <push_error>custom pushed error
            at line -1]]></failure></testcase>
  </testsuite>
</testsuites>`;

// GUT documentation example (abridged): no CDATA, "res://" kept, no time attributes.
const GUT_DOCS = `<?xml version="1.0" encoding="UTF-8"?>
<testsuites name="GutTests" failures="7" tests="17">
      <testsuite name="res://test/resources/exporter_test_files/test_simple_2.gd" tests="3" failures="1" skipped="1">
            <testcase name="test_pass" assertions="1" status="pass" classname="res://test/resources/exporter_test_files/test_simple_2.gd"></testcase>
            <testcase name="test_fail" assertions="1" status="fail" classname="res://test/resources/exporter_test_files/test_simple_2.gd">
                  <failure message="failed">Cannot compare Int[1] to String["two"].
            at line 7</failure>
            </testcase>
            <testcase name="test_pending" assertions="0" status="pending" classname="res://test/resources/exporter_test_files/test_simple_2.gd">
                  <skipped message="pending">this has text</skipped>
            </testcase>
      </testsuite>
      <testsuite name="res://test/resources/exporter_test_files/test_with_inner_classes.gd" tests="0" failures="0" skipped="0"></testsuite>
      <testsuite name="res://test/resources/exporter_test_files/test_with_inner_classes.gd.TestClassOne" tests="3" failures="1" skipped="1">
            <testcase name="test_fail_1" assertions="1" status="fail" classname="res://test/resources/exporter_test_files/test_with_inner_classes.gd.TestClassOne">
                  <failure message="failed">Cannot compare Int[1] to String["two"].
            at line 11</failure>
            </testcase>
      </testsuite>
</testsuites>`;

// GdUnit4 6.2.2, real run: a pass, an engine error, a failure, a skipped test.
const GDUNIT_REAL = `<?xml version="1.0" encoding="UTF-8" ?>
<testsuites id="2026-10-15" name="report_1" tests="6" failures="1" skipped="1" flaky="0" time="0.000">
	<testsuite id="0" name="other_test" package="test" timestamp="2026-10-15T02:59:55" hostname="localhost" tests="2" failures="0" errors="1" skipped="0" flaky="0" time="0.043">
		<testcase name="test_other_ok" classname="other_test" time="0.010">
		</testcase>
		<testcase name="test_runtime_error" classname="other_test" time="0.014">
			<error message="ERROR: res://test/other_test.gd:8" type="ABORT">
<![CDATA[
Godot Runtime Error !
  'Invalid call. Nonexistent function 'nope (via call)' in base 'Nil'.'
	at 'test_runtime_error' in res://test/other_test.gd:8
]]>
			</error>
		</testcase>
	</testsuite>
	<testsuite id="1" name="math_test" package="test/unit" timestamp="2026-10-15T02:59:55" hostname="localhost" tests="4" failures="1" errors="0" skipped="1" flaky="0" time="0.079">
		<testcase name="test_adds" classname="math_test" time="0.011">
		</testcase>
		<testcase name="test_fails" classname="math_test" time="0.012">
			<failure message="FAILED: res://test/unit/math_test.gd:7" type="FAILURE">
<![CDATA[
Expecting:
 2
 but was
 1
	at 'test_fails' in res://test/unit/math_test.gd:7
]]>
			</failure>
		</testcase>
		<testcase name="test_skipped" classname="math_test" time="0.000">
			<skipped message="SKIPPED: res://test/unit/math_test.gd:9">
<![CDATA[
This test is skipped!
  Reason: 'not ready'
]]>
			</skipped>
		</testcase>
		<testcase name="test_also_ok" classname="math_test" time="0.012">
		</testcase>
	</testsuite>
</testsuites>
`;

describe('parseXml', () => {
  it('reads elements, attributes, entities and CDATA', () => {
    const doc = parseXml(`<?xml version="1.0"?><!-- c --><a x="1 &amp; 2" y='q&#39;s'><b/><c>t &lt;x&gt;<![CDATA[<raw>]]></c></a>`);
    const a = doc.children[0]!;
    expect(a.name).toBe('a');
    expect(a.attrs).toEqual({ x: '1 & 2', y: "q's" });
    expect(a.children.map((c) => c.name)).toEqual(['b', 'c']);
    expect(a.children[1]!.text).toBe('t <x><raw>');
  });
  it('tolerates raw ">" in attribute values and unclosed elements', () => {
    const doc = parseXml('<s><t name="a > b" classname="x"><failure message="m">boom');
    const t = doc.children[0]!.children[0]!;
    expect(t.attrs.name).toBe('a > b');
    expect(t.children[0]!.text).toBe('boom');
  });
});

describe('parseJUnit: GUT', () => {
  it('parses a real GUT 9.7.1 report', () => {
    const r = parseJUnit(GUT_REAL, 'gut');
    expect(r.totals).toEqual({ tests: 6, passed: 3, failed: 2, errors: 0, skipped: 1, duration_s: 0.001 });
    const fails = r.cases.filter((c) => c.status === 'failed');
    expect(fails).toEqual([
      { suite: 'test/unit/test_math.gd', name: 'test_fails', status: 'failed', time: 0.000221, file: 'res://test/unit/test_math.gd', line: 7, message: 'got [1], expected to equal [2]: one is not two' },
      { suite: 'test/unit/test_math.gd.TestInner', name: 'test_inner_bad', status: 'failed', time: 0.000178, file: 'res://test/unit/test_math.gd', line: 17, message: 'inner broken' },
    ]);
    const pending = r.cases.find((c) => c.status === 'skipped')!;
    expect(pending).toMatchObject({ name: 'test_pending_one', message: 'later', file: 'res://test/unit/test_math.gd' });
  });
  it('leaves the line out when GUT does not know it (engine errors)', () => {
    const r = parseJUnit(GUT_ENGINE_ERRORS, 'gut');
    expect(r.totals.failed).toBe(2);
    expect(r.cases[0]!.line).toBeUndefined();
    expect(r.cases[0]!.message).toBe("Unexpected Errors:\n[1] <engine-2>Invalid call. Nonexistent function 'nope (via call)' in base 'Nil'.");
  });
  it('parses the documented (older) GUT format', () => {
    const r = parseJUnit(GUT_DOCS, 'gut');
    expect(r.totals).toMatchObject({ tests: 4, passed: 1, failed: 2, skipped: 1, duration_s: 0 });
    expect(r.cases[1]).toMatchObject({ file: 'res://test/resources/exporter_test_files/test_simple_2.gd', line: 7, message: 'Cannot compare Int[1] to String["two"].' });
    expect(r.cases[3]).toMatchObject({ file: 'res://test/resources/exporter_test_files/test_with_inner_classes.gd', line: 11 });
  });
});

describe('parseJUnit: GdUnit4', () => {
  it('parses a real GdUnit4 6.2.2 report', () => {
    const r = parseJUnit(GDUNIT_REAL, 'gdunit4');
    // The root has no errors total and time="0.000"; totals come from the cases and suite times.
    expect(r.totals).toEqual({ tests: 6, passed: 3, failed: 1, errors: 1, skipped: 1, duration_s: 0.122 });
    expect(r.cases.find((c) => c.status === 'error')).toEqual({
      suite: 'other_test',
      name: 'test_runtime_error',
      status: 'error',
      time: 0.014,
      file: 'res://test/other_test.gd',
      line: 8,
      message: "Godot Runtime Error !\n'Invalid call. Nonexistent function 'nope (via call)' in base 'Nil'.'",
    });
    expect(r.cases.find((c) => c.status === 'failed')).toMatchObject({ file: 'res://test/unit/math_test.gd', line: 7, message: 'Expecting:\n2\nbut was\n1' });
    expect(r.cases.find((c) => c.status === 'skipped')).toMatchObject({ name: 'test_skipped', line: 9, message: "This test is skipped!\nReason: 'not ready'" });
  });
  it('handles an empty report', () => {
    expect(parseJUnit('<?xml version="1.0" encoding="UTF-8" ?>\n<testsuites id="x" name="report_1" tests="0" failures="0" skipped="0" flaky="0" time="0.000">\n</testsuites>\n', 'gdunit4').totals).toEqual({
      tests: 0,
      passed: 0,
      failed: 0,
      errors: 0,
      skipped: 0,
      duration_s: 0,
    });
  });
});

describe('helpers', () => {
  it('maps GUT class names to script paths', () => {
    expect(gutScriptPath('test/unit/test_math.gd')).toBe('res://test/unit/test_math.gd');
    expect(gutScriptPath('test/unit/test_math.gd.TestInner')).toBe('res://test/unit/test_math.gd');
    expect(gutScriptPath('res://a/test_b.gd.Inner_2')).toBe('res://a/test_b.gd');
    expect(gutScriptPath('weird')).toBeUndefined();
  });
  it('reads GdUnit4 locations', () => {
    expect(gdunitLocation('FAILED: res://test/a b/x_test.gd:12')).toEqual({ file: 'res://test/a b/x_test.gd', line: 12 });
    expect(gdunitLocation('ERROR: res://x_test.gd:-1')).toEqual({ file: 'res://x_test.gd' });
    expect(gdunitLocation('failed')).toEqual({});
  });
  it('cleans and caps messages', () => {
    expect(cleanMessage('\n  a\n\n   b\n   at line 3\n')).toBe('a\nb');
    expect(cleanMessage('x'.repeat(1000)).length).toBe(600);
  });
});

describe('labelGutAssert', () => {
  it('labels the got value and drops the bare colon of an assert without text', () => {
    expect(labelGutAssert('[1] expected to equal [5]:')).toBe('got [1], expected to equal [5]');
    expect(labelGutAssert('[1] expected to be between [2] and [3]:  why')).toBe('got [1], expected to be between [2] and [3]: why');
    expect(labelGutAssert('[0.5] expected to equal [1] +/- [0.1]:  x')).toBe('got [0.5], expected to equal [1] +/- [0.1]: x');
    expect(labelGutAssert('Unexpected Errors:\n[1] boom')).toBe('Unexpected Errors:\n[1] boom');
  });
});
