/**
 * End-to-end tests for test.run (GUT / GdUnit4) and editor.ui against real
 * Godot (skipped when GODOT_BIN isn't set):
 *
 *   GODOT_BIN=/path/to/godot npx vitest run test/e2e/testing.test.ts
 *
 * The test frameworks are third-party addons. This file (test code only, never
 * the product) downloads pinned release archives from GitHub once and caches
 * them under the OS cache folder (e.g. ~/.cache/godot-mcp-tests/gut-9.7.1/);
 * without network access and without a cached copy the framework suites are
 * skipped. Set GODOT_MCP_TEST_CACHE to use another cache folder.
 *   GUT 9.7.1     - the release for Godot 4.7 (bitwes/Gut README version table)
 *   GdUnit4 6.2.2 - supports Godot 4.5 to 4.7.1 per its README; works on 4.7.2
 */

import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { copySampleProject, errorText, GODOT_BIN, json, killAndWait, removeDir, startServer } from './helpers.js';

type Client = Awaited<ReturnType<typeof startServer>>;

const enabled = Boolean(GODOT_BIN);

// ---------------------------------------------------------------------------
// Pinned framework downloads (test-only)
// ---------------------------------------------------------------------------

function cacheRoot(): string {
  if (process.env.GODOT_MCP_TEST_CACHE) return process.env.GODOT_MCP_TEST_CACHE;
  const home = os.homedir();
  const base =
    process.platform === 'win32'
      ? (process.env.LOCALAPPDATA ?? path.join(home, 'AppData', 'Local'))
      : process.platform === 'darwin'
        ? path.join(home, 'Library', 'Caches')
        : (process.env.XDG_CACHE_HOME ?? path.join(home, '.cache'));
  return path.join(base, 'godot-mcp-tests');
}

interface AddonSpec {
  /** Cache folder name, e.g. "gut-9.7.1". */
  key: string;
  url: string;
  /** Folder inside addons/, e.g. "gut". */
  addon: string;
}

const GUT_SPEC: AddonSpec = { key: 'gut-9.7.1', url: 'https://github.com/bitwes/Gut/archive/refs/tags/v9.7.1.zip', addon: 'gut' };
const GDUNIT_SPEC: AddonSpec = { key: 'gdunit4-6.2.2', url: 'https://github.com/godot-gdunit-labs/gdUnit4/archive/refs/tags/v6.2.2.zip', addon: 'gdUnit4' };

/**
 * Path of a cached `addons/<name>` folder, downloading and extracting the
 * release zip on first use. Undefined (suite skipped) when that fails.
 */
async function cachedAddon(spec: AddonSpec): Promise<string | undefined> {
  const dir = path.join(cacheRoot(), spec.key);
  const addonDir = path.join(dir, 'addons', spec.addon);
  if (existsSync(path.join(dir, '.complete')) && existsSync(addonDir)) return addonDir;
  try {
    const res = await fetch(spec.url, { signal: AbortSignal.timeout(120_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const tmp = path.join(cacheRoot(), `${spec.key}.download`);
    await rm(tmp, { recursive: true, force: true });
    mkdirSync(tmp, { recursive: true });
    const zip = path.join(tmp, 'release.zip');
    await writeFile(zip, Buffer.from(await res.arrayBuffer()));
    // unzip on Linux/macOS; bsdtar (tar.exe) reads zips on Windows and macOS.
    const unzipped = spawnSync('unzip', ['-q', zip, '-d', tmp]).status === 0 || spawnSync('tar', ['-xf', zip, '-C', tmp]).status === 0;
    if (!unzipped) throw new Error('could not extract the zip (needs unzip or bsdtar)');
    // GitHub archives have one top folder, e.g. Gut-9.7.1/addons/gut.
    const top = readdirSync(tmp).find((n) => existsSync(path.join(tmp, n, 'addons', spec.addon)));
    if (!top) throw new Error(`addons/${spec.addon} not found in the archive`);
    await rm(dir, { recursive: true, force: true });
    mkdirSync(path.join(dir, 'addons'), { recursive: true });
    cpSync(path.join(tmp, top, 'addons', spec.addon), addonDir, { recursive: true });
    writeFileSync(path.join(dir, '.complete'), spec.url);
    await rm(tmp, { recursive: true, force: true });
    return addonDir;
  } catch (err) {
    console.warn(`testing.test.ts: ${spec.key} not available (${(err as Error).message}); skipping its tests.`);
    return undefined;
  }
}

const gutDir = enabled ? await cachedAddon(GUT_SPEC) : undefined;
const gdunitDir = enabled ? await cachedAddon(GDUNIT_SPEC) : undefined;

/** Write a file into the project (creating folders). */
function put(dir: string, rel: string, text: string): void {
  mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  writeFileSync(path.join(dir, rel), text);
}

/** Godot processes whose command line mentions `needle` (Linux/macOS only). */
function processesWith(needle: string): string[] {
  const ps = spawnSync('ps', ['-eo', 'args'], { encoding: 'utf8' });
  return (ps.stdout ?? '').split('\n').filter((l) => l.includes(needle) && !l.includes('ps -eo'));
}

// ---------------------------------------------------------------------------
// No framework installed
// ---------------------------------------------------------------------------

describe.skipIf(!enabled)('test.run: no framework', () => {
  const proj = copySampleProject();
  let client: Client;
  beforeAll(async () => {
    client = await startServer({ project: proj.dir, era: 'modern' });
  }, 60_000);
  afterAll(async () => {
    await client?.close();
    await proj.cleanup();
  });

  it('explains which frameworks are supported and how to install them', async () => {
    const msg = errorText(await client.callTool({ name: 'godot_test_run', arguments: {} }));
    expect(msg).toMatch(/^NOT_FOUND: No supported test framework is installed/);
    expect(msg).toContain('GUT (addons/gut');
    expect(msg).toContain('GdUnit4 (addons/gdUnit4');
    expect(msg).toMatch(/AssetLib|download/);
  });

  it('editor.ui needs the editor', async () => {
    const msg = errorText(await client.callTool({ name: 'godot_editor_ui', arguments: { action: 'get_selection' } }));
    expect(msg).toMatch(/^EDITOR_NOT_CONNECTED: "editor\.ui" needs the live editor/);
  });
});

// ---------------------------------------------------------------------------
// GUT
// ---------------------------------------------------------------------------

const GUT_MATH = `extends GutTest

func test_adds():
	assert_eq(1 + 1, 2)

func test_fails():
	assert_eq(1, 2, "one is not two")

func test_pending_one():
	pending("later")

class TestInner:
	extends GutTest
	func test_inner_ok():
		assert_true(true)
	func test_inner_bad():
		assert_true(false, "inner broken")
`;

const GUT_ERRORS = `extends GutTest

func test_runtime_error():
	var n = null
	n.call("nope")
	assert_true(true)
`;

describe.skipIf(!enabled || !gutDir)('test.run: GUT', () => {
  const proj = copySampleProject();
  let client: Client;
  const call = (args: Record<string, unknown>, opts?: Parameters<Client['callTool']>[1]) => client.callTool({ name: 'godot_test_run', arguments: args }, opts);

  beforeAll(async () => {
    cpSync(gutDir!, path.join(proj.dir, 'addons', 'gut'), { recursive: true });
    put(proj.dir, 'test/unit/test_math.gd', GUT_MATH);
    put(proj.dir, 'test/test_errors.gd', GUT_ERRORS);
    put(proj.dir, 'test/test_other.gd', 'extends GutTest\n\nfunc test_other_ok():\n\tassert_eq("a", "a")\n');
    // No import on purpose: test.run must import a never-opened project by itself.
    client = await startServer({ project: proj.dir, era: 'modern' });
  }, 60_000);
  afterAll(async () => {
    await client?.close();
    await proj.cleanup();
  });

  it('runs all tests with progress and reports failures with file:line', async () => {
    const progress: string[] = [];
    const r = json(await call({}, { onprogress: (p) => progress.push(String(p.message)), timeout: 600_000 }));
    expect(r).toMatchObject({ framework: 'gut', version: '9.7.1', status: 'failed', exit_code: 1 });
    expect(r.totals).toMatchObject({ tests: 7, passed: 3, failed: 3, errors: 0, skipped: 1 });
    expect(r.failures).toContainEqual({ test: 'test_fails', file: 'res://test/unit/test_math.gd', line: 7, message: '[1] expected to equal [2]:  one is not two' });
    expect(r.failures).toContainEqual({ test: 'test_inner_bad', class: 'TestInner', file: 'res://test/unit/test_math.gd', line: 17, message: 'inner broken' });
    // GUT reports "at line -1" for engine errors; the line comes from Godot's output instead.
    expect(r.failures).toContainEqual(expect.objectContaining({ test: 'test_runtime_error', file: 'res://test/test_errors.gd', line: 5 }));
    expect(r.skipped).toEqual([{ test: 'test_pending_one', file: 'res://test/unit/test_math.gd', reason: 'later' }]);
    expect(progress.some((m) => m.startsWith('Importing the project'))).toBe(true);
    expect(progress.filter((m) => /^test \d+: /.test(m)).length).toBe(7);
    // Reports are temporary.
    expect(existsSync(path.join(proj.dir, '.godot', 'godot_mcp', 'test_runs'))).toBe(false);
  }, 600_000);

  it('runs a folder, a file, and a single test by name', async () => {
    const dir = json(await call({ path: 'res://test/unit' }));
    expect(dir).toMatchObject({ path: 'res://test/unit', totals: { tests: 5, failed: 2 } });
    const file = json(await call({ path: 'test/test_other.gd' }));
    expect(file).toMatchObject({ status: 'passed', exit_code: 0, totals: { tests: 1, passed: 1 }, failures: [] });
    const one = json(await call({ test: 'inner_ok' }));
    expect(one).toMatchObject({ status: 'passed', test: 'inner_ok', totals: { tests: 1, passed: 1 } });
  }, 300_000);

  it('gives actionable errors for unknown tests and paths', async () => {
    expect(errorText(await call({ test: 'test_fials' }))).toMatch(/^NOT_FOUND: No test function containing "test_fials".*Did you mean: test_fails/);
    expect(errorText(await call({ path: 'res://nope' }))).toMatch(/^NOT_FOUND: "res:\/\/nope" does not exist/);
    expect(errorText(await call({ framework: 'gdunit4' }))).toMatch(/^NOT_FOUND: GdUnit4 \(addons\/gdUnit4\) is not installed.*installed: GUT/);
  }, 60_000);

  it('reports scripts that fail to compile', async () => {
    put(proj.dir, 'broken/test_broken.gd', 'extends GutTest\n\nfunc test_parse():\n\tassert_true(this is not valid\n');
    put(proj.dir, 'broken/test_fine.gd', 'extends GutTest\n\nfunc test_fine():\n\tassert_true(true)\n');
    const r = json(await call({ path: 'res://broken' }));
    expect(r.status).toBe('failed');
    expect(r.totals.passed).toBe(1);
    expect(r.script_errors).toEqual([{ file: 'res://broken/test_broken.gd', line: 4, message: expect.stringContaining('Expected closing ")"') }]);
  }, 120_000);

  // A hanging test, written only for the timeout/cancel tests below ("all tests" would find it).
  const SLOW = 'extends GutTest\n\nfunc test_hangs():\n\tawait get_tree().create_timer(600).timeout\n\tassert_true(true)\n';

  it('enforces the timeout and kills the run', async () => {
    put(proj.dir, 'slow/test_slow.gd', SLOW);
    const msg = errorText(await call({ path: 'res://slow', timeout_s: 10 }));
    expect(msg).toMatch(/^TIMEOUT: Tests did not finish within 10 s/);
    if (process.platform !== 'win32') {
      await new Promise((r) => setTimeout(r, 6000));
      expect(processesWith(proj.dir).filter((l) => l.includes('gut_cmdln'))).toEqual([]);
    }
  }, 120_000);

  it.skipIf(process.platform === 'win32')('stops the Godot process when the client cancels', async () => {
    const controller = new AbortController();
    const pending = call(
      { path: 'res://slow' },
      {
        signal: controller.signal,
        timeout: 120_000,
        // Cancel once the hanging test has started.
        onprogress: (p) => (/test_hangs/.test(String(p.message)) ? controller.abort() : undefined),
      },
    );
    await expect(pending).rejects.toThrow();
    const deadline = Date.now() + 15_000;
    let left = processesWith(proj.dir).filter((l) => l.includes('gut_cmdln'));
    while (left.length && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 500));
      left = processesWith(proj.dir).filter((l) => l.includes('gut_cmdln'));
    }
    expect(left).toEqual([]);
  }, 120_000);
});

// ---------------------------------------------------------------------------
// GdUnit4
// ---------------------------------------------------------------------------

describe.skipIf(!enabled || !gdunitDir)('test.run: GdUnit4', () => {
  const proj = copySampleProject();
  let client: Client;
  const call = (args: Record<string, unknown>) => client.callTool({ name: 'godot_test_run', arguments: args }, { timeout: 600_000 });

  beforeAll(async () => {
    cpSync(gdunitDir!, path.join(proj.dir, 'addons', 'gdUnit4'), { recursive: true });
    put(
      proj.dir,
      'test/unit/math_test.gd',
      'extends GdUnitTestSuite\n\nfunc test_adds() -> void:\n\tassert_int(1 + 1).is_equal(2)\n\nfunc test_fails() -> void:\n\tassert_int(1).is_equal(2)\n\n' +
        'func test_skipped(do_skip := true, skip_reason := "not ready") -> void:\n\tassert_bool(false).is_true()\n',
    );
    put(proj.dir, 'test/other_test.gd', 'extends GdUnitTestSuite\n\nfunc test_other_ok() -> void:\n\tassert_bool(true).is_true()\n\nfunc test_runtime_error() -> void:\n\tvar n: Variant = null\n\tn.call("nope")\n');
    client = await startServer({ project: proj.dir, era: 'modern' });
  }, 60_000);
  afterAll(async () => {
    await client?.close();
    await proj.cleanup();
  });

  it('runs all tests: failures, errors and skips with file:line', async () => {
    const r = json(await call({}));
    expect(r).toMatchObject({ framework: 'gdunit4', version: '6.2.2', status: 'failed', exit_code: 100 });
    expect(r.totals).toMatchObject({ tests: 5, passed: 2, failed: 1, errors: 1, skipped: 1 });
    expect(r.failures).toContainEqual({ test: 'test_fails', file: 'res://test/unit/math_test.gd', line: 7, message: 'Expecting:\n2\nbut was\n1' });
    expect(r.failures).toContainEqual(expect.objectContaining({ test: 'test_runtime_error', file: 'res://test/other_test.gd', line: 8, error: true }));
  }, 600_000);

  it('runs one test by name', async () => {
    const r = json(await call({ test: 'test_adds' }));
    expect(r).toMatchObject({ status: 'passed', exit_code: 0, totals: { tests: 1, passed: 1 } });
  }, 300_000);
});

// ---------------------------------------------------------------------------
// editor.ui
// ---------------------------------------------------------------------------

describe.skipIf(!enabled)('editor.ui', () => {
  const proj = copySampleProject();
  let client: Client;
  const ui = (args: Record<string, unknown>) => client.callTool({ name: 'godot_editor_ui', arguments: args });

  beforeAll(async () => {
    spawnSync(GODOT_BIN!, ['--headless', '--path', proj.dir, '--import'], { timeout: 180_000, stdio: 'ignore' });
    client = await startServer({ project: proj.dir, era: 'legacy' });
    const launched = json(await client.callTool({ name: 'godot_editor_launch', arguments: { headless: true, wait_seconds: 90 } }));
    expect(launched.editor ?? launched.connected).toBeTruthy();
  }, 240_000);
  afterAll(async () => {
    await client?.close();
    try {
      const session = JSON.parse(readFileSync(path.join(proj.dir, '.godot', 'godot_mcp', 'session.json'), 'utf8'));
      await killAndWait(session.pid);
    } catch {
      // no session file: the editor never came up
    }
    await removeDir(proj.dir);
  });

  it('sets and reads the selection, with close matches for wrong paths', async () => {
    const empty = json(await ui({ action: 'get_selection', scene: 'res://main.tscn' }));
    expect(empty).toMatchObject({ scene: 'res://main.tscn', backend: 'editor' });
    const sel = json(await ui({ action: 'select', paths: ['Timer', 'Label'] }));
    expect([...sel.selected].sort()).toEqual(['Label', 'Timer']);
    const read = json(await ui({ action: 'get_selection' }));
    expect([...read.selected].sort()).toEqual(['Label', 'Timer']);
    const one = json(await ui({ action: 'select', paths: ['Main/Camera2D'] }));
    expect(one.selected).toEqual(['Camera2D']);
    const wrong = errorText(await ui({ action: 'select', paths: ['Timr'] }));
    expect(wrong).toMatch(/^NOT_FOUND: Node 'Timr'.*Did you mean: Timer/);
    // A failed select leaves the selection alone.
    expect(json(await ui({ action: 'get_selection' })).selected).toEqual(['Camera2D']);
    expect(json(await ui({ action: 'select', paths: [] })).selected).toEqual([]);
  }, 60_000);

  it('opens a script at a line', async () => {
    const r = json(await ui({ action: 'open_script', script: 'main.gd', line: 5, column: 2 }));
    expect(r).toMatchObject({ script: 'res://main.gd', line: 5, column: 2, current_script: 'res://main.gd' });
    if (r.caret) expect(r.caret).toEqual({ line: 5, column: 2 });
    expect(errorText(await ui({ action: 'open_script', script: 'res://main.gd', line: 99 }))).toMatch(/has \d+ lines; 'line' 99 is past the end/);
    expect(errorText(await ui({ action: 'open_script', script: 'res://mian.gd' }))).toMatch(/^NOT_FOUND: .*Did you mean: res:\/\/main\.gd/);
  }, 60_000);

  it('saves all unsaved scenes and says what it saved', async () => {
    json(await client.callTool({ name: 'godot_node_set', arguments: { scene: 'res://main.tscn', path: 'Label', properties: { text: 'Saved by save_all' } } }));
    const status = json(await client.callTool({ name: 'godot_status', arguments: {} }));
    expect(status.editor.unsaved_scenes).toContain('res://main.tscn');
    const r = json(await ui({ action: 'save_all' }));
    expect(r.saved_scenes).toEqual(['res://main.tscn']);
    expect(r.edited_scene).toBe('res://main.tscn');
    expect(readFileSync(path.join(proj.dir, 'main.tscn'), 'utf8')).toContain('Saved by save_all');
    const again = json(await ui({ action: 'save_all' }));
    expect(again).toMatchObject({ saved_scenes: [], saved_scripts: [], nothing_to_save: true });
  }, 60_000);

  it('shows a toast', async () => {
    expect(json(await ui({ action: 'toast', message: 'Hello from MCP', severity: 'warning' }))).toMatchObject({ shown: true, severity: 'warning' });
    expect(errorText(await ui({ action: 'toast', message: '  ' }))).toMatch(/'message' is empty/);
  }, 30_000);
});
