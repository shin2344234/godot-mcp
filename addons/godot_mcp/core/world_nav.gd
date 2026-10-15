@tool
extends RefCounted
## Navigation helpers for world_ops.gd: source-geometry parsing, baking, path queries.
##
## Why there are two parsers
## -------------------------
## Godot bakes a navigation mesh in two steps: NavigationServer{2D,3D}.parse_source_geometry_data()
## walks the nodes and collects obstacles/walkable geometry, then
## bake_from_source_geometry_data() turns that into polygons. The second step is pure math
## and works anywhere (verified on 4.7.2, synchronously). The first step, however, refuses
## to run unless the root node is inside a SceneTree ("The root node needs to be inside
## the SceneTree"), because it reads global transforms.
##
## * In the editor the edited scene *is* in the tree, so we use the engine parser: the
##   result is exactly what the editor's own "Bake NavigationPolygon/Mesh" button produces.
## * The headless runner handles its request in SceneTree._initialize(), before the root
##   window has entered the tree, and the edited scene is deliberately never added to it
##   (game scripts would run). So headless uses `parse_2d` / `parse_3d` below: a compact
##   re-implementation of the engine parser for the common node types, computing
##   transforms by walking the parent chain instead of using global transforms. Node types
##   it does not understand are reported back as warnings instead of silently ignored.
##
## Path queries build a private navigation map with their own regions (so they work the
## same headless and in the editor, and never disturb the game's/editor's world map), and
## turn off asynchronous map iterations so map_force_update() syncs immediately; with
## async iterations on (the default) a fresh map is not usable until a later frame.

const R := preload("mcp_result.gd")

## Segments used to approximate circles/capsules in the headless 2D parser.
const _CIRCLE_SEGMENTS: int = 16
const _HALF_SEGMENTS: int = 8


# -------------------------------------------------------------------------------------
# Transforms without a SceneTree
# -------------------------------------------------------------------------------------

## Transform of `node` in the space of `top` (an ancestor), from local transforms only.
## CanvasItems that are not Node2D (e.g. Control) contribute get_transform().
static func chain_2d(node: Node, top: Node) -> Transform2D:
	var xf := Transform2D.IDENTITY
	var n: Node = node
	while n != null and n != top:
		if n is CanvasItem:
			xf = (n as CanvasItem).get_transform() * xf
			if (n as CanvasItem).top_level:
				break
		n = n.get_parent()
	return xf


static func chain_3d(node: Node, top: Node) -> Transform3D:
	var xf := Transform3D.IDENTITY
	var n: Node = node
	while n != null and n != top:
		if n is Node3D:
			xf = (n as Node3D).transform * xf
			if (n as Node3D).top_level:
				break
		n = n.get_parent()
	return xf


## Transform of `node` relative to `region`, both under `root` (works off-tree).
static func rel_2d(region: Node, node: Node, root: Node) -> Transform2D:
	if region == node:
		return Transform2D.IDENTITY
	if region.is_ancestor_of(node):
		return chain_2d(node, region)
	return chain_2d(region, root).affine_inverse() * chain_2d(node, root)


static func rel_3d(region: Node, node: Node, root: Node) -> Transform3D:
	if region == node:
		return Transform3D.IDENTITY
	if region.is_ancestor_of(node):
		return chain_3d(node, region)
	return chain_3d(region, root).affine_inverse() * chain_3d(node, root)


# -------------------------------------------------------------------------------------
# Which nodes a bake looks at (NavigationPolygon/NavigationMesh source_geometry_mode)
# -------------------------------------------------------------------------------------

## Returns [[node, recursive: bool], ...] following the resource's source geometry mode:
## 0 = the region's children, 1 = nodes in the group plus their children, 2 = group only.
static func _source_roots(region: Node, root: Node, mode: int, group: StringName) -> Array:
	if mode == 0:
		return [[region, true]]
	var out: Array = []
	_collect_group(root, group, out, mode == 1)
	return out


static func _collect_group(node: Node, group: StringName, out: Array, recursive: bool) -> void:
	if node.is_in_group(group):
		out.append([node, recursive])
	for c: Node in node.get_children():
		_collect_group(c, group, out, recursive)


static func _walk(start: Node, recursive: bool, visit: Callable) -> void:
	visit.call(start)
	if recursive:
		for c: Node in start.get_children():
			_walk(c, true, visit)


# -------------------------------------------------------------------------------------
# Headless 2D parser
# -------------------------------------------------------------------------------------

## Fills `geo` from the nodes NavigationPolygon `np` would parse for `region`.
## Returns {"parsed": int, "warnings": Array[String]}.
static func parse_2d(region: NavigationRegion2D, root: Node, np: NavigationPolygon, geo: NavigationMeshSourceGeometryData2D) -> Dictionary:
	var state: Dictionary = {"parsed": 0, "warnings": [] as Array[String]}
	var gtype: int = np.parsed_geometry_type  # 0 meshes, 1 static colliders, 2 both
	var use_meshes: bool = gtype != NavigationPolygon.PARSED_GEOMETRY_STATIC_COLLIDERS
	var use_colliders: bool = gtype != NavigationPolygon.PARSED_GEOMETRY_MESH_INSTANCES
	var mask: int = np.parsed_collision_mask
	var seen: Dictionary = {}
	for entry: Array in _source_roots(region, root, np.source_geometry_mode, np.source_geometry_group_name):
		_walk(entry[0], entry[1], func(n: Node) -> void:
			if seen.has(n):
				return
			seen[n] = true
			_parse_node_2d(region, root, n, geo, use_meshes, use_colliders, mask, state))
	return state


static func _parse_node_2d(region: Node, root: Node, n: Node, geo: NavigationMeshSourceGeometryData2D,
		use_meshes: bool, use_colliders: bool, mask: int, state: Dictionary) -> void:
	if n is Polygon2D:
		if use_meshes:
			var poly := n as Polygon2D
			if poly.polygon.size() >= 3:
				var xf: Transform2D = rel_2d(region, n, root) * Transform2D(0.0, poly.offset)
				geo.add_obstruction_outline(xf * poly.polygon)
				state["parsed"] += 1
	elif n is MeshInstance2D:
		if use_meshes and (n as MeshInstance2D).mesh != null:
			# Approximation: the convex hull of the mesh's vertices.
			var pts := PackedVector2Array()
			for v: Vector3 in (n as MeshInstance2D).mesh.get_faces():
				pts.append(Vector2(v.x, v.y))
			var hull: PackedVector2Array = Geometry2D.convex_hull(pts)
			if hull.size() >= 3:
				geo.add_obstruction_outline(rel_2d(region, n, root) * hull)
				state["parsed"] += 1
	elif n is StaticBody2D:
		if use_colliders and ((n as StaticBody2D).collision_layer & mask) != 0:
			for c: Node in n.get_children():
				_parse_collider_2d(region, root, c, geo, state)
	elif n is TileMapLayer:
		_parse_tile_layer_2d(region, root, n as TileMapLayer, geo, use_colliders, mask, state)
	elif n is NavigationObstacle2D:
		var ob := n as NavigationObstacle2D
		if ob.affect_navigation_mesh:
			var xf: Transform2D = rel_2d(region, n, root)
			if ob.vertices.size() >= 3:
				geo.add_projected_obstruction(xf * ob.vertices, ob.carve_navigation_mesh)
				state["parsed"] += 1
			if ob.radius > 0.0:
				geo.add_projected_obstruction(xf * _circle(Vector2.ZERO, ob.radius), ob.carve_navigation_mesh)
				state["parsed"] += 1
	elif n.get_class() == "TileMap":
		(state["warnings"] as Array[String]).append("Skipped deprecated TileMap '%s'; convert it to TileMapLayer nodes." % n.name)


static func _parse_collider_2d(region: Node, root: Node, c: Node, geo: NavigationMeshSourceGeometryData2D, state: Dictionary) -> void:
	if c is CollisionPolygon2D:
		var cp := c as CollisionPolygon2D
		if not cp.disabled and cp.polygon.size() >= 3:
			geo.add_obstruction_outline(rel_2d(region, c, root) * cp.polygon)
			state["parsed"] += 1
		return
	if not c is CollisionShape2D:
		return
	var cs := c as CollisionShape2D
	if cs.disabled or cs.shape == null:
		return
	var pts: PackedVector2Array = shape_outline_2d(cs.shape)
	if pts.size() < 3:
		(state["warnings"] as Array[String]).append("Skipped %s on '%s' (no area to obstruct)." % [cs.shape.get_class(), c.name])
		return
	geo.add_obstruction_outline(rel_2d(region, c, root) * pts)
	state["parsed"] += 1


## Outline polygon of a 2D shape in its own space (empty for shapes without an area).
static func shape_outline_2d(shape: Shape2D) -> PackedVector2Array:
	if shape is RectangleShape2D:
		var h: Vector2 = (shape as RectangleShape2D).size * 0.5
		return PackedVector2Array([Vector2(-h.x, -h.y), Vector2(h.x, -h.y), Vector2(h.x, h.y), Vector2(-h.x, h.y)])
	if shape is CircleShape2D:
		return _circle(Vector2.ZERO, (shape as CircleShape2D).radius)
	if shape is CapsuleShape2D:
		var cap := shape as CapsuleShape2D
		var r: float = cap.radius
		var half: float = maxf(cap.height * 0.5 - r, 0.0)
		var pts := PackedVector2Array()
		for i: int in range(_HALF_SEGMENTS + 1):  # bottom half circle
			var a: float = PI * float(i) / float(_HALF_SEGMENTS)
			pts.append(Vector2(cos(a) * r, half + sin(a) * r))
		for i: int in range(_HALF_SEGMENTS + 1):  # top half circle
			var a: float = PI + PI * float(i) / float(_HALF_SEGMENTS)
			pts.append(Vector2(cos(a) * r, -half + sin(a) * r))
		return pts
	if shape is ConvexPolygonShape2D:
		return (shape as ConvexPolygonShape2D).points
	if shape is ConcavePolygonShape2D:
		# Segment pairs; keep each start point, which follows the outline for closed shapes.
		var seg: PackedVector2Array = (shape as ConcavePolygonShape2D).segments
		var pts := PackedVector2Array()
		for i: int in range(0, seg.size(), 2):
			pts.append(seg[i])
		return pts
	return PackedVector2Array()


static func _circle(center: Vector2, radius: float) -> PackedVector2Array:
	var pts := PackedVector2Array()
	for i: int in range(_CIRCLE_SEGMENTS):
		var a: float = TAU * float(i) / float(_CIRCLE_SEGMENTS)
		pts.append(center + Vector2(cos(a), sin(a)) * radius)
	return pts


## TileMapLayer: tile collision polygons become obstructions, tile navigation polygons
## become walkable (traversable) outlines, like the engine parser does.
static func _parse_tile_layer_2d(region: Node, root: Node, layer: TileMapLayer, geo: NavigationMeshSourceGeometryData2D,
		use_colliders: bool, mask: int, state: Dictionary) -> void:
	var ts: TileSet = layer.tile_set
	if ts == null:
		return
	var layer_xf: Transform2D = rel_2d(region, layer, root)
	var phys_layers: Array[int] = []
	if use_colliders and layer.collision_enabled:
		for i: int in range(ts.get_physics_layers_count()):
			if (ts.get_physics_layer_collision_layer(i) & mask) != 0:
				phys_layers.append(i)
	var nav_layers: int = ts.get_navigation_layers_count() if layer.navigation_enabled else 0
	if phys_layers.is_empty() and nav_layers == 0:
		return
	for cell: Vector2i in layer.get_used_cells():
		var td: TileData = layer.get_cell_tile_data(cell)
		if td == null:
			continue
		var cell_xf: Transform2D = layer_xf * Transform2D(0.0, layer.map_to_local(cell))
		for pl: int in phys_layers:
			for pi: int in range(td.get_collision_polygons_count(pl)):
				var pts: PackedVector2Array = td.get_collision_polygon_points(pl, pi)
				if pts.size() >= 3:
					geo.add_obstruction_outline(cell_xf * pts)
					state["parsed"] += 1
		for nl: int in range(nav_layers):
			var tnp: NavigationPolygon = td.get_navigation_polygon(nl)
			if tnp == null:
				continue
			for oi: int in range(tnp.get_outline_count()):
				geo.add_traversable_outline(cell_xf * tnp.get_outline(oi))
				state["parsed"] += 1


# -------------------------------------------------------------------------------------
# Headless 3D parser
# -------------------------------------------------------------------------------------

## Fills `geo` from the nodes NavigationMesh `nm` would parse for `region`.
## Returns {"parsed": int, "warnings": Array[String]}.
static func parse_3d(region: NavigationRegion3D, root: Node, nm: NavigationMesh, geo: NavigationMeshSourceGeometryData3D) -> Dictionary:
	var state: Dictionary = {"parsed": 0, "warnings": [] as Array[String]}
	var gtype: int = nm.geometry_parsed_geometry_type
	var use_meshes: bool = gtype != NavigationMesh.PARSED_GEOMETRY_STATIC_COLLIDERS
	var use_colliders: bool = gtype != NavigationMesh.PARSED_GEOMETRY_MESH_INSTANCES
	var mask: int = nm.geometry_collision_mask
	var seen: Dictionary = {}
	for entry: Array in _source_roots(region, root, nm.geometry_source_geometry_mode, nm.geometry_source_group_name):
		_walk(entry[0], entry[1], func(n: Node) -> void:
			if seen.has(n):
				return
			seen[n] = true
			_parse_node_3d(region, root, n, geo, use_meshes, use_colliders, mask, state))
	return state


static func _parse_node_3d(region: Node, root: Node, n: Node, geo: NavigationMeshSourceGeometryData3D,
		use_meshes: bool, use_colliders: bool, mask: int, state: Dictionary) -> void:
	if n is MeshInstance3D:
		if use_meshes and (n as MeshInstance3D).mesh != null:
			_add_mesh(geo, (n as MeshInstance3D).mesh, rel_3d(region, n, root), n, state)
	elif n is MultiMeshInstance3D:
		var mm: MultiMesh = (n as MultiMeshInstance3D).multimesh
		if use_meshes and mm != null and mm.mesh != null:
			var xf: Transform3D = rel_3d(region, n, root)
			for i: int in range(mm.instance_count):
				_add_mesh(geo, mm.mesh, xf * mm.get_instance_transform(i), n, state)
	elif n is StaticBody3D:
		if use_colliders and ((n as StaticBody3D).collision_layer & mask) != 0:
			for c: Node in n.get_children():
				if c is CollisionShape3D and not (c as CollisionShape3D).disabled and (c as CollisionShape3D).shape != null:
					_add_shape(geo, (c as CollisionShape3D).shape, rel_3d(region, c, root), c, state)
	elif n is GridMap:
		var gm := n as GridMap
		var xf: Transform3D = rel_3d(region, n, root)
		if use_meshes:
			# get_meshes() works off-tree: [Transform3D, Mesh, Transform3D, Mesh, ...].
			var pairs: Array = gm.get_meshes()
			for i: int in range(0, pairs.size() - 1, 2):
				_add_mesh(geo, pairs[i + 1] as Mesh, xf * (pairs[i] as Transform3D), n, state)
		if use_colliders and (gm.collision_layer & mask) != 0 and gm.mesh_library != null:
			for cell: Vector3i in gm.get_used_cells():
				var item: int = gm.get_cell_item(cell)
				var shapes: Array = gm.mesh_library.get_item_shapes(item)
				var cell_xf := Transform3D(gm.get_basis_with_orthogonal_index(gm.get_cell_item_orientation(cell)), gm.map_to_local(cell))
				for i: int in range(0, shapes.size() - 1, 2):
					if shapes[i] is Shape3D:
						_add_shape(geo, shapes[i] as Shape3D, xf * cell_xf * (shapes[i + 1] as Transform3D), n, state)
	elif n is CSGShape3D:
		if (n as CSGShape3D).is_root_shape():
			(state["warnings"] as Array[String]).append("Skipped CSG node '%s': CSG geometry is only built inside the editor's scene tree; bake with the editor open to include it." % n.name)


static func _add_mesh(geo: NavigationMeshSourceGeometryData3D, mesh: Mesh, xf: Transform3D, n: Node, state: Dictionary) -> void:
	var faces: PackedVector3Array = mesh.get_faces()
	if faces.is_empty():
		(state["warnings"] as Array[String]).append("Skipped mesh on '%s': its triangles are not readable without the editor." % n.name)
		return
	geo.add_faces(faces, xf)
	state["parsed"] += 1


## Collision shapes become triangle soup. Primitives use the matching PrimitiveMesh;
## convex shapes use their (solid) debug mesh; height maps are triangulated here.
static func _add_shape(geo: NavigationMeshSourceGeometryData3D, shape: Shape3D, xf: Transform3D, n: Node, state: Dictionary) -> void:
	var faces := PackedVector3Array()
	if shape is BoxShape3D:
		var m := BoxMesh.new()
		m.size = (shape as BoxShape3D).size
		faces = m.get_faces()
	elif shape is SphereShape3D:
		var m := SphereMesh.new()
		m.radius = (shape as SphereShape3D).radius
		m.height = m.radius * 2.0
		faces = m.get_faces()
	elif shape is CapsuleShape3D:
		var m := CapsuleMesh.new()
		m.radius = (shape as CapsuleShape3D).radius
		m.height = (shape as CapsuleShape3D).height
		faces = m.get_faces()
	elif shape is CylinderShape3D:
		var m := CylinderMesh.new()
		m.top_radius = (shape as CylinderShape3D).radius
		m.bottom_radius = m.top_radius
		m.height = (shape as CylinderShape3D).height
		faces = m.get_faces()
	elif shape is ConcavePolygonShape3D:
		faces = (shape as ConcavePolygonShape3D).get_faces()
	elif shape is ConvexPolygonShape3D:
		var dm: ArrayMesh = shape.get_debug_mesh()
		if dm != null:
			faces = dm.get_faces()
	elif shape is HeightMapShape3D:
		faces = _heightmap_faces(shape as HeightMapShape3D)
	if faces.is_empty():
		(state["warnings"] as Array[String]).append("Skipped %s on '%s' (not supported by the headless parser)." % [shape.get_class(), n.name])
		return
	geo.add_faces(faces, xf)
	state["parsed"] += 1


static func _heightmap_faces(hm: HeightMapShape3D) -> PackedVector3Array:
	var w: int = hm.map_width
	var d: int = hm.map_depth
	var data: PackedFloat32Array = hm.map_data
	var faces := PackedVector3Array()
	if w < 2 or d < 2 or data.size() < w * d:
		return faces
	# Centered on the origin with 1 unit between samples, like the physics shape.
	var off := Vector3((w - 1) * 0.5, 0.0, (d - 1) * 0.5)
	for z: int in range(d - 1):
		for x: int in range(w - 1):
			var a := Vector3(x, data[z * w + x], z) - off
			var b := Vector3(x + 1, data[z * w + x + 1], z) - off
			var c := Vector3(x, data[(z + 1) * w + x], z + 1) - off
			var e := Vector3(x + 1, data[(z + 1) * w + x + 1], z + 1) - off
			faces.append_array(PackedVector3Array([a, b, c, b, e, c]))
	return faces


# -------------------------------------------------------------------------------------
# Baking
# -------------------------------------------------------------------------------------

## Bakes into `res` (a NavigationPolygon or NavigationMesh that is NOT the one the region
## uses: callers pass a duplicate so the scene is untouched until the ChangeSet runs).
## Returns {"parser": "engine"|"headless", "parsed": int, "warnings": [...]} or an error.
static func bake(region: Node, root: Node, res: Resource) -> Dictionary:
	var info: Dictionary = {"warnings": [] as Array[String]}
	if region is NavigationRegion2D:
		var np := res as NavigationPolygon
		var geo := NavigationMeshSourceGeometryData2D.new()
		if region.is_inside_tree():
			NavigationServer2D.parse_source_geometry_data(np, geo, region)
			info["parser"] = "engine"
		else:
			var st: Dictionary = parse_2d(region as NavigationRegion2D, root, np, geo)
			info["parser"] = "headless"
			info["parsed"] = st["parsed"]
			info["warnings"] = st["warnings"]
		if np.get_outline_count() == 0 and geo.get_traversable_outlines().is_empty():
			return R.err(R.BAD_PARAMS, ("navigation.bake: NavigationPolygon of '%s' has no walkable outline, so there is nothing to bake. " +
				"Pass 'outline' with the walkable area's corners, e.g. [[0,0],[512,0],[512,512],[0,512]] (region-local pixels).") % region.name)
		NavigationServer2D.bake_from_source_geometry_data(np, geo)
	else:
		var nm := res as NavigationMesh
		var geo3 := NavigationMeshSourceGeometryData3D.new()
		if region.is_inside_tree():
			NavigationServer3D.parse_source_geometry_data(nm, geo3, region)
			info["parser"] = "engine"
		else:
			var st3: Dictionary = parse_3d(region as NavigationRegion3D, root, nm, geo3)
			info["parser"] = "headless"
			info["parsed"] = st3["parsed"]
			info["warnings"] = st3["warnings"]
		if not geo3.has_data():
			return R.err(R.BAD_PARAMS, ("navigation.bake: found no source geometry for '%s'. Add MeshInstance3D / StaticBody3D+CollisionShape3D / GridMap " +
				"children under the region (or change the NavigationMesh's geometry_source_geometry_mode / geometry_parsed_geometry_type).%s") %
				[region.name, (" Notes: " + " ".join(info["warnings"])) if not (info["warnings"] as Array).is_empty() else ""])
		NavigationServer3D.bake_from_source_geometry_data(nm, geo3)
	return R.value(info)


# -------------------------------------------------------------------------------------
# Path queries on a private map
# -------------------------------------------------------------------------------------

## Computes a path over `regions` (NavigationRegion2D or 3D nodes under `root`, all of the
## same dimension). Returns {"points": Array, "length": float}.
static func find_path(root: Node, regions: Array[Node], from: Variant, to: Variant, optimize: bool, layers: int) -> Dictionary:
	var is_2d: bool = regions[0] is NavigationRegion2D
	var rids: Array[RID] = []
	var points: Array = []
	var length: float = 0.0
	if is_2d:
		var map: RID = NavigationServer2D.map_create()
		NavigationServer2D.map_set_use_async_iterations(map, false)
		NavigationServer2D.map_set_cell_size(map, ((regions[0] as NavigationRegion2D).navigation_polygon).cell_size)
		for node: Node in regions:
			var reg := node as NavigationRegion2D
			var rid: RID = NavigationServer2D.region_create()
			NavigationServer2D.region_set_use_async_iterations(rid, false)
			NavigationServer2D.region_set_transform(rid, chain_2d(reg, root))
			NavigationServer2D.region_set_navigation_layers(rid, reg.navigation_layers)
			NavigationServer2D.region_set_navigation_polygon(rid, reg.navigation_polygon)
			NavigationServer2D.region_set_map(rid, map)
			rids.append(rid)
		NavigationServer2D.map_set_active(map, true)
		NavigationServer2D.map_force_update(map)
		var path2: PackedVector2Array = NavigationServer2D.map_get_path(map, from as Vector2, to as Vector2, optimize, layers)
		for i: int in range(path2.size()):
			points.append([path2[i].x, path2[i].y])
			if i > 0:
				length += path2[i].distance_to(path2[i - 1])
		for rid: RID in rids:
			NavigationServer2D.free_rid(rid)
		NavigationServer2D.free_rid(map)
	else:
		var nm0: NavigationMesh = (regions[0] as NavigationRegion3D).navigation_mesh
		var map3: RID = NavigationServer3D.map_create()
		NavigationServer3D.map_set_use_async_iterations(map3, false)
		NavigationServer3D.map_set_cell_size(map3, nm0.cell_size)
		NavigationServer3D.map_set_cell_height(map3, nm0.cell_height)
		for node: Node in regions:
			var reg3 := node as NavigationRegion3D
			var rid3: RID = NavigationServer3D.region_create()
			NavigationServer3D.region_set_use_async_iterations(rid3, false)
			NavigationServer3D.region_set_transform(rid3, chain_3d(reg3, root))
			NavigationServer3D.region_set_navigation_layers(rid3, reg3.navigation_layers)
			NavigationServer3D.region_set_navigation_mesh(rid3, reg3.navigation_mesh)
			NavigationServer3D.region_set_map(rid3, map3)
			rids.append(rid3)
		NavigationServer3D.map_set_active(map3, true)
		NavigationServer3D.map_force_update(map3)
		var path3: PackedVector3Array = NavigationServer3D.map_get_path(map3, from as Vector3, to as Vector3, optimize, layers)
		for i: int in range(path3.size()):
			points.append([snappedf(path3[i].x, 0.001), snappedf(path3[i].y, 0.001), snappedf(path3[i].z, 0.001)])
			if i > 0:
				length += path3[i].distance_to(path3[i - 1])
		for rid: RID in rids:
			NavigationServer3D.free_rid(rid)
		NavigationServer3D.free_rid(map3)
	return {"points": points, "length": snappedf(length, 0.001)}
