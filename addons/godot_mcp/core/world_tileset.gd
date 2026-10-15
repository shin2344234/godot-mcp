@tool
extends RefCounted
## TileSet helpers for world_ops.gd: describing a TileSet and applying `tileset.edit` ops.
##
## `tileset.edit` works on a TileSet saved as its own .tres file. In the editor we edit the
## *cached* instance returned by ResourceLoader.load(), which is the very object every open
## TileMapLayer references, so painted maps update immediately; then the file is saved and
## the FileSystem dock told about it. To stay atomic (all ops or none) the ops are first
## applied to a deep duplicate as a dry run; only if every op validates are they applied
## again to the real instance. The ops are deterministic, so the second pass cannot fail
## for a reason the first pass did not catch.
##
## API notes (verified on Godot 4.7.2): has_tile/get_tiles_count/get_tile_id live on the
## TileSetSource base class; TileSetAtlasSource.create_tile(coords, size = (1, 1));
## TileData collision polygons are in pixels relative to the tile's center.

const R := preload("mcp_result.gd")
const Fuzzy := preload("fuzzy.gd")

## TileSet.CellNeighbor values by the names used in .tres files ("terrains_peering_bit/<name>").
const PEERING_BITS: Dictionary = {
	"right_side": 0, "right_corner": 1, "bottom_right_side": 2, "bottom_right_corner": 3,
	"bottom_side": 4, "bottom_corner": 5, "bottom_left_side": 6, "bottom_left_corner": 7,
	"left_side": 8, "left_corner": 9, "top_left_side": 10, "top_left_corner": 11,
	"top_side": 12, "top_corner": 13, "top_right_side": 14, "top_right_corner": 15,
}

const TERRAIN_MODES: Dictionary = {
	"corners_and_sides": TileSet.TERRAIN_MODE_MATCH_CORNERS_AND_SIDES,
	"corners": TileSet.TERRAIN_MODE_MATCH_CORNERS,
	"sides": TileSet.TERRAIN_MODE_MATCH_SIDES,
}

const OPS: PackedStringArray = ["add_atlas", "remove_source", "add_physics_layer", "set_collision",
	"add_terrain_set", "add_terrain", "set_terrain", "add_custom_data"]

## Tiles listed per source in summaries (bigger atlases report only the count).
const MAX_TILES_LISTED: int = 64


# -------------------------------------------------------------------------------------
# Description (shared with grid.read)
# -------------------------------------------------------------------------------------

## A compact description of what can be painted with `ts`.
static func describe(ts: TileSet) -> Dictionary:
	var sources: Array = []
	for i: int in range(ts.get_source_count()):
		var id: int = ts.get_source_id(i)
		sources.append(describe_source(id, ts.get_source(id)))
	var terrain_sets: Array = []
	for t: int in range(ts.get_terrain_sets_count()):
		var names: Array = []
		for k: int in range(ts.get_terrains_count(t)):
			names.append(ts.get_terrain_name(t, k))
		terrain_sets.append({"index": t, "mode": TERRAIN_MODES.find_key(ts.get_terrain_set_mode(t)), "terrains": names})
	var custom: Array = []
	for c: int in range(ts.get_custom_data_layers_count()):
		custom.append({"name": ts.get_custom_data_layer_name(c), "type": type_string(ts.get_custom_data_layer_type(c))})
	return {
		"tile_size": [ts.tile_size.x, ts.tile_size.y],
		"sources": sources,
		"physics_layers": ts.get_physics_layers_count(),
		"terrain_sets": terrain_sets,
		"custom_data": custom,
	}


static func describe_source(id: int, src: TileSetSource) -> Dictionary:
	if src is TileSetAtlasSource:
		var at := src as TileSetAtlasSource
		var grid: Vector2i = at.get_atlas_grid_size()
		var tiles: Array = []
		for i: int in range(mini(at.get_tiles_count(), MAX_TILES_LISTED)):
			var c: Vector2i = at.get_tile_id(i)
			tiles.append([c.x, c.y])
		var d: Dictionary = {
			"id": id, "type": "atlas",
			"texture": path_or_null(at.texture),
			"tile_size": [at.texture_region_size.x, at.texture_region_size.y],
			"grid": [grid.x, grid.y],
			"tile_count": at.get_tiles_count(),
			"tiles": tiles,
		}
		if at.get_tiles_count() > MAX_TILES_LISTED:
			d["tiles_truncated"] = true
		return d
	if src is TileSetScenesCollectionSource:
		var sc := src as TileSetScenesCollectionSource
		var scenes: Array = []
		for i: int in range(sc.get_scene_tiles_count()):
			var sid: int = sc.get_scene_tile_id(i)
			var ps: PackedScene = sc.get_scene_tile_scene(sid)
			scenes.append({"alt": sid, "scene": path_or_null(ps)})
		return {"id": id, "type": "scenes", "scenes": scenes}
	return {"id": id, "type": src.get_class()}


## A resource's path, or null when there is no resource (JSON-friendly).
static func path_or_null(res: Resource) -> Variant:
	if res == null:
		return null
	return res.resource_path


# -------------------------------------------------------------------------------------
# Small param helpers (ops are plain dictionaries; JSON numbers arrive as floats)
# -------------------------------------------------------------------------------------

static func _int(v: Variant) -> Variant:
	if v is int:
		return v
	if v is float and is_finite(v) and float(v) == floorf(v):
		return int(v)
	return null


## [x, y] or {"x", "y"} -> Vector2i, or null.
static func vec2i(v: Variant) -> Variant:
	if v is Array and (v as Array).size() == 2:
		var x: Variant = _int(v[0])
		var y: Variant = _int(v[1])
		if x != null and y != null:
			return Vector2i(x, y)
	elif v is Dictionary and (v as Dictionary).has("x") and (v as Dictionary).has("y"):
		return vec2i([v["x"], v["y"]])
	return null


static func _bad(i: int, op: String, msg: String) -> Dictionary:
	return R.err(R.BAD_PARAMS, "tileset.edit: ops[%d] (%s): %s" % [i, op, msg])


static func _opt_vec2i(d: Dictionary, key: String, default: Variant) -> Variant:
	if not d.has(key) or d[key] == null:
		return default
	return vec2i(d[key])


static func _opt_int(d: Dictionary, key: String, default: int) -> Variant:
	if not d.has(key) or d[key] == null:
		return default
	return _int(d[key])


# -------------------------------------------------------------------------------------
# Applying ops
# -------------------------------------------------------------------------------------

## Applies `ops` to `ts` in order. Returns {"value": Array of per-op results} or an error
## (in which case `ts` may be partially modified: callers dry-run on a duplicate first).
static func apply_ops(ts: TileSet, ops: Array) -> Dictionary:
	var results: Array = []
	for i: int in range(ops.size()):
		var raw: Variant = ops[i]
		if not raw is Dictionary:
			return R.err(R.BAD_PARAMS, "tileset.edit: ops[%d] must be an object like {\"op\": \"add_atlas\", \"texture\": \"res://tiles.png\"}." % i)
		var d: Dictionary = raw
		var op: String = str(d.get("op", ""))
		var r: Dictionary
		match op:
			"add_atlas":
				r = _add_atlas(ts, d, i)
			"remove_source":
				r = _remove_source(ts, d, i)
			"add_physics_layer":
				r = _add_physics_layer(ts, d, i)
			"set_collision":
				r = _set_collision(ts, d, i)
			"add_terrain_set":
				r = _add_terrain_set(ts, d, i)
			"add_terrain":
				r = _add_terrain(ts, d, i)
			"set_terrain":
				r = _set_terrain(ts, d, i)
			"add_custom_data":
				r = _add_custom_data(ts, d, i)
			_:
				return R.err(R.BAD_PARAMS, "tileset.edit: ops[%d].op '%s' is unknown.%s Valid ops: %s." %
					[i, op, Fuzzy.did_you_mean(Fuzzy.suggest(op, OPS, 2)), ", ".join(OPS)])
		if R.is_err(r):
			return r
		var entry: Dictionary = {"op": op}
		entry.merge(r["value"])
		results.append(entry)
	return R.value(results)


static func _add_atlas(ts: TileSet, d: Dictionary, i: int) -> Dictionary:
	var tex_path: String = str(d.get("texture", ""))
	if tex_path.is_empty():
		return _bad(i, "add_atlas", "'texture' is required (a res:// image, e.g. \"res://tiles.png\").")
	if not tex_path.begins_with("res://"):
		tex_path = "res://" + tex_path.trim_prefix("/")
	if not ResourceLoader.exists(tex_path):
		return R.err(R.NOT_FOUND, "tileset.edit: ops[%d] (add_atlas): texture '%s' does not exist (or is not imported yet; call filesystem.refresh after adding images)." % [i, tex_path])
	var tex: Texture2D = load(tex_path) as Texture2D
	if tex == null:
		return _bad(i, "add_atlas", "'%s' could not be loaded as a texture (not an image, or not imported yet: open the project in the editor or call filesystem.refresh, then retry)." % tex_path)
	var region: Variant = _opt_vec2i(d, "tile_size", ts.tile_size)
	var sep: Variant = _opt_vec2i(d, "separation", Vector2i.ZERO)
	var margins: Variant = _opt_vec2i(d, "margins", Vector2i.ZERO)
	if region == null or sep == null or margins == null:
		return _bad(i, "add_atlas", "'tile_size', 'separation' and 'margins' must be [x, y] integer pairs.")
	if (region as Vector2i).x < 1 or (region as Vector2i).y < 1:
		return _bad(i, "add_atlas", "'tile_size' must be at least [1, 1].")
	var mode: String = str(d.get("create_tiles", "opaque"))
	if not mode in ["opaque", "all", "none"]:
		return _bad(i, "add_atlas", "'create_tiles' must be \"opaque\" (tiles with visible pixels), \"all\" or \"none\", got '%s'." % mode)
	var id_override: Variant = _opt_int(d, "source", -1)
	if id_override == null:
		return _bad(i, "add_atlas", "'source' (optional id for the new source) must be an integer.")
	if int(id_override) >= 0 and ts.has_source(int(id_override)):
		return R.err(R.CONFLICT, "tileset.edit: ops[%d] (add_atlas): source id %d is already used; omit 'source' to get the next free id (%d)." % [i, id_override, ts.get_next_source_id()])
	var at := TileSetAtlasSource.new()
	at.texture = tex
	at.margins = margins
	at.separation = sep
	at.texture_region_size = region
	var grid: Vector2i = at.get_atlas_grid_size()
	if grid.x < 1 or grid.y < 1:
		return _bad(i, "add_atlas", "the texture (%dx%d px) is smaller than one tile (%s px plus margins)." % [tex.get_width(), tex.get_height(), region])
	var img: Image = null
	if mode == "opaque":
		img = tex.get_image()
		if img == null or img.is_empty():
			# Fallback: read the source file directly (works for PNG/JPG/WebP/SVG...).
			img = Image.load_from_file(ProjectSettings.globalize_path(tex_path))
		if img == null or img.is_empty():
			return _bad(i, "add_atlas", "could not read the texture's pixels to find opaque tiles; use create_tiles \"all\".")
		if img.is_compressed():
			img.decompress()
	var created: int = 0
	if mode != "none":
		for y: int in range(grid.y):
			for x: int in range(grid.x):
				if img != null:
					var origin: Vector2i = (margins as Vector2i) + Vector2i(x, y) * ((region as Vector2i) + (sep as Vector2i))
					if img.get_region(Rect2i(origin, region)).is_invisible():
						continue
				at.create_tile(Vector2i(x, y))
				created += 1
	var id: int = ts.add_source(at, int(id_override))
	return R.value({"source": id, "grid": [grid.x, grid.y], "tiles_created": created})


static func _source(ts: TileSet, d: Dictionary, i: int, op: String, atlas_only: bool) -> Dictionary:
	var id: Variant = _opt_int(d, "source", -1)
	if id == null or int(id) < 0:
		return _bad(i, op, "'source' (integer source id) is required.%s" % _source_list(ts))
	if not ts.has_source(int(id)):
		return R.err(R.NOT_FOUND, "tileset.edit: ops[%d] (%s): the TileSet has no source %d.%s" % [i, op, id, _source_list(ts)])
	var src: TileSetSource = ts.get_source(int(id))
	if atlas_only and not src is TileSetAtlasSource:
		return _bad(i, op, "source %d is a %s; only atlas sources have tiles with collision/terrain data." % [id, src.get_class()])
	return R.value(src)


static func _source_list(ts: TileSet) -> String:
	var ids: Array = []
	for k: int in range(ts.get_source_count()):
		ids.append(ts.get_source_id(k))
	if ids.is_empty():
		return " The TileSet has no sources yet; add one with an add_atlas op."
	return " Existing source ids: %s." % ", ".join(ids.map(func(x: int) -> String: return str(x)))


## The atlas coords an op targets: d.tiles ([[x, y], ...]) or every tile of the source.
static func _target_tiles(at: TileSetAtlasSource, d: Dictionary, i: int, op: String) -> Dictionary:
	var out: Array[Vector2i] = []
	if not d.has("tiles") or d["tiles"] == null:
		for k: int in range(at.get_tiles_count()):
			out.append(at.get_tile_id(k))
		if out.is_empty():
			return _bad(i, op, "the source has no tiles; create them first (add_atlas with create_tiles).")
		return R.value(out)
	if not d["tiles"] is Array or (d["tiles"] as Array).is_empty():
		return _bad(i, op, "'tiles' must be a non-empty list of atlas coords like [[0, 0], [1, 0]] (omit it for every tile).")
	for t: Variant in d["tiles"]:
		var c: Variant = vec2i(t)
		if c == null:
			return _bad(i, op, "tile %s is not an [x, y] atlas coordinate." % JSON.stringify(t))
		if not at.has_tile(c):
			var hint: String = ""
			var origin: Vector2i = at.get_tile_at_coords(c)
			if origin != Vector2i(-1, -1):
				hint = " It is covered by the larger tile at %s; use that." % [[origin.x, origin.y]]
			return R.err(R.NOT_FOUND, "tileset.edit: ops[%d] (%s): the atlas has no tile at [%d, %d].%s Use grid.read or the add_atlas result to see existing tiles." % [i, op, (c as Vector2i).x, (c as Vector2i).y, hint])
		out.append(c)
	return R.value(out)


static func _remove_source(ts: TileSet, d: Dictionary, i: int) -> Dictionary:
	var s: Dictionary = _source(ts, d, i, "remove_source", false)
	if R.is_err(s):
		return s
	var id: int = int(_opt_int(d, "source", -1))
	ts.remove_source(id)
	return R.value({"source": id, "note": "Cells painted with this source now render empty; erase or repaint them with grid.edit."})


static func _add_physics_layer(ts: TileSet, d: Dictionary, i: int) -> Dictionary:
	var layer: Variant = _opt_int(d, "collision_layer", 1)
	var mask: Variant = _opt_int(d, "collision_mask", 1)
	if layer == null or mask == null:
		return _bad(i, "add_physics_layer", "'collision_layer' and 'collision_mask' must be integer bitmasks (1 = layer 1).")
	ts.add_physics_layer()
	var idx: int = ts.get_physics_layers_count() - 1
	ts.set_physics_layer_collision_layer(idx, layer)
	ts.set_physics_layer_collision_mask(idx, mask)
	return R.value({"physics_layer": idx})


static func _set_collision(ts: TileSet, d: Dictionary, i: int) -> Dictionary:
	var s: Dictionary = _source(ts, d, i, "set_collision", true)
	if R.is_err(s):
		return s
	var at: TileSetAtlasSource = s["value"]
	var layer: Variant = _opt_int(d, "physics_layer", 0)
	if layer == null or int(layer) < 0 or int(layer) >= ts.get_physics_layers_count():
		return _bad(i, "set_collision", "physics layer %s does not exist (the TileSet has %d). Add one first with an add_physics_layer op." % [JSON.stringify(d.get("physics_layer", 0)), ts.get_physics_layers_count()])
	var custom: Variant = null
	if d.has("polygon") and d["polygon"] != null:
		if not d["polygon"] is Array:
			return _bad(i, "set_collision", "'polygon' must be a list of [x, y] points relative to the tile center, or [] to remove collision.")
		var pts := PackedVector2Array()
		for p: Variant in d["polygon"]:
			if not (p is Array and (p as Array).size() == 2 and (p[0] is float or p[0] is int) and (p[1] is float or p[1] is int)):
				return _bad(i, "set_collision", "polygon point %s is not an [x, y] pair." % JSON.stringify(p))
			pts.append(Vector2(float(p[0]), float(p[1])))
		if pts.size() > 0 and pts.size() < 3:
			return _bad(i, "set_collision", "'polygon' needs at least 3 points (or [] to remove collision).")
		custom = pts
	var tiles: Dictionary = _target_tiles(at, d, i, "set_collision")
	if R.is_err(tiles):
		return tiles
	var count: int = 0
	for c: Vector2i in tiles["value"]:
		var size_px: Vector2 = Vector2(at.texture_region_size * at.get_tile_size_in_atlas(c))
		var pts: PackedVector2Array
		if custom != null:
			pts = custom
		else:
			var h: Vector2 = size_px * 0.5
			pts = PackedVector2Array([Vector2(-h.x, -h.y), Vector2(h.x, -h.y), Vector2(h.x, h.y), Vector2(-h.x, h.y)])
		# Every alternative of the tile gets the same shape, so flipped variants collide too.
		for a: int in range(at.get_alternative_tiles_count(c)):
			var td: TileData = at.get_tile_data(c, at.get_alternative_tile_id(c, a))
			while td.get_collision_polygons_count(layer) > 0:
				td.remove_collision_polygon(layer, 0)
			if not pts.is_empty():
				td.add_collision_polygon(layer)
				td.set_collision_polygon_points(layer, 0, pts)
		count += 1
	return R.value({"source": int(_opt_int(d, "source", -1)), "physics_layer": layer, "tiles": count, "removed": custom != null and (custom as PackedVector2Array).is_empty()})


static func _add_terrain_set(ts: TileSet, d: Dictionary, i: int) -> Dictionary:
	var mode: String = str(d.get("mode", "corners_and_sides"))
	if not TERRAIN_MODES.has(mode):
		return _bad(i, "add_terrain_set", "'mode' must be one of %s, got '%s'." % [", ".join(TERRAIN_MODES.keys()), mode])
	ts.add_terrain_set()
	var idx: int = ts.get_terrain_sets_count() - 1
	ts.set_terrain_set_mode(idx, TERRAIN_MODES[mode])
	return R.value({"terrain_set": idx})


static func _terrain_set(ts: TileSet, d: Dictionary) -> Variant:
	var t: Variant = _opt_int(d, "terrain_set", ts.get_terrain_sets_count() - 1)
	if t == null or int(t) < 0 or int(t) >= ts.get_terrain_sets_count():
		return null
	return t


static func _add_terrain(ts: TileSet, d: Dictionary, i: int) -> Dictionary:
	var t: Variant = _terrain_set(ts, d)
	if t == null:
		return _bad(i, "add_terrain", "terrain set %s does not exist (the TileSet has %d). Add one with an add_terrain_set op first." % [JSON.stringify(d.get("terrain_set")), ts.get_terrain_sets_count()])
	ts.add_terrain(t)
	var idx: int = ts.get_terrains_count(t) - 1
	var terrain_name: String = str(d.get("name", "Terrain %d" % idx))
	ts.set_terrain_name(t, idx, terrain_name)
	if d.has("color") and d["color"] != null:
		var col: Variant = d["color"]
		if col is String and Color.html_is_valid(col):
			ts.set_terrain_color(t, idx, Color.html(col))
		elif col is Array and (col as Array).size() >= 3:
			ts.set_terrain_color(t, idx, Color(float(col[0]), float(col[1]), float(col[2]), float(col[3]) if (col as Array).size() > 3 else 1.0))
		else:
			return _bad(i, "add_terrain", "'color' must be \"#rrggbb\" or [r, g, b] (0-1).")
	return R.value({"terrain_set": t, "terrain": idx, "name": terrain_name})


static func _set_terrain(ts: TileSet, d: Dictionary, i: int) -> Dictionary:
	var s: Dictionary = _source(ts, d, i, "set_terrain", true)
	if R.is_err(s):
		return s
	var at: TileSetAtlasSource = s["value"]
	var t: Variant = _terrain_set(ts, d)
	if t == null:
		return _bad(i, "set_terrain", "terrain set %s does not exist (the TileSet has %d). Add one with add_terrain_set." % [JSON.stringify(d.get("terrain_set")), ts.get_terrain_sets_count()])
	var terrain: Variant = _opt_int(d, "terrain", 0)
	if terrain == null or int(terrain) < -1 or int(terrain) >= ts.get_terrains_count(t):
		return _bad(i, "set_terrain", "terrain %s does not exist in terrain set %d (it has %d terrains; -1 clears)." % [JSON.stringify(d.get("terrain")), t, ts.get_terrains_count(t)])
	var peering: Dictionary = {}
	if d.has("peering") and d["peering"] != null:
		if not d["peering"] is Dictionary:
			return _bad(i, "set_terrain", "'peering' must be an object like {\"right_side\": 0, \"bottom_side\": 0} or {\"all\": 0}.")
		peering = d["peering"]
	var tiles: Dictionary = _target_tiles(at, d, i, "set_terrain")
	if R.is_err(tiles):
		return tiles
	for c: Vector2i in tiles["value"]:
		for a: int in range(at.get_alternative_tiles_count(c)):
			var td: TileData = at.get_tile_data(c, at.get_alternative_tile_id(c, a))
			td.terrain_set = t
			td.terrain = terrain
			for key: Variant in peering:
				var pv: Variant = _int(peering[key])
				if pv == null or int(pv) < -1 or int(pv) >= ts.get_terrains_count(t):
					return _bad(i, "set_terrain", "peering value for '%s' must be a terrain index of set %d or -1." % [key, t])
				if str(key) == "all":
					for b: int in PEERING_BITS.values():
						if td.is_valid_terrain_peering_bit(b):
							td.set_terrain_peering_bit(b, pv)
					continue
				if not PEERING_BITS.has(str(key)):
					return _bad(i, "set_terrain", "unknown peering bit '%s'.%s Valid names: all, %s." % [key, Fuzzy.did_you_mean(Fuzzy.suggest(str(key), PEERING_BITS.keys(), 2)), ", ".join(PEERING_BITS.keys())])
				var bit: int = PEERING_BITS[str(key)]
				if not td.is_valid_terrain_peering_bit(bit):
					return _bad(i, "set_terrain", "peering bit '%s' is not used by this terrain set's mode/tile shape (e.g. square tiles use *_side and *_corner names like right_side, bottom_right_corner)." % key)
				td.set_terrain_peering_bit(bit, pv)
	return R.value({"source": int(_opt_int(d, "source", -1)), "terrain_set": t, "terrain": terrain, "tiles": (tiles["value"] as Array).size()})


static func _add_custom_data(ts: TileSet, d: Dictionary, i: int) -> Dictionary:
	var layer_name: String = str(d.get("name", ""))
	if layer_name.is_empty():
		return _bad(i, "add_custom_data", "'name' is required, e.g. \"damage\".")
	if ts.get_custom_data_layer_by_name(layer_name) != -1:
		return R.err(R.CONFLICT, "tileset.edit: ops[%d] (add_custom_data): a custom data layer named '%s' already exists." % [i, layer_name])
	var type_name: String = str(d.get("type", "int"))
	var vtype: int = -1
	var names: Array[String] = []
	for t: int in range(1, TYPE_MAX):
		names.append(type_string(t))
		if type_string(t).to_lower() == type_name.to_lower():
			vtype = t
	if vtype == -1:
		return _bad(i, "add_custom_data", "unknown type '%s'.%s Use a Variant type name such as int, float, bool, String, Vector2, Color." % [type_name, Fuzzy.did_you_mean(Fuzzy.suggest(type_name, names, 3))])
	ts.add_custom_data_layer()
	var idx: int = ts.get_custom_data_layers_count() - 1
	ts.set_custom_data_layer_name(idx, layer_name)
	ts.set_custom_data_layer_type(idx, vtype)
	return R.value({"custom_data_layer": idx, "name": layer_name, "type": type_string(vtype)})
