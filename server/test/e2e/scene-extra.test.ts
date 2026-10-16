/**
 * End-to-end tests for the scene extras (node.instance, scene.inherit,
 * node.find, node.move, node.groups, scene.close) and batch.apply, against
 * real Godot (skipped when GODOT_BIN isn't set):
 *
 *   GODOT_BIN=/path/to/godot npx vitest run test/e2e/scene-extra.test.ts
 *
 * Each suite works on its own temp copy of examples/sample_project.
 */

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { copySampleProject, errorText, GODOT_BIN, json, killAndWait, startServer } from './helpers.js';

type Client = Awaited<ReturnType<typeof startServer>>;

const enabled = Boolean(GODOT_BIN);
const read = (dir: string, file: string) => readFileSync(path.join(dir, file), 'utf8');

describe.skipIf(!enabled)('scene extras: headless', () => {
  const proj = copySampleProject();
  let client: Client;
  const call = (name: string, args: Record<string, unknown>) => client.callTool({ name, arguments: args });

  beforeAll(async () => {
    client = await startServer({ project: proj.dir, era: 'modern' });
  }, 240_000);
  afterAll(async () => {
    await client?.close();
    await proj.cleanup();
  });

  it('node.instance saves a linked sub-scene with Editable Children', async () => {
    const r = json(
      await call('godot_node_instance', { scene: 'res://main.tscn', instance: 'res://player.tscn', parent: 'Enemies', name: 'P2', editable_children: true, properties: { position: [5, 6] } }),
    );
    expect(r).toMatchObject({ path: 'Enemies/P2', instance: 'res://player.tscn', editable_children: true, saved: true, backend: 'headless' });
    // The applied overrides are echoed back, read from the node.
    expect(r.properties).toEqual({ position: 'Vector2(5, 6)' });
    const tscn = read(proj.dir, 'main.tscn');
    // Linked instance (not copied nodes): no Sprite2D node under P2 is written.
    expect(tscn).toMatch(/\[node name="P2" parent="Enemies"[^\]]*instance=ExtResource\(/);
    expect(tscn).not.toContain('parent="Enemies/P2"');
    expect(tscn).toContain('[editable path="Enemies/P2"]');
    expect(tscn).toContain('position = Vector2(5, 6)');
  }, 120_000);

  it('node.instance refuses cycles', async () => {
    const self = errorText(await call('godot_node_instance', { scene: 'res://main.tscn', instance: 'res://main.tscn' }));
    expect(self).toMatch(/BAD_PARAMS.*cycle/);
    // player.tscn is instanced by main.tscn, so main inside player is a cycle too.
    const indirect = errorText(await call('godot_node_instance', { scene: 'res://player.tscn', instance: 'res://main.tscn' }));
    expect(indirect).toMatch(/cycle \(res:\/\/main\.tscn contains res:\/\/player\.tscn\)/);
  }, 60_000);

  it('scene.inherit writes an inherited scene', async () => {
    const r = json(await call('godot_scene_inherit', { path: 'res://chars/hero.tscn', base: 'res://player.tscn' }));
    expect(r).toMatchObject({ path: 'res://chars/hero.tscn', base: 'res://player.tscn', root_name: 'Hero', opened: false });
    const tscn = read(proj.dir, 'chars/hero.tscn');
    expect(tscn).toMatch(/\[ext_resource type="PackedScene"[^\]]*path="res:\/\/player\.tscn" id="([^"]+)"\]/);
    expect(tscn).toMatch(/\[node name="Hero"[^\]]*instance=ExtResource\(/);
    expect(tscn).not.toContain('parent=');
    const tree = json(await call('godot_scene_tree', { scene: 'res://chars/hero.tscn' }));
    expect(tree.root.inherits).toBe('res://player.tscn');
    expect(tree.root.child_count).toBe(2);
    expect(errorText(await call('godot_scene_inherit', { path: 'res://chars/hero.tscn', base: 'res://player.tscn' }))).toMatch(/^CONFLICT/);
    expect(errorText(await call('godot_scene_inherit', { path: 'res://x.tscn', base: 'res://nope.tscn' }))).toMatch(/NOT_FOUND.*Existing scenes/);
  }, 120_000);

  it('refuses to remove, rename or move nodes inherited from the base scene', async () => {
    // Godot cannot store the removal/rename of a base node in an inherited scene: it would
    // come back on the next load, so these must fail instead of reporting success.
    const scene = 'res://chars/hero.tscn';
    for (const [tool, args] of [
      ['godot_node_remove', { path: 'Sprite2D' }],
      ['godot_node_rename', { path: 'Sprite2D', name: 'Body' }],
      ['godot_node_reparent', { path: 'Sprite2D', new_parent: 'CollisionShape2D' }],
      ['godot_node_move', { path: 'Sprite2D', index: -1 }],
    ] as const) {
      expect(errorText(await call(tool, { scene, ...args }))).toMatch(/BAD_PARAMS.*inherited from the base scene 'res:\/\/player\.tscn'/);
    }
    // Property overrides and nodes added in the inherited scene itself still work.
    json(await call('godot_node_set', { scene, path: 'Sprite2D', properties: { visible: false } }));
    json(await call('godot_node_add', { scene, type: 'Node2D', name: 'Hat' }));
    json(await call('godot_node_rename', { scene, path: 'Hat', name: 'Cap' }));
    json(await call('godot_node_remove', { scene, path: 'Cap' }));
    const tscn = read(proj.dir, 'chars/hero.tscn');
    expect(tscn).toContain('visible = false');
    expect(tscn).not.toContain('Cap');
  }, 120_000);

  it('node.find filters by type, name, group and property', async () => {
    const byType = json(await call('godot_node_find', { scene: 'res://main.tscn', type: 'Node2D' }));
    // Node2D subclasses match too (the CharacterBody2D Player instance).
    expect(byType.matches.map((m: { path: string }) => m.path)).toEqual(expect.arrayContaining(['.', 'Player', 'Enemies']));
    const byName = json(await call('godot_node_find', { scene: 'res://main.tscn', name: 'cam*' }));
    expect(byName.matches).toEqual([{ path: 'Camera2D', type: 'Camera2D' }]);
    const byGroup = json(await call('godot_node_find', { scene: 'res://main.tscn', group: 'timers' }));
    expect(byGroup.total).toBe(1);
    const byValue = json(await call('godot_node_find', { scene: 'res://main.tscn', property: 'text', value: 'Score: 0' }));
    expect(byValue.matches[0].path).toBe('Label');
    const limited = json(await call('godot_node_find', { scene: 'res://main.tscn', type: 'Node', limit: 2 }));
    expect(limited.matches.length).toBe(2);
    expect(limited.truncated).toBe(true);
    expect(errorText(await call('godot_node_find', { scene: 'res://main.tscn' }))).toMatch(/at least one filter/);
    expect(errorText(await call('godot_node_find', { scene: 'res://main.tscn', type: 'Sprit2D' }))).toMatch(/Did you mean: Sprite2D/);
  }, 120_000);

  it('node.move reorders siblings', async () => {
    const r = json(await call('godot_node_move', { scene: 'res://main.tscn', path: 'Timer', index: 0 }));
    expect(r.index).toBe(0);
    expect(r.order[0]).toBe('Timer');
    const tscn = read(proj.dir, 'main.tscn');
    expect(tscn.indexOf('name="Timer"')).toBeLessThan(tscn.indexOf('name="Player"'));
    const last = json(await call('godot_node_move', { scene: 'res://main.tscn', path: 'Timer', index: -1 }));
    expect(last.order.at(-1)).toBe('Timer');
    expect(errorText(await call('godot_node_move', { scene: 'res://main.tscn', path: 'Timer', index: 42 }))).toMatch(/out of range.*0\.\.\d/);
  }, 120_000);

  it('node.groups adds and removes persistent groups', async () => {
    const r = json(await call('godot_node_groups', { scene: 'res://main.tscn', path: 'Label', add: ['ui', 'hud'], remove: ['nope'] }));
    expect(r.groups).toEqual(['ui', 'hud']);
    expect(r.unchanged).toEqual(["not in 'nope'"]);
    expect(read(proj.dir, 'main.tscn')).toMatch(/name="Label"[^\]]*groups=\["hud", "ui"\]/);
    json(await call('godot_node_groups', { scene: 'res://main.tscn', path: 'Timer', remove: ['timers'] }));
    expect(read(proj.dir, 'main.tscn')).not.toContain('"timers"');
    expect(errorText(await call('godot_node_groups', { scene: 'res://main.tscn', path: 'Label' }))).toMatch(/"add" and\/or "remove"/);
  }, 120_000);

  it('scene.close needs the editor', async () => {
    expect(errorText(await call('godot_scene_close', {}))).toMatch(/^EDITOR_NOT_CONNECTED/);
  });

  it('batch.apply applies dependent ops and saves once', async () => {
    const r = json(
      await call('godot_batch_apply', {
        scene: 'res://main.tscn',
        ops: [
          { method: 'node.add', params: { type: 'Area2D', name: 'Hit' } },
          { method: 'godot_node_set', params: { path: 'Hit', properties: { position: [1, 2] } } },
          { method: 'node.add', params: { parent: 'Hit', type: 'CollisionShape2D' } },
          { method: 'signal.connect', params: { from: 'Hit', signal: 'body_entered', create_method: true } },
          { method: 'node.reparent', params: { path: 'Hit', new_parent: 'Enemies' } },
        ],
      }),
    );
    expect(r.count).toBe(5);
    expect(r.results.map((x: { method: string }) => x.method)).toEqual(['node.add', 'node.set', 'node.add', 'signal.connect', 'node.reparent']);
    expect(r.results[4].path).toBe('Enemies/Hit');
    // signal.connect's own "method" (the handler) is kept as "handler", since "method" names the op.
    expect(r.results[3].handler).toBe('_on_hit_body_entered');
    const tscn = read(proj.dir, 'main.tscn');
    expect(tscn).toContain('[node name="Hit" type="Area2D" parent="Enemies"');
    expect(tscn).toContain('[node name="CollisionShape2D" type="CollisionShape2D" parent="Enemies/Hit"');
    expect(tscn).toContain('[connection signal="body_entered" from="Enemies/Hit" to="." method="_on_hit_body_entered"]');
    expect(read(proj.dir, 'main.gd')).toContain('func _on_hit_body_entered(body: Node2D) -> void:');
  }, 120_000);

  it('batch.apply is all-or-nothing and names the failing op', async () => {
    const before = read(proj.dir, 'main.tscn');
    const err = errorText(
      await call('godot_batch_apply', {
        scene: 'res://main.tscn',
        ops: [
          { method: 'node.add', params: { type: 'Node2D', name: 'Tmp' } },
          { method: 'node.set', params: { path: 'Tmp', properties: { positon: [1, 2] } } },
        ],
      }),
    );
    expect(err).toMatch(/^NOT_FOUND: batch\.apply: ops\[1\] \(node\.set\) failed, so nothing was applied/);
    expect(err).toContain('"failed_index":1');
    expect(read(proj.dir, 'main.tscn')).toBe(before);
    const unknown = errorText(await call('godot_batch_apply', { scene: 'res://main.tscn', ops: [{ method: 'node.ad', params: {} }] }));
    expect(unknown).toMatch(/Did you mean: node\.add.*Allowed methods: .*signal\.connect/);
    const otherScene = errorText(
      await call('godot_batch_apply', { scene: 'res://main.tscn', ops: [{ method: 'node.add', params: { scene: 'res://player.tscn', type: 'Node' } }] }),
    );
    expect(otherScene).toMatch(/batch edits one scene/);
  }, 120_000);
});

/** First import of a fresh copy (creates .godot/, uid caches). */
function importProject(dir: string): void {
  spawnSync(GODOT_BIN!, ['--headless', '--path', dir, '--import'], { timeout: 180_000, stdio: 'ignore' });
}

describe.skipIf(!enabled)('scene extras: editor', () => {
  const proj = copySampleProject();
  let client: Client;
  const call = (name: string, args: Record<string, unknown>) => client.callTool({ name, arguments: args });

  beforeAll(async () => {
    importProject(proj.dir);
    client = await startServer({ project: proj.dir, era: 'legacy' });
    const launched = json(await call('godot_editor_launch', { headless: true, wait_seconds: 90 }));
    expect(launched.editor ?? launched.connected).toBeTruthy();
  }, 300_000);

  afterAll(async () => {
    await client?.close();
    try {
      const session = JSON.parse(read(proj.dir, '.godot/godot_mcp/session.json'));
      await killAndWait(session.pid);
    } catch {
      // the editor never came up
    }
    await proj.cleanup();
  });

  it('instances, reorders and groups through the editor, then saves', async () => {
    json(await call('godot_scene_open', { path: 'res://main.tscn' }));
    const inst = json(await call('godot_node_instance', { instance: 'res://player.tscn', name: 'P2', editable_children: true }));
    expect(inst).toMatchObject({ backend: 'editor', saved: false, editable_children: true, path: 'P2' });
    const moved = json(await call('godot_node_move', { path: 'P2', index: 0 }));
    expect(moved.order[0]).toBe('P2');
    json(await call('godot_node_groups', { path: 'P2', add: ['heroes'] }));
    const found = json(await call('godot_node_find', { group: 'heroes' }));
    expect(found.matches).toEqual([{ path: 'P2', type: 'CharacterBody2D', instance: 'res://player.tscn' }]);
    json(await call('godot_scene_save', {}));
    const tscn = read(proj.dir, 'main.tscn');
    expect(tscn).toMatch(/\[node name="P2" parent="\."[^\]]*groups=\["heroes"\][^\]]*instance=ExtResource\(/);
    expect(tscn.indexOf('name="P2"')).toBeLessThan(tscn.indexOf('name="Player"'));
    expect(tscn).toContain('[editable path="P2"]');
  }, 120_000);

  it('batch.apply commits one action; a failing batch changes nothing', async () => {
    const ok = json(
      await call('godot_batch_apply', {
        ops: [
          { method: 'node.add', params: { type: 'Node2D', name: 'Spawner' } },
          { method: 'node.set', params: { path: 'Spawner', properties: { position: [3, 4] } } },
          { method: 'node.reparent', params: { path: 'Spawner', new_parent: 'Enemies' } },
        ],
      }),
    );
    expect(ok).toMatchObject({ backend: 'editor', saved: false, count: 3 });
    const status = json(await call('godot_status', {}));
    expect(status.editor.unsaved_scenes).toContain('res://main.tscn');
    const got = json(await call('godot_node_get', { path: 'Enemies/Spawner', properties: ['position'] }));
    expect(got.properties.position).toBe('Vector2(3, 4)');

    const err = errorText(
      await call('godot_batch_apply', {
        ops: [
          { method: 'node.add', params: { type: 'Node2D', name: 'Ghost' } },
          { method: 'node.remove', params: { path: 'NoSuchNode' } },
        ],
      }),
    );
    expect(err).toMatch(/ops\[1\] \(node\.remove\) failed, so nothing was applied/);
    const tree = json(await call('godot_scene_tree', {}));
    expect(JSON.stringify(tree)).not.toContain('Ghost');
    json(await call('godot_scene_save', {}));
    const tscn = read(proj.dir, 'main.tscn');
    expect(tscn).toContain('[node name="Spawner" type="Node2D" parent="Enemies"');
    expect(tscn).not.toContain('Ghost');
  }, 120_000);

  it('scene.inherit opens the new scene; scene.close guards unsaved changes', async () => {
    const r = json(await call('godot_scene_inherit', { path: 'res://chars/hero.tscn', base: 'res://player.tscn' }));
    expect(r).toMatchObject({ opened: true, backend: 'editor' });
    expect(read(proj.dir, 'chars/hero.tscn')).toMatch(/\[node name="Hero"[^\]]*instance=ExtResource\(/);
    let status = json(await call('godot_status', {}));
    expect(status.editor.edited_scene).toBe('res://chars/hero.tscn');

    json(await call('godot_node_add', { type: 'Node', name: 'Unsaved' }));
    const conflict = errorText(await call('godot_scene_close', {}));
    expect(conflict).toMatch(/^CONFLICT: .*unsaved changes.*save: true.*discard: true/);
    const closed = json(await call('godot_scene_close', { discard: true }));
    expect(closed).toMatchObject({ closed: 'res://chars/hero.tscn', discarded_changes: true, saved: false });
    status = json(await call('godot_status', {}));
    expect(status.editor.open_scenes).not.toContain('res://chars/hero.tscn');
    expect(read(proj.dir, 'chars/hero.tscn')).not.toContain('Unsaved');
    // The same guard applies in the editor (the dogfood test removed a base node there,
    // got a success, and found the node back after save + reopen).
    json(await call('godot_scene_open', { path: 'res://chars/hero.tscn' }));
    expect(errorText(await call('godot_node_remove', { path: 'Sprite2D' }))).toMatch(/BAD_PARAMS.*inherited from the base scene/);
    json(await call('godot_scene_close', { discard: true }));

    expect(errorText(await call('godot_scene_close', { path: 'res://player.tscn' }))).toMatch(/NOT_FOUND: .*not open/);
  }, 120_000);

  it('keeps a scene unsaved after saving a sub-scene it instances, and says when `scene` switched tabs', async () => {
    json(await call('godot_scene_open', { path: 'res://main.tscn' }));
    json(await call('godot_node_set', { path: 'Label', properties: { text: 'dirty' } }));
    const other = json(await call('godot_node_set', { scene: 'res://player.tscn', path: 'Sprite2D', properties: { visible: false } }));
    expect(other).toMatchObject({ scene: 'res://player.tscn', switched_from: 'res://main.tscn' });
    expect(other.note).toMatch(/switched from res:\/\/main\.tscn/);
    // Saving player.tscn makes Godot reload its instances in main.tscn when that tab becomes
    // current again, and the reload used to clear main's unsaved state (Godot 4.7.2 bug).
    json(await call('godot_scene_close', { save: true }));
    let status = json(await call('godot_status', {}));
    expect(status.editor.edited_scene).toBe('res://main.tscn');
    expect(status.editor.unsaved_scenes).toContain('res://main.tscn');
    // Same through a plain switch back (scene.open) after scene.save.
    json(await call('godot_node_set', { scene: 'res://player.tscn', path: 'Sprite2D', properties: { visible: true } }));
    json(await call('godot_scene_save', {}));
    json(await call('godot_scene_open', { path: 'res://main.tscn' }));
    status = json(await call('godot_status', {}));
    expect(status.editor.unsaved_scenes).toContain('res://main.tscn');
    json(await call('godot_scene_close', { path: 'res://player.tscn' }));
    json(await call('godot_scene_close', { path: 'res://main.tscn', discard: true }));
  }, 120_000);

  it('scene.save_as retargets the tab in godot_status; scene.close then reports discarded changes', async () => {
    json(await call('godot_scene_open', { path: 'res://main.tscn' }));
    json(await call('godot_scene_save_as', { path: 'res://levels/main_alt.tscn' }));
    // Godot's own open-scenes list keeps the old path after EditorInterface.save_scene_as;
    // the plugin reports the tab's real path (core/editor_scenes.gd).
    let status = json(await call('godot_status', {}));
    expect(status.editor.edited_scene).toBe('res://levels/main_alt.tscn');
    expect(status.editor.open_scenes).toContain('res://levels/main_alt.tscn');
    expect(status.editor.open_scenes).not.toContain('res://main.tscn');

    json(await call('godot_node_add', { type: 'Node', name: 'DirtyAlt' }));
    status = json(await call('godot_status', {}));
    expect(status.editor.unsaved_scenes).toContain('res://levels/main_alt.tscn');
    const closed = json(await call('godot_scene_close', { discard: true }));
    expect(closed).toMatchObject({ closed: 'res://levels/main_alt.tscn', discarded_changes: true });
    expect(read(proj.dir, 'levels/main_alt.tscn')).not.toContain('DirtyAlt');
  }, 120_000);
});
