/**
 * End-to-end tests for the animation tools (anim.read, anim.edit,
 * anim.tree_read, anim.tree) against real Godot; skipped without GODOT_BIN.
 *
 *   GODOT_BIN=/path/to/godot npx vitest run test/e2e/animation.test.ts
 *
 * Both suites work on a fresh copy of examples/sample_project, whose
 * anim/anim_demo.tscn has a Sprite2D, a Node3D "Rig", an AnimationPlayer
 * (default library: idle, walk; autoplay idle) and an AnimationTree with a
 * state machine (Start -> Idle). anim/moves.tres is an external library.
 */

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { copySampleProject, errorText, GODOT_BIN, json, killAndWait, startServer } from './helpers.js';

const SCENE = 'res://anim/anim_demo.tscn';

describe.skipIf(!GODOT_BIN)('animation (headless)', () => {
  const proj = copySampleProject();
  let client: Awaited<ReturnType<typeof startServer>>;
  const call = async (name: string, args: Record<string, unknown>) => client.callTool({ name, arguments: args });
  const sceneText = () => readFileSync(path.join(proj.dir, 'anim', 'anim_demo.tscn'), 'utf8');

  beforeAll(async () => {
    client = await startServer({ project: proj.dir, era: 'modern' });
  }, 240_000);
  afterAll(async () => {
    await client?.close();
    await proj.cleanup();
  });

  it('reads the player (auto-found) and one animation\'s keys', async () => {
    const list = json(await call('godot_anim_read', { scene: SCENE }));
    expect(list.backend).toBe('headless');
    expect(list.player).toBe('AnimationPlayer');
    expect(list.autoplay).toBe('idle');
    expect(list.libraries[0].animations.map((a: any) => a.name)).toEqual(['idle', 'walk']);

    const idle = json(await call('godot_anim_read', { scene: SCENE, animation: 'idle', max_keys: 1 }));
    const track = idle.animation.tracks[0];
    expect(track).toMatchObject({ index: 0, type: 'value', path: 'Sprite2D:modulate', interpolation: 'linear', key_count: 2, keys_truncated: true });
    expect(track.keys).toEqual([{ time: 0, value: 'Color(1, 1, 1, 1)', transition: 1 }]);
    expect(idle.animation.loop).toBe('linear');
  }, 120_000);

  it('node.set warns when the property is keyed by an animation', async () => {
    // The dogfood test's enemies went invisible: an animation re-applied modulate after the
    // tool set it. node.set now names the animation that will override the value.
    const r = json(await call('godot_node_set', { scene: SCENE, path: 'Sprite2D', properties: { modulate: '#ffffff', position: [1, 2], visible: true } }));
    // idle keys modulate and walk keys position; visible is not animated, so no third warning.
    expect(r.warnings, JSON.stringify(r.warnings)).toHaveLength(2);
    expect(r.warnings[0]).toMatch(/'modulate' is keyed by the animation 'idle' of AnimationPlayer/);
    expect(r.warnings[1]).toMatch(/'position' is keyed by the animation 'walk'/);
  }, 60_000);

  it('reads an AnimationLibrary .tres', async () => {
    const lib = json(await call('godot_anim_read', { library: 'res://anim/moves.tres', animation: 'jump' }));
    expect(lib.library).toBe('res://anim/moves.tres');
    expect(lib.animation.tracks[0].keys[0].value).toEqual({ method: 'queue_free', args: [] });
  }, 60_000);

  it('applies a multi-op edit and saves it into the .tscn', async () => {
    const res = json(
      await call('godot_anim_edit', {
        scene: SCENE,
        ops: [
          { op: 'create', animation: 'jump', length: 0.6, loop: 'pingpong' },
          { op: 'add_track', animation: 'jump', path: 'Sprite2D:scale' },
          { op: 'insert_key', animation: 'jump', track: 0, time: 0, value: [1, 1] },
          { op: 'insert_key', animation: 'jump', track: 'Sprite2D:scale', time: 0.3, value: { x: 1.5, y: 0.5 }, transition: 0.5 },
          { op: 'add_track', animation: 'idle', path: 'Sprite2D:visible' },
          { op: 'insert_key', animation: 'idle', track: 1, time: 0.2, value: false },
          { op: 'remove_key', animation: 'idle', track: 0, time: 0.5 },
          { op: 'rename', animation: 'idle', to: 'rest' },
          { op: 'create', animation: 'moves/dash', length: 0.2 },
          { op: 'add_track', animation: 'moves/dash', type: 'method', path: '.' },
          { op: 'insert_key', animation: 'moves/dash', track: 0, time: 0.1, value: { method: 'queue_free', args: [] } },
          { op: 'add_track', animation: 'walk', type: 'rotation_3d', path: 'Rig' },
          { op: 'insert_key', animation: 'walk', track: 1, time: 0.1, value: [0, 90, 0] },
        ],
      }),
    );
    expect(res.saved).toBe(true);
    expect(res.results[3]).toMatchObject({ op: 'insert_key', key: 1, value: 'Vector2(1.5, 0.5)' });
    expect(res.results[8].created_library).toBe('moves');
    expect(res.results[12].value).toMatch(/^Quaternion\(0, 0\.70710/);
    // The rename touches names the AnimationTree uses, so the caller is warned.
    expect(res.warnings.join(' ')).toMatch(/AnimationTree/);

    const text = sceneText();
    expect(text).toContain('&"jump"');
    expect(text).toContain('libraries/moves');
    expect(text).toContain('autoplay = &"rest"'); // autoplay follows the rename
    const rest = json(await call('godot_anim_read', { scene: SCENE, animation: 'rest' }));
    expect(rest.animation.tracks.map((t: any) => t.key_count)).toEqual([1, 1]);
    expect(rest.animation.tracks[1].update_mode).toBe('discrete'); // bool property
  }, 120_000);

  it('rejects bad edits with actionable messages and leaves the file alone', async () => {
    const before = sceneText();
    const prop = errorText(await call('godot_anim_edit', { scene: SCENE, animation: 'walk', ops: [{ op: 'add_track', path: 'Sprite2D:modulat' }] }));
    expect(prop).toMatch(/Did you mean|Similar properties: modulate/);
    const node = errorText(await call('godot_anim_edit', { scene: SCENE, animation: 'walk', ops: [{ op: 'add_track', path: 'Sprit2D:modulate' }] }));
    expect(node).toMatch(/Did you mean: Sprite2D/);
    // A failing op later in the list must not apply the earlier ones.
    const later = errorText(
      await call('godot_anim_edit', { scene: SCENE, ops: [{ op: 'create', animation: 'ok' }, { op: 'set', animation: 'nope', length: 1 }] }),
    );
    expect(later).toMatch(/no animation 'nope'/);
    expect(sceneText()).toBe(before);
    // allow_missing keeps a path that does not exist (yet).
    const kept = json(await call('godot_anim_edit', { scene: SCENE, animation: 'walk', allow_missing: true, ops: [{ op: 'add_track', path: 'Later:modulate' }] }));
    expect(kept.results[0].path).toBe('Later:modulate');
  }, 120_000);

  it('builds a state machine and a nested blend space, then reads them back', async () => {
    const sm = json(
      await call('godot_anim_tree', {
        scene: SCENE,
        ops: [
          { op: 'add_state', name: 'Walk', animation: 'walk' },
          { op: 'add_state', name: 'Move', type: 'blend_space_1d' },
          { op: 'add_transition', from: 'Idle', to: 'Walk', advance_condition: 'moving', xfade_time: 0.2 },
          { op: 'add_transition', from: 'Walk', to: 'Idle', switch_mode: 'at_end', advance_mode: 'auto' },
          { op: 'set_end', name: 'Walk' },
          { op: 'set_start', name: 'Walk' },
        ],
      }),
    );
    expect(sm.graph.start).toEqual(['Walk']);
    expect(sm.graph.transitions.find((t: any) => t.from === 'Walk' && t.to === 'End')).toMatchObject({ switch_mode: 'at_end', advance_mode: 'auto' });

    const bs = json(
      await call('godot_anim_tree', {
        scene: SCENE,
        nested: 'Move',
        ops: [
          { op: 'add_blend_point', animation: 'rest', position: 0 },
          { op: 'add_blend_point', animation: 'walk', position: 1 },
          { op: 'add_blend_point', animation: 'walk', position: -1 },
          { op: 'remove_blend_point', name: 'walk2' },
          { op: 'set', properties: { min_space: -2, blend_mode: 'Discrete', value_label: 'speed' } },
        ],
      }),
    );
    expect(bs.graph.points.map((p: any) => p.name)).toEqual(['rest', 'walk']);
    expect(bs.graph.blend_mode).toBe('discrete');

    const read = json(await call('godot_anim_tree_read', { scene: SCENE }));
    expect(read.root.type).toBe('state_machine');
    expect(read.root.states.map((s: any) => s.name).sort()).toEqual(['Idle', 'Move', 'Walk']);
    expect(read.root.states.find((s: any) => s.name === 'Move').node.min_space).toBe(-2);
    expect(read.parameters['parameters/conditions/moving']).toBe(false);
    // The playback object scripts use (MCP_TEST_LOG: it was left out).
    expect(read.parameters['parameters/playback']).toMatchObject({ object: 'AnimationNodeStateMachinePlayback' });
    expect(read.parameters['parameters/playback'].use).toMatch(/\.travel\("<state>"\)/);
    expect(read.parameters['parameters/Move/playback']).toBeUndefined(); // a blend space has none
    expect(sceneText()).toContain('AnimationNodeBlendSpace1D');
  }, 120_000);

  it('reports tree errors helpfully', async () => {
    const missing = errorText(await call('godot_anim_tree', { scene: SCENE, ops: [{ op: 'add_state', name: 'Run', animation: 'Walk' }] }));
    expect(missing).toMatch(/Did you mean: walk/);
    const start = errorText(await call('godot_anim_tree', { scene: SCENE, ops: [{ op: 'remove_state', name: 'Start' }] }));
    expect(start).toMatch(/cannot be removed/);
    const nested = errorText(await call('godot_anim_tree', { scene: SCENE, nested: 'move', ops: [{ op: 'set', properties: { snap: 0.5 } }] }));
    expect(nested).toMatch(/Did you mean: Move/);
  }, 120_000);

  // icon.svg imports as a 32x32 texture, so a 2x2 grid gives 16x16 cells.
  it('cuts a sprite sheet into SpriteFrames on a new AnimatedSprite2D and saves it', async () => {
    json(await call('godot_node_add', { scene: SCENE, parent: '.', type: 'AnimatedSprite2D', name: 'Hero' }));
    const res = json(
      await call('godot_anim_frames', {
        scene: SCENE,
        node: 'Hero',
        ops: [
          { op: 'add', animation: 'walk', texture: 'res://icon.svg', hframes: 2, vframes: 2, speed: 8 },
          { op: 'add_frames', animation: 'walk', texture: 'res://icon.svg', hframes: 2, vframes: 2, cells: [[1, 1]], duration: 2 },
          { op: 'add', animation: 'idle', texture: 'res://icon.svg', frame_size: [16, 16], start: 1, count: 2, loop: false },
        ],
      }),
    );
    expect(res.saved).toBe(true);
    // A brand-new SpriteFrames starts with an empty "default"; it is dropped once real
    // animations exist, and the node's animation follows to a real one.
    expect(res.created_frames).toBe(true);
    expect(res.note).toMatch(/default/);
    expect(res.animation).toBe('walk');
    expect(res.results[0]).toMatchObject({ op: 'add', added: 4, cell_size: [16, 16] });
    const walk = res.animations.find((a: any) => a.name === 'walk');
    expect(walk).toMatchObject({ atlas: 'res://icon.svg', frame_count: 5, speed: 8, loop: true });
    expect(walk.regions[4]).toEqual([16, 16, 16, 16]);
    expect(walk.durations).toEqual([1, 1, 1, 1, 2]);
    const idle = res.animations.find((a: any) => a.name === 'idle');
    expect(idle).toMatchObject({ frame_count: 2, loop: false, regions: [[16, 0, 16, 16], [0, 16, 16, 16]] });
    expect(res.animations.map((a: any) => a.name)).not.toContain('default');
    const text = sceneText();
    expect(text).toContain('[sub_resource type="SpriteFrames"');
    expect(text).toContain('Rect2(16, 16, 16, 16)');

    // No ops = the compact summary.
    const read = json(await call('godot_anim_frames', { scene: SCENE, node: 'Hero' }));
    expect(read.animations.map((a: any) => a.name).sort()).toEqual(['idle', 'walk']);

    // Renaming the current/autoplay animation carries the node's references along.
    json(await call('godot_node_set', { scene: SCENE, path: 'Hero', properties: { autoplay: 'walk' } }));
    const renamed = json(
      await call('godot_anim_frames', { scene: SCENE, node: 'Hero', ops: [{ op: 'rename', animation: 'walk', to: 'run' }, { op: 'set', animation: 'run', speed: 12 }] }),
    );
    expect(renamed).toMatchObject({ animation: 'run', autoplay: 'run' });
    expect(renamed.animations.find((a: any) => a.name === 'run').speed).toBe(12);
  }, 120_000);

  it('edits a SpriteFrames .tres, and resource.read shows its frames', async () => {
    json(await call('godot_resource_create', { path: 'res://anim/hero_frames.tres', type: 'SpriteFrames' }));
    const res = json(
      await call('godot_anim_frames', {
        path: 'res://anim/hero_frames.tres',
        ops: [
          { op: 'rename', animation: 'default', to: 'idle' },
          { op: 'add_frames', animation: 'idle', texture: ['res://icon.svg', 'res://icon.svg'] },
        ],
      }),
    );
    expect(res.saved).toBe(true);
    expect(res.animations[0]).toMatchObject({ name: 'idle', frame_count: 2, frames: ['res://icon.svg', 'res://icon.svg'] });

    // resource.read used to show only "animations": [{...}] with embedded atlases hidden.
    const read = json(await call('godot_resource_read', { path: 'res://anim/hero_frames.tres' }));
    expect(read.edit_with).toBe('godot_anim_frames');
    expect(read.properties.animations[0]).toMatchObject({ name: 'idle', frame_count: 2 });
  }, 120_000);

  it('rejects bad SpriteFrames edits with actionable messages', async () => {
    const before = sceneText();
    const notSprite = errorText(await call('godot_anim_frames', { scene: SCENE, node: 'Sprite2D', ops: [{ op: 'add', animation: 'a' }] }));
    expect(notSprite).toMatch(/not an AnimatedSprite2D/);
    expect(notSprite).toMatch(/Hero/);
    const missing = errorText(await call('godot_anim_frames', { scene: SCENE, node: 'Hero', ops: [{ op: 'rename', animation: 'rn', to: 'x' }] }));
    expect(missing).toMatch(/ops\[0\] \(rename\): no animation 'rn'/);
    const later = errorText(
      await call('godot_anim_frames', {
        scene: SCENE,
        node: 'Hero',
        ops: [{ op: 'add', animation: 'ok' }, { op: 'add_frames', animation: 'ok', texture: 'res://icon.svg', hframes: 2, cells: [7] }],
      }),
    );
    expect(later).toMatch(/ops\[1\] \(add_frames\)/);
    expect(sceneText()).toBe(before);
    const both = errorText(await call('godot_anim_frames', { scene: SCENE, node: 'Hero', path: 'res://anim/hero_frames.tres' }));
    expect(both).toMatch(/node|path/);
  }, 120_000);
});

describe.skipIf(!GODOT_BIN)('animation (editor)', () => {
  const proj = copySampleProject();
  let client: Awaited<ReturnType<typeof startServer>>;
  const call = async (name: string, args: Record<string, unknown>) => client.callTool({ name, arguments: args });

  beforeAll(async () => {
    spawnSync(GODOT_BIN!, ['--headless', '--path', proj.dir, '--import'], { timeout: 180_000, stdio: 'ignore' });
    client = await startServer({ project: proj.dir, era: 'legacy' });
    const launched = json(await call('godot_editor_launch', { headless: true, wait_seconds: 90 }));
    expect(launched.editor ?? launched.connected).toBeTruthy();
  }, 300_000);

  afterAll(async () => {
    await client?.close();
    try {
      const session = JSON.parse(readFileSync(path.join(proj.dir, '.godot', 'godot_mcp', 'session.json'), 'utf8'));
      await killAndWait(session.pid);
    } catch {
      // the editor never came up
    }
    await proj.cleanup();
  });

  it('edits animations in the live editor and saves them with the scene', async () => {
    json(await call('godot_scene_open', { path: SCENE }));
    const res = json(
      await call('godot_anim_edit', {
        animation: 'walk',
        ops: [
          { op: 'set', length: 1.2, loop: 'linear' },
          { op: 'insert_key', track: 'Sprite2D:position', time: 0.4, value: [16, -8] },
          { op: 'create', animation: 'spin', length: 0.5 },
        ],
      }),
    );
    expect(res.backend).toBe('editor');
    expect(res.saved).toBe(false);
    const read = json(await call('godot_anim_read', { animation: 'walk' }));
    expect(read.animation).toMatchObject({ length: 1.2, loop: 'linear' });
    expect(read.animation.tracks[0].key_count).toBe(3);

    const status = json(await call('godot_status', {}));
    expect(status.editor.unsaved_scenes).toContain(SCENE);
    json(await call('godot_scene_save', {}));
    const text = readFileSync(path.join(proj.dir, 'anim', 'anim_demo.tscn'), 'utf8');
    expect(text).toContain('&"spin"');
    expect(text).toContain('Vector2(16, -8)');
  }, 180_000);

  it('edits the AnimationTree in the live editor', async () => {
    const res = json(
      await call('godot_anim_tree', {
        ops: [
          { op: 'add_state', name: 'Walk', animation: 'walk', position: [400, 100] },
          { op: 'add_transition', from: 'Idle', to: 'Walk', advance_expression: 'velocity.length() > 0.1' },
        ],
      }),
    );
    expect(res.backend).toBe('editor');
    const read = json(await call('godot_anim_tree_read', { parameters: false }));
    expect(read.root.transitions.find((t: any) => t.to === 'Walk').advance_expression).toBe('velocity.length() > 0.1');
    json(await call('godot_scene_save', {}));
    expect(readFileSync(path.join(proj.dir, 'anim', 'anim_demo.tscn'), 'utf8')).toContain('velocity.length() > 0.1');
  }, 180_000);

  it('builds SpriteFrames in the live editor', async () => {
    json(await call('godot_node_add', { parent: '.', type: 'AnimatedSprite2D', name: 'Hero' }));
    const res = json(
      await call('godot_anim_frames', { node: 'Hero', ops: [{ op: 'add', animation: 'walk', texture: 'res://icon.svg', hframes: 2, vframes: 2 }] }),
    );
    expect(res.backend).toBe('editor');
    expect(res.animations).toEqual([expect.objectContaining({ name: 'walk', frame_count: 4 })]);
    const read = json(await call('godot_anim_frames', { node: 'Hero' }));
    expect(read.animation).toBe('walk');
    json(await call('godot_scene_save', {}));
    expect(readFileSync(path.join(proj.dir, 'anim', 'anim_demo.tscn'), 'utf8')).toContain('[sub_resource type="AtlasTexture"');
  }, 180_000);
});
