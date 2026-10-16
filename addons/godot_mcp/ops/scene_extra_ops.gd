@tool
extends RefCounted
## Scene and node extras: instancing, inherited scenes, find, reorder, groups, close (worker: scene/signals).
##
## Registered in core/methods.gd (MODULES). `methods()` maps each bridge-protocol method
## this module implements to a descriptor (see the comment on Methods.MODULES for kinds).
## batch.apply is registered here too; its implementation lives in core/scene_batch.gd.
##
## Godot facts these functions rely on (verified on 4.7.2):
## * An instanced sub-scene is saved as `instance=ExtResource(...)` (with only overrides)
##   when it was instantiated with GEN_EDIT_STATE_INSTANCE and only its root gets
##   owner = scene root; Node.set_editable_instance(node, true) on the scene root is what
##   writes `[editable path="..."]` ("Editable Children").
## * An inherited scene's root carries a "scene inherited state" that GDScript cannot set
##   (Node.set_scene_inherited_state is not exposed, and instantiate(GEN_EDIT_STATE_MAIN_INHERITED)
##   alone does not set it). Instantiating a scene file whose root is `instance=` of the
##   base does set it, so scene.inherit writes that one-line seed and immediately re-saves
##   it through PackedScene.pack() + core/res_save.gd (ResourceSaver plus the UIDs that
##   headless saves drop), which produces Godot's canonical file.
## * Persistent groups are Node.add_to_group(name, true); only those are packed.
## * EditorInterface.close_scene() closes the *current* scene tab and discards its unsaved
##   changes, so scene.close switches to the requested tab and checks unsaved state first.

const R := preload("../core/mcp_result.gd")
const Params := preload("../core/params.gd")
const Codec := preload("../core/variant_codec.gd")
const NodePaths := preload("../core/node_paths.gd")
const ResPaths := preload("../core/res_paths.gd")
const ChangeSet := preload("../core/change_set.gd")
const SceneOps := preload("../core/scene_ops.gd")
const SceneBatch := preload("../core/scene_batch.gd")
const ResSave := preload("../core/res_save.gd")
const EditorScenes := preload("../core/editor_scenes.gd")

## node.find default and hard caps on returned matches.
const FIND_DEFAULT_LIMIT: int = 100
const FIND_MAX_LIMIT: int = 1000


static func methods() -> Dictionary:
	return {
		"node.instance": {"kind": "scene_mutation", "fn": plan_node_instance},
		"scene.inherit": {"kind": "project", "fn": do_scene_inherit},
		"node.find": {"kind": "scene_read", "fn": read_node_find},
		"node.move": {"kind": "scene_mutation", "fn": plan_node_move},
		"node.groups": {"kind": "scene_mutation", "fn": plan_node_groups},
		"scene.close": {"kind": "project", "fn": do_scene_close, "editor_only": true},
		"batch.apply": {"kind": "project", "fn": SceneBatch.apply},
	}


# ---------------------------------------------------------------------------------------
# node.instance
# ---------------------------------------------------------------------------------------

## node.instance: like node.add {instance}, plus Editable Children and a cycle check that
## also covers scenes instanced indirectly.
static func plan_node_instance(root: Node, params: Variant) -> Dictionary:
	var p := Params.new(params, "node.instance")
	var raw_instance: String = p.req_string("instance")
	var parent_path: String = p.opt_string("parent", ".")
	var editable: bool = p.opt_bool("editable_children", false)
	if p.failed():
		return p.error
	var sres: Dictionary = ResPaths.normalize_scene(raw_instance, "instance")
	if R.is_err(sres):
		return sres
	var instance_path: String = sres["value"]
	if not ResPaths.file_exists(instance_path):
		return ResPaths.scene_not_found(instance_path)
	var pres: Dictionary = NodePaths.resolve(root, parent_path, "parent")
	if R.is_err(pres):
		return pres
	var parent: Node = pres["value"]
	# A cycle exists when the instanced scene contains (directly or through its own
	# sub-scenes) the scene being edited, or any sub-scene the parent lives in.
	var forbidden: Array[String] = []
	var walker: Node = parent
	while walker != null:
		if not walker.scene_file_path.is_empty() and not walker.scene_file_path in forbidden:
			forbidden.append(walker.scene_file_path)
		if walker == root:
			break
		walker = walker.get_parent()
	var chain: Array[String] = _dependency_chain(instance_path, forbidden)
	if not chain.is_empty():
		return R.err(R.BAD_PARAMS, "node.instance: instancing '%s' here would create a cycle (%s): a scene cannot contain itself. Instance a different scene, or restructure the sub-scenes." % [instance_path, " contains ".join(chain)])

	var node_name: String = p.opt_string("name", "")
	var props: Dictionary = p.opt_dict("properties", {})
	var index: int = p.opt_int("index", -1)
	if p.failed():
		return p.error
	if p.has("name"):
		var name_err: Dictionary = SceneOps._check_name(node_name, "name")
		if not name_err.is_empty():
			return name_err
	var edit_err: Dictionary = NodePaths.check_editable(root, parent, "add a child to")
	if not edit_err.is_empty():
		return edit_err
	if index < -1 or index > parent.get_child_count():
		return R.err(R.BAD_PARAMS, "node.instance: 'index' %d is out of range; '%s' has %d children, so use -1 (append) or 0..%d." % [index, NodePaths.rel_path(root, parent), parent.get_child_count(), parent.get_child_count()])
	var packed: PackedScene = load(instance_path) as PackedScene
	if packed == null or not packed.can_instantiate():
		return R.err(R.BAD_PARAMS, "node.instance: '%s' is not a loadable PackedScene (broken file or missing dependencies)." % instance_path)
	# GEN_EDIT_STATE_INSTANCE keeps the link to the .tscn, so packing writes
	# `instance=ExtResource(...)` plus overrides instead of copying the sub-scene's nodes.
	var node: Node = packed.instantiate(PackedScene.GEN_EDIT_STATE_INSTANCE)
	if node == null:
		return R.err(R.GODOT_ERROR, "node.instance: instantiating '%s' failed (the scene may be broken or have missing dependencies)." % instance_path)
	var desired: String = node_name if not node_name.is_empty() else String(node.name)
	node.name = NodePaths.unique_child_name(parent, desired)
	# Properties go on the fresh node before it enters the scene (no undo needed).
	for key: Variant in props:
		var r: Dictionary = Codec.decode_property(node, str(key), props[key], root)
		if R.is_err(r):
			node.free()
			return r
		node.set(str(key), r["value"])

	var cs := ChangeSet.new()
	cs.do_method(parent, &"add_child", [node, true])
	if index >= 0:
		cs.do_method(parent, &"move_child", [node, index])
	# Only the instance root is owned by the scene root; its internal nodes keep their
	# owner (the instance root), which is what makes it an instance rather than a copy.
	cs.do_method(node, &"set_owner", [root])
	if editable:
		cs.do_method(root, &"set_editable_instance", [node, true])
	cs.do_reference(node)
	# Undo runs in the order added: clear the editable flag while the node is still there.
	if editable:
		cs.undo_method(root, &"set_editable_instance", [node, false])
	cs.undo_method(node, &"set_owner", [null])
	cs.undo_method(parent, &"remove_child", [node])
	var finish := func() -> Dictionary:
		var result: Dictionary = {
			"path": NodePaths.rel_path(root, node),
			"name": String(node.name),
			"type": node.get_class(),
			"instance": instance_path,
			"editable_children": root.is_editable_instance(node),
		}
		if String(node.name) != desired:
			result["renamed_from"] = desired
		if not props.is_empty():
			# Echo the applied properties as read back, like node.set's "changed", so the
			# caller does not need a node.get to verify them (MCP_TEST_LOG).
			var applied: Dictionary = {}
			for key: Variant in props:
				applied[str(key)] = Codec.encode(node.get(str(key)), root)
			result["properties"] = applied
		return result
	return {"changes": cs, "finish": finish}


## Returns the chain of scene paths from `start` to the first scene in `forbidden` it
## depends on (["res://a.tscn", "res://b.tscn", "res://main.tscn"]), or [] if none.
static func _dependency_chain(start: String, forbidden: Array[String], visited: Dictionary = {}) -> Array[String]:
	if start in forbidden:
		return [start]
	if visited.has(start):
		return []
	visited[start] = true
	for dep: String in ResourceLoader.get_dependencies(start):
		# Entries are "res://x.tscn" or, with UIDs, "uid://...::Type::res://x.tscn".
		var dep_path: String = dep.get_slice("::", dep.get_slice_count("::") - 1)
		var ext: String = dep_path.get_extension().to_lower()
		if ext != "tscn" and ext != "scn":
			continue
		var sub: Array[String] = _dependency_chain(dep_path, forbidden, visited)
		if not sub.is_empty():
			var out: Array[String] = [start]
			out.append_array(sub)
			return out
	return []


# ---------------------------------------------------------------------------------------
# scene.inherit
# ---------------------------------------------------------------------------------------

## scene.inherit: write a new scene inheriting `base` ("New Inherited Scene"), open it in
## the editor when connected.
static func do_scene_inherit(params: Variant, env: Dictionary) -> Dictionary:
	var p := Params.new(params, "scene.inherit")
	var raw_path: String = p.req_string("path")
	var raw_base: String = p.req_string("base")
	var root_name: String = p.opt_string("root_name", "")
	var should_open: bool = p.opt_bool("open", true)
	if p.failed():
		return p.error
	var pres: Dictionary = ResPaths.normalize_scene(raw_path, "path")
	if R.is_err(pres):
		return pres
	var path: String = pres["value"]
	var bres: Dictionary = ResPaths.normalize_scene(raw_base, "base")
	if R.is_err(bres):
		return bres
	var base: String = bres["value"]
	if path.get_extension().to_lower() != "tscn":
		return R.err(R.BAD_PARAMS, "scene.inherit: 'path' must end in .tscn, got '%s'." % path)
	if not ResPaths.file_exists(base):
		return ResPaths.scene_not_found(base)
	if path == base:
		return R.err(R.BAD_PARAMS, "scene.inherit: 'path' and 'base' are the same file; choose a new path for the inherited scene.")
	if ResPaths.file_exists(path):
		return R.err(R.CONFLICT, "scene.inherit: '%s' already exists. Choose another path, or edit that scene with the node.* tools." % path)
	if root_name.is_empty():
		root_name = path.get_file().get_basename().to_pascal_case()
		if root_name.validate_node_name().is_empty():
			root_name = "Node"
	if root_name.validate_node_name() != root_name:
		return R.err(R.BAD_PARAMS, "scene.inherit: invalid 'root_name' '%s' (names cannot contain . : @ / \" %%). A valid version would be '%s'." % [root_name, root_name.validate_node_name()])
	var base_packed: PackedScene = load(base) as PackedScene
	if base_packed == null or not base_packed.can_instantiate():
		return R.err(R.BAD_PARAMS, "scene.inherit: '%s' is not a loadable scene (broken file or missing dependencies)." % base)
	var dir_err: int = DirAccess.make_dir_recursive_absolute(ProjectSettings.globalize_path(path.get_base_dir()))
	if dir_err != OK and dir_err != ERR_ALREADY_EXISTS:
		return R.godot_err("Creating folder '%s'" % path.get_base_dir(), dir_err)

	# Seed: the smallest valid inherited scene (see the header comment for why). It is
	# replaced right away by Godot's own serialization of the instantiated scene.
	var seed_text: String = "[gd_scene format=3]\n\n[ext_resource type=\"PackedScene\" path=\"%s\" id=\"1_base\"]\n\n[node name=\"%s\" instance=ExtResource(\"1_base\")]\n" % [base.c_escape(), root_name.c_escape()]
	var f: FileAccess = FileAccess.open(path, FileAccess.WRITE)
	if f == null:
		return R.godot_err("Writing '%s'" % path, FileAccess.get_open_error())
	f.store_string(seed_text)
	f.close()
	var seeded: PackedScene = ResourceLoader.load(path, "PackedScene", ResourceLoader.CACHE_MODE_IGNORE) as PackedScene
	var root: Node = seeded.instantiate(PackedScene.GEN_EDIT_STATE_MAIN) if seeded != null else null
	if root == null:
		DirAccess.remove_absolute(ProjectSettings.globalize_path(path))
		return R.err(R.GODOT_ERROR, "scene.inherit: Godot could not instantiate '%s' as a base scene. Check that it opens in the editor." % base)
	# ResSave instead of ResourceSaver: headless saves would otherwise drop every UID.
	var packed := PackedScene.new()
	var err: int = packed.pack(root)
	root.free()
	if err == OK:
		err = ResSave.save(packed, path)
	if err != OK:
		DirAccess.remove_absolute(ProjectSettings.globalize_path(path))
		return R.godot_err("Saving inherited scene '%s'" % path, err)
	var result: Dictionary = {"path": path, "base": base, "root_name": root_name, "opened": false}
	if bool(env.get("editor", false)):
		var fs: Object = env.get("filesystem")
		if fs != null:
			fs.call(&"update_file", path)
		if should_open:
			var opened: Dictionary = (env["edited_root"] as Callable).call({"scene": path})
			if R.is_err(opened):
				return opened
			result["opened"] = true
	return R.ok(result)


# ---------------------------------------------------------------------------------------
# node.find
# ---------------------------------------------------------------------------------------

## node.find: nodes matching every given filter (name, type, group, script, property).
static func read_node_find(root: Node, params: Variant) -> Dictionary:
	var p := Params.new(params, "node.find")
	var name_q: String = p.opt_string("name", "")
	var type_q: String = p.opt_string("type", "")
	var group_q: String = p.opt_string("group", "")
	var script_q: String = p.opt_string("script", "")
	var prop_q: String = p.opt_string("property", "")
	var start_path: String = p.opt_string("root", ".")
	var limit: int = p.opt_int("limit", FIND_DEFAULT_LIMIT)
	var has_value: bool = (params as Dictionary).has("value")
	var value_q: Variant = (params as Dictionary).get("value")
	if p.failed():
		return p.error
	if name_q.is_empty() and type_q.is_empty() and group_q.is_empty() and script_q.is_empty() and prop_q.is_empty():
		return R.err(R.BAD_PARAMS, "node.find: pass at least one filter: name (glob or substring, e.g. \"enemy*\"), type (e.g. \"CollisionShape2D\", subclasses match), group, script (res:// path) or property (with optional value).")
	if has_value and prop_q.is_empty():
		return R.err(R.BAD_PARAMS, "node.find: 'value' needs 'property' (the property to compare), e.g. {\"property\": \"visible\", \"value\": false}.")
	if limit < 1 or limit > FIND_MAX_LIMIT:
		return R.err(R.BAD_PARAMS, "node.find: 'limit' must be between 1 and %d (default %d)." % [FIND_MAX_LIMIT, FIND_DEFAULT_LIMIT])
	if not type_q.is_empty() and not ClassDB.class_exists(type_q) and not _is_global_class(type_q):
		var similar: Array[String] = preload("../core/fuzzy.gd").suggest(type_q, ClassDB.get_inheriters_from_class("Node") + PackedStringArray(_global_class_names()), 5)
		return R.err(R.BAD_PARAMS, "node.find: unknown type '%s'.%s" % [type_q, preload("../core/fuzzy.gd").did_you_mean(similar)], {"similar": similar})
	if not script_q.is_empty():
		var sres: Dictionary = ResPaths.normalize(script_q, "script")
		if R.is_err(sres):
			return sres
		script_q = sres["value"]
	var res: Dictionary = NodePaths.resolve(root, start_path, "root")
	if R.is_err(res):
		return res
	var name_lower: String = name_q.to_lower()
	var is_glob: bool = name_q.contains("*") or name_q.contains("?")
	var nodes: Array[Node] = [res["value"]]
	_collect_listed(root, res["value"], nodes)
	var matches: Array = []
	var total: int = 0
	for node: Node in nodes:
		if not name_q.is_empty():
			var n: String = String(node.name).to_lower()
			if is_glob:
				if not n.match(name_lower):
					continue
			elif not n.contains(name_lower):
				continue
		if not type_q.is_empty() and not _is_type(node, type_q):
			continue
		if not group_q.is_empty() and not node.is_in_group(group_q):
			continue
		var script: Script = node.get_script() as Script
		if not script_q.is_empty() and (script == null or script.resource_path != script_q):
			continue
		if not prop_q.is_empty():
			if Codec.find_property(node, prop_q).is_empty() or prop_q.begins_with("metadata/") and not node.has_meta(prop_q.trim_prefix("metadata/")):
				continue
			if has_value:
				var d: Dictionary = Codec.decode_property(node, prop_q, value_q, root)
				if R.is_err(d):
					continue
				var cur: Variant = node.get(prop_q)
				var want: Variant = d["value"]
				if typeof(cur) != typeof(want) or cur != want:
					continue
		total += 1
		if matches.size() < limit:
			var entry: Dictionary = {"path": NodePaths.rel_path(root, node), "type": node.get_class()}
			if script != null and not String(script.get_global_name()).is_empty():
				entry["script_class"] = String(script.get_global_name())
			if node != root and not node.scene_file_path.is_empty():
				entry["instance"] = node.scene_file_path
			matches.append(entry)
	return R.ok({"matches": matches, "total": total, "truncated": total > matches.size()})


static func _collect_listed(root: Node, node: Node, out: Array[Node]) -> void:
	for c: Node in NodePaths.listed_children(root, node):
		out.append(c)
		_collect_listed(root, c, out)


## is_class() for engine types, plus global script classes (and their subclasses).
static func _is_type(node: Node, type_name: String) -> bool:
	if ClassDB.class_exists(type_name):
		return node.is_class(type_name)
	var s: Script = node.get_script() as Script
	while s != null:
		if String(s.get_global_name()) == type_name:
			return true
		s = s.get_base_script()
	return false


static func _global_class_names() -> Array[String]:
	var out: Array[String] = []
	for c: Dictionary in ProjectSettings.get_global_class_list():
		out.append(String(c["class"]))
	return out


static func _is_global_class(type_name: String) -> bool:
	return type_name in _global_class_names()


# ---------------------------------------------------------------------------------------
# node.move
# ---------------------------------------------------------------------------------------

## node.move: reorder a node among its siblings (negative index counts from the end).
static func plan_node_move(root: Node, params: Variant) -> Dictionary:
	var p := Params.new(params, "node.move")
	var path: String = p.req_string("path")
	var index: int = p.opt_int("index", 0)
	if p.failed():
		return p.error
	if not (params as Dictionary).has("index"):
		return R.err(R.BAD_PARAMS, "node.move: missing 'index' (0 = first child, -1 = last).")
	var res: Dictionary = NodePaths.resolve(root, path)
	if R.is_err(res):
		return res
	var node: Node = res["value"]
	if node == root:
		return R.err(R.BAD_PARAMS, "node.move: the scene root has no siblings to reorder.")
	var edit_err: Dictionary = NodePaths.check_editable(root, node, "move")
	if edit_err.is_empty():
		edit_err = NodePaths.check_structural(root, node, "reorder")
	if not edit_err.is_empty():
		return edit_err
	var parent: Node = node.get_parent()
	var count: int = parent.get_child_count()
	var target: int = index if index >= 0 else count + index
	if target < 0 or target >= count:
		return R.err(R.BAD_PARAMS, "node.move: 'index' %d is out of range; '%s' has %d children, so use 0..%d or -1..-%d (from the end)." % [index, NodePaths.rel_path(root, parent), count, count - 1, count])
	var old_index: int = node.get_index()
	var cs := ChangeSet.new()
	if target != old_index:
		cs.do_method(parent, &"move_child", [node, target])
		cs.undo_method(parent, &"move_child", [node, old_index])
	var finish := func() -> Dictionary:
		var siblings: Array[String] = []
		for c: Node in NodePaths.listed_children(root, parent):
			siblings.append(String(c.name))
		return {"path": NodePaths.rel_path(root, node), "index": node.get_index(), "old_index": old_index, "order": siblings}
	return {"changes": cs, "finish": finish}


# ---------------------------------------------------------------------------------------
# node.groups
# ---------------------------------------------------------------------------------------

## node.groups: add/remove persistent groups (saved in the .tscn).
static func plan_node_groups(root: Node, params: Variant) -> Dictionary:
	var p := Params.new(params, "node.groups")
	var path: String = p.req_string("path")
	var add: Array = p.opt_array("add", [])
	var remove: Array = p.opt_array("remove", [])
	if p.failed():
		return p.error
	if add.is_empty() and remove.is_empty():
		return R.err(R.BAD_PARAMS, "node.groups: pass 'add' and/or 'remove' (arrays of group names), e.g. {\"add\": [\"enemies\"]}.")
	var res: Dictionary = NodePaths.resolve(root, path)
	if R.is_err(res):
		return res
	var node: Node = res["value"]
	var edit_err: Dictionary = NodePaths.check_editable(root, node, "change the groups of")
	if not edit_err.is_empty():
		return edit_err
	var cs := ChangeSet.new()
	var notes: Array[String] = []
	for g: Variant in add:
		var gname: String = str(g).strip_edges()
		if gname.is_empty():
			return R.err(R.BAD_PARAMS, "node.groups: group names must not be empty.")
		if gname in remove.map(func(x: Variant) -> String: return str(x).strip_edges()):
			return R.err(R.BAD_PARAMS, "node.groups: '%s' is in both 'add' and 'remove'." % gname)
		if node.is_in_group(gname):
			notes.append("already in '%s'" % gname)
			continue
		cs.do_method(node, &"add_to_group", [StringName(gname), true])
		cs.undo_method(node, &"remove_from_group", [StringName(gname)])
	for g: Variant in remove:
		var rname: String = str(g).strip_edges()
		if not node.is_in_group(rname):
			notes.append("not in '%s'" % rname)
			continue
		cs.do_method(node, &"remove_from_group", [StringName(rname)])
		cs.undo_method(node, &"add_to_group", [StringName(rname), true])
	var finish := func() -> Dictionary:
		var result: Dictionary = {"path": NodePaths.rel_path(root, node), "groups": SceneOps._persistent_groups(node)}
		if not notes.is_empty():
			result["unchanged"] = notes
		return result
	return {"changes": cs, "finish": finish}


# ---------------------------------------------------------------------------------------
# scene.close (editor only)
# ---------------------------------------------------------------------------------------

## scene.close: close a scene tab; refuses to drop unsaved changes unless told to.
static func do_scene_close(params: Variant, env: Dictionary) -> Dictionary:
	var p := Params.new(params, "scene.close")
	var raw: String = p.opt_string("path", "")
	var save: bool = p.opt_bool("save", false)
	var discard: bool = p.opt_bool("discard", false)
	if p.failed():
		return p.error
	if save and discard:
		return R.err(R.BAD_PARAMS, "scene.close: pass either save: true or discard: true, not both.")
	var ei: Object = env.get("interface")
	if ei == null:
		return R.err(R.UNSUPPORTED, "scene.close needs the live Godot editor.")
	# Real tab paths: the editor's own list keeps the old path after scene.save_as.
	var open_scenes: PackedStringArray = EditorScenes.open_scenes(ei)
	var path: String = ""
	if raw.is_empty():
		var current: Node = ei.call(&"get_edited_scene_root")
		if current == null:
			return R.err(R.NO_SCENE, "scene.close: no scene is open in the editor.")
		path = current.scene_file_path
	else:
		var norm: Dictionary = ResPaths.normalize_scene(raw, "path")
		if R.is_err(norm):
			return norm
		path = norm["value"]
		if not path in open_scenes:
			return R.err(R.NOT_FOUND, "scene.close: '%s' is not open in the editor. Open scenes: %s." % [path, ", ".join(open_scenes) if not open_scenes.is_empty() else "(none)"], {"open_scenes": Array(open_scenes)})
		# close_scene() acts on the current tab, so switch to the requested one first.
		var switched: Dictionary = (env["edited_root"] as Callable).call({"scene": path})
		if R.is_err(switched):
			return switched
	# By tab (root), not by path: after scene.save_as the editor's unsaved list still names
	# the old file, and a path lookup reported discarded_changes: false for a dirty scene.
	var unsaved: bool = path.is_empty() or EditorScenes.current_is_unsaved(ei)
	var saved: bool = false
	if unsaved and not save and not discard:
		return R.err(R.CONFLICT, "scene.close: '%s' has unsaved changes. Pass save: true to save before closing, or discard: true to drop the changes." % (path if not path.is_empty() else "the edited scene (never saved)"))
	if unsaved and save:
		if path.is_empty():
			return R.err(R.BAD_PARAMS, "scene.close: the edited scene has never been saved; save it with scene.save_as first, or pass discard: true.")
		var serr: int = ei.call(&"save_scene")
		if serr != OK:
			return R.godot_err("Saving '%s' before closing" % path, serr)
		saved = true
	# Closing makes another tab current; keep its unsaved state (EditorScenes.restore_unsaved).
	var dirty_before: PackedStringArray = EditorScenes.unsaved_scenes(ei)
	var err: int = ei.call(&"close_scene")
	if err != OK:
		return R.godot_err("Closing '%s'" % path, err)
	EditorScenes.restore_unsaved(ei, dirty_before)
	var now: Node = ei.call(&"get_edited_scene_root")
	var closed: Variant = null
	if not path.is_empty():
		closed = path
	var edited: Variant = null
	if now != null and not now.scene_file_path.is_empty():
		edited = now.scene_file_path
	return R.ok({
		"closed": closed,
		"saved": saved,
		"discarded_changes": unsaved and discard,
		"edited_scene": edited,
	})
