/**
 * End-to-end tests for the code.* tools (GDScript language server), against real Godot.
 *
 *   GODOT_BIN=/path/to/godot npx vitest run test/e2e/code.test.ts
 *
 * 1. private LSP editor: no editor connected, so the server starts its own headless editor
 *    (LSP-only mode: lsp_session.json, never session.json) and kills it on exit;
 * 2. connected editor: an editor launched through godot_editor_launch, whose language
 *    server port comes from editor settings. We point XDG_CONFIG_HOME at a temp folder with
 *    an editor_settings file using a free port, so the test never talks to some other
 *    editor's language server on the default 6005 (other Godot editors may be running).
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { copySampleProject, errorText, GODOT_BIN, json, killAndWait, removeDir, startServer } from './helpers.js';

const enabled = Boolean(GODOT_BIN);

function importProject(dir: string): void {
  spawnSync(GODOT_BIN!, ['--headless', '--path', dir, '--import'], { timeout: 180_000, stdio: 'ignore' });
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitGone(pid: number, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (!alive(pid)) return true;
    await new Promise((r) => setTimeout(r, 200));
  }
  return !alive(pid);
}

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(port));
    });
  });
}

const BROKEN = 'extends Node\n\nfunc f() -> void:\n\tvar x: int = "text"\n\tundefined_fn()\n\tvar unused := 3\n';

describe.skipIf(!enabled)('code tools: private LSP editor', () => {
  const proj = copySampleProject();
  let client: Awaited<ReturnType<typeof startServer>>;
  const call = async (name: string, args: Record<string, unknown>) => client.callTool({ name, arguments: args });

  beforeAll(async () => {
    importProject(proj.dir);
    writeFileSync(path.join(proj.dir, 'broken.gd'), BROKEN);
    client = await startServer({ project: proj.dir, era: 'modern' });
  }, 240_000);
  afterAll(async () => {
    await client?.close();
    proj.cleanup();
  });

  it('reports errors and warnings of a broken script (starting the private editor)', async () => {
    const r = json(await call('godot_code_diagnostics', { paths: ['res://broken.gd', 'res://player.gd'] }));
    expect(r.source).toBe('lsp (private headless editor)');
    expect(r.checked).toBe(2);
    expect(r.errors).toBeGreaterThanOrEqual(2);
    expect(r.warnings).toBeGreaterThanOrEqual(1);
    const broken = r.files.find((f: { path: string }) => f.path === 'res://broken.gd');
    expect(broken.diagnostics).toContainEqual(expect.objectContaining({ line: 5, severity: 'error', message: expect.stringContaining('undefined_fn') }));
    expect(broken.diagnostics.some((d: { severity: string; message: string }) => d.severity === 'warning' && /UNUSED_VARIABLE/.test(d.message))).toBe(true);
    expect(r.clean).toEqual(['res://player.gd']);
  }, 120_000);

  it('runs the private editor in LSP-only mode (no session.json for the main bridge)', async () => {
    expect(existsSync(path.join(proj.dir, '.godot', 'godot_mcp', 'session.json'))).toBe(false);
    const status = json(await call('godot_status', {}));
    expect(status.editor_connected).toBe(false);
    const lsp = JSON.parse(readFileSync(path.join(proj.dir, '.godot', 'godot_mcp', 'lsp_session.json'), 'utf8'));
    expect(lsp.lsp_only).toBe(true);
    expect(alive(lsp.pid)).toBe(true);
  });

  it('checks a folder and skips addons/', async () => {
    const r = json(await call('godot_code_diagnostics', { paths: ['res://'] }));
    expect(r.checked).toBe(5); // broken, enemy, game_state, main, player; nothing from addons/
    expect(r.note).toMatch(/addons/);
  }, 60_000);

  it('rejects non-script paths with a clear message', async () => {
    expect(errorText(await call('godot_code_diagnostics', { paths: ['res://main.tscn'] }))).toMatch(/not a \.gd file/);
    expect(errorText(await call('godot_code_diagnostics', { paths: ['res://../x.gd'] }))).toMatch(/escapes the project/);
  });

  it('outlines player.gd', async () => {
    const r = json(await call('godot_code_symbols', { path: 'res://player.gd' }));
    expect(r.class).toBe('player.gd');
    expect(r.doc).toMatch(/player controller/);
    expect(r.symbols).toContain('4: @export var speed: float = 200.0');
    expect(r.symbols).toContain('10: func _physics_process(delta: float) -> void');
  }, 60_000);

  it('finds symbols by name across scripts', async () => {
    const r = json(await call('godot_code_symbols', { query: 'score' }));
    expect(r.matches[0]).toMatchObject({ name: 'score', path: 'res://game_state.gd', kind: 'var' });
    expect(r.matches.map((m: { name: string }) => m.name)).toEqual(expect.arrayContaining(['add_score', 'score_changed']));
    expect(errorText(await call('godot_code_symbols', { path: 'res://' }))).toMatch(/add "query"/);
  }, 60_000);

  it('hovers, jumps to definitions and lists references', async () => {
    const hover = json(await call('godot_code_lookup', { path: 'res://main.gd', line: 6, symbol: 'add_score', kind: 'hover' }));
    expect(hover.markdown).toBe('func add_score(amount: int) -> void\n\nDefined in res://game_state.gd');

    const def = json(await call('godot_code_lookup', { path: 'res://main.gd', line: 6, symbol: 'add_score', kind: 'definition' }));
    expect(def.locations).toEqual([{ path: 'res://game_state.gd', line: 10, column: 6, text: 'func add_score(amount: int) -> void:' }]);

    const native = json(await call('godot_code_lookup', { path: 'res://player.gd', line: 17, symbol: 'move_and_slide', kind: 'definition' }));
    expect(native.native).toBe(true);
    expect(native.signature).toBe('func CharacterBody2D.move_and_slide() -> bool');
    expect(native.docs).toMatch(/velocity/);

    const refs = json(await call('godot_code_lookup', { path: 'res://game_state.gd', line: 10, symbol: 'add_score', kind: 'references' }));
    expect(refs.locations.map((l: { path: string; line: number }) => `${l.path}:${l.line}`).sort()).toEqual(['res://game_state.gd:10', 'res://main.gd:6']);

    // Godot's text-search finds the class name inside a doc comment; we flag it.
    const enemy = json(await call('godot_code_lookup', { path: 'res://enemy.gd', line: 1, symbol: 'Enemy', kind: 'references' }));
    expect(enemy.locations.some((l: { in_comment?: boolean }) => l.in_comment)).toBe(true);
  }, 60_000);

  it('gives signatures, completions and highlights', async () => {
    const sig = json(await call('godot_code_lookup', { path: 'res://player.gd', line: 15, symbol: 'get_axis', kind: 'signature' }));
    expect(sig.signatures[0].label).toBe('func Input.get_axis(negative_action: StringName, positive_action: StringName) -> float');

    const comp = json(await call('godot_code_lookup', { path: 'res://player.gd', line: 17, symbol: 'move_and', kind: 'completion', limit: 5 }));
    expect(comp.prefix).toBe('move_and');
    expect(comp.items.map((i: { label: string }) => i.label)).toContain('move_and_slide()');

    const hl = json(await call('godot_code_lookup', { path: 'res://player.gd', line: 4, symbol: 'speed', kind: 'highlight' }));
    expect(hl.positions).toEqual([{ line: 4, column: 13 }, { line: 16, column: 27 }]);
  }, 60_000);

  it('explains bad lookup positions', async () => {
    expect(errorText(await call('godot_code_lookup', { path: 'res://player.gd', line: 4, symbol: 'nope', kind: 'hover' }))).toMatch(/not on line 4/);
    expect(errorText(await call('godot_code_lookup', { path: 'res://player.gd', line: 400, column: 1 }))).toMatch(/outside res:\/\/player\.gd/);
    expect(errorText(await call('godot_code_lookup', { path: 'res://player.gd', line: 4 }))).toMatch(/"column".*"symbol"/);
  });

  it('previews a rename, skipping matches inside comments', async () => {
    const r = json(await call('godot_code_rename', { path: 'res://enemy.gd', line: 1, symbol: 'Enemy', new_name: 'Foe', dry_run: true }));
    expect(r.dry_run).toBe(true);
    expect(r.files[0]).toMatchObject({ path: 'res://enemy.gd', lines: [1] });
    expect(r.skipped.some((s: { reason: string; path: string }) => s.path === 'res://enemy.gd' && s.reason === 'inside a comment')).toBe(true);
    // Nothing written.
    expect(readFileSync(path.join(proj.dir, 'enemy.gd'), 'utf8')).toMatch(/^class_name Enemy/);
  }, 60_000);

  it('renames a method across files and the result still compiles', async () => {
    const r = json(await call('godot_code_rename', { path: 'res://game_state.gd', line: 10, symbol: 'add_score', new_name: 'add_points' }));
    expect(r.applied).toBe(true);
    expect(r.files.map((f: { path: string }) => f.path).sort()).toEqual(['res://game_state.gd', 'res://main.gd']);
    expect(readFileSync(path.join(proj.dir, 'main.gd'), 'utf8')).toContain('GameState.add_points(1)');
    expect(readFileSync(path.join(proj.dir, 'game_state.gd'), 'utf8')).toContain('func add_points(amount: int) -> void:');
    const d = json(await call('godot_code_diagnostics', { paths: ['res://main.gd', 'res://game_state.gd'] }));
    expect(d.errors).toBe(0);
    expect(errorText(await call('godot_code_rename', { path: 'res://player.gd', line: 17, symbol: 'move_and_slide', new_name: 'go' }))).toMatch(/engine symbols can't be renamed/);
    expect(errorText(await call('godot_code_rename', { path: 'res://main.gd', line: 6, symbol: 'add_points', new_name: '2bad' }))).toMatch(/not a valid GDScript identifier/);
  }, 60_000);

  it('picks up a new class_name script written by another tool', async () => {
    json(await call('godot_files_write', { path: 'res://code_tmp/helper.gd', content: 'class_name CodeTmpHelper\nextends RefCounted\n\nfunc twice(x: int) -> int:\n\treturn x * 2\n' }));
    json(await call('godot_files_write', { path: 'res://code_tmp/user.gd', content: 'extends Node\n\nfunc _ready() -> void:\n\tprint(CodeTmpHelper.new().twice(2))\n' }));
    await new Promise((r) => setTimeout(r, 1200)); // past the change-scan throttle
    const d = json(await call('godot_code_diagnostics', { paths: ['res://code_tmp/user.gd'] }));
    expect(d.files).toEqual([]);
    expect(d.clean).toEqual(['res://code_tmp/user.gd']);
  }, 60_000);

  it('stops the private editor when the server exits', async () => {
    const lsp = JSON.parse(readFileSync(path.join(proj.dir, '.godot', 'godot_mcp', 'lsp_session.json'), 'utf8'));
    await client.close();
    expect(await waitGone(lsp.pid, 15_000)).toBe(true);
  }, 30_000);
});

describe.skipIf(!enabled)('code tools: connected editor', () => {
  const proj = copySampleProject();
  const config = mkdtempSync(path.join(os.tmpdir(), 'godot-mcp-xdg-'));
  let client: Awaited<ReturnType<typeof startServer>>;
  let lspPort = 0;
  const call = async (name: string, args: Record<string, unknown>) => client.callTool({ name, arguments: args });

  beforeAll(async () => {
    importProject(proj.dir);
    lspPort = await freePort();
    // A private editor-settings file so this editor's language server gets its own port.
    mkdirSync(path.join(config, 'godot'), { recursive: true });
    writeFileSync(
      path.join(config, 'godot', 'editor_settings-4.7.tres'),
      `[gd_resource type="EditorSettings" format=3]\n\n[resource]\nnetwork/language_server/remote_port = ${lspPort}\n`,
    );
    client = await startServer({ project: proj.dir, era: 'legacy', env: { XDG_CONFIG_HOME: config } });
    const launched = json(await call('godot_editor_launch', { headless: true, wait_seconds: 90 }));
    expect(launched.editor ?? launched.connected).toBeTruthy();
  }, 240_000);

  afterAll(async () => {
    await client?.close();
    try {
      const session = JSON.parse(readFileSync(path.join(proj.dir, '.godot', 'godot_mcp', 'session.json'), 'utf8'));
      await killAndWait(session.pid);
    } catch {
      // the editor never came up
    }
    proj.cleanup();
    removeDir(config);
  });

  it('reports the editor language server port in session.json', () => {
    const session = JSON.parse(readFileSync(path.join(proj.dir, '.godot', 'godot_mcp', 'session.json'), 'utf8'));
    expect(session.lsp_port).toBe(lspPort);
    expect(session.lsp_only).toBe(false);
  });

  it('uses the connected editor for diagnostics and lookups', async () => {
    writeFileSync(path.join(proj.dir, 'broken.gd'), BROKEN);
    const d = json(await call('godot_code_diagnostics', { paths: ['res://broken.gd'] }));
    expect(d.source).toBe('lsp (connected editor)');
    expect(d.errors).toBeGreaterThanOrEqual(2);
    const def = json(await call('godot_code_lookup', { path: 'res://main.gd', line: 6, symbol: 'add_score', kind: 'definition' }));
    expect(def.locations[0]).toMatchObject({ path: 'res://game_state.gd', line: 10 });
    expect(existsSync(path.join(proj.dir, '.godot', 'godot_mcp', 'lsp_session.json'))).toBe(false);
  }, 90_000);

  it('falls back to script.validate when the language server is unreachable', async () => {
    // A second server whose LSP port points at nothing; the bridge itself still works.
    const deadPort = await freePort();
    const second = await startServer({ project: proj.dir, era: 'legacy', env: { XDG_CONFIG_HOME: config, GODOT_MCP_LSP_PORT: String(deadPort) } });
    try {
      const d = json(await second.callTool({ name: 'godot_code_diagnostics', arguments: { paths: ['res://broken.gd'] } }));
      expect(d.source).toMatch(/^script\.validate \(language server unavailable: .*not reachable on 127\.0\.0\.1:\d+/);
      expect(d.errors).toBeGreaterThanOrEqual(1);
      expect(errorText(await second.callTool({ name: 'godot_code_symbols', arguments: { path: 'res://player.gd' } }))).toMatch(/GODOT_MCP_LSP_PORT/);
    } finally {
      await second.close();
    }
  }, 90_000);

  it('renames through the editor language server and refreshes the editor', async () => {
    const r = json(await call('godot_code_rename', { path: 'res://game_state.gd', line: 5, symbol: 'score_changed', new_name: 'points_changed' }));
    expect(r.applied).toBe(true);
    expect(r.editor_refreshed).toBe(true);
    const text = readFileSync(path.join(proj.dir, 'game_state.gd'), 'utf8');
    expect(text).toContain('signal points_changed(new_score: int)');
    expect(text).toContain('points_changed.emit(score)');
  }, 60_000);
});
