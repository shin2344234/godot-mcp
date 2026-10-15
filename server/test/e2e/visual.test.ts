/**
 * E2E: visual.shader_graph / visual.shader_graph_read / visual.layout /
 * visual.shader_check (addons/godot_mcp/ops/visual_ops.gd), headless and
 * through a live headless editor. Skipped without GODOT_BIN.
 */

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { copySampleProject, errorText, GODOT_BIN, json, killAndWait, startServer } from './helpers.js';

const enabled = Boolean(GODOT_BIN);

function importProject(dir: string): void {
  spawnSync(GODOT_BIN!, ['--headless', '--path', dir, '--import'], { timeout: 180_000, stdio: 'ignore' });
}

const BAD_SHADER = 'shader_type spatial;\nvoid fragment() {\n  ALBEDO = vec3(1.0) * missing_value;\n}\n';

describe.skipIf(!enabled)('visual (headless)', () => {
  const proj = copySampleProject();
  let client: Awaited<ReturnType<typeof startServer>>;
  const call = async (name: string, args: Record<string, unknown>) => client.callTool({ name, arguments: args });

  beforeAll(async () => {
    importProject(proj.dir);
    client = await startServer({ project: proj.dir });
  }, 240_000);
  afterAll(async () => {
    await client?.close();
    proj.cleanup();
  });

  it('creates a visual shader graph and reads it back', async () => {
    const r = json(
      await call('godot_visual_shader_graph', {
        path: 'res://shaders/glow.tres',
        create: true,
        mode: 'spatial',
        ops: [
          { op: 'add_node', type: 'ColorConstant', id: 2, properties: { constant: '#ff0000' } },
          { op: 'connect', from: 2, from_port: 0, to: 0, to_port: 'albedo' },
          { op: 'add_node', type: 'Input', properties: { input_name: 'time' } },
          { op: 'add_node', type: 'FloatOp', id: 10, properties: { operator: 'Multiply' }, inputs: { '1': 2.5 } },
          { op: 'connect', from: 3, to: 10, to_port: 0 },
          { op: 'connect', from: 10, to: 0, to_port: 'emission' },
        ],
      }),
    );
    expect(r.created).toBe(true);
    expect(r.uid).toMatch(/^uid:\/\//);
    expect(r.results.map((x: { id?: number }) => x.id)).toEqual([2, undefined, 3, 10, undefined, undefined]);
    const g = json(await call('godot_visual_shader_graph_read', { path: 'res://shaders/glow.tres' }));
    const frag = g.types.fragment;
    expect(frag.connections).toEqual(
      expect.arrayContaining([
        { from: 2, from_port: 0, to: 0, to_port: 0 },
        { from: 3, from_port: 0, to: 10, to_port: 0 },
        { from: 10, from_port: 0, to: 0, to_port: 5 },
      ]),
    );
    const op = frag.nodes.find((n: { id: number }) => n.id === 10);
    expect(op).toMatchObject({ class: 'VisualShaderNodeFloatOp', properties: { operator: 2 }, inputs: { '1': 2.5 } });
    // The generated shader compiles.
    const check = json(await call('godot_visual_shader_check', { path: 'res://shaders/glow.tres' }));
    expect(check).toMatchObject({ valid: true, source: 'visual_shader' });
  }, 120_000);

  it('edits, disconnects and removes nodes; failures leave the file untouched', async () => {
    const before = readFileSync(path.join(proj.dir, 'shaders', 'glow.tres'), 'utf8');
    const bad = errorText(
      await call('godot_visual_shader_graph', {
        path: 'res://shaders/glow.tres',
        ops: [
          { op: 'set', id: 2, properties: { constant: '#00ff00' } },
          { op: 'connect', from: 2, from_port: 4, to: 0, to_port: 1 },
        ],
      }),
    );
    expect(bad).toMatch(/ops\[1\].*1 output port/);
    expect(readFileSync(path.join(proj.dir, 'shaders', 'glow.tres'), 'utf8')).toBe(before);

    const r = json(
      await call('godot_visual_shader_graph', {
        path: 'res://shaders/glow.tres',
        ops: [
          { op: 'set', id: 2, properties: { constant: '#00ff00' }, position: [-600, 0] },
          { op: 'disconnect', from: 10, to: 0, to_port: 5 },
          { op: 'remove_node', id: 10 },
        ],
      }),
    );
    expect(r.results[2]).toMatchObject({ op: 'remove_node', id: 10, connections_removed: 1 });
    const g = json(await call('godot_visual_shader_graph_read', { path: 'res://shaders/glow.tres', shader_type: 'fragment' }));
    expect(g.types.fragment.nodes.map((n: { id: number }) => n.id)).toEqual([0, 2, 3]);
    expect(g.types.fragment.connections).toEqual([{ from: 2, from_port: 0, to: 0, to_port: 0 }]);
  }, 120_000);

  it('explains bad graph ops', async () => {
    const typeErr = errorText(await call('godot_visual_shader_graph', { path: 'res://shaders/glow.tres', ops: [{ op: 'add_node', type: 'ColourConstant' }] }));
    expect(typeErr).toMatch(/ColorConstant/);
    const input = errorText(await call('godot_visual_shader_graph', { path: 'res://shaders/glow.tres', ops: [{ op: 'add_node', type: 'Input', properties: { input_name: 'UVV' } }] }));
    expect(input).toMatch(/Did you mean: uv/);
    const port = errorText(await call('godot_visual_shader_graph', { path: 'res://shaders/glow.tres', ops: [{ op: 'connect', from: 2, to: 0, to_port: 'albdo' }] }));
    expect(port).toMatch(/0 Albedo, 1 Alpha/);
    const kinds = errorText(
      await call('godot_visual_shader_graph', {
        path: 'res://shaders/glow.tres',
        ops: [
          { op: 'add_node', type: 'TransformConstant', id: 30 },
          { op: 'connect', from: 30, to: 0, to_port: 0 },
        ],
      }),
    );
    expect(kinds).toMatch(/incompatible port types.*transform/);
    const missing = errorText(await call('godot_visual_shader_graph', { path: 'res://shaders/none.tres', ops: [] }));
    expect(missing).toMatch(/create: true/);
  }, 120_000);

  it('checks shader code and reports compiler errors with lines', async () => {
    const bad = json(await call('godot_visual_shader_check', { code: BAD_SHADER }));
    expect(bad.valid).toBe(false);
    expect(bad.errors[0]).toMatchObject({ line: 3 });
    expect(bad.errors[0].message).toMatch(/missing_value/);
    const good = json(await call('godot_visual_shader_check', { code: 'shader_type canvas_item;\nuniform float k = 1.0;\nvoid fragment() { COLOR.r = k; }\n' }));
    expect(good).toMatchObject({ valid: true, mode: 'canvas_item', uniforms: [{ name: 'k', type: 'float' }] });
    const none = errorText(await call('godot_visual_shader_check', {}));
    expect(none).toMatch(/code.*path/);
  }, 60_000);

  it('applies Control layout presets in a scene file', async () => {
    json(await call('godot_scene_create', { path: 'res://ui/hud.tscn', root_type: 'Control' }));
    json(await call('godot_node_add', { scene: 'res://ui/hud.tscn', parent: '.', type: 'Panel', name: 'Box', properties: { size: [100, 50] } }));
    const r = json(await call('godot_visual_layout', { scene: 'res://ui/hud.tscn', path: 'Box', preset: 'center', resize_mode: 'keep_size' }));
    expect(r).toMatchObject({ layout_mode: 'anchors', anchors: [0.5, 0.5, 0.5, 0.5], offsets: [-50, -25, 50, 25], grow: [2, 2], saved: true });
    const full = json(
      await call('godot_visual_layout', { scene: 'res://ui/hud.tscn', path: 'Box', preset: 'Full Rect', margin: 8, size_flags: { horizontal: 'expand_fill' }, custom_minimum_size: [10, 20] }),
    );
    expect(full.offsets).toEqual([8, 8, -8, -8]);
    const text = readFileSync(path.join(proj.dir, 'ui', 'hud.tscn'), 'utf8');
    expect(text).toContain('anchors_preset = 15');
    expect(text).toContain('size_flags_horizontal = 3');
    expect(text).toContain('custom_minimum_size = Vector2(10, 20)');
  }, 120_000);

  it('rejects layout on non-Controls and unknown presets', async () => {
    const n2d = errorText(await call('godot_visual_layout', { scene: 'res://main.tscn', path: '.', preset: 'center' }));
    expect(n2d).toMatch(/Control/);
    const preset = errorText(await call('godot_visual_layout', { scene: 'res://ui/hud.tscn', path: 'Box', preset: 'fullrect' }));
    expect(preset).toMatch(/Did you mean: full_rect/);
  }, 60_000);
});

describe.skipIf(!enabled)('visual (editor)', () => {
  const proj = copySampleProject();
  let client: Awaited<ReturnType<typeof startServer>>;
  const call = async (name: string, args: Record<string, unknown>) => client.callTool({ name, arguments: args });

  beforeAll(async () => {
    importProject(proj.dir);
    client = await startServer({ project: proj.dir });
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

  it('applies a layout preset as an editor edit and saves it', async () => {
    json(await call('godot_scene_create', { path: 'res://ui/menu.tscn', root_type: 'Control' }));
    json(await call('godot_scene_open', { path: 'res://ui/menu.tscn' }));
    json(await call('godot_node_add', { parent: '.', type: 'Button', name: 'Play' }));
    const r = json(await call('godot_visual_layout', { path: 'Play', preset: 'bottom_wide', margin: 4 }));
    expect(r.backend).toBe('editor');
    expect(r.saved).toBe(false);
    expect(r.anchors).toEqual([0, 1, 1, 1]);
    json(await call('godot_scene_save', {}));
    const text = readFileSync(path.join(proj.dir, 'ui', 'menu.tscn'), 'utf8');
    expect(text).toContain('anchors_preset = 12');
    expect(text).toContain('anchor_top = 1.0');
  }, 120_000);

  it('edits a visual shader and checks shaders in the editor', async () => {
    const r = json(
      await call('godot_visual_shader_graph', {
        path: 'res://shaders/ed.tres',
        create: true,
        mode: 'canvas_item',
        ops: [
          { op: 'add_node', type: 'ColorConstant', properties: { constant: '#336699' } },
          { op: 'connect', from: 2, to: 0, to_port: 'color' },
        ],
      }),
    );
    expect(r.backend).toBe('editor');
    expect(r.uid).toMatch(/^uid:\/\//);
    // Second call goes through the rehearsal-on-a-copy path (existing, cached resource).
    const bad = errorText(await call('godot_visual_shader_graph', { path: 'res://shaders/ed.tres', ops: [{ op: 'remove_node', id: 2 }, { op: 'remove_node', id: 0 }] }));
    expect(bad).toMatch(/Output node/);
    const g = json(await call('godot_visual_shader_graph_read', { path: 'res://shaders/ed.tres' }));
    expect(g.types.fragment.nodes.map((n: { id: number }) => n.id)).toEqual([0, 2]);
    const check = json(await call('godot_visual_shader_check', { code: BAD_SHADER }));
    expect(check.backend).toBe('editor');
    expect(check.valid).toBe(false);
    expect(check.errors[0].line).toBe(3);
  }, 120_000);
});
