@tool
extends RefCounted
## Backend-agnostic scene operations (docs/bridge-protocol.md section 5).
##
## Every function takes the scene root explicitly, so the same code serves:
## * the editor backend (root = EditorInterface.get_edited_scene_root()), and
## * the headless backend (root = a freshly instantiated PackedScene).
##
## Read-only operations (`tree`, `node_info`) return a finished `{"result": ...}`.
##
## Mutations are split in two phases so the editor can make them undoable:
## `plan_*` validates everything up front and returns
##     {"changes": ChangeSet, "finish": Callable}
## without modifying the scene. The backend applies the ChangeSet (through
## EditorUndoRedoManager, or directly when headless) and then calls `finish` to build the
## result from the *actual* post-change state (e.g. the final auto-renamed node name).
## Validation failures return `{"error": ...}` and leave the scene untouched.
##
## Ownership rules (why nodes get saved or not): PackedScene.pack() only stores nodes whose
## `owner` is the scene root (or that belong to an instanced sub-scene). Every node we add
## or move therefore gets `owner = root`; for an instanced sub-scene only the instance root
## gets it, its internal nodes keep their owner (the instance root) so the .tscn references
## the sub-scene instead of inlining a copy of it.

const ResSave := preload("res_save.gd")
const R := preload("mcp_result.gd")
const Params := preload("params.gd")
const Codec := preload("variant_codec.gd")
const NodePaths := preload("node_paths.gd")
const ResPaths := preload("res_paths.gd")
const ChangeSet := preload("change_set.gd")

## Usage flags that mark inspector grouping entries rather than real properties.
const _GROUPING_USAGE: int = PROPERTY_USAGE_GROUP | PROPERTY_USAGE_SUBGROUP | PROPERTY_USAGE_CATEGORY

## Edit state used when instancing sub-scenes. GEN_EDIT_STATE_INSTANCE keeps the link to
## the sub-scene so packing stores an `instance=ExtResource(...)` with only overrides.
const _INSTANCE_EDIT_STATE := PackedScene.GEN_EDIT_STATE_INSTANCE


# ---------------------------------------------------------------------------------------
# Read-only operations
# ---------------------------------------------------------------------------------------

## scene.tree: hierarchical dump of the scene (or a subtree).
static func tree(root: Node, scene_path: String, params: Variant) -> Dictionary:
	var p := Params.new(params, "scene.tree")
	var start_path: String = p.opt_string("root", ".")
	var depth: int = p.opt_int("depth", -1)
	var max_nodes: int = p.opt_int("max_nodes", 300)
	var include_props: bool = p.opt_bool("include_properties", false)
	if p.failed():
		return p.error
	if max_nodes < 1:
		return R.err(R.BAD_PARAMS, "scene.tree: 'max_nodes' must be at least 1 (default 300).")
	var res: Dictionary = NodePaths.resolve(root, start_path, "root")
	if R.is_err(res):
		return res
	var start: Node = res["value"]
	# Starting at an instanced sub-scene (or inside one) is an explicit request for its own
	# nodes, so they are listed even without "Editable Children" (marked inside_instance;
	# node.get works on them too). The 2D dogfood test could read "HUD/Margin" with node.get
	# but had no way to discover it: scene.tree from the root showed HUD as a leaf.
	var show_internal: bool = start != root and (not start.scene_file_path.is_empty() or not NodePaths.is_editable(root, start))
	var state: Dictionary = {"count": 0, "max": max_nodes, "truncated": false, "internal": show_internal}
	var dump: Dictionary = _dump_node(root, start, 0, depth, include_props, state)
	return R.ok({
		"scene": scene_path,
		"root": dump,
		"node_count": state["count"],
		"truncated": state["truncated"],
	})


static func _dump_node(root: Node, node: Node, level: int, max_depth: int, include_props: bool, state: Dictionary) -> Dictionary:
	state["count"] = int(state["count"]) + 1
	var info: Dictionary = _node_summary(root, node)
	if include_props:
		info["properties"] = non_default_properties(root, node)
	# Internal nodes of an instanced sub-scene are hidden unless "Editable Children" is on;
	# NodePaths.listed_children applies exactly that rule.
	var children: Array[Node] = NodePaths.listed_children(root, node)
	if bool(state.get("internal", false)):
		children.assign(node.get_children())
	elif children.size() < node.get_child_count():
		# An instance whose own nodes are hidden: say how many, and how to list them.
		info["hidden_children"] = node.get_child_count() - children.size()
	info["child_count"] = children.size()
	var out_children: Array = []
	var truncated: bool = false
	if max_depth >= 0 and level >= max_depth:
		truncated = not children.is_empty()
	else:
		for child: Node in children:
			if int(state["count"]) >= int(state["max"]):
				truncated = true
				state["truncated"] = true
				break
			out_children.append(_dump_node(root, child, level + 1, max_depth, include_props, state))
	# Token budget: a tree of a few hundred nodes is read often, so leave out what carries no
	# information: no script / not an instance (null), no groups, not truncated. "children"
	# stays even when empty: it is the tree's structure and clients walk it without checks.
	# (node.get keeps the full node summary; only the tree is trimmed.)
	for key: String in ["script", "instance"]:
		if info.get(key) == null:
			info.erase(key)
	if (info.get("groups", []) as Array).is_empty():
		info.erase("groups")
	info["children"] = out_children
	if truncated:
		info["truncated"] = true
	return info


## Basic identity of a node shared by scene.tree and node.get.
static func _node_summary(root: Node, node: Node) -> Dictionary:
	var script: Script = node.get_script() as Script
	# The root's scene_file_path is the scene itself, which is not an "instance".
	var instance: Variant = null
	if node != root and not node.scene_file_path.is_empty():
		instance = node.scene_file_path
	var info: Dictionary = {
		"name": String(node.name),
		"type": node.get_class(),
		"path": NodePaths.rel_path(root, node),
		"script": _script_path(script),
		"instance": instance,
		"groups": _persistent_groups(node),
	}
	if script != null and not String(script.get_global_name()).is_empty():
		info["script_class"] = String(script.get_global_name())
	if node == root:
		var base_scene: String = _inherited_from(root)
		if not base_scene.is_empty():
			info["inherits"] = base_scene
	if node != root and node.owner != null and node.owner != root:
		info["inside_instance"] = NodePaths.rel_path(root, node.owner)
	return info


## For an inherited scene ("New Inherited Scene"), the path of the base scene; else "".
## The inherited state is not exposed on Node, so we read it from the saved PackedScene:
## node 0 of an inherited scene's SceneState is an instance of the base scene.
static func _inherited_from(root: Node) -> String:
	if root.scene_file_path.is_empty() or not ResourceLoader.exists(root.scene_file_path):
		return ""
	var packed: PackedScene = load(root.scene_file_path) as PackedScene
	if packed == null:
		return ""
	var state: SceneState = packed.get_state()
	if state.get_node_count() == 0:
		return ""
	var base: PackedScene = state.get_node_instance(0)
	return base.resource_path if base != null else ""


static func _script_path(script: Script) -> Variant:
	if script == null:
		return null
	return script.resource_path if not script.resource_path.is_empty() else "<built-in script>"


## Groups saved with the scene. Godot uses "_"-prefixed groups internally (per the
## Node.get_groups() docs), so those are filtered out.
static func _persistent_groups(node: Node) -> Array[String]:
	var out: Array[String] = []
	for g: StringName in node.get_groups():
		if not String(g).begins_with("_"):
			out.append(String(g))
	return out


## Stored properties whose value differs from the class (or script) default. This is what
## the .tscn file would contain, and is a compact view for an LLM.
static func non_default_properties(root: Node, node: Node) -> Dictionary:
	var out: Dictionary = {}
	var script: Script = node.get_script() as Script
	for info: Dictionary in node.get_property_list():
		var usage: int = info["usage"]
		if (usage & PROPERTY_USAGE_STORAGE) == 0 or (usage & _GROUPING_USAGE) != 0:
			continue
		var pname: String = info["name"]
		if pname.begins_with("_") or pname == "script":
			continue
		var v: Variant = node.get(pname)
		var default: Variant = ClassDB.class_get_property_default_value(node.get_class(), pname)
		if default == null and script != null:
			default = script.get_property_default_value(pname)
		if typeof(v) == typeof(default) and v == default:
			continue
		if v == null and default == null:
			continue
		out[pname] = Codec.encode(v, root)
	return out


## True when `v` is the default of property `pname`: the engine class default, or, when
## the class has none, the attached script's default (exported/script variables). Same
## comparison non_default_properties uses (same type and value).
static func _is_default(node: Node, script: Script, pname: String, v: Variant) -> bool:
	var default: Variant = ClassDB.class_get_property_default_value(node.get_class(), pname)
	if default == null and script != null:
		default = script.get_property_default_value(pname)
	if default == null:
		return v == null
	return typeof(v) == typeof(default) and v == default


## node.get: properties, script, and persistent signal connections of one node.
static func node_info(root: Node, params: Variant) -> Dictionary:
	var p := Params.new(params, "node.get")
	var path: String = p.opt_string("path", ".")
	var wanted: Array = p.opt_array("properties", [])
	var has_filter: bool = p.has("properties")
	if p.failed():
		return p.error
	var res: Dictionary = NodePaths.resolve(root, path)
	if R.is_err(res):
		return res
	var node: Node = res["value"]
	var info: Dictionary = _node_summary(root, node)
	var props: Dictionary = {}
	# ["*"] = every property, defaults included (the old default output); the same opt-in
	# godot_game_get uses for live nodes.
	var everything: bool = has_filter and wanted.size() == 1 and str(wanted[0]) == "*"
	if has_filter and not everything:
		for w: Variant in wanted:
			var pname: String = str(w)
			if Codec.find_property(node, pname).is_empty():
				return Codec.unknown_property_error(node, pname, "Node '%s' (%s)" % [info["path"], info["type"]])
			props[pname] = Codec.encode(node.get(pname), root)
	else:
		# Without a filter only values that differ from the class (or script) default are
		# listed, plus a count of the ones left out: a node has 50-150 inspector properties,
		# almost all at their defaults, and listing them cost a lot of tokens for nothing.
		var script: Script = node.get_script() as Script
		var omitted: int = 0
		for pinfo: Dictionary in node.get_property_list():
			var usage: int = pinfo["usage"]
			if (usage & (PROPERTY_USAGE_STORAGE | PROPERTY_USAGE_EDITOR)) == 0 or (usage & _GROUPING_USAGE) != 0:
				continue
			var pname2: String = pinfo["name"]
			if pname2.begins_with("_"):
				continue
			var v: Variant = node.get(pname2)
			if not everything and _is_default(node, script, pname2, v):
				omitted += 1
				continue
			props[pname2] = Codec.encode(v, root)
		if omitted > 0:
			info["defaults_omitted"] = omitted
	info["properties"] = props
	info["signals_connected"] = _signal_connections(root, node)
	var child_names: Array[String] = []
	for c: Node in NodePaths.listed_children(root, node):
		child_names.append(String(c.name))
	info["children"] = child_names
	info.erase("name")
	return R.ok(info)


## Outgoing connections from `node` to nodes inside the scene. Target paths are relative to
## the scene root, like every other path in results (protocol section 4).
static func _signal_connections(root: Node, node: Node) -> Array:
	var out: Array = []
	for sig: Dictionary in node.get_signal_list():
		for conn: Dictionary in node.get_signal_connection_list(sig["name"]):
			var callable: Callable = conn["callable"]
			var target: Object = callable.get_object()
			if not target is Node:
				continue
			var tnode: Node = target
			if tnode != root and not root.is_ancestor_of(tnode):
				continue
			# Only connections saved in the scene (CONNECT_PERSIST) are interesting; the editor
			# itself connects internal callbacks we must not report.
			var flags: int = conn.get("flags", 0)
			if (flags & CONNECT_PERSIST) == 0:
				continue
			out.append({
				"signal": String(sig["name"]),
				"target": NodePaths.rel_path(root, tnode),
				"method": String(callable.get_method()),
				"flags": flags,
			})
	return out


# ---------------------------------------------------------------------------------------
# Mutations (plan -> apply -> finish)
# ---------------------------------------------------------------------------------------

static func _plan(changes: ChangeSet, finish: Callable) -> Dictionary:
	return {"changes": changes, "finish": finish}


## Validates a node name the same way Godot would sanitise it.
static func _check_name(node_name: String, param_name: String) -> Dictionary:
	if node_name.strip_edges().is_empty():
		return R.err(R.BAD_PARAMS, "Parameter '%s' must not be empty." % param_name)
	var valid: String = node_name.validate_node_name()
	if valid != node_name:
		return R.err(R.BAD_PARAMS, "Invalid node name '%s' in '%s': names cannot contain . : @ / \" %% or be empty. A valid version would be '%s'." % [node_name, param_name, valid])
	return {}


## `node` plus all its descendants whose owner is the scene root: the nodes whose owner
## must be restored after a remove/re-add (Godot clears owners when a node leaves the tree).
static func _owned_by_root(root: Node, node: Node) -> Array[Node]:
	var out: Array[Node] = []
	if node.owner == root:
		out.append(node)
	_collect_owned(root, node, out)
	return out


static func _collect_owned(root: Node, node: Node, out: Array[Node]) -> void:
	for c: Node in node.get_children():
		if c.owner == root:
			out.append(c)
		_collect_owned(root, c, out)


## node.add
static func plan_node_add(root: Node, params: Variant) -> Dictionary:
	var p := Params.new(params, "node.add")
	var parent_path: String = p.opt_string("parent", ".")
	var type_name: String = p.opt_string("type", "")
	var instance_path: String = p.opt_string("instance", "")
	var node_name: String = p.opt_string("name", "")
	var props: Dictionary = p.opt_dict("properties", {})
	var index: int = p.opt_int("index", -1)
	if p.failed():
		return p.error
	if type_name.is_empty() == instance_path.is_empty():
		return R.err(R.BAD_PARAMS, "node.add: pass exactly one of 'type' (a node class such as \"Sprite2D\" or a global script class) or 'instance' (a res:// path to a .tscn to instance).")
	if p.has("name"):
		var name_err: Dictionary = _check_name(node_name, "name")
		if not name_err.is_empty():
			return name_err
	var pres: Dictionary = NodePaths.resolve(root, parent_path, "parent")
	if R.is_err(pres):
		return pres
	var parent: Node = pres["value"]
	var edit_err: Dictionary = NodePaths.check_editable(root, parent, "add a child to")
	if not edit_err.is_empty():
		return edit_err
	if index < -1 or index > parent.get_child_count():
		return R.err(R.BAD_PARAMS, "node.add: 'index' %d is out of range; '%s' has %d children, so use -1 (append) or 0..%d." % [index, NodePaths.rel_path(root, parent), parent.get_child_count(), parent.get_child_count()])

	var node: Node = null
	var default_name: String = type_name
	if not type_name.is_empty():
		var created: Dictionary = Codec.instantiate_class(type_name, "Node")
		if R.is_err(created):
			return created
		node = created["value"]
	else:
		var sres: Dictionary = ResPaths.normalize_scene(instance_path, "instance")
		if R.is_err(sres):
			return sres
		instance_path = sres["value"]
		if not ResPaths.file_exists(instance_path):
			return ResPaths.scene_not_found(instance_path)
		if instance_path == root.scene_file_path:
			return R.err(R.BAD_PARAMS, "node.add: cannot instance '%s' inside itself (that would be recursive)." % instance_path)
		var packed: PackedScene = load(instance_path) as PackedScene
		if packed == null:
			return R.err(R.BAD_PARAMS, "node.add: '%s' is not a loadable PackedScene." % instance_path)
		node = packed.instantiate(_INSTANCE_EDIT_STATE)
		if node == null:
			return R.err(R.GODOT_ERROR, "node.add: instantiating '%s' failed (the scene may be broken or have missing dependencies)." % instance_path)
		default_name = String(node.name)

	# Godot would auto-rename on collision anyway (to "@Name@123" style names unless asked
	# for readable ones); we pick the editor-style "Name2" ourselves and report it.
	var desired: String = node_name if not node_name.is_empty() else default_name
	node.name = NodePaths.unique_child_name(parent, desired)

	# Properties are set on the fresh node before it enters the scene: no undo needed
	# (undoing the add discards the node), and errors leave the scene untouched.
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
	cs.do_method(node, &"set_owner", [root])
	cs.do_reference(node)
	cs.undo_method(node, &"set_owner", [null])
	cs.undo_method(parent, &"remove_child", [node])
	var finish := func() -> Dictionary:
		var result: Dictionary = {
			"path": NodePaths.rel_path(root, node),
			"name": String(node.name),
			"type": node.get_class(),
		}
		if not instance_path.is_empty():
			result["instance"] = instance_path
		if String(node.name) != desired:
			result["renamed_from"] = desired
		return result
	return _plan(cs, finish)


## node.set
static func plan_node_set(root: Node, params: Variant) -> Dictionary:
	var p := Params.new(params, "node.set")
	var path: String = p.req_string("path")
	var props: Dictionary = p.opt_dict("properties", {})
	if p.failed():
		return p.error
	if props.is_empty():
		return R.err(R.BAD_PARAMS, "node.set: 'properties' must be a non-empty object, e.g. {\"position\": [10, 20], \"modulate\": \"#ff0000\"}.")
	var res: Dictionary = NodePaths.resolve(root, path)
	if R.is_err(res):
		return res
	var node: Node = res["value"]
	var edit_err: Dictionary = NodePaths.check_editable(root, node, "set properties on")
	if not edit_err.is_empty():
		return edit_err
	var label: String = "Node '%s' (%s)" % [NodePaths.rel_path(root, node), node.get_class()]
	var new_values: Dictionary = {}
	for key: Variant in props:
		var pname: String = str(key)
		if pname == "name":
			return R.err(R.BAD_PARAMS, "node.set: use node.rename to change a node's name (it checks for sibling name conflicts).")
		if pname.contains(":"):
			# Nested path into a sub-resource or a vector component, e.g.
			# "material:albedo_color" or "position:x" (Object.set_indexed syntax).
			var nested: Dictionary = _decode_nested(root, node, pname, props[key], label)
			if R.is_err(nested):
				return nested
			new_values[pname] = nested["value"]
			continue
		if Codec.find_property(node, pname).is_empty():
			return Codec.unknown_property_error(node, pname, label)
		var r: Dictionary = Codec.decode_property(node, pname, props[key], root)
		if R.is_err(r):
			return r
		new_values[pname] = r["value"]
	var cs := ChangeSet.new()
	for pname: String in new_values:
		if pname.contains(":"):
			var np := NodePath(pname)
			cs.do_method(node, &"set_indexed", [np, new_values[pname]])
			cs.undo_method(node, &"set_indexed", [np, node.get_indexed(np)])
		else:
			cs.do_property(node, pname, new_values[pname])
			cs.undo_property(node, pname, node.get(pname))
	var finish := func() -> Dictionary:
		var changed: Dictionary = {}
		var warnings: Array[String] = []
		for pname: String in new_values:
			var now: Variant = node.get_indexed(NodePath(pname))
			changed[pname] = Codec.encode(now, root)
			var wanted: Variant = new_values[pname]
			if Codec.read_back_differs(now, wanted):
				warnings.append("'%s' reads back as %s, not the requested value (Godot clamped or adjusted it)." % [pname, JSON.stringify(changed[pname])])
			var animated: String = animated_by(root, node, pname)
			if not animated.is_empty():
				warnings.append(animated)
		var result: Dictionary = {"path": NodePaths.rel_path(root, node), "changed": changed}
		if not warnings.is_empty():
			result["warnings"] = warnings
		return result
	return _plan(cs, finish)


## A warning when `prop` of `node` is keyed by an animation in the scene, else "".
##
## Why: an animated property does not keep the value node.set gives it. At runtime the
## AnimationPlayer/AnimationTree overwrites it every frame it plays; and in the editor an
## AnimationTree with active = true is processed live, so the value is overwritten at once
## and the *animated* value is what gets saved. The dogfood test lost a whole enemy that
## way: modulate was set back to opaque, the slime's active AnimationTree re-applied
## alpha 0 and the editor saved it, so every slime was invisible in the game.
static func animated_by(root: Node, node: Node, prop: String) -> String:
	var hits: Array[String] = []
	for mixer: Node in _mixers(root):
		var m := mixer as AnimationMixer
		var base: Node = m.get_node_or_null(m.root_node)
		if base == null:
			continue
		for lib_name: StringName in m.get_animation_library_list():
			var lib: AnimationLibrary = m.get_animation_library(lib_name)
			for anim_name: StringName in lib.get_animation_list():
				var anim: Animation = lib.get_animation(anim_name)
				for t: int in anim.get_track_count():
					var tt: int = anim.track_get_type(t)
					if tt != Animation.TYPE_VALUE and tt != Animation.TYPE_BEZIER:
						continue
					var tp: NodePath = anim.track_get_path(t)
					var sub: String = String(tp.get_concatenated_subnames())
					# "modulate" vs "modulate:a" both count, in either direction.
					if not (sub == prop or sub.begins_with(prop + ":") or prop.begins_with(sub + ":")):
						continue
					if base.get_node_or_null(NodePath(String(tp.get_concatenated_names()))) != node:
						continue
					var full: String = String(anim_name) if String(lib_name).is_empty() else "%s/%s" % [lib_name, anim_name]
					var label: String = "'%s' of %s" % [full, NodePaths.rel_path(root, m)]
					if not hits.has(label):
						hits.append(label)
	if hits.is_empty():
		return ""
	var msg: String = "'%s' is keyed by the animation %s, which overrides this value while it plays." % [prop, ", ".join(hits.slice(0, 3))]
	for mixer: Node in _mixers(root):
		if mixer is AnimationTree and (mixer as AnimationTree).active and Engine.is_editor_hint():
			msg += " AnimationTree '%s' is active, and the editor processes active AnimationTrees, so the value is overwritten right away and saved in its animated state; set active = false in the scene (and turn it on from a script) to edit the base value." % NodePaths.rel_path(root, mixer)
			break
	return msg


## AnimationPlayer/AnimationTree nodes of the scene (editable ones, i.e. saved with it).
static func _mixers(root: Node) -> Array[Node]:
	var out: Array[Node] = []
	var stack: Array[Node] = [root]
	while not stack.is_empty():
		var n: Node = stack.pop_back()
		if n is AnimationMixer and NodePaths.is_editable(root, n):
			out.append(n)
		stack.append_array(n.get_children())
	return out


## Validates and decodes one nested property path for node.set ("material:albedo_color",
## "shape:size", "position:x"). Every step but the last must be an existing property
## holding a sub-resource (or, for the final step, a vector/color value whose component
## is set). Returns {"value": decoded} or an error.
##
## Sub-resources saved as their own file (res://x.tres) are refused: the change would
## silently alter every scene sharing that file, and headless it would not be saved at
## all (only the scene is written). Those go through resource.set instead.
static func _decode_nested(root: Node, node: Node, pname: String, value: Variant, label: String) -> Dictionary:
	var parts: PackedStringArray = pname.split(":", false)
	if parts.size() < 2:
		return R.err(R.BAD_PARAMS, "node.set: '%s' is not a valid property path; use \"property:sub_property\", e.g. \"material:albedo_color\"." % pname)
	var obj: Object = node
	var walked: String = ""
	for i: int in parts.size() - 1:
		var part: String = parts[i]
		if Codec.find_property(obj, part).is_empty():
			return Codec.unknown_property_error(obj, part, label if obj == node else "'%s' (%s)" % [walked, obj.get_class()])
		var sub: Variant = obj.get(part)
		walked = part if walked.is_empty() else walked + ":" + part
		if sub is Object and sub != null:
			obj = sub
			if obj is Resource:
				var rpath: String = (obj as Resource).resource_path
				if not rpath.is_empty() and not rpath.contains("::"):
					return R.err(R.CONFLICT, ("node.set: '%s' is the shared resource file %s, used by everything that references it. " +
						"Edit it with resource.set (godot_resource_set) on that file, or give this node its own copy first with " +
						"{\"%s\": {\"new\": \"%s\"}}.") % [walked, rpath, walked, obj.get_class()])
			continue
		# Last step on a built-in value: a component like position:x or modulate:a.
		if i == parts.size() - 2 and sub != null and typeof(sub) in [TYPE_VECTOR2, TYPE_VECTOR2I, TYPE_VECTOR3, TYPE_VECTOR3I, TYPE_VECTOR4, TYPE_VECTOR4I, TYPE_COLOR, TYPE_QUATERNION, TYPE_RECT2, TYPE_RECT2I]:
			if not (value is float or value is int):
				return R.err(R.BAD_PARAMS, "node.set: '%s' is one component of a %s, so pass a number." % [pname, type_string(typeof(sub))])
			return R.value(value)
		if sub == null:
			return R.err(R.BAD_PARAMS, ("node.set: '%s' is empty on %s, so '%s' can't be set yet. Create it first, " +
				"e.g. {\"%s\": {\"new\": \"<ResourceType>\"}}, then set its properties.") % [walked, label, pname, walked])
		return R.err(R.BAD_PARAMS, "node.set: '%s' holds a %s, which has no sub-properties to set." % [walked, type_string(typeof(sub))])
	var last: String = parts[parts.size() - 1]
	if Codec.find_property(obj, last).is_empty():
		return Codec.unknown_property_error(obj, last, "'%s' (%s)" % [walked, obj.get_class()])
	return Codec.decode_property(obj, last, value, root)


## node.remove
static func plan_node_remove(root: Node, params: Variant) -> Dictionary:
	var p := Params.new(params, "node.remove")
	var path: String = p.req_string("path")
	if p.failed():
		return p.error
	var res: Dictionary = NodePaths.resolve(root, path)
	if R.is_err(res):
		return res
	var node: Node = res["value"]
	if node == root:
		return R.err(R.BAD_PARAMS, "node.remove: cannot remove the scene root. Remove its children individually, or create a new scene with scene.create.")
	var edit_err: Dictionary = NodePaths.check_editable(root, node, "remove")
	if edit_err.is_empty():
		edit_err = NodePaths.check_structural(root, node, "remove")
	if not edit_err.is_empty():
		return edit_err
	var parent: Node = node.get_parent()
	var old_index: int = node.get_index()
	var old_path: String = NodePaths.rel_path(root, node)
	var owned: Array[Node] = _owned_by_root(root, node)
	var cs := ChangeSet.new()
	# Clear owners before detaching so a later re-add (undo) does not warn about an
	# owner that is not an ancestor; undo restores them after re-adding.
	for n: Node in owned:
		cs.do_method(n, &"set_owner", [null])
	cs.do_method(parent, &"remove_child", [node])
	cs.undo_method(parent, &"add_child", [node, true])
	cs.undo_method(parent, &"move_child", [node, old_index])
	for n: Node in owned:
		cs.undo_method(n, &"set_owner", [root])
	cs.undo_reference(node)
	var finish := func() -> Dictionary:
		return {"removed": old_path}
	return _plan(cs, finish)


## node.rename
static func plan_node_rename(root: Node, params: Variant) -> Dictionary:
	var p := Params.new(params, "node.rename")
	var path: String = p.req_string("path")
	var new_name: String = p.req_string("name")
	if p.failed():
		return p.error
	var name_err: Dictionary = _check_name(new_name, "name")
	if not name_err.is_empty():
		return name_err
	var res: Dictionary = NodePaths.resolve(root, path)
	if R.is_err(res):
		return res
	var node: Node = res["value"]
	var edit_err: Dictionary = NodePaths.check_editable(root, node, "rename")
	if edit_err.is_empty():
		edit_err = NodePaths.check_structural(root, node, "rename")
	if not edit_err.is_empty():
		return edit_err
	var parent: Node = node.get_parent()
	if node != root and parent != null and NodePaths.has_child_named(parent, new_name, node):
		var suggestion: String = NodePaths.unique_child_name(parent, new_name, node)
		return R.err(R.CONFLICT, "node.rename: '%s' already has a child named '%s'. Choose another name, e.g. '%s'." % [NodePaths.rel_path(root, parent), new_name, suggestion], {"suggestion": suggestion})
	var cs := ChangeSet.new()
	if String(node.name) != new_name:
		cs.do_property(node, &"name", new_name)
		cs.undo_property(node, &"name", node.name)
	var finish := func() -> Dictionary:
		return {"path": NodePaths.rel_path(root, node), "name": String(node.name)}
	return _plan(cs, finish)


## node.reparent
static func plan_node_reparent(root: Node, params: Variant) -> Dictionary:
	var p := Params.new(params, "node.reparent")
	var path: String = p.req_string("path")
	var new_parent_path: String = p.req_string("new_parent")
	var index: int = p.opt_int("index", -1)
	var keep_global: bool = p.opt_bool("keep_global_transform", true)
	if p.failed():
		return p.error
	var res: Dictionary = NodePaths.resolve(root, path)
	if R.is_err(res):
		return res
	var node: Node = res["value"]
	if node == root:
		return R.err(R.BAD_PARAMS, "node.reparent: the scene root cannot be moved.")
	var edit_err: Dictionary = NodePaths.check_editable(root, node, "move")
	if edit_err.is_empty():
		edit_err = NodePaths.check_structural(root, node, "move")
	if not edit_err.is_empty():
		return edit_err
	var pres: Dictionary = NodePaths.resolve(root, new_parent_path, "new_parent")
	if R.is_err(pres):
		return pres
	var new_parent: Node = pres["value"]
	if new_parent == node or node.is_ancestor_of(new_parent):
		return R.err(R.BAD_PARAMS, "node.reparent: cannot move '%s' under itself or one of its own descendants ('%s')." % [NodePaths.rel_path(root, node), NodePaths.rel_path(root, new_parent)])
	var edit_err2: Dictionary = NodePaths.check_editable(root, new_parent, "move a node under")
	if not edit_err2.is_empty():
		return edit_err2
	var old_parent: Node = node.get_parent()
	var old_index: int = node.get_index()
	var same_parent: bool = old_parent == new_parent
	var max_index: int = new_parent.get_child_count() - (1 if same_parent else 0)
	if index < -1 or index > max_index:
		return R.err(R.BAD_PARAMS, "node.reparent: 'index' %d is out of range for '%s'; use -1 (append) or 0..%d." % [index, NodePaths.rel_path(root, new_parent), max_index])

	var cs := ChangeSet.new()
	if same_parent:
		# Same parent: this is just a reorder.
		var target_index: int = index if index >= 0 else old_parent.get_child_count() - 1
		cs.do_method(old_parent, &"move_child", [node, target_index])
		cs.undo_method(old_parent, &"move_child", [node, old_index])
	else:
		var old_name: String = String(node.name)
		var new_name: String = NodePaths.unique_child_name(new_parent, old_name)
		var owned: Array[Node] = _owned_by_root(root, node)
		var transform_prop: String = ""
		var old_local: Variant = null
		var new_local: Variant = null
		if keep_global:
			var kept: Dictionary = _compute_kept_transform(node, new_parent)
			if not kept.is_empty():
				transform_prop = kept["property"]
				old_local = kept["old"]
				new_local = kept["new"]
		# We do not use Node.reparent(): outside the SceneTree (headless) it does not clear
		# owners and Godot warns on re-add, and it cannot rename on a name collision.
		for n: Node in owned:
			cs.do_method(n, &"set_owner", [null])
		cs.do_method(old_parent, &"remove_child", [node])
		if new_name != old_name:
			cs.do_property(node, &"name", new_name)
		cs.do_method(new_parent, &"add_child", [node, true])
		if index >= 0:
			cs.do_method(new_parent, &"move_child", [node, index])
		for n: Node in owned:
			cs.do_method(n, &"set_owner", [root])
		if not transform_prop.is_empty():
			cs.do_property(node, transform_prop, new_local)

		for n: Node in owned:
			cs.undo_method(n, &"set_owner", [null])
		cs.undo_method(new_parent, &"remove_child", [node])
		if new_name != old_name:
			cs.undo_property(node, &"name", old_name)
		cs.undo_method(old_parent, &"add_child", [node, true])
		cs.undo_method(old_parent, &"move_child", [node, old_index])
		for n: Node in owned:
			cs.undo_method(n, &"set_owner", [root])
		if not transform_prop.is_empty():
			cs.undo_property(node, transform_prop, old_local)
	var finish := func() -> Dictionary:
		return {"path": NodePaths.rel_path(root, node), "name": String(node.name)}
	return _plan(cs, finish)


## Computes the local transform that keeps `node` visually in place under `new_parent`.
## We walk the transform chain ourselves instead of using global_transform because the
## headless backend works on scenes that are not inside the SceneTree, where Node3D's
## global_transform is unavailable. Returns {} for nodes without a transform.
static func _compute_kept_transform(node: Node, new_parent: Node) -> Dictionary:
	if node is Node2D:
		var old_local_2d: Transform2D = (node as Node2D).transform
		var global_2d: Transform2D = _chain_2d(node.get_parent()) * old_local_2d
		var new_local_2d: Transform2D = _chain_2d(new_parent).affine_inverse() * global_2d
		return {"property": "transform", "old": old_local_2d, "new": new_local_2d}
	if node is Control:
		# Controls are laid out by anchors/containers; only keep the visual position.
		var ctrl: Control = node
		var global_pos: Vector2 = _chain_2d(node.get_parent()) * ctrl.position
		var new_pos: Vector2 = _chain_2d(new_parent).affine_inverse() * global_pos
		return {"property": "position", "old": ctrl.position, "new": new_pos}
	if node is Node3D:
		var old_local_3d: Transform3D = (node as Node3D).transform
		var global_3d: Transform3D = _chain_3d(node.get_parent()) * old_local_3d
		var new_local_3d: Transform3D = _chain_3d(new_parent).affine_inverse() * global_3d
		return {"property": "transform", "old": old_local_3d, "new": new_local_3d}
	return {}


## Scene-global 2D transform of `n` (product of CanvasItem transforms up to a non-canvas
## ancestor or a top_level item).
static func _chain_2d(n: Node) -> Transform2D:
	var t := Transform2D.IDENTITY
	var cur: Node = n
	while cur is CanvasItem:
		var ci: CanvasItem = cur
		t = ci.get_transform() * t
		if ci.top_level:
			break
		cur = cur.get_parent()
	return t


static func _chain_3d(n: Node) -> Transform3D:
	var t := Transform3D.IDENTITY
	var cur: Node = n
	while cur is Node3D:
		var n3: Node3D = cur
		t = n3.transform * t
		if n3.top_level:
			break
		cur = cur.get_parent()
	return t


## node.duplicate
static func plan_node_duplicate(root: Node, params: Variant) -> Dictionary:
	var p := Params.new(params, "node.duplicate")
	var path: String = p.req_string("path")
	var node_name: String = p.opt_string("name", "")
	if p.failed():
		return p.error
	if p.has("name"):
		var name_err: Dictionary = _check_name(node_name, "name")
		if not name_err.is_empty():
			return name_err
	var res: Dictionary = NodePaths.resolve(root, path)
	if R.is_err(res):
		return res
	var node: Node = res["value"]
	if node == root:
		return R.err(R.BAD_PARAMS, "node.duplicate: the scene root cannot be duplicated. To copy a whole scene use scene.save_as (editor) or instance it with node.add {\"instance\": ...}.")
	var edit_err: Dictionary = NodePaths.check_editable(root, node, "duplicate")
	if not edit_err.is_empty():
		return edit_err
	# Default flags copy signals, groups and scripts and re-instance sub-scenes
	# (DUPLICATE_USE_INSTANTIATION), so instanced children stay linked to their .tscn.
	var dup: Node = node.duplicate()
	if dup == null:
		return R.err(R.GODOT_ERROR, "node.duplicate: Godot could not duplicate '%s'." % NodePaths.rel_path(root, node))
	var parent: Node = node.get_parent()
	var desired: String = node_name if not node_name.is_empty() else String(node.name)
	dup.name = NodePaths.unique_child_name(parent, desired)
	# Map every root-owned node in the original subtree to its copy: those copies need
	# owner = root to be saved. Internal nodes of re-instanced sub-scenes already have the
	# right owner (their instance root) from instantiation.
	var dup_owned: Array[Node] = []
	for orig: Node in _owned_by_root(root, node):
		var copy: Node = dup if orig == node else dup.get_node_or_null(node.get_path_to(orig))
		if copy != null:
			dup_owned.append(copy)
	var cs := ChangeSet.new()
	cs.do_method(parent, &"add_child", [dup, true])
	cs.do_method(parent, &"move_child", [dup, node.get_index() + 1])
	for d: Node in dup_owned:
		cs.do_method(d, &"set_owner", [root])
	cs.do_reference(dup)
	for d: Node in dup_owned:
		cs.undo_method(d, &"set_owner", [null])
	cs.undo_method(parent, &"remove_child", [dup])
	var finish := func() -> Dictionary:
		return {"path": NodePaths.rel_path(root, dup), "name": String(dup.name)}
	return _plan(cs, finish)


## script.attach (script: null detaches)
static func plan_script_attach(root: Node, params: Variant) -> Dictionary:
	var p := Params.new(params, "script.attach")
	var path: String = p.req_string("path")
	if p.failed():
		return p.error
	if not (params as Dictionary).has("script"):
		return R.err(R.BAD_PARAMS, "script.attach: missing 'script' - pass a res:// path to a script file, or null to detach the current script.")
	var script_param: Variant = params["script"]
	if script_param != null and not script_param is String:
		return R.err(R.BAD_PARAMS, "script.attach: 'script' must be a res:// path string or null.")
	var res: Dictionary = NodePaths.resolve(root, path)
	if R.is_err(res):
		return res
	var node: Node = res["value"]
	var edit_err: Dictionary = NodePaths.check_editable(root, node, "attach a script to")
	if not edit_err.is_empty():
		return edit_err
	var new_script: Script = null
	var script_path: String = ""
	if script_param != null:
		var sres: Dictionary = ResPaths.normalize(str(script_param), "script")
		if R.is_err(sres):
			return sres
		script_path = sres["value"]
		if not ResPaths.file_exists(script_path):
			return R.err(R.NOT_FOUND, "script.attach: script '%s' does not exist. Write the file first (and call filesystem.refresh when the editor is open), then attach it." % script_path)
		new_script = load(script_path) as Script
		if new_script == null:
			return R.err(R.BAD_PARAMS, "script.attach: '%s' is not a script resource (or failed to load; check it with script.validate)." % script_path)
		var base: String = String(new_script.get_instance_base_type())
		if not base.is_empty() and not node.is_class(base):
			return R.err(R.BAD_PARAMS, "script.attach: '%s' extends %s, but node '%s' is a %s. Attach it to a %s node, or change the script's `extends` line." % [script_path, base, NodePaths.rel_path(root, node), node.get_class(), base])
	var old_script: Variant = node.get_script()
	var cs := ChangeSet.new()
	cs.do_property(node, &"script", new_script)
	cs.undo_property(node, &"script", old_script)
	var finish := func() -> Dictionary:
		return {"path": NodePaths.rel_path(root, node), "script": _script_path(node.get_script() as Script)}
	return _plan(cs, finish)


# ---------------------------------------------------------------------------------------
# Scene files
# ---------------------------------------------------------------------------------------

## scene.create (the file-writing part, shared by both backends).
## Returns {"result": {"path", "root_type", "root_name"}} or an error.
static func create_scene_file(params: Variant) -> Dictionary:
	var p := Params.new(params, "scene.create")
	var raw_path: String = p.req_string("path")
	var root_type: String = p.req_string("root_type")
	var root_name: String = p.opt_string("root_name", "")
	if p.failed():
		return p.error
	var sres: Dictionary = ResPaths.normalize_scene(raw_path, "path")
	if R.is_err(sres):
		return sres
	var path: String = sres["value"]
	if ResPaths.file_exists(path):
		return R.err(R.CONFLICT, "scene.create: '%s' already exists. Edit it with the node.* methods (pass scene: \"%s\"), or choose a different path." % [path, path])
	if root_name.is_empty():
		root_name = path.get_file().get_basename().to_pascal_case()
		if root_name.validate_node_name().is_empty():
			root_name = root_type
	var name_err: Dictionary = _check_name(root_name, "root_name")
	if not name_err.is_empty():
		return name_err
	var created: Dictionary = Codec.instantiate_class(root_type, "Node")
	if R.is_err(created):
		return created
	var node: Node = created["value"]
	node.name = root_name
	var dir_err: int = DirAccess.make_dir_recursive_absolute(ProjectSettings.globalize_path(path.get_base_dir()))
	if dir_err != OK and dir_err != ERR_ALREADY_EXISTS:
		node.free()
		return R.godot_err("Creating folder '%s'" % path.get_base_dir(), dir_err)
	var save_res: Dictionary = pack_and_save(node, path)
	node.free()
	if R.is_err(save_res):
		return save_res
	return R.ok({"path": path, "root_type": root_type, "root_name": root_name})


## Packs `root` into a PackedScene and saves it to `path`. Returns {} or an error.
static func pack_and_save(root: Node, path: String) -> Dictionary:
	var packed := PackedScene.new()
	var err: int = packed.pack(root)
	if err != OK:
		return R.godot_err("Packing scene '%s'" % path, err)
	# ResSave keeps the scene's UIDs in headless runs (plain ResourceSaver.save drops them).
	err = ResSave.save(packed, path)
	if err != OK:
		return R.godot_err("Saving scene '%s'" % path, err)
	return {}
