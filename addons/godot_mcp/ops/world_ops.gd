@tool
extends RefCounted
## World building: TileMapLayer/GridMap cells, TileSet atlas sources, navigation baking.
##
## Registered in core/methods.gd (MODULES). `methods()` maps each bridge-protocol method
## this module implements to a descriptor (see the comment on Methods.MODULES for kinds).
##
##   grid.read        scene_read      cells + palette (TileSet sources / MeshLibrary items)
##   grid.edit        scene_mutation  set / erase / fill_rect / clear / terrain, one undo step
##   tileset.edit     project         edit or create a TileSet .tres (saved immediately)
##   navigation.bake  scene_mutation  bake a NavigationRegion2D/3D (undoable in the editor)
##   navigation.path  scene_read      shortest path over the scene's baked regions
##
## Only TileMapLayer is supported for tiles: TileMap is deprecated since Godot 4.3 and its
## multi-layer API differs; the editor can convert a TileMap into TileMapLayer nodes.
##
## How grid.edit stays undoable and cheap: the ops are first replayed on a *scratch* copy
## of the node (a fresh TileMapLayer/GridMap that is never added to the scene, loaded with
## the same tile data), which validates them and tells us the exact end state, including
## what terrain painting decides for neighbouring cells. The ChangeSet then either
## * re-sets only the touched cells (small edits: per-cell set_cell / set_cell_item with
##   the previous values as undo), or
## * swaps the whole cell data (TileMapLayer.tile_map_data, a PackedByteArray of ~12 bytes
##   per cell; GridMap's "data" dictionary) when the edit is large, clears the map, or uses
##   terrains (whose affected cells are not known up front). That costs two copies of the
##   map's data in the undo history but only one undo entry instead of thousands.

const R := preload("../core/mcp_result.gd")
const Params := preload("../core/params.gd")
const NodePaths := preload("../core/node_paths.gd")
const ResPaths := preload("../core/res_paths.gd")
const ChangeSet := preload("../core/change_set.gd")
const Fuzzy := preload("../core/fuzzy.gd")
const WorldNav := preload("../core/world_nav.gd")
const WorldTileset := preload("../core/world_tileset.gd")
## Use instead of ResourceSaver.save: headless saves drop UIDs otherwise (see res_save.gd).
const ResSave := preload("../core/res_save.gd")

## Max cells one grid.edit call may address (sum over its ops; `clear` counts as 0).
const MAX_CELLS: int = 10000
## Edits touching more cells than this switch from per-cell undo to a data snapshot.
const PER_CELL_UNDO_LIMIT: int = 256
const GRID_OPS: PackedStringArray = ["set", "erase", "fill_rect", "clear", "terrain"]


static func methods() -> Dictionary:
	return {
		"grid.read": {"kind": "scene_read", "fn": read_grid},
		"grid.edit": {"kind": "scene_mutation", "fn": plan_grid_edit},
		"tileset.edit": {"kind": "project", "fn": do_tileset_edit},
		"navigation.bake": {"kind": "scene_mutation", "fn": plan_navigation_bake},
		"navigation.path": {"kind": "scene_read", "fn": read_navigation_path},
	}


# =====================================================================================
# Shared helpers
# =====================================================================================

## Paths of nodes under `root` for which `pred(node)` is true (for actionable errors).
static func _find_nodes(root: Node, pred: Callable, limit: int = 20) -> Array[String]:
	var out: Array[String] = []
	var stack: Array[Node] = [root]
	while not stack.is_empty() and out.size() < limit:
		var n: Node = stack.pop_back()
		if pred.call(n):
			out.append(NodePaths.rel_path(root, n))
		var kids: Array[Node] = n.get_children()
		kids.reverse()
		stack.append_array(kids)
	return out


static func _is_grid(n: Node) -> bool:
	return n is TileMapLayer or n is GridMap


static func _is_region(n: Node) -> bool:
	return n is NavigationRegion2D or n is NavigationRegion3D


## Resolves params.path to a TileMapLayer or GridMap. Returns {"value": node} or an error.
static func _grid_node(root: Node, path: String, method: String) -> Dictionary:
	var res: Dictionary = NodePaths.resolve(root, path)
	if R.is_err(res):
		return res
	var node: Node = res["value"]
	if node.get_class() == "TileMap":
		return R.err(R.UNSUPPORTED, ("%s: '%s' is a TileMap, which is deprecated since Godot 4.3 and not supported here. " +
			"Convert it to TileMapLayer nodes: in the editor select it and use the TileMap bottom panel's toolbar menu " +
			"(\"Extract TileMap layers as individual TileMapLayer nodes\"), or add a TileMapLayer with node.add and the same tile_set.") % [method, path])
	if not _is_grid(node):
		var found: Array[String] = _find_nodes(root, _is_grid)
		return R.err(R.BAD_PARAMS, "%s: '%s' is a %s, not a TileMapLayer or GridMap. %s" % [method, path, node.get_class(),
			("TileMapLayer/GridMap nodes in this scene: %s." % ", ".join(found)) if not found.is_empty() else "This scene has none; add one with node.add (type TileMapLayer or GridMap)."])
	return R.value(node)


static func _int(v: Variant) -> Variant:
	if v is int:
		return v
	if v is float and is_finite(v) and float(v) == floorf(v):
		return int(v)
	return null


## A cell as [x, y] / [x, y, z] or {"x","y"(,"z")} -> Vector2i / Vector3i, or null.
static func _cell(v: Variant, dims: int) -> Variant:
	var arr: Array = []
	if v is Array:
		arr = v
	elif v is Dictionary:
		var d: Dictionary = v
		arr = [d.get("x"), d.get("y")] if dims == 2 else [d.get("x"), d.get("y"), d.get("z")]
	if arr.size() != dims:
		return null
	var ints: Array[int] = []
	for e: Variant in arr:
		var n: Variant = _int(e)
		if n == null:
			return null
		ints.append(n)
	if dims == 2:
		return Vector2i(ints[0], ints[1])
	return Vector3i(ints[0], ints[1], ints[2])


static func _tile_set_path(ts: Resource) -> Variant:
	if ts == null:
		return null
	if ts.resource_path.is_empty() or ts.resource_path.contains("::"):
		return "(embedded in the scene)"
	return ts.resource_path


# =====================================================================================
# grid.read
# =====================================================================================

static func read_grid(root: Node, params: Variant) -> Dictionary:
	var p := Params.new(params, "grid.read")
	var path: String = p.req_string("path")
	var region: Dictionary = p.opt_dict("region", {})
	var limit: int = p.opt_int("limit", 500)
	var summary_only: bool = p.opt_bool("summary_only", false)
	if p.failed():
		return p.error
	if limit < 1 or limit > 10000:
		return R.err(R.BAD_PARAMS, "grid.read: 'limit' must be between 1 and 10000.")
	var g: Dictionary = _grid_node(root, path, "grid.read")
	if R.is_err(g):
		return g
	var node: Node = g["value"]
	if node is TileMapLayer:
		return _read_tiles(root, node as TileMapLayer, region, limit, summary_only)
	return _read_gridmap(root, node as GridMap, region, limit, summary_only)


## Parses region {x,y,w,h} (3D adds z,d). Returns {"value": [min: Vector3i, max_excl: Vector3i]} or an error.
static func _region(region: Dictionary, dims: int, method: String) -> Dictionary:
	var keys: Array[String] = ["x", "y", "w", "h"]
	if dims == 3:
		keys = ["x", "y", "z", "w", "h", "d"]
	var v: Dictionary = {}
	for k: String in keys:
		# Offsets default to 0; sizes are required.
		var fallback: Variant = null
		if k in ["x", "y", "z"]:
			fallback = 0
		var n: Variant = _int(region.get(k, fallback))
		if n == null:
			return R.err(R.BAD_PARAMS, "%s: region needs integer %s, e.g. %s." % [method, ", ".join(keys),
				"{\"x\": 0, \"y\": 0, \"w\": 16, \"h\": 16}" if dims == 2 else "{\"x\": 0, \"y\": 0, \"z\": 0, \"w\": 8, \"h\": 2, \"d\": 8}"])
		v[k] = n
	if int(v["w"]) < 1 or int(v["h"]) < 1 or (dims == 3 and int(v["d"]) < 1):
		return R.err(R.BAD_PARAMS, "%s: region sizes (w, h%s) must be at least 1." % [method, ", d" if dims == 3 else ""])
	var lo := Vector3i(v["x"], v["y"], v.get("z", 0))
	var size := Vector3i(v["w"], v["h"], v.get("d", 1))
	return R.value([lo, lo + size])


static func _read_tiles(root: Node, layer: TileMapLayer, region: Dictionary, limit: int, summary_only: bool) -> Dictionary:
	var used: Array[Vector2i] = layer.get_used_cells()
	var rect: Rect2i = layer.get_used_rect()
	var result: Dictionary = {
		"path": NodePaths.rel_path(root, layer),
		"type": "TileMapLayer",
		"tile_set": _tile_set_path(layer.tile_set),
		"used_cells": used.size(),
		"used_rect": {"x": rect.position.x, "y": rect.position.y, "w": rect.size.x, "h": rect.size.y},
	}
	if layer.tile_set != null:
		# summary_only is a real summary: per-source tile counts without the coordinate
		# lists (it used to omit only the cells and still listed every tile).
		var list_ids: Variant = null
		if summary_only:
			list_ids = []
		result.merge(WorldTileset.describe(layer.tile_set, list_ids))
	else:
		result["note"] = "No tile_set assigned: set one with node.set {\"tile_set\": \"res://....tres\"} (create it with tileset.edit create=true)."
	if summary_only:
		return R.ok(result)
	var cells: Array[Vector2i] = used
	if not region.is_empty():
		var rr: Dictionary = _region(region, 2, "grid.read")
		if R.is_err(rr):
			return rr
		var lo: Vector3i = rr["value"][0]
		var hi: Vector3i = rr["value"][1]
		cells = used.filter(func(c: Vector2i) -> bool: return c.x >= lo.x and c.x < hi.x and c.y >= lo.y and c.y < hi.y)
	cells.sort_custom(func(a: Vector2i, b: Vector2i) -> bool: return a.y < b.y or (a.y == b.y and a.x < b.x))
	var out: Array = []
	for c: Vector2i in cells.slice(0, limit):
		var ac: Vector2i = layer.get_cell_atlas_coords(c)
		out.append({"x": c.x, "y": c.y, "source": layer.get_cell_source_id(c), "atlas": [ac.x, ac.y], "alt": layer.get_cell_alternative_tile(c)})
	result["cells"] = out
	result["truncated"] = cells.size() > limit
	if cells.size() > limit:
		result["note"] = "Showing %d of %d cells; narrow with region or raise limit." % [limit, cells.size()]
	return R.ok(result)


static func _read_gridmap(root: Node, gm: GridMap, region: Dictionary, limit: int, summary_only: bool) -> Dictionary:
	var used: Array[Vector3i] = gm.get_used_cells()
	var result: Dictionary = {
		"path": NodePaths.rel_path(root, gm),
		"type": "GridMap",
		"mesh_library": _tile_set_path(gm.mesh_library),
		"cell_size": [gm.cell_size.x, gm.cell_size.y, gm.cell_size.z],
		"used_cells": used.size(),
	}
	if not used.is_empty():
		var lo: Vector3i = used[0]
		var hi: Vector3i = used[0]
		for c: Vector3i in used:
			lo = lo.min(c)
			hi = hi.max(c)
		result["bounds"] = {"x": lo.x, "y": lo.y, "z": lo.z, "w": hi.x - lo.x + 1, "h": hi.y - lo.y + 1, "d": hi.z - lo.z + 1}
	if gm.mesh_library != null:
		var items: Array = []
		for id: int in gm.mesh_library.get_item_list():
			items.append({"id": id, "name": gm.mesh_library.get_item_name(id)})
		result["items"] = items
	else:
		result["note"] = "No mesh_library assigned: set one with node.set {\"mesh_library\": \"res://....tres\"}."
	if summary_only:
		return R.ok(result)
	var cells: Array[Vector3i] = used
	if not region.is_empty():
		var rr: Dictionary = _region(region, 3, "grid.read")
		if R.is_err(rr):
			return rr
		var rlo: Vector3i = rr["value"][0]
		var rhi: Vector3i = rr["value"][1]
		cells = used.filter(func(c: Vector3i) -> bool:
			return c.x >= rlo.x and c.x < rhi.x and c.y >= rlo.y and c.y < rhi.y and c.z >= rlo.z and c.z < rhi.z)
	cells.sort_custom(func(a: Vector3i, b: Vector3i) -> bool:
		if a.y != b.y:
			return a.y < b.y
		if a.z != b.z:
			return a.z < b.z
		return a.x < b.x)
	var out: Array = []
	for c: Vector3i in cells.slice(0, limit):
		out.append({"x": c.x, "y": c.y, "z": c.z, "item": gm.get_cell_item(c), "orientation": gm.get_cell_item_orientation(c)})
	result["cells"] = out
	result["truncated"] = cells.size() > limit
	if cells.size() > limit:
		result["note"] = "Showing %d of %d cells; narrow with region or raise limit." % [limit, cells.size()]
	return R.ok(result)


# =====================================================================================
# grid.edit
# =====================================================================================

static func plan_grid_edit(root: Node, params: Variant) -> Dictionary:
	var p := Params.new(params, "grid.edit")
	var path: String = p.req_string("path")
	var ops: Array = p.opt_array("ops", [])
	if p.failed():
		return p.error
	if ops.is_empty():
		return R.err(R.BAD_PARAMS, "grid.edit: 'ops' must be a non-empty list, e.g. [{\"op\": \"set\", \"cells\": [[0, 0], [1, 0]], \"source\": 0, \"atlas\": [0, 0]}].")
	var g: Dictionary = _grid_node(root, path, "grid.edit")
	if R.is_err(g):
		return g
	var node: Node = g["value"]
	var edit_err: Dictionary = NodePaths.check_editable(root, node, "edit cells of")
	if not edit_err.is_empty():
		return edit_err
	var is_tiles: bool = node is TileMapLayer
	# Scratch copy: never in the scene, discarded at the end of planning.
	var scratch: Node
	if is_tiles:
		var layer := node as TileMapLayer
		var s := TileMapLayer.new()
		s.tile_set = layer.tile_set
		s.tile_map_data = layer.tile_map_data
		scratch = s
	else:
		var gm := node as GridMap
		var sg := GridMap.new()
		sg.mesh_library = gm.mesh_library
		sg.set("data", gm.get("data"))
		scratch = sg
	var state: Dictionary = {"touched": {}, "snapshot": false, "budget": 0, "warnings": [] as Array[String]}
	for i: int in range(ops.size()):
		var r: Dictionary = _apply_grid_op(node, scratch, ops[i], i, state)
		if R.is_err(r):
			scratch.free()
			return r
	var cs := ChangeSet.new()
	var changed: int = 0
	var undo_mode: String
	var touched: Dictionary = state["touched"]
	if bool(state["snapshot"]) or touched.size() > PER_CELL_UNDO_LIMIT:
		undo_mode = "snapshot"
		changed = _diff_count(node, scratch, is_tiles)
		if changed > 0:
			if is_tiles:
				cs.do_property(node, &"tile_map_data", (scratch as TileMapLayer).tile_map_data)
				cs.undo_property(node, &"tile_map_data", (node as TileMapLayer).tile_map_data)
			else:
				# Setting GridMap "data" adds cells without removing the old ones: clear first.
				cs.do_method(node, &"clear")
				cs.do_property(node, &"data", scratch.get("data"))
				cs.undo_method(node, &"clear")
				cs.undo_property(node, &"data", node.get("data"))
	else:
		undo_mode = "cells"
		for c: Variant in touched:
			var before: Array = _cell_value(node, c, is_tiles)
			var after: Array = _cell_value(scratch, c, is_tiles)
			if before == after:
				continue
			changed += 1
			if is_tiles:
				cs.do_method(node, &"set_cell", [c, after[0], after[1], after[2]])
				cs.undo_method(node, &"set_cell", [c, before[0], before[1], before[2]])
			else:
				cs.do_method(node, &"set_cell_item", [c, after[0], after[1]])
				cs.undo_method(node, &"set_cell_item", [c, before[0], before[1]])
	scratch.free()
	var warnings: Array[String] = state["warnings"]
	if changed == 0:
		warnings.append("No cell changed (the cells already had these values).")
	var finish := func() -> Dictionary:
		var result: Dictionary = {
			"path": NodePaths.rel_path(root, node),
			"type": node.get_class(),
			"ops_applied": ops.size(),
			"cells_changed": changed,
			"used_cells": (node as TileMapLayer).get_used_cells().size() if is_tiles else (node as GridMap).get_used_cells().size(),
			"undo": undo_mode,
		}
		if not warnings.is_empty():
			result["warnings"] = warnings
		return result
	return {"changes": cs, "finish": finish}


## [source, atlas, alt] for tiles, [item, orientation] for GridMap.
static func _cell_value(n: Node, c: Variant, is_tiles: bool) -> Array:
	if is_tiles:
		var l := n as TileMapLayer
		return [l.get_cell_source_id(c), l.get_cell_atlas_coords(c), l.get_cell_alternative_tile(c)]
	var g := n as GridMap
	var item: int = g.get_cell_item(c)
	return [item, g.get_cell_item_orientation(c) if item != GridMap.INVALID_CELL_ITEM else -1]


## Number of cells that differ between the real node and the scratch copy.
static func _diff_count(node: Node, scratch: Node, is_tiles: bool) -> int:
	var cells: Dictionary = {}
	for c: Variant in node.call("get_used_cells"):
		cells[c] = true
	for c: Variant in scratch.call("get_used_cells"):
		cells[c] = true
	var n: int = 0
	for c: Variant in cells:
		if _cell_value(node, c, is_tiles) != _cell_value(scratch, c, is_tiles):
			n += 1
	return n


static func _bad_op(i: int, op: String, msg: String) -> Dictionary:
	return R.err(R.BAD_PARAMS, "grid.edit: ops[%d] (%s): %s" % [i, op, msg])


static func _apply_grid_op(node: Node, scratch: Node, raw: Variant, i: int, state: Dictionary) -> Dictionary:
	if not raw is Dictionary:
		return R.err(R.BAD_PARAMS, "grid.edit: ops[%d] must be an object like {\"op\": \"set\", \"cells\": [[0, 0]], ...}." % i)
	var d: Dictionary = raw
	var op: String = str(d.get("op", ""))
	if not op in GRID_OPS:
		return R.err(R.BAD_PARAMS, "grid.edit: ops[%d].op '%s' is unknown.%s Valid ops: %s." % [i, op, Fuzzy.did_you_mean(Fuzzy.suggest(op, GRID_OPS, 2)), ", ".join(GRID_OPS)])
	var is_tiles: bool = node is TileMapLayer
	var dims: int = 2 if is_tiles else 3
	var touched: Dictionary = state["touched"]
	match op:
		"clear":
			scratch.call("clear")
			state["snapshot"] = true
			return {}
		"set", "erase", "terrain":
			if op == "terrain" and not is_tiles:
				return _bad_op(i, op, "terrains exist only for TileMapLayer; use set/fill_rect with an item for GridMap.")
			var cl: Dictionary = _cells_or_rect(d, dims, i, op, state)
			if R.is_err(cl):
				return cl
			var cells: Array = cl["value"]
			if op == "erase":
				for c: Variant in cells:
					if is_tiles:
						(scratch as TileMapLayer).erase_cell(c)
					else:
						(scratch as GridMap).set_cell_item(c, GridMap.INVALID_CELL_ITEM)
					touched[c] = true
				return {}
			if op == "terrain":
				return _terrain(node as TileMapLayer, scratch as TileMapLayer, d, cells, i, state)
			var spec: Dictionary = _paint_spec(node, d, i, op)
			if R.is_err(spec):
				return spec
			_paint(scratch, cells, spec["value"], touched, is_tiles)
			return {}
		"fill_rect":
			var rc: Dictionary = _rect_cells(d.get("rect", {}) if d.get("rect") is Dictionary else {}, dims, i, op, state)
			if R.is_err(rc):
				return rc
			var spec2: Dictionary = _paint_spec(node, d, i, op)
			if R.is_err(spec2):
				return spec2
			_paint(scratch, rc["value"], spec2["value"], touched, is_tiles)
			return {}
	return {}


## The cells of rect {x, y, w, h} (GridMap: + z, d), counted against the per-call budget.
static func _rect_cells(rect: Dictionary, dims: int, i: int, op: String, state: Dictionary) -> Dictionary:
	var rr: Dictionary = _region(rect, dims, "grid.edit: ops[%d] (%s) rect" % [i, op])
	if R.is_err(rr):
		return rr
	var lo: Vector3i = rr["value"][0]
	var hi: Vector3i = rr["value"][1]
	var size: Vector3i = hi - lo
	state["budget"] = int(state["budget"]) + size.x * size.y * size.z
	if int(state["budget"]) > MAX_CELLS:
		return _bad_op(i, op, "this call would touch more than %d cells; split it into several grid.edit calls." % MAX_CELLS)
	var cells: Array = []
	for z: int in range(lo.z, hi.z):
		for y: int in range(lo.y, hi.y):
			for x: int in range(lo.x, hi.x):
				if dims == 2:
					cells.append(Vector2i(x, y))
				else:
					cells.append(Vector3i(x, y, z))
	return R.value(cells)


## set / erase / terrain cells: d.cells and/or d.rect (both may be given; the rect's cells
## come after the listed ones). The rect form exists mainly for terrain painting: the
## dogfood test typed ~250 cells by hand to paint a 60x22 level because terrain only
## took `cells`.
static func _cells_or_rect(d: Dictionary, dims: int, i: int, op: String, state: Dictionary) -> Dictionary:
	var has_rect: bool = d.get("rect") != null
	if has_rect and not d["rect"] is Dictionary:
		return _bad_op(i, op, "'rect' must be an object like %s." % ("{\"x\": 0, \"y\": 0, \"w\": 16, \"h\": 4}" if dims == 2 else "{\"x\": 0, \"y\": 0, \"z\": 0, \"w\": 8, \"h\": 1, \"d\": 8}"))
	var out: Array = []
	if d.get("cells") != null or not has_rect:
		var cl: Dictionary = _cells(d, dims, i, op, state)
		if R.is_err(cl):
			return cl
		out = cl["value"]
	if has_rect:
		var rc: Dictionary = _rect_cells(d["rect"], dims, i, op, state)
		if R.is_err(rc):
			return rc
		out.append_array(rc["value"])
	return R.value(out)


## Parses d.cells, counting them against the per-call budget.
static func _cells(d: Dictionary, dims: int, i: int, op: String, state: Dictionary) -> Dictionary:
	var raw: Variant = d.get("cells")
	var example: String = "[[0, 0], [1, 0]]" if dims == 2 else "[[0, 0, 0], [1, 0, 0]]"
	if not raw is Array or (raw as Array).is_empty():
		return _bad_op(i, op, "'cells' must be a non-empty list of %s coordinates, e.g. %s%s." % ["[x, y]" if dims == 2 else "[x, y, z]", example,
			"" if op == "fill_rect" else " (or pass 'rect' {x, y, w, h})"])
	state["budget"] = int(state["budget"]) + (raw as Array).size()
	if int(state["budget"]) > MAX_CELLS:
		return _bad_op(i, op, "this call would touch more than %d cells; split it into several grid.edit calls." % MAX_CELLS)
	var out: Array = []
	for v: Variant in raw:
		var c: Variant = _cell(v, dims)
		if c == null:
			# WorldTileset.js prints integral floats as ints: JSON numbers arrive as floats,
			# and "[0.0,18.0,5.0]" read as if the caller had sent floats.
			return _bad_op(i, op, "cell %s is not an integer %s coordinate (e.g. %s)." % [WorldTileset.js(v), "[x, y]" if dims == 2 else "[x, y, z]", example])
		out.append(c)
	return R.value(out)


## What `set`/`fill_rect` paint: tiles {source, atlas, alt} or GridMap {item, orientation}.
## Validated against the TileSet / MeshLibrary.
static func _paint_spec(node: Node, d: Dictionary, i: int, op: String) -> Dictionary:
	if node is TileMapLayer:
		var ts: TileSet = (node as TileMapLayer).tile_set
		if ts == null:
			return _bad_op(i, op, "the TileMapLayer has no tile_set. Assign one first with node.set {\"tile_set\": \"res://tileset.tres\"} (create it with tileset.edit).")
		var source: Variant = _int(d.get("source"))
		if source == null:
			return _bad_op(i, op, "'source' (TileSet source id) is required.%s" % _sources_hint(ts))
		if not ts.has_source(source):
			return R.err(R.NOT_FOUND, "grid.edit: ops[%d] (%s): the TileSet has no source %s.%s" % [i, op, source, _sources_hint(ts)])
		var atlas: Variant = WorldTileset.vec2i(d.get("atlas", [0, 0]))
		var alt: Variant = _int(d.get("alt", 0))
		if atlas == null or alt == null:
			return _bad_op(i, op, "'atlas' must be [x, y] atlas coords and 'alt' an integer alternative id (0 = the base tile).")
		var src: TileSetSource = ts.get_source(source)
		if src is TileSetScenesCollectionSource:
			if not (src as TileSetScenesCollectionSource).has_scene_tile_id(alt):
				return R.err(R.NOT_FOUND, "grid.edit: ops[%d] (%s): scene source %d has no scene tile %d; pass its id as 'alt' (with atlas [0, 0]). See grid.read sources." % [i, op, source, alt])
			atlas = Vector2i.ZERO
		else:
			if not src.has_tile(atlas):
				var listed: Array = WorldTileset.describe_source(source, src).get("tiles", [])
				return R.err(R.NOT_FOUND, "grid.edit: ops[%d] (%s): source %d has no tile at atlas %s. Existing tiles: %s. Add tiles with tileset.edit if needed." % [i, op, source, JSON.stringify([atlas.x, atlas.y]), JSON.stringify(listed)])
			if not src.has_alternative_tile(atlas, alt):
				return R.err(R.NOT_FOUND, "grid.edit: ops[%d] (%s): tile %s of source %d has no alternative %d (it has %d; 0 is the base tile)." % [i, op, JSON.stringify([atlas.x, atlas.y]), source, alt, src.get_alternative_tiles_count(atlas)])
		return R.value([source, atlas, alt])
	var lib: MeshLibrary = (node as GridMap).mesh_library
	if lib == null:
		return _bad_op(i, op, "the GridMap has no mesh_library. Assign one first with node.set {\"mesh_library\": \"res://library.tres\"}.")
	var item: Variant = _int(d.get("item"))
	if item == null or not int(item) in lib.get_item_list():
		return R.err(R.NOT_FOUND if item != null else R.BAD_PARAMS, "grid.edit: ops[%d] (%s): %s MeshLibrary items: %s." % [i, op,
			"'item' (MeshLibrary item id) is required." if item == null else "the MeshLibrary has no item %d." % item, _items_hint(lib)])
	var orient: Variant = _int(d.get("orientation", 0))
	if orient == null or int(orient) < 0 or int(orient) > 23:
		return _bad_op(i, op, "'orientation' must be an orthogonal index 0-23 (0 = unrotated; 16, 10, 22 = 90, 180, 270 degrees around Y).")
	return R.value([item, orient])


static func _paint(scratch: Node, cells: Array, spec: Array, touched: Dictionary, is_tiles: bool) -> void:
	for c: Variant in cells:
		if is_tiles:
			(scratch as TileMapLayer).set_cell(c, spec[0], spec[1], spec[2])
		else:
			(scratch as GridMap).set_cell_item(c, spec[0], spec[1])
		touched[c] = true


static func _terrain(layer: TileMapLayer, scratch: TileMapLayer, d: Dictionary, cells: Array, i: int, state: Dictionary) -> Dictionary:
	var ts: TileSet = layer.tile_set
	if ts == null:
		return _bad_op(i, "terrain", "the TileMapLayer has no tile_set.")
	if ts.get_terrain_sets_count() == 0:
		return _bad_op(i, "terrain", "the TileSet has no terrain sets. Add one with tileset.edit (add_terrain_set, add_terrain, set_terrain) first.")
	var tset: Variant = _int(d.get("terrain_set", 0))
	if tset == null or int(tset) < 0 or int(tset) >= ts.get_terrain_sets_count():
		return _bad_op(i, "terrain", "'terrain_set' must be 0-%d, got %s." % [ts.get_terrain_sets_count() - 1, WorldTileset.js(d.get("terrain_set"))])
	var terrain: Variant = null
	var raw_terrain: Variant = d.get("terrain")
	if raw_terrain is String:
		# Terrains by name ("rock"), as named with tileset.edit add_terrain. Without an explicit
		# terrain_set, every set is searched so the common one-set case needs no index at all.
		var sets: Array = [tset] if d.get("terrain_set") != null else range(ts.get_terrain_sets_count())
		for s: int in sets:
			for k: int in range(ts.get_terrains_count(s)):
				if ts.get_terrain_name(s, k) == raw_terrain:
					tset = s
					terrain = k
					break
			if terrain != null:
				break
		if terrain == null:
			return _bad_op(i, "terrain", "no terrain named '%s'%s. Terrains: %s." % [raw_terrain,
				(" in terrain set %d" % tset) if d.get("terrain_set") != null else "", _terrain_names(ts)])
	else:
		terrain = _int(raw_terrain)
	if terrain == null or int(terrain) < -1 or int(terrain) >= ts.get_terrains_count(tset):
		return _bad_op(i, "terrain", "'terrain' must be a terrain name, or an index of set %d, or -1 to clear; got %s. Terrains: %s." % [tset, WorldTileset.js(raw_terrain), _terrain_names(ts)])
	var mode: String = str(d.get("mode", "connect"))
	if not mode in ["connect", "path"]:
		return _bad_op(i, "terrain", "'mode' must be \"connect\" (fill an area) or \"path\" (connect cells in the given order).")
	# ignore_empty_terrains defaults to false: with Godot's default (true), painting onto an
	# empty map places nothing in 4.7 (verified), which is never what a caller wants.
	var ignore_empty: bool = d.get("ignore_empty_terrains") is bool and bool(d["ignore_empty_terrains"])
	var before: int = _diff_count(layer, scratch, true)
	var arr: Array[Vector2i] = []
	for c: Variant in cells:
		arr.append(c)
	if mode == "connect":
		scratch.set_cells_terrain_connect(arr, tset, terrain, ignore_empty)
	else:
		scratch.set_cells_terrain_path(arr, tset, terrain, ignore_empty)
	if _diff_count(layer, scratch, true) == before:
		(state["warnings"] as Array[String]).append("ops[%d] (terrain) changed nothing: no tile in the TileSet has terrain %s of set %s (set it with tileset.edit set_terrain)." % [i, terrain, tset])
	state["snapshot"] = true
	return {}


## "set 0: 0 = rock, 1 = dirt; set 1: ..." for terrain errors.
static func _terrain_names(ts: TileSet) -> String:
	var parts: Array = []
	for s: int in range(ts.get_terrain_sets_count()):
		var names: Array = []
		for k: int in range(ts.get_terrains_count(s)):
			names.append("%d = %s" % [k, ts.get_terrain_name(s, k)])
		parts.append("set %d: %s" % [s, ", ".join(names) if not names.is_empty() else "(none)"])
	return "; ".join(parts)


static func _sources_hint(ts: TileSet) -> String:
	var parts: Array = []
	for k: int in range(ts.get_source_count()):
		parts.append(str(ts.get_source_id(k)))
	if parts.is_empty():
		return " The TileSet has no sources; add an atlas with tileset.edit (add_atlas)."
	return " Source ids: %s (grid.read lists their tiles)." % ", ".join(parts)


static func _items_hint(lib: MeshLibrary) -> String:
	var parts: Array = []
	for id: int in lib.get_item_list():
		parts.append("%d = %s" % [id, lib.get_item_name(id)])
	return ", ".join(parts) if not parts.is_empty() else "(none)"


# =====================================================================================
# tileset.edit
# =====================================================================================

static func do_tileset_edit(params: Variant, env: Dictionary) -> Dictionary:
	var p := Params.new(params, "tileset.edit")
	var raw_path: String = p.req_string("path")
	var create: bool = p.opt_bool("create", false)
	var ops: Array = p.opt_array("ops", [])
	if p.failed():
		return p.error
	var norm: Dictionary = ResPaths.normalize(raw_path, "path")
	if R.is_err(norm):
		return norm
	var path: String = norm["value"]
	if not path.get_extension().to_lower() in ["tres", "res"]:
		return R.err(R.BAD_PARAMS, "tileset.edit: 'path' must be a TileSet resource file ending in .tres or .res, got '%s'. TileSets embedded in a scene are not supported; save it as a .tres in the inspector first." % path)
	var tile_size: Variant = null
	if p.has("tile_size"):
		tile_size = WorldTileset.vec2i(p.raw("tile_size"))
		if tile_size == null or (tile_size as Vector2i).x < 1 or (tile_size as Vector2i).y < 1:
			return R.err(R.BAD_PARAMS, "tileset.edit: 'tile_size' must be [width, height] in pixels, e.g. [16, 16].")
	var ts: TileSet
	if create:
		if ResPaths.file_exists(path):
			return R.err(R.CONFLICT, "tileset.edit: '%s' already exists; omit 'create' to edit it." % path)
		ts = TileSet.new()
		ts.tile_size = tile_size if tile_size != null else Vector2i(16, 16)
	else:
		if not ResPaths.file_exists(path):
			var existing: PackedStringArray = ResPaths.list_files(PackedStringArray(["tres"]), 20)
			return R.err(R.NOT_FOUND, "tileset.edit: '%s' does not exist. Pass create: true (and tile_size) to make a new TileSet. .tres files in the project: %s." % [path, ", ".join(existing) if not existing.is_empty() else "(none)"])
		# Default cache mode: in the editor this is the instance open TileMapLayers use.
		var loaded: Resource = load(path)
		if not loaded is TileSet:
			return R.err(R.BAD_PARAMS, "tileset.edit: '%s' is a %s, not a TileSet." % [path, loaded.get_class() if loaded != null else "unreadable resource"])
		ts = loaded
		if ops.is_empty() and tile_size == null:
			return R.err(R.BAD_PARAMS, "tileset.edit: nothing to do; pass 'ops', e.g. [{\"op\": \"add_atlas\", \"texture\": \"res://tiles.png\"}].")
	# Dry run on a deep copy so a failing op leaves the (possibly shared) TileSet untouched.
	var dry: TileSet = ts.duplicate(true) as TileSet
	if tile_size != null:
		dry.tile_size = tile_size
	var check: Dictionary = WorldTileset.apply_ops(dry, ops)
	if R.is_err(check):
		return check
	if tile_size != null:
		ts.tile_size = tile_size
	var applied: Dictionary = WorldTileset.apply_ops(ts, ops)
	if R.is_err(applied):
		return applied
	var dir_err: int = DirAccess.make_dir_recursive_absolute(ProjectSettings.globalize_path(path.get_base_dir()))
	if dir_err != OK and dir_err != ERR_ALREADY_EXISTS:
		return R.godot_err("Creating folder '%s'" % path.get_base_dir(), dir_err)
	var err: int = ResSave.save(ts, path, ResourceSaver.FLAG_CHANGE_PATH if create else 0)
	if err != OK:
		return R.godot_err("Saving TileSet '%s'" % path, err)
	if bool(env.get("editor", false)) and env.get("filesystem") != null:
		(env["filesystem"] as Object).call("update_file", path)
	var done: Dictionary = applied["value"]
	var result: Dictionary = {"path": path, "created": create, "ops": done["ops"], "saved": true}
	# Tile coordinate lists only for the atlases this call created (what the caller paints
	# with next); every other source reports counts. grid.read lists all tiles.
	var new_sources: Array = []
	for r: Dictionary in done["ops"]:
		if r["op"] == "add_atlas":
			new_sources.append(r["source"])
	result.merge(WorldTileset.describe(ts, new_sources))
	if not (done["warnings"] as Array).is_empty():
		result["warnings"] = done["warnings"]
	return R.ok(result)


# =====================================================================================
# navigation.bake
# =====================================================================================

## Resolves params.path to a navigation region; with no path, the scene's only region.
static func _region_node(root: Node, path: String, method: String) -> Dictionary:
	var regions: Array[String] = _find_nodes(root, _is_region)
	if path.is_empty():
		if regions.size() == 1:
			return R.value(root.get_node(regions[0]) if regions[0] != "." else root)
		if regions.is_empty():
			return R.err(R.NOT_FOUND, "%s: the scene has no NavigationRegion2D/3D. Add one with node.add (type NavigationRegion2D or NavigationRegion3D)." % method)
		return R.err(R.BAD_PARAMS, "%s: the scene has several navigation regions; pass 'path': %s." % [method, ", ".join(regions)])
	var res: Dictionary = NodePaths.resolve(root, path)
	if R.is_err(res):
		return res
	var node: Node = res["value"]
	if not _is_region(node):
		return R.err(R.BAD_PARAMS, "%s: '%s' is a %s, not a NavigationRegion2D/3D.%s" % [method, path, node.get_class(),
			(" Regions in this scene: %s." % ", ".join(regions)) if not regions.is_empty() else ""])
	return R.value(node)


static func plan_navigation_bake(root: Node, params: Variant) -> Dictionary:
	var p := Params.new(params, "navigation.bake")
	var path: String = p.opt_string("path", "")
	var outline_raw: Array = p.opt_array("outline", [])
	var agent_radius: Variant = p.raw("agent_radius")
	if p.failed():
		return p.error
	if agent_radius != null and not ((agent_radius is float or agent_radius is int) and float(agent_radius) >= 0.0):
		return R.err(R.BAD_PARAMS, "navigation.bake: 'agent_radius' must be a number >= 0 (px in 2D, meters in 3D), got %s." % WorldTileset.js(agent_radius))
	var rr: Dictionary = _region_node(root, path, "navigation.bake")
	if R.is_err(rr):
		return rr
	var region: Node = rr["value"]
	var edit_err: Dictionary = NodePaths.check_editable(root, region, "bake")
	if not edit_err.is_empty():
		return edit_err
	var is_2d: bool = region is NavigationRegion2D
	var prop: StringName = &"navigation_polygon" if is_2d else &"navigation_mesh"
	var res: Resource = region.get(prop)
	var outline := PackedVector2Array()
	if not outline_raw.is_empty():
		if not is_2d:
			return R.err(R.BAD_PARAMS, "navigation.bake: 'outline' only applies to NavigationRegion2D; 3D regions bake from their child meshes/colliders.")
		for v: Variant in outline_raw:
			if not (v is Array and (v as Array).size() == 2 and (v[0] is float or v[0] is int) and (v[1] is float or v[1] is int)):
				return R.err(R.BAD_PARAMS, "navigation.bake: outline point %s is not [x, y]." % WorldTileset.js(v))
			outline.append(Vector2(float(v[0]), float(v[1])))
		if outline.size() < 3:
			return R.err(R.BAD_PARAMS, "navigation.bake: 'outline' needs at least 3 points.")
	# Bake into a copy: the scene is only changed by the ChangeSet (undoable in the editor).
	var work: Resource
	if res != null:
		work = res.duplicate()
	elif is_2d:
		work = NavigationPolygon.new()
	else:
		work = NavigationMesh.new()
	if is_2d and not outline.is_empty():
		(work as NavigationPolygon).clear_outlines()
		(work as NavigationPolygon).add_outline(outline)
	# agent_radius is how far the baked area keeps away from obstacles and outline edges
	# (NavigationPolygon default 10 px, NavigationMesh 0.5 m). It is a property of the
	# resource, so it is written to the region's resource together with the baked data
	# below, and later bakes (the editor's Bake button too) keep using it. The other bake
	# settings (parsed_geometry_type, source_geometry_mode, collision mask) can be set
	# beforehand with node.set {"navigation_polygon:parsed_geometry_type": 1} on the region.
	if agent_radius != null:
		work.set(&"agent_radius", float(agent_radius))
	var baked: Dictionary = WorldNav.bake(region, root, work)
	if R.is_err(baked):
		return baked
	var info: Dictionary = baked["value"]
	var verts: Variant = work.get("vertices")
	var vertex_count: int = verts.size()
	var polygon_count: int = work.call("get_polygon_count")
	if polygon_count == 0:
		return R.err(R.BAD_PARAMS, ("navigation.bake: baking '%s' produced no polygons (the obstacles cover the whole walkable area, the area is smaller than the agent radius, " +
			"or the geometry lies outside the outline/baking AABB). Nothing was changed.%s") % [region.name,
			(" Parser notes: " + " ".join(info["warnings"])) if not (info["warnings"] as Array).is_empty() else ""])
	var cs := ChangeSet.new()
	var external: bool = res != null and not res.resource_path.is_empty() and not res.resource_path.contains("::")
	if res == null:
		cs.do_property(region, prop, work)
		cs.undo_property(region, prop, null)
	else:
		if agent_radius != null:
			cs.do_property(res, &"agent_radius", work.get("agent_radius"))
			cs.undo_property(res, &"agent_radius", res.get("agent_radius"))
		# Write the baked arrays into the region's own resource, so a NavigationPolygon/Mesh
		# shared by several regions or saved as a .tres stays shared. Polygons are cleared
		# first so vertices and polygon indices never disagree in between.
		if is_2d and not outline.is_empty():
			cs.do_property(res, &"outlines", work.get("outlines"))
		cs.do_property(res, &"polygons", [])
		cs.do_property(res, &"vertices", work.get("vertices"))
		cs.do_property(res, &"polygons", work.get("polygons"))
		if is_2d and not outline.is_empty():
			cs.undo_property(res, &"outlines", res.get("outlines"))
		cs.undo_property(res, &"polygons", [])
		cs.undo_property(res, &"vertices", res.get("vertices"))
		cs.undo_property(res, &"polygons", res.get("polygons"))
	var finish := func() -> Dictionary:
		var result: Dictionary = {
			"path": NodePaths.rel_path(root, region),
			"type": region.get_class(),
			"vertices": vertex_count,
			"polygons": polygon_count,
			"parser": info["parser"],
			"resource": res.resource_path if external else "(embedded in the scene)",
		}
		if agent_radius != null:
			result["agent_radius"] = work.get("agent_radius")
		if info.has("parsed"):
			result["parsed_shapes"] = info["parsed"]
		if not (info["warnings"] as Array).is_empty():
			result["warnings"] = info["warnings"]
		if external:
			# The scene file only references a .tres; write the baked data to it as well.
			var err: int = ResSave.save(res, res.resource_path)
			result["resource_saved"] = err == OK
		return result
	return {"changes": cs, "finish": finish}


# =====================================================================================
# navigation.path
# =====================================================================================

static func read_navigation_path(root: Node, params: Variant) -> Dictionary:
	var p := Params.new(params, "navigation.path")
	var from_raw: Array = p.opt_array("from", [])
	var to_raw: Array = p.opt_array("to", [])
	var path: String = p.opt_string("path", "")
	var optimize: bool = p.opt_bool("optimize", true)
	var layers: int = p.opt_int("layers", 0xFFFFFFFF)
	if p.failed():
		return p.error
	var dims: int = from_raw.size()
	if not dims in [2, 3] or to_raw.size() != dims:
		return R.err(R.BAD_PARAMS, "navigation.path: 'from' and 'to' must both be [x, y] (2D) or [x, y, z] (3D) in the scene root's coordinates.")
	var nums: Array[float] = []
	for v: Variant in from_raw + to_raw:
		if not (v is float or v is int):
			return R.err(R.BAD_PARAMS, "navigation.path: 'from'/'to' must contain numbers, got %s." % WorldTileset.js(v))
		nums.append(float(v))
	var want_2d: bool = dims == 2
	var candidates: Array[Node] = []
	if not path.is_empty():
		var rr: Dictionary = _region_node(root, path, "navigation.path")
		if R.is_err(rr):
			return rr
		candidates.append(rr["value"])
	else:
		for rp: String in _find_nodes(root, _is_region, 1000):
			candidates.append(root if rp == "." else root.get_node(rp))
	var regions: Array[Node] = []
	var skipped: Array[String] = []
	for n: Node in candidates:
		if (n is NavigationRegion2D) != want_2d:
			continue
		var res: Resource = n.get("navigation_polygon" if want_2d else "navigation_mesh")
		if not n.get("enabled"):
			skipped.append("%s (disabled)" % NodePaths.rel_path(root, n))
		elif res == null or int(res.call("get_polygon_count")) == 0:
			skipped.append("%s (not baked)" % NodePaths.rel_path(root, n))
		else:
			regions.append(n)
	if regions.is_empty():
		return R.err(R.NOT_FOUND, "navigation.path: no baked %s in the scene%s. Bake one with navigation.bake first." %
			["NavigationRegion2D" if want_2d else "NavigationRegion3D", (" (skipped: %s)" % ", ".join(skipped)) if not skipped.is_empty() else ""])
	var from: Variant
	var to: Variant
	if want_2d:
		from = Vector2(nums[0], nums[1])
		to = Vector2(nums[2], nums[3])
	else:
		from = Vector3(nums[0], nums[1], nums[2])
		to = Vector3(nums[3], nums[4], nums[5])
	var found: Dictionary = WorldNav.find_path(root, regions, from, to, optimize, layers)
	var points: Array = found["points"]
	var result: Dictionary = {"points": points, "length": found["length"], "regions": regions.map(func(n: Node) -> String: return NodePaths.rel_path(root, n))}
	if points.is_empty():
		result["reached"] = false
		result["note"] = "No path: the points may be off the navigation mesh, or the layers do not match the regions' navigation_layers."
	else:
		var last: Array = points[points.size() - 1]
		var end_distance: float = (Vector2(last[0], last[1]).distance_to(to) if want_2d else Vector3(last[0], last[1], last[2]).distance_to(to))
		# The path ends at the closest reachable point; within ~an agent radius counts as reached.
		var res0: Resource = regions[0].get("navigation_polygon" if want_2d else "navigation_mesh")
		var tolerance: float = maxf(float(res0.get("agent_radius")), float(res0.get("cell_size"))) * 2.0 + 0.01
		result["end_distance"] = snappedf(end_distance, 0.001)
		result["reached"] = end_distance <= tolerance
	if not skipped.is_empty():
		result["skipped_regions"] = skipped
	return R.ok(result)
