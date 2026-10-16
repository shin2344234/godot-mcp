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
    // A real summary: tile counts, no coordinate lists.
    expect(summary.sources[0].tile_count).toBe(3);
    expect(summary.sources[0].tiles).toBeUndefined();
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
    // Terrain by name over a rect (no hand-typed cell lists), plus cells in the same op.
    const rect = await call(client, 'godot_grid_edit', {
      scene: L2,
      path: 'Ground',
      ops: [{ op: 'terrain', rect: { x: 30, y: 30, w: 4, h: 3 }, cells: [[40, 40]], terrain: 'grass' }],
    });
    expect(rect.cells_changed).toBe(13);
    const painted = await call(client, 'godot_grid_read', { scene: L2, path: 'Ground', region: { x: 30, y: 30, w: 4, h: 3 } });
    expect(painted.cells).toHaveLength(12);
    expect(await fail(client, 'godot_grid_edit', { scene: L2, path: 'Ground', ops: [{ op: 'terrain', rect: { x: 0, y: 0, w: 2, h: 2 }, terrain: 'lava' }] })).toMatch(
      /no terrain named 'lava'.*set 0: 0 = grass/,
    );
    const erased = await call(client, 'godot_grid_edit', { scene: L2, path: 'Ground', ops: [{ op: 'erase', rect: { x: 30, y: 30, w: 4, h: 3 } }] });
    expect(erased.cells_changed).toBe(12);

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
    // JSON numbers arrive in Godot as floats; messages still print the integers sent.
    const notInt = await fail(client, 'godot_grid_edit', { scene: L2, path: 'Ground', ops: [{ op: 'terrain', cells: [[0, 18, 5]], terrain: 0 }] });
    expect(notInt).toContain('cell [0,18,5] is not an integer [x, y] coordinate');
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
    // The atlas this call created lists its tiles (what the caller paints with next).
    expect(r.sources[0].tiles).toEqual([[0, 0], [1, 0], [2, 0]]);

    // The new file has a uid, so scenes reference it by uid and resource.deps reports it.
    const deps = await call(client, 'godot_resource_deps', { path: 'res://world/generated.tres' });
    expect(deps.uid).toMatch(/^uid:\/\//);
    expect(text).toContain(`uid="${deps.uid}"`);
  }, 120_000);

  it('tileset.edit sets one-way collision, navigation, occlusion, per-tile values, alternatives and animation', async () => {
    const r = await call(client, 'godot_tileset_edit', {
      path: 'res://world/generated.tres',
      ops: [
        { op: 'set_collision', source: 0, tiles: [[0, 0]], polygon: [[-8, -8], [8, -8], [8, -4], [-8, -4]], one_way: true, one_way_margin: 2 },
        { op: 'add_navigation_layer', layers: 3 },
        { op: 'set_navigation', source: 0, tiles: [[1, 0]] },
        { op: 'add_occlusion_layer', light_mask: 2, sdf_collision: true },
        { op: 'set_occluder', source: 0, tiles: [[2, 0]] },
        { op: 'add_custom_data', name: 'hazard', type: 'bool' },
        { op: 'set_tile_data', source: 0, tiles: [[2, 0]], values: { hazard: 1, modulate: '#ff0000', z_index: 2 } },
        { op: 'add_alternative', source: 0, tiles: [[2, 0]], values: { flip_h: true } },
        { op: 'add_terrain', name: 'rock', color: '#8fd16a', type: '#8fd16a' },
        { op: 'set_animation', source: 0, tiles: [[1, 0]], frames: 2, duration: [0.5, 0.25], speed: 2, mode: 'random_start_times' },
      ],
    });
    expect(r.ops[7]).toEqual({ op: 'add_alternative', source: 0, alternatives: [[2, 0, 1]] });
    expect(r.ops[9]).toMatchObject({ op: 'set_animation', frames: 2, removed_tiles: [[2, 0]] });
    // No new atlas in this call: counts only, no coordinate lists.
    expect(r.sources[0]).toMatchObject({ id: 0, tile_count: 2 });
    expect(r.sources[0].tiles).toBeUndefined();
    expect(r).toMatchObject({ navigation_layers: 1, occlusion_layers: 1 });
    // The unused key is reported, with the hint the dogfood test needed.
    expect(r.warnings.join('\n')).toMatch(/ops\[8\] \(add_terrain\): ignored 'type'.*pass it as 'color'/);
    // The frame cell [2, 0] held a tile, which set_animation removed (and says so).
    expect(r.warnings.join('\n')).toMatch(/removed tiles \[\[2,0\]\]/);

    const text = readFileSync(path.join(proj.dir, 'world', 'generated.tres'), 'utf8');
    expect(text).toContain('0:0/0/physics_layer_0/polygon_0/one_way = true');
    expect(text).toContain('0:0/0/physics_layer_0/polygon_0/one_way_margin = 2.0');
    expect(text).toMatch(/1:0\/0\/navigation_layer_0\/polygon = SubResource\("NavigationPolygon_/);
    expect(text).toContain('navigation_layer_0/layers = 3');
    expect(text).toContain('occlusion_layer_0/light_mask = 2');
    expect(text).toContain('occlusion_layer_0/sdf_collision = true');
    expect(text).toContain('terrain_set_0/terrain_1/color = Color(0.56078434, 0.81960785, 0.41568628, 1)');
    expect(text).toContain('1:0/animation_speed = 2.0');
    expect(text).toContain('1:0/animation_mode = 1');
    expect(text).toContain('1:0/animation_frame_1/duration = 0.25');

    // set_tile_data / add_alternative ran before set_animation removed [2, 0]; check them
    // on a fresh tile instead.
    const t = await call(client, 'godot_tileset_edit', {
      path: 'res://world/generated.tres',
      ops: [
        { op: 'set_tile_data', source: 0, tiles: [[0, 0]], values: { hazard: true, modulate: '#ff0000', z_index: 2 } },
        { op: 'add_alternative', source: 0, tiles: [[0, 0]], values: { flip_v: true, transpose: true } },
      ],
    });
    expect(t.ops[1].alternatives).toEqual([[0, 0, 1]]);
    expect(t.sources[0].alternatives).toBe(1);
    const text2 = readFileSync(path.join(proj.dir, 'world', 'generated.tres'), 'utf8');
    // custom_data_1: layer 0 is the 'damage' layer of the first test.
    expect(text2).toContain('0:0/0/custom_data_1 = true');
    expect(text2).toContain('0:0/0/modulate = Color(1, 0, 0, 1)');
    expect(text2).toContain('0:0/0/z_index = 2');
    // The alternative starts as a copy of the base tile (collision, custom data...).
    expect(text2).toContain('0:0/1/flip_v = true');
    expect(text2).toContain('0:0/1/transpose = true');
    expect(text2).toContain('0:0/1/custom_data_1 = true');
    expect(text2).toContain('0:0/1/physics_layer_0/polygon_0/one_way = true');
    // grid.read (full) lists the alternatives as grid.edit atlas/alt values.
    await call(client, 'godot_node_set', { scene: L2, path: 'Ground', properties: { tile_set: 'res://world/generated.tres' } });
    const read = await call(client, 'godot_grid_read', { scene: L2, path: 'Ground', limit: 1 });
    expect(read.sources[0].alt_tiles).toEqual([[0, 0, 1]]);
    await call(client, 'godot_node_set', { scene: L2, path: 'Ground', properties: { tile_set: 'res://world/tileset.tres' } });
  }, 120_000);

  it('tileset.edit reports bad per-tile values clearly, and ints as ints', async () => {
    const ts = 'res://world/generated.tres';
    expect(await fail(client, 'godot_tileset_edit', { path: ts, ops: [{ op: 'set_terrain', source: 0, terrain_set: 5 }] })).toContain('terrain set 5 does not exist');
    expect(await fail(client, 'godot_tileset_edit', { path: ts, ops: [{ op: 'set_collision', source: 0, polygon: [[-8, -8, 0]] }] })).toContain('polygon point [-8,-8,0] is not an [x, y] pair');
    expect(await fail(client, 'godot_tileset_edit', { path: ts, ops: [{ op: 'set_tile_data', source: 0, values: { hazrd: true } }] })).toMatch(
      /'hazrd' is neither a custom data layer nor a tile property\. Did you mean: hazard\?/,
    );
    expect(await fail(client, 'godot_tileset_edit', { path: ts, ops: [{ op: 'set_tile_data', source: 0, values: { hazard: 'maybe' } }] })).toMatch(/expected bool/);
    expect(await fail(client, 'godot_tileset_edit', { path: ts, ops: [{ op: 'set_tile_data', source: 0, tiles: [[0, 0]], alt: 7, values: { z_index: 1 } }] })).toMatch(
      /tile \[0, 0\] has no alternative 7 \(it has \[0,1\]/,
    );
    expect(await fail(client, 'godot_tileset_edit', { path: ts, ops: [{ op: 'set_animation', source: 0, tiles: [[0, 0]], frames: 9 }] })).toMatch(
      /frame 4 of tile \[0, 0\] would be at atlas cell \[4, 0\], outside the 4x1 atlas/,
    );
    expect(await fail(client, 'godot_tileset_edit', { path: ts, ops: [{ op: 'set_navigation', source: 0, layer: 3 }] })).toMatch(/navigation layer 3 does not exist \(the TileSet has 1\)/);
    expect(await fail(client, 'godot_tileset_edit', { path: ts, ops: [{ op: 'set_navigation', source: 0, polygon: [[0, 0], [1, 1], [2, 2]] }] })).toMatch(/bakes to no walkable area/);
    expect(await fail(client, 'godot_tileset_edit', { path: ts, ops: [{ op: 'add_alternative', source: 0 }] })).toMatch(/'tiles' is required/);
  }, 120_000);

  it('tile navigation polygons feed navigation.bake; agent_radius is applied', async () => {
    const scene = 'res://world/nav_tiles.tscn';
    await call(client, 'godot_scene_create', { path: scene, root_type: 'Node2D' });
    await call(client, 'godot_node_add', { scene, parent: '.', type: 'NavigationRegion2D', name: 'Nav' });
    await call(client, 'godot_node_add', { scene, parent: 'Nav', type: 'TileMapLayer', name: 'Floor', properties: { tile_set: 'res://world/generated.tres' } });
    // [1, 0] is the tile with a full-tile navigation polygon (and 2 animation frames).
    await call(client, 'godot_grid_edit', { scene, path: 'Nav/Floor', ops: [{ op: 'fill_rect', rect: { x: 0, y: 0, w: 8, h: 2 }, source: 0, atlas: [1, 0] }] });
    const baked = await call(client, 'godot_navigation_bake', { scene, agent_radius: 2 });
    expect(baked).toMatchObject({ parser: 'headless', parsed_shapes: 16, agent_radius: 2 });
    expect(baked.polygons).toBeGreaterThan(0);
    expect(readFileSync(path.join(proj.dir, 'world', 'nav_tiles.tscn'), 'utf8')).toContain('agent_radius = 2.0');
    const p = await call(client, 'godot_navigation_path', { scene, from: [4, 4], to: [124, 28] });
    expect(p.reached).toBe(true);
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

  it('a TileSet created in the editor has a uid, and its tile navigation feeds the engine parser', async () => {
    const r = await call(client, 'godot_tileset_edit', {
      path: 'res://world/editor_nav.tres',
      create: true,
      ops: [
        { op: 'add_atlas', texture: 'res://world/tiles.png' },
        { op: 'add_navigation_layer' },
        { op: 'set_navigation', source: 0, tiles: [[1, 0]] },
      ],
    });
    expect(r.backend).toBe('editor');
    expect(readFileSync(path.join(proj.dir, 'world', 'editor_nav.tres'), 'utf8')).toMatch(/^\[gd_resource type="TileSet" format=3 uid="uid:\/\//);
    const deps = await call(client, 'godot_resource_deps', { path: 'res://world/editor_nav.tres' });
    expect(deps.uid).toMatch(/^uid:\/\//);

    await call(client, 'godot_scene_create', { path: 'res://world/editor_nav.tscn', root_type: 'Node2D' });
    await call(client, 'godot_scene_open', { path: 'res://world/editor_nav.tscn' });
    await call(client, 'godot_node_add', { parent: '.', type: 'NavigationRegion2D', name: 'Nav' });
    await call(client, 'godot_node_add', { parent: 'Nav', type: 'TileMapLayer', name: 'Floor', properties: { tile_set: 'res://world/editor_nav.tres' } });
    await call(client, 'godot_grid_edit', { path: 'Nav/Floor', ops: [{ op: 'fill_rect', rect: { x: 0, y: 0, w: 8, h: 2 }, source: 0, atlas: [1, 0] }] });
    const baked = await call(client, 'godot_navigation_bake', { path: 'Nav', agent_radius: 2 });
    expect(baked).toMatchObject({ parser: 'engine', agent_radius: 2 });
    expect(baked.polygons).toBeGreaterThan(0);
  }, 180_000);
});
