/**
 * test.run plumbing that needs no Godot: framework detection, test discovery,
 * the GUT / GdUnit4 command lines, and the output scanner (progress lines,
 * compile errors, error locations). Output lines are copied from real runs on
 * Godot 4.7.2 with GUT 9.7.1 and GdUnit4 6.2.2.
 */

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { detectFrameworks, findTestScripts, gdunitArgs, gutArgs, scriptFramework, testFunctions, type FrameworkInfo } from '../../src/testing/frameworks.js';
import { OutputScanner, suggest } from '../../src/testing/runner.js';

const GUT: FrameworkInfo = { framework: 'gut', addonDir: 'gut', entry: 'res://addons/gut/gut_cmdln.gd' };
const GDU: FrameworkInfo = { framework: 'gdunit4', addonDir: 'gdUnit4', entry: 'res://addons/gdUnit4/bin/GdUnitCmdTool.gd' };

describe('test scripts', () => {
  it('recognises the framework from the extends line', () => {
    expect(scriptFramework('extends GutTest\n')).toBe('gut');
    expect(scriptFramework('# x\nextends "res://addons/gut/test.gd"\n')).toBe('gut');
    expect(scriptFramework('class_name FooTest\nextends GdUnitTestSuite\n')).toBe('gdunit4');
    expect(scriptFramework('extends Node\n')).toBeUndefined();
  });
  it('lists test functions, including inner classes', () => {
    expect(testFunctions('func test_a():\n\tpass\nfunc helper():\n\tpass\nclass TestX:\n\textends GutTest\n\tfunc test_b() -> void:\n\t\tpass\n')).toEqual(['test_a', 'test_b']);
  });
});

describe('project scanning', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'godot-mcp-testrun-'));
  afterAll(() => rm(dir, { recursive: true, force: true }));
  const put = (rel: string, text: string) => {
    mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    writeFileSync(path.join(dir, rel), text);
  };
  put('addons/gut/gut_cmdln.gd', 'extends SceneTree\n');
  put('addons/gut/plugin.cfg', '[plugin]\nname="Gut"\nversion="9.7.1"\n');
  put('addons/gdUnit4/bin/GdUnitCmdTool.gd', 'extends SceneTree\n');
  put('addons/gdUnit4/plugin.cfg', '[plugin]\nversion="6.2.2"\n');
  put('addons/gut/test/test_internal.gd', 'extends GutTest\nfunc test_x():\n\tpass\n');
  put('test/unit/test_math.gd', 'extends GutTest\nfunc test_add():\n\tpass\n');
  put('test/player_test.gd', 'extends GdUnitTestSuite\nfunc test_jump() -> void:\n\tpass\nfunc test_run() -> void:\n\tpass\n');
  put('src/extra_test.gd', 'extends GdUnitTestSuite\nfunc test_extra() -> void:\n\tpass\n');
  put('ignored/.gdignore', '');
  put('ignored/test_skip.gd', 'extends GutTest\n');
  put('.hidden/test_h.gd', 'extends GutTest\n');

  it('detects installed frameworks and versions', async () => {
    expect(await detectFrameworks(dir)).toEqual([
      { framework: 'gut', addonDir: 'gut', version: '9.7.1', entry: 'res://addons/gut/gut_cmdln.gd' },
      { framework: 'gdunit4', addonDir: 'gdUnit4', version: '6.2.2', entry: 'res://addons/gdUnit4/bin/GdUnitCmdTool.gd' },
    ]);
  });
  it('finds test scripts outside addons/, hidden and .gdignore folders', async () => {
    const all = await findTestScripts(dir);
    expect(all.map((s) => [s.res, s.framework])).toEqual([
      ['res://src/extra_test.gd', 'gdunit4'],
      ['res://test/player_test.gd', 'gdunit4'],
      ['res://test/unit/test_math.gd', 'gut'],
    ]);
    expect((await findTestScripts(dir, 'test/unit')).map((s) => s.res)).toEqual(['res://test/unit/test_math.gd']);
    expect(await findTestScripts(dir, 'test/player_test.gd')).toEqual([{ res: 'res://test/player_test.gd', framework: 'gdunit4', tests: ['test_jump', 'test_run'] }]);
  });

  it('builds GUT command lines', async () => {
    const scripts = await findTestScripts(dir);
    const common = ['-gexit', '-gdisable_colors', '-gjunit_xml_file=res://r.xml'];
    const o = { junitFile: 'res://r.xml', hasConfig: false, scripts, projectPath: dir };
    expect(gutArgs(GUT, {}, o)).toEqual(['-s', GUT.entry, '-gdir=res://test', '-ginclude_subdirs', ...common]);
    // With a .gutconfig.json, "all tests" leaves the choice to the config.
    expect(gutArgs(GUT, {}, { ...o, hasConfig: true })).toEqual(['-s', GUT.entry, ...common]);
    expect(gutArgs(GUT, { path: 'res://test/unit', test: 'add' }, o)).toEqual(['-s', GUT.entry, '-gdir=res://test/unit', '-ginclude_subdirs', '-gtest=', '-gunit_test_name=add', ...common]);
    expect(gutArgs(GUT, { path: 'res://test/unit/test_math.gd', isFile: true }, o)).toEqual(['-s', GUT.entry, '-gtest=res://test/unit/test_math.gd', '-gdir=', ...common]);
  });

  it('builds GdUnit4 command lines', async () => {
    const scripts = (await findTestScripts(dir)).filter((s) => s.framework === 'gdunit4');
    const head = ['-s', '-d', '--remote-debug', 'tcp://127.0.0.1:0', GDU.entry, '--ignoreHeadlessMode', '-c'];
    const tail = ['-rd', 'res://.godot/r', '-rc', '1'];
    const o = { reportDir: 'res://.godot/r', scripts, projectPath: dir };
    // All: the test folder plus suites found elsewhere.
    expect(gdunitArgs(GDU, {}, o)).toEqual([...head, '-a', 'res://test', '-a', 'res://src/extra_test.gd', ...tail]);
    expect(gdunitArgs(GDU, { path: 'res://test' }, o)).toEqual([...head, '-a', 'res://test', ...tail]);
    // One test: add only suites that have it and ignore their other tests.
    expect(gdunitArgs(GDU, { test: 'test_jump' }, o)).toEqual([...head, '-a', 'res://test/player_test.gd', '-i', 'res://test/player_test.gd:test_run', ...tail]);
  });
});

describe('OutputScanner', () => {
  it('counts GUT tests for progress and remembers runtime error lines', () => {
    const progress: [number, string | undefined][] = [];
    const s = new OutputScanner('gut', (p, _t, m) => progress.push([p, m]));
    for (const l of [
      'res://test/test_errors.gd',
      '* test_runtime_error',
      "SCRIPT ERROR: Invalid call. Nonexistent function 'nope (via call)' in base 'Nil'.",
      '          at: test_runtime_error (res://test/test_errors.gd:6)',
      '              [0] test_runtime_error (res://test/test_errors.gd:6)',
      '* test_push_error',
    ])
      s.onLine(l);
    expect(progress).toEqual([
      [1, 'test 1: test/test_errors.gd > test_runtime_error'],
      [2, 'test 2: test/test_errors.gd > test_push_error'],
    ]);
    expect(s.lineFor('test_runtime_error', 'res://test/test_errors.gd')).toBe(6);
    expect(s.scriptErrors).toEqual([]);
  });
  it('collects compile errors and GdUnit4 progress', () => {
    const s = new OutputScanner('gdunit4');
    for (const l of [
      'SCRIPT ERROR: Parse Error: Expected closing ")" after call arguments.',
      '          at: GDScript::reload (res://test/broken/broken_test.gd:4)',
      '  res://test/unit/math_test.gd > test_adds STARTED',
      '  res://test/unit/math_test.gd > test_adds PASSED 11ms',
    ])
      s.onLine(l);
    expect(s.scriptErrors).toEqual([{ file: 'res://test/broken/broken_test.gd', line: 4, message: 'Expected closing ")" after call arguments.' }]);
    expect(s.started).toBe(1);
  });
});

describe('suggest', () => {
  it('ranks close test names first', () => {
    const names = ['test_jump', 'test_run', 'test_jump_twice', 'helper'];
    expect(suggest('test_jmp', names)).toEqual(['test_jump']);
    expect(suggest('jump', names)).toEqual(['test_jump', 'test_jump_twice']);
    expect(suggest('test_fials', ['test_adds', 'test_fails', 'test_inner_bad'])).toEqual(['test_fails']);
  });
});
