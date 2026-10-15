/**
 * End-to-end tests against real Godot (skipped when GODOT_BIN isn't set).
 *
 *   GODOT_BIN=/path/to/godot npm run test:e2e
 *
 * Two scenarios, each on a fresh temp copy of examples/sample_project:
 *   1. headless: no editor running; scene edits go through the headless runner;
 *   2. editor: a headless *editor* is launched, the plugin's bridge comes up,
 *      and the same operations go through the live editor instead.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { copySampleProject, errorText, GODOT_BIN, json, killAndWait, startServer } from './helpers.js';

const enabled = Boolean(GODOT_BIN);

/** First import of a fresh copy (creates .godot/, uid caches). */
function importProject(dir: string): void {
  spawnSync(GODOT_BIN!, ['--headless', '--path', dir, '--import'], { timeout: 180_000, stdio: 'ignore' });
}

describe.skipIf(!enabled)('headless backend', () => {
  const proj = copySampleProject();
  let client: Awaited<ReturnType<typeof startServer>>;

  beforeAll(async () => {
    // No manual import here: the server must import a fresh project by itself.
    client = await startServer({ project: proj.dir, era: 'modern' });
  }, 240_000);
  afterAll(async () => {
    await client?.close();
    await proj.cleanup();
  });

  it('reports headless as the scene backend', async () => {
    const status = json(await client.callTool({ name: 'godot_status', arguments: {} }));
    expect(status.editor_connected).toBe(false);
    expect(status.scene_backend).toMatch(/headless/);
  });

  it('reads the scene tree', async () => {
    const tree = json(await client.callTool({ name: 'godot_scene_tree', arguments: { scene: 'res://main.tscn' } }));
    expect(tree.backend).toBe('headless');
    expect(tree.root.path).toBe('.');
    expect(tree.node_count).toBeGreaterThan(1);
  }, 60_000);

  it('adds, sets, reads and removes a node, persisting to the .tscn', async () => {
    const added = json(
      await client.callTool({
        name: 'godot_node_add',
        arguments: { scene: 'res://main.tscn', parent: '.', type: 'Sprite2D', name: 'McpSprite', properties: { position: [10, 20] } },
      }),
    );
    expect(added.path).toBe('McpSprite');

    json(await client.callTool({ name: 'godot_node_set', arguments: { scene: 'res://main.tscn', path: 'McpSprite', properties: { modulate: '#ff0000' } } }));
    const got = json(await client.callTool({ name: 'godot_node_get', arguments: { scene: 'res://main.tscn', path: 'McpSprite', properties: ['position', 'modulate'] } }));
    expect(got.properties.position).toBe('Vector2(10, 20)');
    expect(got.properties.modulate).toMatch(/^Color\(1, 0, 0, 1\)$/);
    expect(readFileSync(path.join(proj.dir, 'main.tscn'), 'utf8')).toContain('McpSprite');

    json(await client.callTool({ name: 'godot_node_remove', arguments: { scene: 'res://main.tscn', path: 'McpSprite' } }));
    expect(readFileSync(path.join(proj.dir, 'main.tscn'), 'utf8')).not.toContain('McpSprite');
  }, 120_000);

  it('sets nested properties (sub-resource fields and vector components)', async () => {
    json(
      await client.callTool({
        name: 'godot_node_add',
        arguments: { scene: 'res://main.tscn', parent: '.', type: 'Sprite2D', name: 'Nested', properties: { material: { new: 'CanvasItemMaterial' } } },
      }),
    );
    const set = json(
      await client.callTool({ name: 'godot_node_set', arguments: { scene: 'res://main.tscn', path: 'Nested', properties: { 'material:blend_mode': 'add', 'position:x': 7 } } }),
    );
    expect(set.changed['position:x']).toBe(7);
    // Node2D.rotation is a 32-bit float: 1.6 reads back as 1.60000002384186, which is not a
    // clamp and must not warn (MCP_TEST_LOG: speed_scale=1.6 did).
    const rot = json(await client.callTool({ name: 'godot_node_set', arguments: { scene: 'res://main.tscn', path: 'Nested', properties: { rotation: 1.6, skew: 0.3 } } }));
    expect(rot.warnings).toBeUndefined();
    const got = json(await client.callTool({ name: 'godot_node_get', arguments: { scene: 'res://main.tscn', path: 'Nested', properties: ['position'] } }));
    expect(got.properties.position).toBe('Vector2(7, 0)');
    // Without a filter only non-default values are listed (plus how many were left out),
    // and the embedded material shows only what differs from a fresh CanvasItemMaterial.
    const all = json(await client.callTool({ name: 'godot_node_get', arguments: { scene: 'res://main.tscn', path: 'Nested' } }));
    expect(all.properties.position).toBe('Vector2(7, 0)');
    expect(all.properties).not.toHaveProperty('visible'); // true is the default
    expect(all.defaults_omitted).toBeGreaterThan(10);
    expect(all.properties.material).toMatchObject({ class: 'CanvasItemMaterial', embedded: true, properties: { blend_mode: 1 } });
    expect(Object.keys(all.properties.material.properties)).toEqual(['blend_mode']);
    expect(all.properties.material.defaults_omitted).toBeGreaterThan(0);
    // ["*"] still lists everything, defaults included.
    const star = json(await client.callTool({ name: 'godot_node_get', arguments: { scene: 'res://main.tscn', path: 'Nested', properties: ['*'] } }));
    expect(star.properties.visible).toBe(true);
    expect(star.defaults_omitted).toBeUndefined();
    // CanvasItemMaterial.BLEND_MODE_ADD == 1, saved inside the scene's sub-resource.
    expect(readFileSync(path.join(proj.dir, 'main.tscn'), 'utf8')).toMatch(/blend_mode = 1/);
    const bad = await client.callTool({ name: 'godot_node_set', arguments: { scene: 'res://main.tscn', path: 'Nested', properties: { 'texture:width': 3 } } });
    expect(errorText(bad)).toMatch(/texture.*empty|has no sub-properties|not found/i);
  }, 120_000);

  it('creates a scene and validates scripts', async () => {
    json(await client.callTool({ name: 'godot_scene_create', arguments: { path: 'res://levels/level_1.tscn', root_type: 'Node2D' } }));
    expect(existsSync(path.join(proj.dir, 'levels', 'level_1.tscn'))).toBe(true);

    const bad = json(await client.callTool({ name: 'godot_script_validate', arguments: { source: 'extends Node\nfunc _ready():\n\tvar x = \n' } }));
    expect(bad.valid).toBe(false);
    expect(bad.errors.length).toBeGreaterThan(0);

    // files.write runs validation automatically for .gd files.
    const written = json(await client.callTool({ name: 'godot_files_write', arguments: { path: 'res://ok.gd', content: 'extends Node\n\nfunc _ready() -> void:\n\tpass\n' } }));
    expect(written.validation?.valid).toBe(true);
  }, 120_000);

  it('runs the game as a process and captures output', async () => {
    const run = json(await client.callTool({ name: 'godot_run_start', arguments: { mode: 'process', headless: true, quit_after_frames: 30 } }));
    expect(run.run_id).toBeTruthy();
    // Wait for it to exit by itself.
    for (let i = 0; i < 40; i++) {
      const out = json(await client.callTool({ name: 'godot_run_output', arguments: { run_id: run.run_id } }));
      if (!out.running) {
        expect(out.lines.length).toBeGreaterThan(0);
        return;
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    throw new Error('game did not exit');
  }, 60_000);
});

describe.skipIf(!enabled)('editor backend', () => {
  const proj = copySampleProject();
  let client: Awaited<ReturnType<typeof startServer>>;

  beforeAll(async () => {
    importProject(proj.dir);
    client = await startServer({ project: proj.dir, era: 'legacy' });
    const launched = json(await client.callTool({ name: 'godot_editor_launch', arguments: { headless: true, wait_seconds: 90 } }));
    expect(launched.editor ?? launched.connected).toBeTruthy();
  }, 240_000);

  afterAll(async () => {
    await client?.close();
    // Stop the editor we launched (its pid is in the session file) and wait
    // for it to exit: on Windows its open file handles would otherwise make
    // deleting the temp project fail with EPERM.
    try {
      const session = JSON.parse(readFileSync(path.join(proj.dir, '.godot', 'godot_mcp', 'session.json'), 'utf8'));
      await killAndWait(session.pid);
    } catch {
      // no session file: the editor never came up
    }
    await proj.cleanup();
  });

  it('routes scene edits through the live editor and saves', async () => {
    const status = json(await client.callTool({ name: 'godot_status', arguments: {} }));
    expect(status.editor_connected).toBe(true);

    json(await client.callTool({ name: 'godot_scene_open', arguments: { path: 'res://main.tscn' } }));
    const added = json(await client.callTool({ name: 'godot_node_add', arguments: { parent: '.', type: 'Label', name: 'McpLabel', properties: { text: 'hello' } } }));
    expect(added.backend).toBe('editor');

    const s2 = json(await client.callTool({ name: 'godot_status', arguments: {} }));
    expect(s2.editor.unsaved_scenes).toContain('res://main.tscn');

    json(await client.callTool({ name: 'godot_scene_save', arguments: {} }));
    expect(readFileSync(path.join(proj.dir, 'main.tscn'), 'utf8')).toContain('McpLabel');
  }, 120_000);

  it('keeps the editor connection when a command-line import runs on the same project', async () => {
    // `godot --import` / `--export-*` start a throwaway editor that loads our plugin; it must
    // not overwrite or delete the real editor's session file.
    const sessionFile = path.join(proj.dir, '.godot', 'godot_mcp', 'session.json');
    const before = readFileSync(sessionFile, 'utf8');
    importProject(proj.dir);
    expect(existsSync(sessionFile)).toBe(true);
    expect(readFileSync(sessionFile, 'utf8')).toBe(before);
    const status = json(await client.callTool({ name: 'godot_status', arguments: {} }));
    expect(status.editor_connected).toBe(true);
  }, 240_000);

  it('reads editor logs', async () => {
    const logs = json(await client.callTool({ name: 'godot_editor_logs', arguments: {} }));
    expect(Array.isArray(logs.entries)).toBe(true);
  });
});
