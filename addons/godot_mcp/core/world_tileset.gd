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
## for a reason the first pass did not catch. Every op therefore validates ALL of its
## input before it changes anything, and never relies on an engine call failing (engine
## errors would also be printed, which the headless smoke test treats as a failure).
##
## API notes (verified on Godot 4.7.2 with headless probe scripts):
## * has_tile/get_tiles_count/get_tile_id live on the TileSetSource base class;
##   TileSetAtlasSource.create_tile(coords, size = (1, 1)).
## * TileData collision, navigation and occluder polygons are in pixels relative to the
##   tile's center. One-way collision is per polygon:
##   set_collision_polygon_one_way(layer, polygon_index, bool) and
##   set_collision_polygon_one_way_margin(layer, polygon_index, float).
## * Occluders use the polygon-index API (set_occluder_polygons_count,
##   add_occluder_polygon, set_occluder_polygon(layer, index, OccluderPolygon2D)); the
##   single-polygon set_occluder(layer, polygon) is still bound but the .tres format is
##   per polygon: "<tile>/occlusion_layer_0/polygon_0/polygon = SubResource(...)".
## * The default one-way margin of a collision polygon is 1.0.
## * Navigation is one NavigationPolygon per tile and layer: set_navigation_polygon(layer,
##   np). See _nav_polygon() for why it needs both outlines and baked polygons.
## * Animations: frame k of a tile at `c` (size `s` in atlas cells) sits at
##   c + (s + separation) * Vector2i(k % cols, k / cols), with cols = animation_columns, or
##   the frame count when columns is 0 (one row). Frames other than 0 must be free atlas
##   cells (has_room_for_tile), otherwise the setters print an engine error and refuse.
## * TileData copies: every PROPERTY_USAGE_STORAGE property of TileData (flip_h, ...,
##   "physics_layer_0/polygon_0/points", "custom_data_0", "terrains_peering_bit/...")
##   can be read from one TileData and set on another; that is how add_alternative clones
##   the base tile.

const R := preload("mcp_result.gd")
const Fuzzy := preload("fuzzy.gd")
const Codec := preload("variant_codec.gd")

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

## set_animation `mode` names. They share the `mode` field with add_terrain_set (one schema
## field instead of two keeps the tool definition small).
const ANIMATION_MODES: Dictionary = {
	"default": TileSetAtlasSource.TILE_ANIMATION_MODE_DEFAULT,
	"random_start_times": TileSetAtlasSource.TILE_ANIMATION_MODE_RANDOM_START_TIMES,
}

## The fields each op reads, besides "op". Any other key in an op is reported in the
## result's `warnings` instead of being dropped silently: the dogfood test passed
## add_terrain {"type": "#8fd16a"} (guessing where the colour goes) and the colour stayed
## the default without a word. The server lets unknown keys through to here for this.
const OP_KEYS: Dictionary = {
	"add_atlas": ["texture", "tile_size", "separation", "margins", "create_tiles", "source"],
	"remove_source": ["source"],
	"add_physics_layer": ["collision_layer", "collision_mask"],
	"set_collision": ["source", "tiles", "alt", "physics_layer", "layer", "polygon", "one_way", "one_way_margin"],
	"add_navigation_layer": ["layers"],
	"set_navigation": ["source", "tiles", "alt", "layer", "polygon"],
	"add_occlusion_layer": ["light_mask", "sdf_collision"],
	"set_occluder": ["source", "tiles", "alt", "layer", "polygon"],
	"add_terrain_set": ["mode"],
	"add_terrain": ["terrain_set", "name", "color"],
	"set_terrain": ["source", "tiles", "alt", "terrain_set", "terrain", "peering"],
	"add_custom_data": ["name", "type"],
	"set_tile_data": ["source", "tiles", "alt", "values"],
	"add_alternative": ["source", "tiles", "alt", "values"],
	"set_animation": ["source", "tiles", "columns", "frames", "duration", "speed", "separation", "mode"],
}

## TileData properties that set_tile_data / add_alternative accept in `values` (the
## inspector's Rendering and Miscellaneous groups). Terrains, collision, navigation and
## occlusion have their own ops because they need layer indices and polygons.
const TILE_PROPS: PackedStringArray = ["modulate", "z_index", "y_sort_origin", "texture_origin",
	"probability", "flip_h", "flip_v", "transpose", "material"]

## Tiles (and alternatives) listed per source in descriptions; bigger atlases report only
## the count.
const MAX_TILES_LISTED: int = 64


# -------------------------------------------------------------------------------------
# Description (shared with grid.read)
# -------------------------------------------------------------------------------------

## A compact description of what can be painted with `ts`.
##
## `list_ids` says which sources list their tile coordinates: null = every source (a full
## grid.read), [] = none (grid.read summary_only), or the source ids to list (tileset.edit
## lists only the sources its add_atlas ops just created: their tiles are what the caller
## needs next, while repeating every source's coordinates on every edit was the biggest
## token cost the dogfood test reported). Unlisted sources still give `tile_count`.
static func describe(ts: TileSet, list_ids: Variant = null) -> Dictionary:
	var sources: Array = []
	for i: int in range(ts.get_source_count()):
		var id: int = ts.get_source_id(i)
		var listed: bool = list_ids == null or (list_ids as Array).has(id)
		sources.append(describe_source(id, ts.get_source(id), listed))
	var terrain_sets: Array = []
	for t: int in range(ts.get_terrain_sets_count()):
		var names: Array = []
		for k: int in range(ts.get_terrains_count(t)):
			names.append(ts.get_terrain_name(t, k))
		terrain_sets.append({"index": t, "mode": TERRAIN_MODES.find_key(ts.get_terrain_set_mode(t)), "terrains": names})
	var custom: Array = []
	for c: int in range(ts.get_custom_data_layers_count()):
		custom.append({"name": ts.get_custom_data_layer_name(c), "type": type_string(ts.get_custom_data_layer_type(c))})
	var out: Dictionary = {
		"tile_size": [ts.tile_size.x, ts.tile_size.y],
		"sources": sources,
		"physics_layers": ts.get_physics_layers_count(),
		"terrain_sets": terrain_sets,
		"custom_data": custom,
	}
	# Only when present: most TileSets have neither, and every key costs tokens on each read.
	if ts.get_navigation_layers_count() > 0:
		out["navigation_layers"] = ts.get_navigation_layers_count()
	if ts.get_occlusion_layers_count() > 0:
		out["occlusion_layers"] = ts.get_occlusion_layers_count()
	return out


## One source. `list_tiles` adds the atlas coords (`tiles`) and the non-base alternatives
## (`alt_tiles`: [x, y, alt] triples, the values grid.edit's `atlas`/`alt` take), each
## capped at MAX_TILES_LISTED. Without it an atlas reports counts only.
static func describe_source(id: int, src: TileSetSource, list_tiles: bool = true) -> Dictionary:
	if src is TileSetAtlasSource:
		var at := src as TileSetAtlasSource
		var grid: Vector2i = at.get_atlas_grid_size()
		var d: Dictionary = {
			"id": id, "type": "atlas",
			"texture": path_or_null(at.texture),
			"tile_size": [at.texture_region_size.x, at.texture_region_size.y],
			"grid": [grid.x, grid.y],
			"tile_count": at.get_tiles_count(),
		}
		var alts: Array = []
		var alt_count: int = 0
		var tiles: Array = []
		for i: int in range(at.get_tiles_count()):
			var c: Vector2i = at.get_tile_id(i)
			if list_tiles and tiles.size() < MAX_TILES_LISTED:
				tiles.append([c.x, c.y])
			for a: int in range(1, at.get_alternative_tiles_count(c)):
				alt_count += 1
				if list_tiles and alts.size() < MAX_TILES_LISTED:
					alts.append([c.x, c.y, at.get_alternative_tile_id(c, a)])
		if list_tiles:
			d["tiles"] = tiles
			if at.get_tiles_count() > MAX_TILES_LISTED:
				d["tiles_truncated"] = true
			if not alts.is_empty():
				d["alt_tiles"] = alts
		elif alt_count > 0:
			d["alternatives"] = alt_count
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


static func _num(v: Variant) -> bool:
	return (v is float or v is int) and is_finite(float(v))


## JSON text of a param value for error messages, with integral floats written as ints.
## JSON numbers reach GDScript as floats, so JSON.stringify(op["terrain_set"]) printed
## "0.0" and a cell [0, 18, 5] came back as "[0.0,18.0,5.0]", which reads as if the
## caller had sent floats (reported by the dogfood test).
static func js(v: Variant) -> String:
	return JSON.stringify(_ints(v))


static func _ints(v: Variant) -> Variant:
	if v is float and is_finite(v) and float(v) == floorf(v) and absf(v) < 1e15:
		return int(v)
	if v is Array:
		return (v as Array).map(_ints)
	if v is Dictionary:
		var out: Dictionary = {}
		for k: Variant in v:
			out[k] = _ints(v[k])
		return out
	return v


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


## Optional bool field: {"value": bool or `default`} or an error.
static func _opt_bool(d: Dictionary, key: String, default: Variant, i: int, op: String) -> Dictionary:
	if not d.has(key) or d[key] == null:
		return R.value(default)
	if not d[key] is bool:
		return _bad(i, op, "'%s' must be true or false, got %s." % [key, js(d[key])])
	return R.value(d[key])


## Warnings for keys of op `d` that `op` does not read (see OP_KEYS).
static func _unused_keys(d: Dictionary, op: String, i: int) -> Array[String]:
	var used: Array = OP_KEYS[op]
	var out: Array[String] = []
	for k: Variant in d:
		var key: String = str(k)
		if key == "op" or used.has(key) or d[k] == null:
			continue
		var hint: String = Fuzzy.did_you_mean(Fuzzy.suggest(key, used, 2))
		# The case from the dogfood test: a colour put in the wrong field.
		if used.has("color") and d[k] is String and Color.html_is_valid(d[k]):
			hint = " It looks like a colour: pass it as 'color'."
		out.append("ops[%d] (%s): ignored '%s' (%s uses: %s).%s" % [i, op, key, op, ", ".join(used), hint])
	return out


# -------------------------------------------------------------------------------------
# Applying ops
# -------------------------------------------------------------------------------------

## Applies `ops` to `ts` in order. Returns {"value": {"ops": per-op results, "warnings":
## Array[String]}} or an error (in which case `ts` may be partially modified: callers
## dry-run on a duplicate first).
static func apply_ops(ts: TileSet, ops: Array) -> Dictionary:
	var results: Array = []
	var warnings: Array[String] = []
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
			"add_navigation_layer":
				r = _add_navigation_layer(ts, d, i)
			"set_navigation":
				r = _set_navigation(ts, d, i)
			"add_occlusion_layer":
				r = _add_occlusion_layer(ts, d, i)
			"set_occluder":
				r = _set_occluder(ts, d, i)
			"add_terrain_set":
				r = _add_terrain_set(ts, d, i)
			"add_terrain":
				r = _add_terrain(ts, d, i)
			"set_terrain":
				r = _set_terrain(ts, d, i)
			"add_custom_data":
				r = _add_custom_data(ts, d, i)
			"set_tile_data":
				r = _set_tile_data(ts, d, i)
			"add_alternative":
				r = _add_alternative(ts, d, i)
			"set_animation":
				r = _set_animation(ts, d, i)
			_:
				var names: Array = OP_KEYS.keys()
				return R.err(R.BAD_PARAMS, "tileset.edit: ops[%d].op '%s' is unknown.%s Valid ops: %s." %
					[i, op, Fuzzy.did_you_mean(Fuzzy.suggest(op, names, 2)), ", ".join(names)])
		if R.is_err(r):
			return r
		var entry: Dictionary = {"op": op}
		var rv: Dictionary = r["value"]
		# Ops may hand back warnings of their own (e.g. tiles removed for animation frames).
		if rv.has("warnings"):
			warnings.append_array(rv["warnings"])
			rv.erase("warnings")
		entry.merge(rv)
		results.append(entry)
		warnings.append_array(_unused_keys(d, op, i))
	return R.value({"ops": results, "warnings": warnings})


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
		return _bad(i, op, "source %d is a %s; only atlas sources have tiles with per-tile data." % [id, src.get_class()])
	return R.value(src)


static func _source_list(ts: TileSet) -> String:
	var ids: Array = []
	for k: int in range(ts.get_source_count()):
		ids.append(ts.get_source_id(k))
	if ids.is_empty():
		return " The TileSet has no sources yet; add one with an add_atlas op."
	return " Existing source ids: %s." % ", ".join(ids.map(func(x: int) -> String: return str(x)))


## The atlas coords an op targets: d.tiles ([[x, y], ...]) or, unless `required`, every
## tile of the source.
static func _target_tiles(at: TileSetAtlasSource, d: Dictionary, i: int, op: String, required: bool = false) -> Dictionary:
	var out: Array[Vector2i] = []
	if not d.has("tiles") or d["tiles"] == null:
		if required:
			return _bad(i, op, "'tiles' is required: the atlas coords to change, e.g. [[0, 3]].")
		for k: int in range(at.get_tiles_count()):
			out.append(at.get_tile_id(k))
		if out.is_empty():
			return _bad(i, op, "the source has no tiles; create them first (add_atlas with create_tiles).")
		return R.value(out)
	if not d["tiles"] is Array or (d["tiles"] as Array).is_empty():
		return _bad(i, op, "'tiles' must be a non-empty list of atlas coords like [[0, 0], [1, 0]]%s." % ("" if required else " (omit it for every tile)"))
	for t: Variant in d["tiles"]:
		var c: Variant = vec2i(t)
		if c == null:
			return _bad(i, op, "tile %s is not an [x, y] atlas coordinate." % js(t))
		if not at.has_tile(c):
			var hint: String = ""
			var origin: Vector2i = at.get_tile_at_coords(c)
			if origin != Vector2i(-1, -1):
				hint = " It is covered by the larger (or animated) tile at %s; use that." % [[origin.x, origin.y]]
			return R.err(R.NOT_FOUND, "tileset.edit: ops[%d] (%s): the atlas has no tile at [%d, %d].%s Use grid.read or the add_atlas result to see existing tiles." % [i, op, (c as Vector2i).x, (c as Vector2i).y, hint])
		if not out.has(c):
			out.append(c)
	return R.value(out)


## The alternative ids of tile `c` an op touches: d.alt only, or every alternative (so
## variants keep the same collision/terrain/data as the base tile unless the caller picks
## one). Validated for every target tile before anything changes.
static func _target_alts(at: TileSetAtlasSource, c: Vector2i, d: Dictionary, i: int, op: String) -> Dictionary:
	if d.has("alt") and d["alt"] != null:
		var alt: Variant = _int(d["alt"])
		if alt == null or not at.has_alternative_tile(c, alt):
			var ids: Array = []
			for a: int in range(at.get_alternative_tiles_count(c)):
				ids.append(at.get_alternative_tile_id(c, a))
			return R.err(R.NOT_FOUND, "tileset.edit: ops[%d] (%s): tile [%d, %d] has no alternative %s (it has %s; 0 is the base tile). Omit 'alt' for every alternative." % [i, op, c.x, c.y, js(d["alt"]), js(ids)])
		return R.value([alt])
	var out: Array = []
	for a: int in range(at.get_alternative_tiles_count(c)):
		out.append(at.get_alternative_tile_id(c, a))
	return R.value(out)


## Resolves tiles + alternatives up front: {"value": [[coords, [alt ids]], ...]} or an error.
static func _targets(at: TileSetAtlasSource, d: Dictionary, i: int, op: String) -> Dictionary:
	var tiles: Dictionary = _target_tiles(at, d, i, op)
	if R.is_err(tiles):
		return tiles
	var out: Array = []
	for c: Vector2i in tiles["value"]:
		var alts: Dictionary = _target_alts(at, c, d, i, op)
		if R.is_err(alts):
			return alts
		out.append([c, alts["value"]])
	return R.value(out)


## d.polygon as {"value": PackedVector2Array} (empty = remove), {"value": null} when the
## op should use the full tile, or an error. `what` names the effect of [] for messages.
static func _polygon(d: Dictionary, i: int, op: String, what: String) -> Dictionary:
	if not d.has("polygon") or d["polygon"] == null:
		return R.value(null)
	if not d["polygon"] is Array:
		return _bad(i, op, "'polygon' must be a list of [x, y] points relative to the tile center, or [] to remove the %s." % what)
	var pts := PackedVector2Array()
	for p: Variant in d["polygon"]:
		if not (p is Array and (p as Array).size() == 2 and _num(p[0]) and _num(p[1])):
			return _bad(i, op, "polygon point %s is not an [x, y] pair." % js(p))
		pts.append(Vector2(float(p[0]), float(p[1])))
	if pts.size() > 0 and pts.size() < 3:
		return _bad(i, op, "'polygon' needs at least 3 points (or [] to remove the %s)." % what)
	return R.value(pts)


## The full-tile rectangle of tile `c`, in px relative to its center (the default shape).
static func _full_tile(at: TileSetAtlasSource, c: Vector2i) -> PackedVector2Array:
	var h: Vector2 = Vector2(at.texture_region_size * at.get_tile_size_in_atlas(c)) * 0.5
	return PackedVector2Array([Vector2(-h.x, -h.y), Vector2(h.x, -h.y), Vector2(h.x, h.y), Vector2(-h.x, h.y)])


## Layer index field `key` (default 0), checked against `count` layers.
static func _layer(d: Dictionary, key: String, count: int, i: int, op: String, kind: String, add_op: String) -> Dictionary:
	var raw: Variant = d.get(key, 0)
	if raw == null:
		raw = 0
	var layer: Variant = _int(raw)
	if layer == null or int(layer) < 0 or int(layer) >= count:
		return _bad(i, op, "%s layer %s does not exist (the TileSet has %d). Add one first with an %s op." % [kind, js(raw), count, add_op])
	return R.value(layer)


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
	# `layer` is accepted as an alias: the navigation/occlusion ops call it that, and a
	# caller who writes it here means the physics layer (ignoring it would silently put
	# the shape on layer 0).
	var key: String = "physics_layer" if d.get("physics_layer") != null or d.get("layer") == null else "layer"
	var lr: Dictionary = _layer(d, key, ts.get_physics_layers_count(), i, "set_collision", "physics", "add_physics_layer")
	if R.is_err(lr):
		return lr
	var layer: int = lr["value"]
	var poly: Dictionary = _polygon(d, i, "set_collision", "collision")
	if R.is_err(poly):
		return poly
	var custom: Variant = poly["value"]
	var one_way: Dictionary = _opt_bool(d, "one_way", null, i, "set_collision")
	if R.is_err(one_way):
		return one_way
	var margin: Variant = d.get("one_way_margin")
	if margin != null and not (_num(margin) and float(margin) >= 0.0):
		return _bad(i, "set_collision", "'one_way_margin' must be a number >= 0 (px of tolerance for one-way collisions; Godot's default is 1).")
	var targets: Dictionary = _targets(at, d, i, "set_collision")
	if R.is_err(targets):
		return targets
	for t: Array in targets["value"]:
		var c: Vector2i = t[0]
		var pts: PackedVector2Array = custom if custom != null else _full_tile(at, c)
		for alt: int in t[1]:
			var td: TileData = at.get_tile_data(c, alt)
			while td.get_collision_polygons_count(layer) > 0:
				td.remove_collision_polygon(layer, 0)
			if pts.is_empty():
				continue
			td.add_collision_polygon(layer)
			td.set_collision_polygon_points(layer, 0, pts)
			# One-way platforms: per polygon in TileData, so it is set on the polygon just added.
			if one_way["value"] != null:
				td.set_collision_polygon_one_way(layer, 0, one_way["value"])
			if margin != null:
				td.set_collision_polygon_one_way_margin(layer, 0, float(margin))
	var out: Dictionary = {"source": int(_opt_int(d, "source", -1)), "physics_layer": layer, "tiles": (targets["value"] as Array).size(),
		"removed": custom != null and (custom as PackedVector2Array).is_empty()}
	if one_way["value"] != null:
		out["one_way"] = one_way["value"]
	return R.value(out)


static func _add_navigation_layer(ts: TileSet, d: Dictionary, i: int) -> Dictionary:
	var layers: Variant = _opt_int(d, "layers", 1)
	if layers == null or int(layers) < 0:
		return _bad(i, "add_navigation_layer", "'layers' must be an integer bitmask of navigation layers (1 = layer 1).")
	ts.add_navigation_layer()
	var idx: int = ts.get_navigation_layers_count() - 1
	ts.set_navigation_layer_layers(idx, layers)
	return R.value({"navigation_layer": idx})


## A NavigationPolygon covering `pts` exactly: the shape is stored as an outline AND baked
## with NavigationServer2D (agent_radius 0, so the
## walkable area is not shrunk) into convex polygons. Both halves are used: TileMapLayer's
## own navigation regions use the baked vertices/polygons (verified on 4.7.2: with an
## outline only, map_get_path over the layer's cells finds nothing), and NavigationRegion2D
## bakes that parse a TileMapLayer read the outlines (core/world_nav.gd does; the e2e test
## covers the editor's engine parser too). Baking also splits concave shapes into convex
## polygons, which navigation requires. Returns null when the shape bakes to nothing
## (degenerate or self-intersecting).
static func _nav_polygon(pts: PackedVector2Array) -> NavigationPolygon:
	var np := NavigationPolygon.new()
	np.agent_radius = 0.0
	np.add_outline(pts)
	var geo := NavigationMeshSourceGeometryData2D.new()
	geo.add_traversable_outline(pts)
	NavigationServer2D.bake_from_source_geometry_data(np, geo)
	if np.get_polygon_count() == 0:
		return null
	return np


static func _set_navigation(ts: TileSet, d: Dictionary, i: int) -> Dictionary:
	var s: Dictionary = _source(ts, d, i, "set_navigation", true)
	if R.is_err(s):
		return s
	var at: TileSetAtlasSource = s["value"]
	var lr: Dictionary = _layer(d, "layer", ts.get_navigation_layers_count(), i, "set_navigation", "navigation", "add_navigation_layer")
	if R.is_err(lr):
		return lr
	var layer: int = lr["value"]
	var poly: Dictionary = _polygon(d, i, "set_navigation", "navigation polygon")
	if R.is_err(poly):
		return poly
	var custom: Variant = poly["value"]
	var targets: Dictionary = _targets(at, d, i, "set_navigation")
	if R.is_err(targets):
		return targets
	# Bake every distinct shape before changing anything, so a bad polygon fails the op
	# cleanly (one shape per tile size when the default full tile is used).
	var baked: Dictionary = {}
	for t: Array in targets["value"]:
		var pts: PackedVector2Array = custom if custom != null else _full_tile(at, t[0])
		if pts.is_empty() or baked.has(pts):
			continue
		var np: NavigationPolygon = _nav_polygon(pts)
		if np == null:
			return _bad(i, "set_navigation", "the polygon %s bakes to no walkable area (degenerate or self-intersecting); list the corners in order around the shape." % js(Array(pts).map(func(v: Vector2) -> Array: return [v.x, v.y])))
		baked[pts] = np
	for t: Array in targets["value"]:
		var c: Vector2i = t[0]
		var pts2: PackedVector2Array = custom if custom != null else _full_tile(at, c)
		# One NavigationPolygon per tile, so editing one tile's resource later (e.g. in the
		# inspector) never changes another tile; the tile's alternatives share it, like the
		# copies add_alternative makes (one sub-resource referenced twice in the .tres).
		var np2: NavigationPolygon = null
		if not pts2.is_empty():
			np2 = (baked[pts2] as NavigationPolygon).duplicate()
		for alt: int in t[1]:
			at.get_tile_data(c, alt).set_navigation_polygon(layer, np2)
	return R.value({"source": int(_opt_int(d, "source", -1)), "navigation_layer": layer, "tiles": (targets["value"] as Array).size(),
		"removed": custom != null and (custom as PackedVector2Array).is_empty()})


static func _add_occlusion_layer(ts: TileSet, d: Dictionary, i: int) -> Dictionary:
	var mask: Variant = _opt_int(d, "light_mask", 1)
	if mask == null or int(mask) < 0:
		return _bad(i, "add_occlusion_layer", "'light_mask' must be an integer bitmask of light layers (1 = layer 1).")
	var sdf: Dictionary = _opt_bool(d, "sdf_collision", false, i, "add_occlusion_layer")
	if R.is_err(sdf):
		return sdf
	ts.add_occlusion_layer()
	var idx: int = ts.get_occlusion_layers_count() - 1
	ts.set_occlusion_layer_light_mask(idx, mask)
	ts.set_occlusion_layer_sdf_collision(idx, sdf["value"])
	return R.value({"occlusion_layer": idx})


static func _set_occluder(ts: TileSet, d: Dictionary, i: int) -> Dictionary:
	var s: Dictionary = _source(ts, d, i, "set_occluder", true)
	if R.is_err(s):
		return s
	var at: TileSetAtlasSource = s["value"]
	var lr: Dictionary = _layer(d, "layer", ts.get_occlusion_layers_count(), i, "set_occluder", "occlusion", "add_occlusion_layer")
	if R.is_err(lr):
		return lr
	var layer: int = lr["value"]
	var poly: Dictionary = _polygon(d, i, "set_occluder", "occluder")
	if R.is_err(poly):
		return poly
	var custom: Variant = poly["value"]
	var targets: Dictionary = _targets(at, d, i, "set_occluder")
	if R.is_err(targets):
		return targets
	for t: Array in targets["value"]:
		var c: Vector2i = t[0]
		var pts: PackedVector2Array = custom if custom != null else _full_tile(at, c)
		# One OccluderPolygon2D per tile, shared by its alternatives (as for navigation).
		var occ: OccluderPolygon2D = null
		if not pts.is_empty():
			occ = OccluderPolygon2D.new()
			occ.polygon = pts
		for alt: int in t[1]:
			var td: TileData = at.get_tile_data(c, alt)
			td.set_occluder_polygons_count(layer, 0)
			if occ != null:
				td.add_occluder_polygon(layer)
				td.set_occluder_polygon(layer, 0, occ)
	return R.value({"source": int(_opt_int(d, "source", -1)), "occlusion_layer": layer, "tiles": (targets["value"] as Array).size(),
		"removed": custom != null and (custom as PackedVector2Array).is_empty()})


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


## "the TileSet has 0" / "valid: 0-2": the end of a missing-terrain-set message.
static func _terrain_set_msg(ts: TileSet, d: Dictionary, add_hint: String) -> String:
	var shown: String = js(d["terrain_set"]) if d.get("terrain_set") != null else "(default: the last one)"
	return "terrain set %s does not exist (the TileSet has %d). %s" % [shown, ts.get_terrain_sets_count(), add_hint]


static func _add_terrain(ts: TileSet, d: Dictionary, i: int) -> Dictionary:
	var t: Variant = _terrain_set(ts, d)
	if t == null:
		return _bad(i, "add_terrain", _terrain_set_msg(ts, d, "Add one with an add_terrain_set op first."))
	var col: Variant = d.get("color")
	var color: Variant = null
	if col != null:
		if col is String and Color.html_is_valid(col):
			color = Color.html(col)
		elif col is Array and (col as Array).size() in [3, 4] and (col as Array).all(_num):
			color = Color(float(col[0]), float(col[1]), float(col[2]), float(col[3]) if (col as Array).size() > 3 else 1.0)
		else:
			return _bad(i, "add_terrain", "'color' must be \"#rrggbb\" or [r, g, b] (0-1), got %s." % js(col))
	ts.add_terrain(t)
	var idx: int = ts.get_terrains_count(t) - 1
	var terrain_name: String = str(d.get("name", "Terrain %d" % idx))
	ts.set_terrain_name(t, idx, terrain_name)
	if color != null:
		ts.set_terrain_color(t, idx, color)
	return R.value({"terrain_set": t, "terrain": idx, "name": terrain_name})


static func _set_terrain(ts: TileSet, d: Dictionary, i: int) -> Dictionary:
	var s: Dictionary = _source(ts, d, i, "set_terrain", true)
	if R.is_err(s):
		return s
	var at: TileSetAtlasSource = s["value"]
	var t: Variant = _terrain_set(ts, d)
	if t == null:
		return _bad(i, "set_terrain", _terrain_set_msg(ts, d, "Add one with add_terrain_set."))
	var terrain: Variant = _opt_int(d, "terrain", 0)
	if terrain == null or int(terrain) < -1 or int(terrain) >= ts.get_terrains_count(t):
		return _bad(i, "set_terrain", "terrain %s does not exist in terrain set %d (it has %d terrains; -1 clears)." % [js(d.get("terrain")), t, ts.get_terrains_count(t)])
	var peering: Dictionary = {}
	if d.has("peering") and d["peering"] != null:
		if not d["peering"] is Dictionary:
			return _bad(i, "set_terrain", "'peering' must be an object like {\"right_side\": 0, \"bottom_side\": 0} or {\"all\": 0}.")
		peering = d["peering"]
	# Validate the peering table before touching any tile (atomic per op as well).
	for key: Variant in peering:
		var pv: Variant = _int(peering[key])
		if pv == null or int(pv) < -1 or int(pv) >= ts.get_terrains_count(t):
			return _bad(i, "set_terrain", "peering value for '%s' must be a terrain index of set %d or -1, got %s." % [key, t, js(peering[key])])
		if str(key) != "all" and not PEERING_BITS.has(str(key)):
			return _bad(i, "set_terrain", "unknown peering bit '%s'.%s Valid names: all, %s." % [key, Fuzzy.did_you_mean(Fuzzy.suggest(str(key), PEERING_BITS.keys(), 2)), ", ".join(PEERING_BITS.keys())])
	var targets: Dictionary = _targets(at, d, i, "set_terrain")
	if R.is_err(targets):
		return targets
	for tg: Array in targets["value"]:
		var c: Vector2i = tg[0]
		for alt: int in tg[1]:
			var td: TileData = at.get_tile_data(c, alt)
			td.terrain_set = t
			td.terrain = terrain
			for key: Variant in peering:
				var pv: int = _int(peering[key])
				if str(key) == "all":
					for b: int in PEERING_BITS.values():
						if td.is_valid_terrain_peering_bit(b):
							td.set_terrain_peering_bit(b, pv)
					continue
				var bit: int = PEERING_BITS[str(key)]
				if not td.is_valid_terrain_peering_bit(bit):
					return _bad(i, "set_terrain", "peering bit '%s' is not used by this terrain set's mode/tile shape (e.g. square tiles use *_side and *_corner names like right_side, bottom_right_corner)." % key)
				td.set_terrain_peering_bit(bit, pv)
	return R.value({"source": int(_opt_int(d, "source", -1)), "terrain_set": t, "terrain": terrain, "tiles": (targets["value"] as Array).size()})


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


# -------------------------------------------------------------------------------------
# Per-tile values, alternatives, animation
# -------------------------------------------------------------------------------------

## Decodes d.values once for every tile: {"value": [[is_custom, key, value], ...]} or an
## error. Keys are custom data layer NAMES (checked first: the caller named those layers)
## or TileData properties from TILE_PROPS. Values go through the same type-directed
## decoder as node.set (core/variant_codec.gd), so a bool layer takes true, a Color
## property "#ff0000" or [1, 0, 0], z_index 2.0 becomes 2, and material takes a res://
## path or {"new": "ShaderMaterial", ...}.
static func _plan_values(ts: TileSet, d: Dictionary, i: int, op: String, required: bool) -> Dictionary:
	var raw: Variant = d.get("values")
	if raw == null:
		if required:
			return _bad(i, op, "'values' is required, e.g. {\"hazard\": true} (custom data by layer name) or {\"modulate\": \"#ff8080\", \"z_index\": 1}.")
		return R.value([])
	if not raw is Dictionary or (required and (raw as Dictionary).is_empty()):
		return _bad(i, op, "'values' must be an object like {\"hazard\": true, \"z_index\": 1}.")
	var out: Array = []
	# A detached TileData only to read property infos (types, hints); freed below.
	var sample := TileData.new()
	for k: Variant in raw:
		var key: String = str(k)
		var info: Dictionary
		var custom: bool = false
		var layer: int = ts.get_custom_data_layer_by_name(key)
		if layer != -1:
			custom = true
			info = {"name": key, "type": ts.get_custom_data_layer_type(layer), "hint": PROPERTY_HINT_NONE, "hint_string": ""}
		elif TILE_PROPS.has(key):
			info = Codec.find_property(sample, key)
		else:
			var custom_names: Array = []
			for c: int in range(ts.get_custom_data_layers_count()):
				custom_names.append(ts.get_custom_data_layer_name(c))
			sample.free()
			return R.err(R.NOT_FOUND, "tileset.edit: ops[%d] (%s): '%s' is neither a custom data layer nor a tile property.%s Custom data layers: %s (add one with add_custom_data first). Tile properties: %s." %
				[i, op, key, Fuzzy.did_you_mean(Fuzzy.suggest(key, custom_names + Array(TILE_PROPS), 2)),
				", ".join(custom_names) if not custom_names.is_empty() else "(none)", ", ".join(TILE_PROPS)])
		var dec: Dictionary = Codec.decode_typed(raw[k], info, null)
		if R.is_err(dec):
			sample.free()
			var e: Dictionary = dec["error"]
			return R.err(str(e["code"]), "tileset.edit: ops[%d] (%s): %s" % [i, op, str(e["message"])])
		out.append([custom, key, dec["value"]])
	sample.free()
	return R.value(out)


static func _apply_values(td: TileData, values: Array) -> void:
	for v: Array in values:
		if v[0]:
			td.set_custom_data(v[1], v[2])
		else:
			td.set(v[1], v[2])


static func _set_tile_data(ts: TileSet, d: Dictionary, i: int) -> Dictionary:
	var s: Dictionary = _source(ts, d, i, "set_tile_data", true)
	if R.is_err(s):
		return s
	var at: TileSetAtlasSource = s["value"]
	var values: Dictionary = _plan_values(ts, d, i, "set_tile_data", true)
	if R.is_err(values):
		return values
	var targets: Dictionary = _targets(at, d, i, "set_tile_data")
	if R.is_err(targets):
		return targets
	for t: Array in targets["value"]:
		for alt: int in t[1]:
			_apply_values(at.get_tile_data(t[0], alt), values["value"])
	return R.value({"source": int(_opt_int(d, "source", -1)), "tiles": (targets["value"] as Array).size(),
		"values": (values["value"] as Array).map(func(v: Array) -> String: return v[1])})


## Copies every stored TileData property (rendering flags, terrain, collision, navigation,
## occlusion, custom data) from `from` to `to`; the property names include the per-layer
## dynamic ones such as "physics_layer_0/polygon_0/points" (verified on 4.7.2).
static func _copy_tile_data(from: TileData, to: TileData) -> void:
	for p: Dictionary in from.get_property_list():
		var pname: String = p["name"]
		if (int(p["usage"]) & PROPERTY_USAGE_STORAGE) and pname != "script":
			to.set(pname, from.get(pname))


static func _add_alternative(ts: TileSet, d: Dictionary, i: int) -> Dictionary:
	var s: Dictionary = _source(ts, d, i, "add_alternative", true)
	if R.is_err(s):
		return s
	var at: TileSetAtlasSource = s["value"]
	var tiles: Dictionary = _target_tiles(at, d, i, "add_alternative", true)
	if R.is_err(tiles):
		return tiles
	var values: Dictionary = _plan_values(ts, d, i, "add_alternative", false)
	if R.is_err(values):
		return values
	var override: Variant = -1
	if d.get("alt") != null:
		override = _int(d["alt"])
		if override == null or int(override) < 1:
			return _bad(i, "add_alternative", "'alt' (optional id for the new alternative) must be an integer >= 1 (0 is the base tile); omit it for the next free id.")
		for c: Vector2i in tiles["value"]:
			if at.has_alternative_tile(c, override):
				return R.err(R.CONFLICT, "tileset.edit: ops[%d] (add_alternative): tile [%d, %d] already has alternative %d; omit 'alt' to get the next free id (%d)." % [i, c.x, c.y, override, at.get_next_alternative_tile_id(c)])
	var created: Array = []
	for c: Vector2i in tiles["value"]:
		var alt: int = at.create_alternative_tile(c, override)
		var td: TileData = at.get_tile_data(c, alt)
		# Godot creates alternatives with default (empty) data. Start from a copy of the base
		# tile instead, so a flipped or tinted variant keeps its terrain, custom data and
		# collision. Note that TileData.flip_h/flip_v/transpose flip the TEXTURE only: the
		# copied collision polygon is not mirrored (verified on 4.7.2 with a half-tile shape
		# and a physics point query); an asymmetric shape needs set_collision with `alt`.
		_copy_tile_data(at.get_tile_data(c, 0), td)
		_apply_values(td, values["value"])
		created.append([c.x, c.y, alt])
	# [x, y, alt] triples: exactly grid.edit's `atlas` and `alt` for painting the new tiles.
	return R.value({"source": int(_opt_int(d, "source", -1)), "alternatives": created})


static func _set_animation(ts: TileSet, d: Dictionary, i: int) -> Dictionary:
	var op: String = "set_animation"
	var s: Dictionary = _source(ts, d, i, op, true)
	if R.is_err(s):
		return s
	var at: TileSetAtlasSource = s["value"]
	var tiles: Dictionary = _target_tiles(at, d, i, op, true)
	if R.is_err(tiles):
		return tiles
	var frames: Variant = _int(d.get("frames"))
	if frames == null or int(frames) < 1:
		return _bad(i, op, "'frames' (the number of animation frames, >= 1; 1 stops the animation) is required, got %s." % js(d.get("frames")))
	var columns: Variant = _opt_int(d, "columns", 0)
	if columns == null or int(columns) < 0:
		return _bad(i, op, "'columns' must be an integer >= 0 (frames per row in the atlas; 0 = all frames in one row).")
	var sep: Variant = _opt_vec2i(d, "separation", Vector2i.ZERO)
	if sep == null or (sep as Vector2i).x < 0 or (sep as Vector2i).y < 0:
		return _bad(i, op, "'separation' must be [x, y] with the number of atlas cells between frames (>= 0), e.g. [0, 0].")
	var speed: Variant = d.get("speed", 1.0)
	if speed == null:
		speed = 1.0
	if not (_num(speed) and float(speed) > 0.0):
		return _bad(i, op, "'speed' must be a number > 0 (a multiplier on the frame durations; default 1).")
	var durations: Array[float] = []
	var raw_dur: Variant = d.get("duration", 1.0)
	if raw_dur == null:
		raw_dur = 1.0
	if _num(raw_dur):
		for f: int in range(frames):
			durations.append(float(raw_dur))
	elif raw_dur is Array and (raw_dur as Array).size() == int(frames) and (raw_dur as Array).all(_num):
		for v: Variant in raw_dur:
			durations.append(float(v))
	else:
		return _bad(i, op, "'duration' must be seconds per frame: one number for every frame, or a list with one number per frame (%d), got %s." % [frames, js(raw_dur)])
	if durations.any(func(x: float) -> bool: return x <= 0.0):
		return _bad(i, op, "frame durations must be > 0 seconds.")
	var mode_name: String = str(d.get("mode", "default")) if d.get("mode") != null else "default"
	if not ANIMATION_MODES.has(mode_name):
		return _bad(i, op, "'mode' must be \"default\" or \"random_start_times\" (each cell starts at a random frame), got '%s'." % mode_name)
	# Work out every frame's atlas cells and what is in the way, for all tiles first.
	var grid: Vector2i = at.get_atlas_grid_size()
	var cols: int = int(columns) if int(columns) > 0 else int(frames)
	var to_remove: Array[Vector2i] = []
	var animated: Array = tiles["value"]
	for c: Vector2i in animated:
		var size: Vector2i = at.get_tile_size_in_atlas(c)
		for f: int in range(1, frames):
			var origin: Vector2i = c + (size + (sep as Vector2i)) * Vector2i(f % cols, floori(f / float(cols)))
			if origin.x + size.x > grid.x or origin.y + size.y > grid.y:
				return _bad(i, op, ("frame %d of tile [%d, %d] would be at atlas cell [%d, %d], outside the %dx%d atlas. " +
					"Put the frames to the right of / below the tile, or wrap them with 'columns'.") % [f, c.x, c.y, origin.x, origin.y, grid.x, grid.y])
			for y: int in range(origin.y, origin.y + size.y):
				for x: int in range(origin.x, origin.x + size.x):
					var other: Vector2i = at.get_tile_at_coords(Vector2i(x, y))
					if other == Vector2i(-1, -1) or other == c:
						continue
					if animated.has(other):
						return _bad(i, op, "the frames of tile [%d, %d] would cover tile [%d, %d], which this op animates too; animate them in separate rows or fewer frames." % [c.x, c.y, other.x, other.y])
					if not to_remove.has(other):
						to_remove.append(other)
	# Frame cells hold the frame images, so tiles there (add_atlas creates one for every
	# opaque cell, frames included) are removed: Godot cannot animate over them, and there
	# is no other op to remove a tile. Reported as a warning, since map cells painted with
	# a removed tile render empty.
	for o: Vector2i in to_remove:
		at.remove_tile(o)
	var removed: Array = to_remove.map(func(v: Vector2i) -> Array: return [v.x, v.y])
	for c: Vector2i in animated:
		var size2: Vector2i = at.get_tile_size_in_atlas(c)
		if not at.has_room_for_tile(c, size2, columns, sep, frames, c):
			# Should not happen after the checks above; never let the engine setters fail.
			return R.err(R.INTERNAL, "tileset.edit: ops[%d] (%s): the atlas still has no room for %d frames of tile [%d, %d]." % [i, op, frames, c.x, c.y])
		# Shrink to one frame first: with one frame any layout fits, so the separation and
		# columns setters (which re-check the room for the current frame count) never fail.
		at.set_tile_animation_frames_count(c, 1)
		at.set_tile_animation_separation(c, sep)
		at.set_tile_animation_columns(c, columns)
		at.set_tile_animation_frames_count(c, frames)
		for f: int in range(frames):
			at.set_tile_animation_frame_duration(c, f, durations[f])
		at.set_tile_animation_speed(c, float(speed))
		at.set_tile_animation_mode(c, ANIMATION_MODES[mode_name])
	var out: Dictionary = {"source": int(_opt_int(d, "source", -1)), "tiles": animated.size(), "frames": frames}
	if not removed.is_empty():
		out["removed_tiles"] = removed
		out["warnings"] = ["ops[%d] (set_animation): removed tiles %s because their atlas cells are now animation frames; map cells painted with them render empty." % [i, js(removed)]]
	return R.value(out)
