/**
 * End-to-end tests for the project configuration tools (project.set, input.edit,
 * autoload.edit, project.plugins, project.validate) against real Godot.
 *
 *   GODOT_BIN=/path/to/godot npx vitest run test/e2e/project.test.ts
 *
 * Each suite works on a fresh temp copy of examples/sample_project; the sample
 * itself is never modified.
 */

import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { copySampleProject, errorText, GODOT_BIN, json, killAndWait, startServer } from './helpers.js';

const enabled = Boolean(GODOT_BIN);

function importProject(dir: string): void {
  spawnSync(GODOT_BIN!, ['--headless', '--path', dir, '--import'], { timeout: 180_000, stdio: 'ignore' });
}

const projectGodot = (dir: string) => readFileSync(path.join(dir, 'project.godot'), 'utf8');

describe.skipIf(!enabled)('project tools (headless)', () => {
  const proj = copySampleProject();
  let client: Awaited<ReturnType<typeof startServer>>;
  const call = async (name: string, args: Record<string, unknown>) => client.callTool({ name, arguments: args });

  beforeAll(async () => {
    importProject(proj.dir);
    client = await startServer({ project: proj.dir, era: 'modern' });
  }, 240_000);
  afterAll(async () => {
    await client?.close();
    proj.cleanup();
  });

  it('project.set changes, type-converts and resets settings', async () => {
    const res = json(await call('godot_project_set', { settings: { 'display/window/size/viewport_width': '1280', 'application/config/name': 'Renamed' } }));
    expect(res.backend).toBe('headless');
    expect(res.changed['display/window/size/viewport_width']).toEqual({ old: 1152, new: 1280 });
    let text = projectGodot(proj.dir);
    expect(text).toContain('window/size/viewport_width=1280');
    expect(text).toContain('config/name="Renamed"');
    // Untouched settings survive the rewrite.
    expect(text).toContain('GameState="*res://game_state.gd"');
    expect(text).toContain('run/main_scene="res://main.tscn"');

    // null = back to the default, which Godot drops from the file.
    json(await call('godot_project_set', { settings: { 'display/window/size/viewport_width': null } }));
    text = projectGodot(proj.dir);
    expect(text).not.toContain('viewport_width');

    // Custom settings need create: true.
    const noCreate = errorText(await call('godot_project_set', { settings: { 'game/difficulty': 2 } }));
    expect(noCreate).toMatch(/not an existing project setting.*create/s);
    json(await call('godot_project_set', { settings: { 'game/difficulty': 2 }, create: true }));
    expect(projectGodot(proj.dir)).toContain('difficulty=2');
  }, 120_000);

  it('project.set gives actionable errors', async () => {
    const typo = errorText(await call('godot_project_set', { settings: { 'display/window/size/viewport_widht': 1 } }));
    expect(typo).toContain('Did you mean: display/window/size/viewport_width');
    const badEnum = errorText(await call('godot_project_set', { settings: { 'rendering/renderer/rendering_method': 'vulkan' } }));
    expect(badEnum).toMatch(/forward_plus, mobile, gl_compatibility/);
    const redirect = errorText(await call('godot_project_set', { settings: { 'input/jump': {} } }));
    expect(redirect).toContain('input.edit');
    const port = errorText(await call('godot_project_set', { settings: { 'godot_mcp/bridge/port': 80 } }));
    expect(port).toMatch(/1024/);
    const missingScene = errorText(await call('godot_project_set', { settings: { 'application/run/main_scene': 'res://nope.tscn' } }));
    expect(missingScene).toContain('does not exist');
  }, 120_000);

  it('input.edit adds actions and bindings and persists them', async () => {
    const res = json(
      await call('godot_input_edit', {
        ops: [
          { op: 'add_action', action: 'fire', event: 'Ctrl+F' },
          { op: 'add_event', action: 'fire', event: { type: 'mouse_button', button: 'left' } },
          { op: 'add_event', action: 'fire', event: { type: 'joy_button', button: 'a' } },
          { op: 'add_event', action: 'fire', event: { type: 'joy_axis', axis: 'trigger_right', value: 1 } },
          { op: 'set_deadzone', action: 'jump', deadzone: 0.4 },
        ],
      }),
    );
    expect(res.actions.fire.deadzone).toBeCloseTo(0.2);
    expect(res.actions.fire.events).toHaveLength(4);
    expect(res.actions.fire.events[0]).toMatch(/^key: Ctrl\+F/);
    expect(res.actions.fire.events[1]).toMatch(/^mouse_button: Left Mouse Button/);
    const text = projectGodot(proj.dir);
    expect(text).toMatch(/fire=\{\n"deadzone": 0\.2,/);
    expect(text).toContain('InputEventJoypadMotion');
    expect(text).toMatch(/jump=\{\n"deadzone": 0\.4/);

    // Remove one binding by spec, then the whole action.
    const removed = json(await call('godot_input_edit', { ops: [{ op: 'remove_event', action: 'fire', event: { type: 'mouse_button', button: 'left' } }] }));
    expect(removed.actions.fire.events).toHaveLength(3);
    json(await call('godot_input_edit', { ops: [{ op: 'remove_action', action: 'fire' }] }));
    expect(projectGodot(proj.dir)).not.toContain('fire=');
  }, 120_000);

  it('input.edit warns when editing built-in ui_* actions and resets them on remove', async () => {
    const res = json(await call('godot_input_edit', { ops: [{ op: 'add_event', action: 'ui_accept', event: 'E' }] }));
    expect(res.warnings.join(' ')).toMatch(/built-in/);
    expect(projectGodot(proj.dir)).toContain('ui_accept=');
    const reset = json(await call('godot_input_edit', { ops: [{ op: 'remove_action', action: 'ui_accept' }] }));
    expect(reset.warnings.join(' ')).toMatch(/reset to its default/);
    expect(projectGodot(proj.dir)).not.toContain('ui_accept=');
  }, 120_000);

  it('input.edit errors are actionable', async () => {
    expect(errorText(await call('godot_input_edit', { ops: [{ op: 'add_event', action: 'jmp', event: 'Space' }] }))).toContain('Did you mean: jump');
    expect(errorText(await call('godot_input_edit', { ops: [{ op: 'add_event', action: 'jump', event: 'NoSuchKey' }] }))).toMatch(/unknown key.*"Escape"/s);
    expect(errorText(await call('godot_input_edit', { ops: [{ op: 'add_action', action: 'jump' }] }))).toContain('already exists');
  }, 120_000);

  it('autoload.edit adds, reorders and removes autoloads', async () => {
    const added = json(await call('godot_autoload_edit', { op: 'add', name: 'Enemies', path: 'res://enemy.gd', index: 0 }));
    expect(added.autoloads.map((a: { name: string }) => a.name)).toEqual(['Enemies', 'GameState']);
    let text = projectGodot(proj.dir);
    // 4.7 stores autoloads as "*uid://..." like the editor's Autoload tab.
    expect(text).toMatch(/\[autoload\]\n\nEnemies="\*uid:\/\/[a-z0-9]+"\nGameState=/);

    const moved = json(await call('godot_autoload_edit', { op: 'move', name: 'Enemies', index: 1 }));
    expect(moved.autoloads.map((a: { name: string }) => a.name)).toEqual(['GameState', 'Enemies']);
    text = projectGodot(proj.dir);
    expect(text.indexOf('GameState=')).toBeLessThan(text.indexOf('Enemies='));

    const plain = json(await call('godot_autoload_edit', { op: 'add', name: 'Hud', path: 'res://player.tscn', singleton: false }));
    expect(plain.autoloads.find((a: { name: string }) => a.name === 'Hud').singleton).toBe(false);
    expect(projectGodot(proj.dir)).toContain('Hud="res://player.tscn"');

    json(await call('godot_autoload_edit', { op: 'remove', name: 'Enemies' }));
    json(await call('godot_autoload_edit', { op: 'remove', name: 'Hud' }));
    expect(projectGodot(proj.dir)).not.toMatch(/Enemies=|Hud=/);
  }, 120_000);

  it('autoload.edit validates names and paths', async () => {
    expect(errorText(await call('godot_autoload_edit', { op: 'add', name: 'Node2D', path: 'res://enemy.gd' }))).toContain('engine class');
    expect(errorText(await call('godot_autoload_edit', { op: 'add', name: 'Foo', path: 'res://nope.gd' }))).toContain('does not exist');
    expect(errorText(await call('godot_autoload_edit', { op: 'add', name: 'GameState', path: 'res://enemy.gd' }))).toContain('already exists');
    expect(errorText(await call('godot_autoload_edit', { op: 'remove', name: 'GameStat' }))).toContain('Did you mean: GameState');
  }, 120_000);

  it('project.plugins lists, enables and disables plugins', async () => {
    mkdirSync(path.join(proj.dir, 'addons', 'demo'), { recursive: true });
    writeFileSync(path.join(proj.dir, 'addons', 'demo', 'plugin.cfg'), '[plugin]\n\nname="Demo"\ndescription=""\nauthor=""\nversion="1.0"\nscript="demo.gd"\n');
    writeFileSync(path.join(proj.dir, 'addons', 'demo', 'demo.gd'), '@tool\nextends EditorPlugin\n');
    const res = json(await call('godot_project_plugins', { enable: ['demo'] }));
    expect(res.changed).toEqual([{ path: 'res://addons/demo/plugin.cfg', enabled: true }]);
    expect(res.plugins.map((p: { name: string }) => p.name).sort()).toEqual(['Demo', 'Godot MCP']);
    expect(projectGodot(proj.dir)).toContain('enabled=PackedStringArray("res://addons/demo/plugin.cfg", "res://addons/godot_mcp/plugin.cfg")');
    json(await call('godot_project_plugins', { disable: ['Demo'] }));
    expect(projectGodot(proj.dir)).toContain('enabled=PackedStringArray("res://addons/godot_mcp/plugin.cfg")');

    expect(errorText(await call('godot_project_plugins', { disable: ['godot_mcp'] }))).toContain('force');
    expect(errorText(await call('godot_project_plugins', { enable: ['dmo'] }))).toMatch(/no plugin 'dmo'.*Did you mean: demo/s);
  }, 120_000);

  it('project.validate reports a clean project, then broken references and scripts', async () => {
    const clean = json(await call('godot_project_validate', { scope: 'all' }));
    expect(clean.counts.error).toBe(0);
    expect(clean.checked.scenes).toBeGreaterThanOrEqual(2);
    expect(clean.checked.scripts).toBeGreaterThan(3);

    mkdirSync(path.join(proj.dir, 'broken'), { recursive: true });
    writeFileSync(
      path.join(proj.dir, 'broken', 'level.tscn'),
      '[gd_scene format=3]\n\n[ext_resource type="Script" path="res://broken/missing.gd" id="1_a"]\n[ext_resource type="Texture2D" uid="uid://bnotarealuid1" path="res://icon.svg" id="2_b"]\n\n[node name="Level" type="Node2D"]\nscript = ExtResource("1_a")\n',
    );
    writeFileSync(path.join(proj.dir, 'broken', 'bad.gd'), 'extends Node\n\nfunc _ready() -> void:\n\tundefined_function()\n');
    const res = json(await call('godot_project_validate', { path_prefix: 'res://broken' }));
    const kinds = res.issues.map((i: { kind: string }) => i.kind);
    expect(kinds).toContain('missing_dependency');
    expect(kinds).toContain('stale_uid');
    expect(kinds).toContain('script_error');
    const scriptIssue = res.issues.find((i: { kind: string }) => i.kind === 'script_error');
    expect(scriptIssue.path).toBe('res://broken/bad.gd');
    expect(scriptIssue.message).toMatch(/Line 4/);
    expect(scriptIssue.fix_hint).toBeTruthy();
    expect(res.checked.files).toBeLessThan(clean.checked.files + 3);

    // Pagination: limit 1 returns one issue and a next_offset.
    const page = json(await call('godot_project_validate', { path_prefix: 'res://broken', limit: 1 }));
    expect(page.issues).toHaveLength(1);
    expect(page.truncated).toBe(true);
    expect(page.next_offset).toBe(1);

    // deep: loading the scene surfaces the engine's load errors too.
    const deep = json(await call('godot_project_validate', { path_prefix: 'res://broken', scope: 'scenes', deep: true }));
    expect(deep.issues.map((i: { kind: string }) => i.kind)).toContain('load_errors');
  }, 180_000);

  it('project.validate flags broken project settings', async () => {
    const text = projectGodot(proj.dir).replace('GameState="*res://game_state.gd"', 'GameState="*res://gone.gd"');
    writeFileSync(path.join(proj.dir, 'project.godot'), text);
    const res = json(await call('godot_project_validate', { scope: 'project' }));
    expect(res.issues.find((i: { kind: string }) => i.kind === 'autoload').message).toContain('res://gone.gd');
    expect(errorText(await call('godot_project_validate', { scope: 'everything' }))).toMatch(/Invalid option|scope/i);
  }, 120_000);
});

describe.skipIf(!enabled)('project tools (editor)', () => {
  const proj = copySampleProject();
  let client: Awaited<ReturnType<typeof startServer>>;
  const call = async (name: string, args: Record<string, unknown>) => client.callTool({ name, arguments: args });

  beforeAll(async () => {
    importProject(proj.dir);
    client = await startServer({ project: proj.dir, era: 'legacy' });
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
  });

  it('project.set goes through the editor and saves project.godot', async () => {
    const res = json(await call('godot_project_set', { settings: { 'display/window/size/viewport_height': 720 } }));
    expect(res.backend).toBe('editor');
    expect(projectGodot(proj.dir)).toContain('window/size/viewport_height=720');
    // The scene stays clean: project settings are not scene edits.
    const status = json(await call('godot_status', {}));
    expect(status.editor.unsaved_scenes).toEqual([]);
  }, 120_000);

  it('input.edit and autoload.edit go through the editor', async () => {
    const res = json(await call('godot_input_edit', { ops: [{ op: 'add_action', action: 'dash', event: 'Shift' }] }));
    expect(res.backend).toBe('editor');
    expect(projectGodot(proj.dir)).toMatch(/dash=\{/);

    // add with the defaults uses the editor's own Autoload tab path (EditorPlugin.add_autoload_singleton).
    const added = json(await call('godot_autoload_edit', { op: 'add', name: 'Enemies', path: 'res://enemy.gd' }));
    expect(added.autoloads.map((a: { name: string }) => a.name)).toEqual(['GameState', 'Enemies']);
    expect(projectGodot(proj.dir)).toMatch(/Enemies="\*uid:\/\//);
    const moved = json(await call('godot_autoload_edit', { op: 'move', name: 'Enemies', index: 0 }));
    expect(moved.autoloads[0].name).toBe('Enemies');
    json(await call('godot_autoload_edit', { op: 'remove', name: 'Enemies' }));
    expect(projectGodot(proj.dir)).not.toContain('Enemies=');
  }, 120_000);

  it('project.plugins reports the live plugin state and project.validate runs in the editor', async () => {
    const res = json(await call('godot_project_plugins', {}));
    expect(res.backend).toBe('editor');
    expect(res.plugins.find((p: { path: string }) => p.path === 'res://addons/godot_mcp/plugin.cfg').enabled).toBe(true);
    const v = json(await call('godot_project_validate', { scope: 'project' }));
    expect(v.backend).toBe('editor');
    expect(v.counts.error).toBe(0);
  }, 120_000);

  it('left no addon errors in the editor log', async () => {
    const logs = json(await call('godot_editor_logs', { level: 'error' }));
    const ours = logs.entries.filter((e: unknown) => JSON.stringify(e).includes('addons/godot_mcp'));
    expect(ours).toEqual([]);
  });
});
