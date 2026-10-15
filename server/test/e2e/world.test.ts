/**
 * World building e2e tests (skipped without GODOT_BIN):
 *
 *   GODOT_BIN=/path/to/godot npx vitest run test/e2e/world.test.ts
 *
 * Uses the sample assets in examples/sample_project/world/:
 *   tiles.png (64x16, three opaque 16px tiles + one transparent), tileset.tres
 *   (atlas source 0, physics layer 0 on the stone tile, terrain "grass"),
 *   mesh_library.tres (items 0 floor, 1 wall), level_2d.tscn (TileMapLayer "Ground",
 *   NavigationRegion2D "Nav" with a 256px outline and a 64px StaticBody2D rock) and
 *   level_3d.tscn (GridMap "Grid", NavigationRegion3D "Nav" with a 20x20 floor and a block).
 *
 * Two suites on separate temp copies: headless (runner process per call) and editor
 * (a headless editor with the plugin; edits go through the undo history and need
 * scene.save). Undo itself is covered at the GDScript level: the ChangeSets are
 * replayed do -> undo -> redo and compared (see the report of the world worker).
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { copySampleProject, errorText, GODOT_BIN, json, killAndWait, startServer } from './helpers.js';

const enabled = Boolean(GODOT_BIN);
type Client = Awaited<ReturnType<typeof startServer>>;

const call = async (client: Client, name: string, args: Record<string, unknown>) => json(await client.callTool({ name, arguments: args }));
const fail = async (client: Client, name: string, args: Record<string, unknown>) => errorText(await client.callTool({ name, arguments: args }));

const L2 = 'res://world/level_2d.tscn';
const L3 = 'res://world/level_3d.tscn';

describe.skipIf(!enabled)('world: headless backend', () => {
  const proj = copySampleProject();
  let client: Client;

  beforeAll(async () => {
    client = await startServer({ project: proj.dir, era: 'modern' });
  }, 240_000);
  afterAll(async () => {
    await client?.close();
    await proj.cleanup();
  });

  it('grid.read describes a TileMapLayer and its TileSet', async () => {
    const r = await call(client, 'godot_grid_read', { scene: L2, path: 'Ground' });
    expect(r.backend).toBe('headless');
    expect(r.type).toBe('TileMapLayer');
    expect(r.tile_set).toBe('res://world/tileset.tres');
    expect(r.used_cells).toBe(6);
    expect(r.used_rect).toEqual({ x: 0, y: 0, w: 4, h: 2 });
    expect(r.sources[0]).toMatchObject({ id: 0, type: 'atlas', texture: 'res://world/tiles.png', tile_count: 3, tiles: [[0, 0], [1, 0], [2, 0]] });
    expect(r.terrain_sets[0].terrains).toEqual(['grass']);
    expect(r.cells[0]).toEqual({ x: 0, y: 0, source: 0, atlas: [0, 0], alt: 0 });

    const region = await call(client, 'godot_grid_read', { scene: L2, path: 'Ground', region: { x: 0, y: 1, w: 4, h: 1 } });
    expect(region.cells.map((c: any) => c.atlas)).toEqual([[1, 0], [2, 0]]);
    const summary = await call(client, 'godot_grid_read', { scene: L2, path: 'Ground', summary_only: true });
    expect(summary.cells).toBeUndefined();
  }, 120_000);

  it('grid.read describes a GridMap and its MeshLibrary', async () => {
    const r = await call(client, 'godot_grid_read', { scene: L3, path: 'Grid' });
    expect(r.type).toBe('GridMap');
    expect(r.items).toEqual([{ id: 0, name: 'floor' }, { id: 1, name: 'wall' }]);
    expect(r.used_cells).toBe(4);
    expect(r.cells).toContainEqual({ x: 0, y: 1, z: 1, item: 1, orientation: 16 });
  }, 60_000);

  it('grid.read explains wrong node types', async () => {
    const msg = await fail(client, 'godot_grid_read', { scene: L2, path: 'Nav' });
    expect(msg).toMatch(/NavigationRegion2D, not a TileMapLayer or GridMap/);
    expect(msg).toContain('Ground');
  }, 60_000);

  it('grid.edit paints tiles and saves the scene', async () => {
    const r = await call(client, 'godot_grid_edit', {
      scene: L2,
      path: 'Ground',
      ops: [
        { op: 'set', cells: [[5, 5], [6, 5]], source: 0, atlas: [1, 0] },
        { op: 'erase', cells: [[0, 0]] },
        { op: 'fill_rect', rect: { x: 10, y: 10, w: 3, h: 2 }, source: 0, atlas: [2, 0] },
      ],
    });
    expect(r).toMatchObject({ cells_changed: 9, used_cells: 13, undo: 'cells', saved: true });
    const after = await call(client, 'godot_grid_read', { scene: L2, path: 'Ground', region: { x: 5, y: 5, w: 2, h: 1 } });
    expect(after.cells).toEqual([
      { x: 5, y: 5, source: 0, atlas: [1, 0], alt: 0 },
      { x: 6, y: 5, source: 0, atlas: [1, 0], alt: 0 },
    ]);

    const terrain = await call(client, 'godot_grid_edit', { scene: L2, path: 'Ground', ops: [{ op: 'terrain', cells: [[20, 20], [21, 20], [20, 21]], terrain: 0 }] });
    expect(terrain).toMatchObject({ cells_changed: 3, undo: 'snapshot' });

    const cleared = await call(client, 'godot_grid_edit', { scene: L2, path: 'Ground', ops: [{ op: 'clear' }] });
    expect(cleared.used_cells).toBe(0);
    expect((await call(client, 'godot_grid_read', { scene: L2, path: 'Ground', summary_only: true })).used_cells).toBe(0);
  }, 120_000);

  it('grid.edit validates tiles, items and ops', async () => {
    const badTile = await fail(client, 'godot_grid_edit', { scene: L2, path: 'Ground', ops: [{ op: 'set', cells: [[0, 0]], source: 0, atlas: [3, 0] }] });
    expect(badTile).toMatch(/no tile at atlas \[3,0\]/);
    expect(badTile).toContain('[[0,0],[1,0],[2,0]]');
    const badSource = await fail(client, 'godot_grid_edit', { scene: L2, path: 'Ground', ops: [{ op: 'set', cells: [[0, 0]], source: 7 }] });
    expect(badSource).toMatch(/no source 7.*Source ids: 0/);
    const badItem = await fail(client, 'godot_grid_edit', { scene: L3, path: 'Grid', ops: [{ op: 'set', cells: [[0, 0, 0]], item: 9 }] });
    expect(badItem).toMatch(/no item 9.*0 = floor, 1 = wall/);
    const terrain3d = await fail(client, 'godot_grid_edit', { scene: L3, path: 'Grid', ops: [{ op: 'terrain', cells: [[0, 0, 0]], terrain: 0 }] });
    expect(terrain3d).toMatch(/only for TileMapLayer/);
    const tooMany = await fail(client, 'godot_grid_edit', { scene: L2, path: 'Ground', ops: [{ op: 'fill_rect', rect: { x: 0, y: 0, w: 200, h: 200 }, source: 0 }] });
    expect(tooMany).toMatch(/more than 10000 cells/);
  }, 120_000);

  it('grid.edit paints a GridMap', async () => {
    const r = await call(client, 'godot_grid_edit', {
      scene: L3,
      path: 'Grid',
      ops: [
        { op: 'fill_rect', rect: { x: 0, y: 0, z: 5, w: 4, h: 1, d: 2 }, item: 1, orientation: 16 },
        { op: 'erase', cells: [[0, 0, 0]] },
      ],
    });
    expect(r).toMatchObject({ cells_changed: 9, used_cells: 11 });
    const read = await call(client, 'godot_grid_read', { scene: L3, path: 'Grid', region: { x: 0, y: 0, z: 5, w: 1, h: 1, d: 1 } });
    expect(read.cells).toEqual([{ x: 0, y: 0, z: 5, item: 1, orientation: 16 }]);
  }, 120_000);

  it('tileset.edit creates a TileSet from a texture', async () => {
    const r = await call(client, 'godot_tileset_edit', {
      path: 'res://world/generated.tres',
      create: true,
      tile_size: [16, 16],
      ops: [
        { op: 'add_atlas', texture: 'res://world/tiles.png' },
        { op: 'add_physics_layer', collision_layer: 2 },
        { op: 'set_collision', source: 0, tiles: [[2, 0]] },
        { op: 'add_terrain_set' },
        { op: 'add_terrain', name: 'dirt' },
        { op: 'set_terrain', source: 0, tiles: [[1, 0]], terrain: 0, peering: { all: 0 } },
        { op: 'add_custom_data', name: 'damage', type: 'float' },
      ],
    });
    // Only the three opaque tiles of the 4x1 atlas are created.
    expect(r.ops[0]).toMatchObject({ op: 'add_atlas', source: 0, grid: [4, 1], tiles_created: 3 });
    expect(r.custom_data).toEqual([{ name: 'damage', type: 'float' }]);
    const text = readFileSync(path.join(proj.dir, 'world', 'generated.tres'), 'utf8');
    expect(text).toMatch(/^\[gd_resource type="TileSet" format=3 uid="uid:\/\//);
    expect(text).toContain('2:0/0/physics_layer_0/polygon_0/points = PackedVector2Array(-8, -8, 8, -8, 8, 8, -8, 8)');
    expect(text).toContain('1:0/0/terrains_peering_bit/right_side = 0');
  }, 120_000);

  it('tileset.edit rejects bad calls without touching the file', async () => {
    const before = readFileSync(path.join(proj.dir, 'world', 'tileset.tres'), 'utf8');
    expect(await fail(client, 'godot_tileset_edit', { path: 'res://world/tileset.tres', create: true })).toMatch(/already exists/);
    const partial = await fail(client, 'godot_tileset_edit', {
      path: 'res://world/tileset.tres',
      ops: [{ op: 'add_physics_layer' }, { op: 'set_terrain', source: 0, tiles: [[3, 0]], terrain: 0 }],
    });
    expect(partial).toMatch(/ops\[1\] \(set_terrain\): the atlas has no tile at \[3, 0\]/);
    expect(readFileSync(path.join(proj.dir, 'world', 'tileset.tres'), 'utf8')).toBe(before);
    expect(await fail(client, 'godot_tileset_edit', { path: 'res://world/nope.tres', ops: [{ op: 'add_physics_layer' }] })).toMatch(/create: true/);
  }, 120_000);

  it('navigation.bake bakes 2D and 3D regions headless', async () => {
    const r2 = await call(client, 'godot_navigation_bake', { scene: L2 });
    expect(r2).toMatchObject({ path: 'Nav', type: 'NavigationRegion2D', vertices: 8, polygons: 4, parser: 'headless', saved: true });
    expect(readFileSync(path.join(proj.dir, 'world', 'level_2d.tscn'), 'utf8')).toMatch(/polygons = .*PackedInt32Array\(/);
    const r3 = await call(client, 'godot_navigation_bake', { scene: L3, path: 'Nav' });
    expect(r3.type).toBe('NavigationRegion3D');
    expect(r3.polygons).toBeGreaterThan(4);

    expect(await fail(client, 'godot_navigation_bake', { scene: L3, outline: [[0, 0], [1, 0], [1, 1]] })).toMatch(/only applies to NavigationRegion2D/);
    expect(await fail(client, 'godot_navigation_bake', { scene: 'res://main.tscn' })).toMatch(/no NavigationRegion2D\/3D/);
  }, 120_000);

  it('navigation.path finds a path around the obstacle', async () => {
    const p2 = await call(client, 'godot_navigation_path', { scene: L2, from: [10, 10], to: [250, 250] });
    expect(p2.reached).toBe(true);
    // A straight line would cross the 64px rock in the middle; the path bends around it.
    expect(p2.points.length).toBeGreaterThan(2);
    const p3 = await call(client, 'godot_navigation_path', { scene: L3, from: [-8, 0, 12], to: [8, 0, 28] });
    expect(p3.reached).toBe(true);
    expect(await fail(client, 'godot_navigation_path', { scene: 'res://main.tscn', from: [0, 0], to: [1, 1] })).toMatch(/navigation\.bake/);
  }, 120_000);
});

/** First import of a fresh copy (creates .godot/, uid caches). */
function importProject(dir: string): void {
  spawnSync(GODOT_BIN!, ['--headless', '--path', dir, '--import'], { timeout: 180_000, stdio: 'ignore' });
}

describe.skipIf(!enabled)('world: editor backend', () => {
  const proj = copySampleProject();
  let client: Client;

  beforeAll(async () => {
    importProject(proj.dir);
    client = await startServer({ project: proj.dir, era: 'legacy' });
    const launched = await call(client, 'godot_editor_launch', { headless: true, wait_seconds: 90 });
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
    await proj.cleanup();
  });

  it('grid.edit goes through the editor and is saved by scene.save', async () => {
    await call(client, 'godot_scene_open', { path: L2 });
    const r = await call(client, 'godot_grid_edit', { path: 'Ground', ops: [{ op: 'set', cells: [[7, 7]], source: 0, atlas: [2, 0] }] });
    expect(r).toMatchObject({ backend: 'editor', saved: false, cells_changed: 1 });
    const status = await call(client, 'godot_status', {});
    expect(status.editor.unsaved_scenes).toContain(L2);
    const read = await call(client, 'godot_grid_read', { path: 'Ground', region: { x: 7, y: 7, w: 1, h: 1 } });
    expect(read.cells).toEqual([{ x: 7, y: 7, source: 0, atlas: [2, 0], alt: 0 }]);

    const before = readFileSync(path.join(proj.dir, 'world', 'level_2d.tscn'), 'utf8');
    await call(client, 'godot_scene_save', {});
    expect(readFileSync(path.join(proj.dir, 'world', 'level_2d.tscn'), 'utf8')).not.toBe(before);
  }, 120_000);

  it('navigation.bake uses the engine parser in the editor', async () => {
    const r = await call(client, 'godot_navigation_bake', { path: 'Nav' });
    // Same counts as the headless parser for this scene.
    expect(r).toMatchObject({ backend: 'editor', parser: 'engine', vertices: 8, polygons: 4, saved: false });
    const p = await call(client, 'godot_navigation_path', { from: [10, 10], to: [250, 250] });
    expect(p.reached).toBe(true);

    await call(client, 'godot_scene_open', { path: L3 });
    const r3 = await call(client, 'godot_navigation_bake', { path: 'Nav' });
    expect(r3.parser).toBe('engine');
    expect(r3.polygons).toBeGreaterThan(4);
    const g = await call(client, 'godot_grid_edit', { path: 'Grid', ops: [{ op: 'fill_rect', rect: { x: 0, y: 0, z: 3, w: 2, h: 1, d: 2 }, item: 0 }] });
    expect(g.cells_changed).toBe(4);
    await call(client, 'godot_scene_save', {});
    expect(readFileSync(path.join(proj.dir, 'world', 'level_3d.tscn'), 'utf8')).toMatch(/polygons = .*PackedInt32Array\(/);
  }, 180_000);

  it('tileset.edit edits the cached TileSet the open maps use', async () => {
    await call(client, 'godot_scene_open', { path: L2 });
    const r = await call(client, 'godot_tileset_edit', { path: 'res://world/tileset.tres', ops: [{ op: 'add_custom_data', name: 'speed', type: 'float' }] });
    expect(r.backend).toBe('editor');
    expect(readFileSync(path.join(proj.dir, 'world', 'tileset.tres'), 'utf8')).toContain('custom_data_layer_0/name = "speed"');
    // The open scene's TileMapLayer shares the edited instance.
    const read = await call(client, 'godot_grid_read', { path: 'Ground', summary_only: true });
    expect(read.custom_data).toEqual([{ name: 'speed', type: 'float' }]);
    expect(existsSync(path.join(proj.dir, 'world', 'tileset.tres'))).toBe(true);
  }, 120_000);
});
