/**
 * World building: TileMapLayer / GridMap cells, TileSet resources and
 * navigation baking. See addons/godot_mcp/ops/world_ops.gd for the Godot side.
 *
 * - grid.read / grid.edit work on a TileMapLayer or GridMap node in a scene
 *   (TileMap is deprecated and rejected with a conversion hint). grid.edit is
 *   one undo step in the editor, whatever the number of ops.
 * - tileset.edit edits (or creates) a TileSet .tres file and saves it at once;
 *   in the editor it edits the cached instance so open maps update live.
 * - navigation.bake is a scene mutation: it bakes into a copy of the region's
 *   NavigationPolygon/NavigationMesh, then writes the result through the undo
 *   history. Headless, it parses common node types itself because Godot's
 *   parser needs the scene inside a SceneTree (see core/world_nav.gd).
 * - navigation.path queries a private navigation map built from the scene's
 *   baked regions, so it works headless too.
 */

import { z } from 'zod';
import { forwardOp } from './backend.js';
import { defineOp, type Operation } from './types.js';

const scene = z.string().optional().describe('Scene; default edited one (required headless)');
// Plain numbers: z.number().int() adds +-2^53 bounds to every field's JSON schema
// (~20 tokens each); the Godot side checks that cell coordinates and ids are integral.
const int = z.number();
// Lengths are checked in Godot too; leaving minItems/maxItems out keeps the schemas small.
const pair = z.array(int);
const cells = z.array(pair).describe('[[x,y]...]; GridMap [[x,y,z]...]');

export const gridRead = defineOp({
  name: 'grid.read',
  group: 'world',
  title: 'Read tile/grid map',
  description:
    'Godot world: read a TileMapLayer/GridMap: cells, bounds and the TileSet tiles/terrains or MeshLibrary items to paint with.',
  input: z.object({
    scene,
    path: z.string(),
    region: z.record(z.string(), int).optional().describe('{x,y,w,h}; GridMap +z,d'),
    limit: z.number().int().min(1).max(10000).default(500),
    summary_only: z.boolean().default(false),
  }),
  readOnly: true,
  idempotent: true,
  run: (args, ctx) => forwardOp(ctx, 'grid.read', args, { needsScene: true }),
});

export const gridEdit = defineOp({
  name: 'grid.edit',
  group: 'world',
  title: 'Edit tile/grid map',
  description:
    'Godot world: paint a TileMapLayer/GridMap with ordered ops (set, erase, fill_rect, terrain; clear wipes all cells). One undo step.',
  input: z.object({
    scene,
    path: z.string(),
    ops: z
      .array(
        z.object({
          op: z.enum(['set', 'erase', 'fill_rect', 'clear', 'terrain']),
          cells: cells.optional(),
          rect: z.record(z.string(), int).optional().describe('{x,y,w,h}; GridMap +z,d'),
          source: int.optional(),
          atlas: pair.optional(),
          alt: int.optional(),
          item: int.optional(),
          orientation: int.optional().describe('0-23; Y 90/180/270=16/10/22'),
          terrain_set: int.optional(),
          terrain: int.optional(),
          mode: z.enum(['connect', 'path']).optional(),
        }),
      )
      .min(1)
      .describe('Max 10000 cells.'),
  }),
  readOnly: false,
  destructive: false,
  run: (args, ctx) => forwardOp(ctx, 'grid.edit', args, { needsScene: true }),
});

export const tilesetEdit = defineOp({
  name: 'tileset.edit',
  group: 'world',
  title: 'Edit TileSet',
  description:
    'Godot world: create/edit a TileSet .tres: atlas sources from textures, collision, terrains, custom data. Saved at once.',
  input: z.object({
    path: z.string().describe('.tres path'),
    create: z.boolean().default(false),
    tile_size: pair.optional(),
    ops: z
      .array(
        z.object({
          op: z.enum(['add_atlas', 'remove_source', 'add_physics_layer', 'set_collision', 'add_terrain_set', 'add_terrain', 'set_terrain', 'add_custom_data']),
          texture: z.string().optional(),
          tile_size: pair.optional(),
          separation: pair.optional(),
          margins: pair.optional(),
          create_tiles: z.enum(['opaque', 'all', 'none']).optional(),
          source: int.optional(),
          tiles: z.array(pair).optional().describe('Atlas coords; default all'),
          physics_layer: int.optional(),
          polygon: z.array(pair).optional().describe('Px from tile center; default full tile; [] removes'),
          collision_layer: int.optional(),
          mode: z.enum(['corners_and_sides', 'corners', 'sides']).optional(),
          terrain_set: int.optional(),
          terrain: int.optional(),
          peering: z.record(z.string(), int).optional().describe('{"right_side":0} or {"all":0}'),
          name: z.string().optional(),
          type: z.string().optional(),
        }),
      )
      .default([]),
  }),
  readOnly: false,
  destructive: false,
  run: (args, ctx) => forwardOp(ctx, 'tileset.edit', args),
});

export const navigationBake = defineOp({
  name: 'navigation.bake',
  group: 'world',
  title: 'Bake navigation',
  description:
    'Godot world: bake a NavigationRegion2D/3D from its child colliders, meshes, GridMaps and TileMapLayers.',
  input: z.object({
    scene,
    path: z.string().optional().describe('Region; default the only one'),
    outline: z.array(pair).optional().describe('2D walkable polygon'),
  }),
  readOnly: false,
  destructive: false,
  idempotent: true,
  run: (args, ctx) => forwardOp(ctx, 'navigation.bake', args, { needsScene: true }),
});

export const navigationPath = defineOp({
  name: 'navigation.path',
  group: 'world',
  title: 'Navigation path',
  description: 'Godot world: shortest path between two points over the scene\'s baked navigation regions.',
  input: z.object({
    scene,
    from: pair.describe('[x,y] or [x,y,z]'),
    to: pair,
    path: z.string().optional(),
    optimize: z.boolean().default(true),
    layers: int.optional(),
  }),
  readOnly: true,
  idempotent: true,
  run: (args, ctx) => forwardOp(ctx, 'navigation.path', args, { needsScene: true }),
});

/** Operations in this area, in the order they should appear in tools/list. */
export const operations: Operation[] = [gridRead, gridEdit, tilesetEdit, navigationBake, navigationPath];
