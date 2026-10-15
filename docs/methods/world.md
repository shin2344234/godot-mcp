# World methods (step 2)

TileMapLayer / GridMap cells, TileSet resources and navigation. GDScript side:
`addons/godot_mcp/ops/world_ops.gd` (+ `core/world_nav.gd`, `core/world_tileset.gd`);
MCP tools: `godot_grid_read`, `godot_grid_edit`, `godot_tileset_edit`,
`godot_navigation_bake`, `godot_navigation_path` (group `world`).

Conventions as in [bridge-protocol.md](../bridge-protocol.md) section 5: **(E/H)** works
in the editor and headless; `scene` is optional in the editor (edited scene) and required
headless. Scene mutations are one `"MCP: <method>"` undo action in the editor and are
saved to the scene file immediately headless (`saved: true`).

Only **TileMapLayer** is supported for tiles. `TileMap` is deprecated since Godot 4.3;
pointing a method at one answers `UNSUPPORTED` with the conversion hint (TileMap bottom
panel menu, "Extract TileMap layers as individual TileMapLayer nodes").

Cell coordinates are integers: `[x, y]` for TileMapLayer, `[x, y, z]` for GridMap
(`{"x":..,"y":..}` objects are accepted too). Regions/rects are `{x, y, w, h}`, plus
`z, d` for GridMap (`x/y/z` default to 0).

### grid.read (E/H)

params: `{ "scene"?, "path": "Ground", "region"?: {x,y,w,h[,z,d]}, "limit"?: 500, "summary_only"?: false }`

TileMapLayer result:

```json
{ "path": "Ground", "type": "TileMapLayer",
  "tile_set": "res://world/tileset.tres" | "(embedded in the scene)" | null,
  "used_cells": 6, "used_rect": { "x": 0, "y": 0, "w": 4, "h": 2 },
  "tile_size": [16, 16],
  "sources": [ { "id": 0, "type": "atlas", "texture": "res://world/tiles.png", "tile_size": [16, 16],
                 "grid": [4, 1], "tile_count": 3, "tiles": [[0,0],[1,0],[2,0]] },
               { "id": 1, "type": "scenes", "scenes": [ { "alt": 0, "scene": "res://tree.tscn" } ] } ],
  "physics_layers": 1,
  "terrain_sets": [ { "index": 0, "mode": "corners_and_sides", "terrains": ["grass"] } ],
  "custom_data": [ { "name": "damage", "type": "float" } ],
  "cells": [ { "x": 0, "y": 0, "source": 0, "atlas": [0, 0], "alt": 0 } ],
  "truncated": false }
```

GridMap result: `mesh_library`, `cell_size`, `used_cells`, `bounds {x,y,z,w,h,d}`,
`items: [{id, name}]`, `cells: [{x, y, z, item, orientation}]`.

Cells are sorted (y, then x; GridMap y, z, x) and capped by `limit` (1-10000);
`summary_only` omits them. `tiles` lists at most 64 atlas coords per source
(`tiles_truncated: true` beyond).

### grid.edit (E/H, scene mutation)

params: `{ "scene"?, "path": "Ground", "ops": [ ... ] }`, ops applied in order:

| op | fields |
|---|---|
| `set` | `cells`, tiles: `source`, `atlas` (default `[0,0]`), `alt` (default 0); GridMap: `item`, `orientation` (0-23, default 0) |
| `erase` | `cells` |
| `fill_rect` | `rect`, plus the `set` fields |
| `clear` | none: removes **every** cell |
| `terrain` | TileMapLayer only: `cells`, `terrain_set` (default 0), `terrain` (-1 clears), `mode` `"connect"` (default; `set_cells_terrain_connect`) or `"path"` (`set_cells_terrain_path`), `ignore_empty_terrains` (default **false**) |

Result: `{ "path", "type", "ops_applied", "cells_changed", "used_cells", "undo": "cells" | "snapshot", "warnings"? }`.

- Validation (nothing is changed on error): the TileSet must have the source
  (`has_source`), atlas tile (`has_tile`) and alternative (`has_alternative_tile`); for a
  scenes source, `alt` is the scene tile id. GridMap items must exist in the MeshLibrary.
  Errors list the existing sources/tiles/items.
- At most 10000 cells per call (sum of `cells` lengths and rect areas; `clear` counts 0).
- GridMap orientation is an orthogonal index (`GridMap.get_orthogonal_index_from_basis`):
  0 = none; 16, 10, 22 = 90, 180, 270 degrees around Y.
- `ignore_empty_terrains` defaults to false because with Godot's default (true),
  terrain painting onto empty cells places nothing (verified on 4.7.2).
- How it is applied: the ops run first on a scratch TileMapLayer/GridMap (never in the
  scene) holding a copy of the cell data. If at most 256 cells were touched and no
  `clear`/`terrain` op ran, the undo action re-sets only the changed cells
  (`set_cell` / `set_cell_item` with the old values as undo, `undo: "cells"`); otherwise
  it swaps the whole data: `TileMapLayer.tile_map_data` (PackedByteArray) or GridMap's
  `data` property (after `clear()`, since setting `data` alone keeps old cells),
  `undo: "snapshot"`.

### tileset.edit (E/H, project)

params: `{ "path": "res://world/tileset.tres", "create"?: false, "tile_size"?: [16, 16], "ops"?: [ ... ] }`

Edits a TileSet saved as its own `.tres`/`.res` (scene-embedded TileSets are not
supported). `create: true` makes a new one (`CONFLICT` if the file exists; `tile_size`
defaults to 16x16); `tile_size` on an existing TileSet changes it. Ops, in order:

| op | fields | result fields |
|---|---|---|
| `add_atlas` | `texture` (res:// image), `tile_size` (region size, default the TileSet's), `separation`, `margins`, `create_tiles` `"opaque"` (default: tiles with any visible pixel) / `"all"` / `"none"`, `source` (optional id) | `source`, `grid`, `tiles_created` |
| `remove_source` | `source` | `source` |
| `add_physics_layer` | `collision_layer` (default 1), `collision_mask` (default 1) | `physics_layer` |
| `set_collision` | `source`, `tiles` (default all), `physics_layer` (default 0), `polygon` (px relative to the tile center; default the full tile; `[]` removes) | `tiles` |
| `add_terrain_set` | `mode` `corners_and_sides` (default) / `corners` / `sides` | `terrain_set` |
| `add_terrain` | `terrain_set` (default last), `name`, `color` (`"#rrggbb"` or `[r,g,b]`) | `terrain` |
| `set_terrain` | `source`, `tiles` (default all), `terrain_set`, `terrain`, `peering` (`{"right_side": 0, ...}` or `{"all": 0}`; names as in .tres files) | `tiles` |
| `add_custom_data` | `name`, `type` (Variant type name: int, float, bool, String, Vector2, Color...) | `custom_data_layer` |

Result: `{ "path", "created", "ops": [ {op, ...result fields} ], "saved": true }` merged
with the TileSet description (`tile_size`, `sources`, `physics_layers`, `terrain_sets`,
`custom_data`, as in grid.read).

- Atomic: the ops are first applied to `duplicate(true)` of the TileSet; only when all
  succeed are they applied to the real one and the file saved (headless with
  `core/res_save.gd`, which keeps UIDs).
- In the editor the cached instance (`load(path)`) is edited, so open TileMapLayers using
  it update immediately; `EditorFileSystem.update_file` is called after saving. This is a
  file edit, not an undoable scene action.
- `set_collision` / `set_terrain` apply to every alternative of each tile.
- Opaque detection reads `Texture2D.get_image()` (works headless) and falls back to
  loading the source image file.

### navigation.bake (E/H, scene mutation)

params: `{ "scene"?, "path"?: "Nav", "outline"?: [[0,0],[512,0],[512,512],[0,512]] }`

`path` defaults to the scene's only NavigationRegion2D/3D. `outline` (2D only) replaces
the NavigationPolygon's walkable outlines before baking. Result:

```json
{ "path": "Nav", "type": "NavigationRegion2D", "vertices": 8, "polygons": 4,
  "parser": "engine" | "headless", "parsed_shapes"?: 1,
  "resource": "(embedded in the scene)" | "res://nav.tres", "resource_saved"?: true, "warnings"?: [] }
```

- Bakes into a duplicate of the region's NavigationPolygon/NavigationMesh with
  `NavigationServer{2D,3D}.bake_from_source_geometry_data` (synchronous), then the undo
  action writes `vertices`/`polygons` (and `outlines`) into the region's own resource, so
  shared/.tres resources stay shared. A region without a resource gets a new embedded one.
  A bake that yields no polygons is an error and changes nothing.
- Kind choice: a scene mutation, because the baked data lives in the scene (or in a
  resource the scene references) and should be one Ctrl+Z step like other scene edits.
  External `.tres` navigation resources are also written to disk in `finish`.
- Source geometry: in the editor the scene is inside the SceneTree, so Godot's own
  `parse_source_geometry_data` is used (`parser: "engine"`), identical to the editor's
  Bake button. Headless that function refuses to run ("The root node needs to be inside
  the SceneTree"): the runner handles requests in `SceneTree._initialize()` before the
  root window enters the tree, and adding the edited scene would run game scripts. So
  headless uses a built-in parser (`parser: "headless"`) honouring the resource's
  `parsed_geometry_type`, collision mask and `source_geometry_mode`, with transforms
  computed from the parent chain:
  - 2D: Polygon2D, MeshInstance2D (convex hull), StaticBody2D with CollisionShape2D
    (rectangle, circle, capsule, convex, concave) / CollisionPolygon2D, TileMapLayer
    (tile collision polygons as obstructions, tile navigation polygons as walkable),
    NavigationObstacle2D (`affect_navigation_mesh`).
  - 3D: MeshInstance3D, MultiMeshInstance3D, StaticBody3D with CollisionShape3D (box,
    sphere, capsule, cylinder, concave, convex, height map), GridMap (meshes and item
    collision shapes). CSG nodes are skipped with a warning (their mesh is only built
    in the tree): bake with the editor open for those.
  - 2D baking needs a walkable outline (NavigationPolygon outlines, `outline` param, or
    TileMapLayer navigation polygons); otherwise `BAD_PARAMS` with an example.

### navigation.path (E/H, scene read)

params: `{ "scene"?, "from": [x, y] | [x, y, z], "to": ..., "path"?: "Nav", "optimize"?: true, "layers"?: 4294967295 }`

Result: `{ "points": [[x, y], ...], "length": 354.36, "reached": true, "end_distance": 0, "regions": ["Nav"], "skipped_regions"?: [...] }`

- Points are in the scene root's coordinate space. All enabled, baked regions of the
  matching dimension take part (or only `path`).
- Builds a private navigation map (`map_create`, one `region_create` per region with its
  parent-chain transform, layers and resource), disables async iterations on the map and
  regions so `map_force_update` syncs immediately (with async iterations, the default since
  4.5, a fresh map is not usable until later frames), queries `map_get_path`, then frees
  the RIDs. Works the same headless and in the editor and never touches the game/editor
  world map.
- `reached` is true when the path ends within about two agent radii (or cells) of `to`;
  an empty path means the points are off the mesh or the layers don't match.
