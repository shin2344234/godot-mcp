@tool
extends RefCounted
## Resources: read, create and modify .tres/.res files; dependencies and UIDs.
##
## Registered in core/methods.gd (MODULES). `methods()` maps each bridge-protocol method
## this module implements to a descriptor (see the comment on Methods.MODULES for kinds).
##
## All four methods are "project" kind: they work on resource files, not on one scene.
## * In the editor, resources are loaded through the default resource cache, so we edit the
##   very instance that open scenes and the inspector share (a material change shows up in
##   the viewport at once), and resource.set goes through EditorUndoRedoManager (undo also
##   re-saves the file).
## * Headless, each call loads, edits and saves in one process. Godot does not write UIDs
##   outside the editor, so core/resource_util.gd re-applies / assigns them (see there).
## Documented in docs/methods/resources-visual-import.md.

const R := preload("../core/mcp_result.gd")
const Params := preload("../core/params.gd")
const Codec := preload("../core/variant_codec.gd")
const ResPaths := preload("../core/res_paths.gd")
const Fuzzy := preload("../core/fuzzy.gd")
const ChangeSet := preload("../core/change_set.gd")
const RU := preload("../core/resource_util.gd")
const Frames := preload("../core/sprite_frames_ops.gd")

## File extensions scanned for `dependents` (anything ResourceLoader can list deps for).
const DEPENDENT_EXTS: PackedStringArray = ["tscn", "scn", "tres", "res", "material"]
## Text files searched for literal references to the path / uid (preload("res://..."), ...).
const TEXT_REF_EXTS: PackedStringArray = ["gd", "gdshader", "gdshaderinc", "cs", "cfg", "godot"]
## Maximum characters of a Shader's `code` returned by resource.read.
const MAX_CODE_CHARS: int = 20000
## Approximate JSON size (characters, ~4 per token) resource.read lets `properties` and
## `theme_items` grow to before shortening them (see RU.fit). ~2.5k tokens.
const READ_BUDGET: int = 10000
## Nodes listed when resource.read is pointed at a scene file.
const MAX_SCENE_NODES: int = 100


static func methods() -> Dictionary:
	return {
		"resource.read": {"kind": "project", "fn": read},
		"resource.create": {"kind": "project", "fn": create},
		"resource.set": {"kind": "project", "fn": set_properties},
		"resource.deps": {"kind": "project", "fn": deps},
	}


# ---------------------------------------------------------------------------------------
# resource.read
# ---------------------------------------------------------------------------------------

## params: {path, properties?: [names or nested paths], depth?: 1}
static func read(params: Variant, _env: Dictionary) -> Dictionary:
	var p := Params.new(params, "resource.read")
	var raw: String = p.req_string("path")
	var picks: Array = p.opt_array("properties", [])
	var depth: int = clampi(p.opt_int("depth", 1), 0, 4)
	if p.failed():
		return p.error
	var where: Dictionary = RU.resolve(raw)
	if R.is_err(where):
		return where
	var path: String = where["value"]
	var loaded: Dictionary = RU.load_existing(path, "resource.read")
	if R.is_err(loaded):
		return loaded
	var res: Resource = loaded["value"]
	var out: Dictionary = {
		"path": path,
		"class": res.get_class(),
		"uid": RU.or_null(str(where["uid"])),
		"resource_path": res.resource_path,
	}
	var script: Script = res.get_script() as Script
	if script != null:
		out["script"] = script.resource_path
		if not String(script.get_global_name()).is_empty():
			out["script_class"] = String(script.get_global_name())
	if res is PackedScene:
		# The stored form of a scene is the `_bundled` dictionary (name/type indices, a flat
		# variants list...), unreadable and ~1k tokens for a small scene (MCP_TEST_LOG). The
		# SceneState gives a readable node list without instantiating anything.
		return R.ok(_scene_overview(path, res as PackedScene, out))
	if not picks.is_empty():
		var chosen: Dictionary = {}
		for item: Variant in picks:
			var key: String = str(item)
			var first: String = key.split(":")[0]
			var theme_item: bool = res is Theme and key.count("/") == 2
			if not theme_item and Codec.find_property(res, first).is_empty():
				return RU.unknown_property(res, first, "%s '%s'" % [res.get_class(), path])
			chosen[key] = RU.encode_value(res.get_indexed(NodePath(key)), depth)
		_capped(out, "properties", chosen)
		return R.ok(out)
	var props: Dictionary = RU.non_default_properties(res, depth, res is Theme)
	if res is SpriteFrames:
		# The raw `animations` array (nested dictionaries of embedded AtlasTextures) is long
		# and hard to read; the anim.frames summary says the same compactly (atlas + regions).
		props["animations"] = Frames.summary(res as SpriteFrames)
		out["edit_with"] = "godot_anim_frames"
	# The Shader code has its own, larger limit; keep it out of the generic size cap.
	var code: Variant = props.get("code")
	props.erase("code")
	if code is String and (code as String).length() > MAX_CODE_CHARS:
		code = (code as String).left(MAX_CODE_CHARS) + "\n…(truncated; use files.read for the full file)"
	_capped(out, "properties", props)
	if code != null:
		(out["properties"] as Dictionary)["code"] = code
	if res is Shader:
		var uniforms: Array = []
		for u: Dictionary in (res as Shader).get_shader_uniform_list():
			var entry: Dictionary = {"name": u["name"], "type": type_string(int(u["type"]))}
			if not str(u.get("hint_string", "")).is_empty():
				entry["hint_string"] = u["hint_string"]
			uniforms.append(entry)
		out["uniforms"] = uniforms
	if res is Theme:
		_capped(out, "theme_items", RU.theme_items(res as Theme, depth))
	return R.ok(out)


## Applies the planned values, reads them back and undoes them again (each plan's "undo"
## step, last plan first). Returns the keys that read back as null although a non-null
## value was set. The resource ends up exactly as before.
static func _rehearse(res: Resource, plans: Array[Dictionary]) -> Array[String]:
	var lost: Array[String] = []
	for plan: Dictionary in plans:
		res.set_indexed(NodePath(str(plan["key"])), plan["value"])
	for plan: Dictionary in plans:
		if plan["value"] != null and res.get_indexed(NodePath(str(plan["key"]))) == null:
			lost.append(str(plan["key"]))
	for i: int in range(plans.size() - 1, -1, -1):
		var undo: Array = plans[i]["undo"]
		var args: Array = (undo[1] as Array).duplicate()
		if str(undo[0]) == "set_indexed":
			args[0] = NodePath(str(args[0]))
		res.callv(StringName(str(undo[0])), args)
	return lost


## out[key] = value, shrunk to READ_BUDGET characters (core/resource_util.gd fit()); when
## something was left out, out["truncated"] says how to get at it.
static func _capped(out: Dictionary, key: String, value: Dictionary) -> void:
	var fitted: Variant = RU.fit(value, READ_BUDGET)
	out[key] = fitted
	if JSON.stringify(fitted).length() < JSON.stringify(value).length():
		out["truncated"] = ("'%s' was shortened to about %d tokens (keys under \"…\" and \"…(+N more)\" were left out). " +
			"Read single values with properties: [\"name\"] (nested: \"name:sub\") or a smaller depth.") % [key, floori(READ_BUDGET / 4.0)]


## resource.read on a .tscn/.scn: a short node list instead of the packed `_bundled` data.
static func _scene_overview(path: String, scene: PackedScene, out: Dictionary) -> Dictionary:
	var state: SceneState = scene.get_state()
	var nodes: Array = []
	var count: int = state.get_node_count()
	for i: int in range(mini(count, MAX_SCENE_NODES)):
		var entry: Dictionary = {"path": String(state.get_node_path(i)).trim_prefix("./")}
		var type: String = String(state.get_node_type(i))
		if not type.is_empty():
			entry["type"] = type
		var inst: PackedScene = state.get_node_instance(i)
		if inst != null:
			entry["instance"] = inst.resource_path
		nodes.append(entry)
	out["node_count"] = count
	out["nodes"] = nodes
	if count > nodes.size():
		out["nodes_truncated"] = true
	out["note"] = "A scene file: use scene.tree / node.get with scene: \"%s\" for node properties, and node.set to change them." % path
	return out


# ---------------------------------------------------------------------------------------
# resource.create
# ---------------------------------------------------------------------------------------

## params: {path, type?, properties?, code?, overwrite?: false}
static func create(params: Variant, env: Dictionary) -> Dictionary:
	var p := Params.new(params, "resource.create")
	var raw: String = p.req_string("path")
	var type: String = p.opt_string("type", "")
	var props: Dictionary = p.opt_dict("properties", {})
	var code: String = p.opt_string("code", "")
	var has_code: bool = p.has("code")
	var overwrite: bool = p.opt_bool("overwrite", false)
	if p.failed():
		return p.error
	var norm: Dictionary = ResPaths.normalize(raw, "path")
	if R.is_err(norm):
		return norm
	var path: String = norm["value"]
	var ext: String = path.get_extension().to_lower()
	if ext.is_empty():
		return R.err(R.BAD_PARAMS, "resource.create: 'path' needs a file extension: .tres (text, recommended), .res (binary), or .gdshader for shader code.")
	# Shader source files have a fixed type; everything else needs `type`.
	if ext == "gdshader" or ext == "gdshaderinc":
		var expected: String = "Shader" if ext == "gdshader" else "ShaderInclude"
		if not type.is_empty() and type != expected:
			return R.err(R.BAD_PARAMS, "resource.create: a .%s file holds a %s, not a %s. %s" % [ext, expected, type,
				"Visual shaders are saved as .tres (use type VisualShader, or visual.shader_graph with create: true)." if type == "VisualShader" else ""])
		type = expected
	elif type.is_empty():
		return R.err(R.BAD_PARAMS, "resource.create: pass 'type', the Resource class to create, e.g. \"StandardMaterial3D\", \"Theme\", \"Gradient\", \"RectangleShape2D\". For shader code use a .gdshader path with 'code'.")
	if FileAccess.file_exists(path) and not overwrite:
		return R.err(R.CONFLICT, "resource.create: '%s' already exists. Pass overwrite: true to replace it, use resource.set to change its properties, or pick another path." % path, {"path": path})
	var made: Dictionary = Codec.instantiate_class(type, "Resource")
	if R.is_err(made):
		return made
	var res: Resource = made["value"]
	if has_code:
		if not (res is Shader or res is ShaderInclude):
			return R.err(R.BAD_PARAMS, "resource.create: 'code' only applies to shaders (.gdshader / .gdshaderinc); for a %s use 'properties'." % type)
		res.set("code", code)
	elif res is Shader and not res is VisualShader:
		res.set("code", "shader_type spatial;\n\nvoid fragment() {\n\t// Called for every pixel the material is visible on.\n}\n")
	var exts: PackedStringArray = ResourceSaver.get_recognized_extensions(res)
	if not ext in exts:
		return R.err(R.BAD_PARAMS, "resource.create: a %s cannot be saved as .%s; use one of: .%s." % [type, ext, ", .".join(exts)])
	var applied: Array[String] = []
	for key: Variant in props:
		var plan: Dictionary = RU.plan_property(res, str(key), props[key], type)
		if R.is_err(plan):
			return plan
		res.set_indexed(NodePath(str(key)), plan["value"])
		applied.append(str(key))

	var existed: bool = FileAccess.file_exists(path)
	var mk: int = DirAccess.make_dir_recursive_absolute(path.get_base_dir())
	if mk != OK and not DirAccess.dir_exists_absolute(path.get_base_dir()):
		return R.godot_err("Creating folder '%s'" % path.get_base_dir(), mk)
	# In the editor a previous version may sit in the resource cache; taking over its path
	# makes the new instance the one later loads return.
	if ResourceLoader.has_cached(path):
		res.take_over_path(path)
	else:
		res.resource_path = path
	var saved: Dictionary = RU.save(res, path)
	if not saved.is_empty():
		return saved
	var uid: String = ""
	if bool(env.get("editor", false)):
		var fs: Object = env.get("filesystem")
		if fs != null:
			fs.call("update_file", path)
		uid = RU.uid_text(path)
	else:
		uid = RU.uid_text(path)
		if uid.is_empty():
			uid = RU.assign_uid(path)
	var out: Dictionary = {"path": path, "type": res.get_class(), "uid": RU.or_null(uid), "properties_set": applied}
	# A project class_name script extending Resource: get_class() is only the native base
	# ("Resource"), which read as if the script had been ignored (MCP_TEST_LOG). Report the
	# script class as the type, and the native base and script path next to it.
	var script: Script = res.get_script() as Script
	if script != null:
		out["script"] = script.resource_path
		out["base_type"] = res.get_class()
		if not String(script.get_global_name()).is_empty():
			out["type"] = String(script.get_global_name())
	if existed:
		out["overwritten"] = true
	return R.ok(out)


# ---------------------------------------------------------------------------------------
# resource.set
# ---------------------------------------------------------------------------------------

## params: {path, properties: {name or nested path: value}}
static func set_properties(params: Variant, env: Dictionary) -> Dictionary:
	var p := Params.new(params, "resource.set")
	var raw: String = p.req_string("path")
	var props: Dictionary = p.opt_dict("properties", {})
	if p.failed():
		return p.error
	if props.is_empty():
		return R.err(R.BAD_PARAMS, "resource.set: 'properties' must be a non-empty object, e.g. {\"albedo_color\": \"#ff0000\", \"next_pass:albedo_color\": [0, 1, 0]} or for a Theme {\"Button/colors/font_color\": \"#ffffff\"}.")
	var where: Dictionary = RU.resolve(raw)
	if R.is_err(where):
		return where
	var path: String = where["value"]
	var ext: String = path.get_extension().to_lower()
	if FileAccess.file_exists(path + ".import"):
		return R.err(R.BAD_PARAMS, "resource.set: '%s' is an imported asset; its resource is regenerated on import, so edits would be lost. Change its import options with import.set instead." % path)
	if ext == "tscn" or ext == "scn":
		return R.err(R.BAD_PARAMS, "resource.set: '%s' is a scene; edit its nodes with node.set (scene: \"%s\")." % [path, path])
	var loaded: Dictionary = RU.load_existing(path, "resource.set")
	if R.is_err(loaded):
		return loaded
	var res: Resource = loaded["value"]
	var label: String = "%s '%s'" % [res.get_class(), path]
	var plans: Array[Dictionary] = []
	for key: Variant in props:
		var plan: Dictionary = RU.plan_property(res, str(key), props[key], label)
		if R.is_err(plan):
			return plan
		plans.append(plan)
	# A key can pass validation and still not exist: Godot classes answer set() for some
	# names they do not store (TileSet's inspector array headers "navigation_layers" were
	# once accepted and reported changed: null, MCP_TEST_LOG). Try the values first and
	# refuse any that read back as null although a value was given.
	var lost: Array[String] = _rehearse(res, plans)
	if not lost.is_empty():
		return R.err(R.NOT_FOUND, "resource.set: %s does not keep %s (the value reads back as null, so nothing would change). Use resource.read to see its real properties%s." %
			[label, ", ".join(lost.map(func(k: String) -> String: return "'%s'" % k)), "; TileSet layers are added with godot_tileset_edit" if res is TileSet else ""], {"keys": lost})

	var editor: bool = bool(env.get("editor", false))
	if editor and env.get("undo_redo") != null:
		# One undo step: set every value, then save; undo restores and saves again so the
		# file on disk always matches what the editor shows.
		var cs := ChangeSet.new()
		for plan: Dictionary in plans:
			cs.do_method(res, &"set_indexed", [NodePath(str(plan["key"])), plan["value"]])
		cs.do_method(ResourceSaver, &"save", [res, path])
		var undo_seen: Dictionary = {}
		for plan: Dictionary in plans:
			var undo: Array = plan["undo"]
			# Several keys of one new MeshLibrary item share the undo "remove_item <id>".
			if undo_seen.has(str(undo)):
				continue
			undo_seen[str(undo)] = true
			var undo_args: Array = (undo[1] as Array).duplicate()
			if str(undo[0]) == "set_indexed":
				undo_args[0] = NodePath(str(undo_args[0]))
			cs.undo_method(res, StringName(str(undo[0])), undo_args)
		cs.undo_method(ResourceSaver, &"save", [res, path])
		cs.commit_to_undo_redo(env["undo_redo"], "MCP: resource.set", res)
	else:
		for plan: Dictionary in plans:
			res.set_indexed(NodePath(str(plan["key"])), plan["value"])
		var saved: Dictionary = RU.save(res, path)
		if not saved.is_empty():
			return saved

	var changed: Dictionary = {}
	var warnings: Array[String] = []
	for plan: Dictionary in plans:
		var key: String = plan["key"]
		var now: Variant = res.get_indexed(NodePath(key))
		changed[key] = RU.encode_value(now, 1)
		var wanted: Variant = plan["value"]
		if Codec.read_back_differs(now, wanted):
			warnings.append("'%s' reads back as %s, not the requested value (Godot clamped or adjusted it)." % [key, JSON.stringify(changed[key])])
	var out: Dictionary = {"path": path, "class": res.get_class(), "changed": changed, "saved": true, "undoable": editor}
	if not warnings.is_empty():
		out["warnings"] = warnings
	return R.ok(out)


# ---------------------------------------------------------------------------------------
# resource.deps
# ---------------------------------------------------------------------------------------

## params: {path (res:// or uid://), dependents?: false, limit?: 100}
static func deps(params: Variant, _env: Dictionary) -> Dictionary:
	var p := Params.new(params, "resource.deps")
	var raw: String = p.req_string("path")
	var want_dependents: bool = p.opt_bool("dependents", false)
	var limit: int = clampi(p.opt_int("limit", 100), 1, 1000)
	if p.failed():
		return p.error
	var where: Dictionary = RU.resolve(raw)
	if R.is_err(where):
		return where
	var path: String = where["value"]
	if not ResPaths.file_exists(path):
		return RU.load_existing(path, "resource.deps")
	var uid: String = where["uid"]
	var dependencies: Array = []
	var missing: Array = []
	for dep: String in ResourceLoader.get_dependencies(path):
		var d: Dictionary = RU.parse_dependency(dep)
		var dpath: String = d["path"]
		var exists: bool = not dpath.is_empty() and ResPaths.file_exists(dpath)
		var entry: Dictionary = {"path": dpath, "uid": RU.or_null(str(d["uid"])), "type": RU.or_null(RU.file_type(dpath) if exists else ""), "exists": exists}
		dependencies.append(entry)
		if not exists:
			missing.append(entry)
	var out: Dictionary = {"path": path, "uid": RU.or_null(uid), "type": RU.file_type(path), "dependencies": dependencies, "missing": missing}
	if want_dependents:
		var found: Array = []
		var state: Dictionary = {"visited": 0, "truncated": false}
		_find_dependents("res://", path, uid, limit, found, state)
		out["dependents"] = found
		out["dependents_truncated"] = state["truncated"]
		out["files_scanned"] = state["visited"]
	return R.ok(out)


## Walks the project looking for files that reference `target` (by path or uid): resource
## files through ResourceLoader.get_dependencies, scripts/shaders/config by a text search.
static func _find_dependents(dir_path: String, target: String, uid: String, limit: int, found: Array, state: Dictionary) -> void:
	var dir: DirAccess = DirAccess.open(dir_path)
	if dir == null:
		return
	for f: String in dir.get_files():
		if found.size() >= limit or int(state["visited"]) >= RU.SCAN_LIMIT:
			state["truncated"] = true
			return
		var full: String = dir_path.path_join(f)
		if full == target:
			continue
		var ext: String = f.get_extension().to_lower()
		if ext in DEPENDENT_EXTS:
			state["visited"] = int(state["visited"]) + 1
			for dep: String in ResourceLoader.get_dependencies(full):
				var d: Dictionary = RU.parse_dependency(dep)
				if d["path"] == target or (not uid.is_empty() and d["uid"] == uid):
					found.append({"path": full, "type": RU.file_type(full), "via": "uid" if bool(d["by_uid"]) else "path"})
					break
		elif ext in TEXT_REF_EXTS:
			state["visited"] = int(state["visited"]) + 1
			var fa: FileAccess = FileAccess.open(full, FileAccess.READ)
			if fa == null or fa.get_length() > 1_000_000:
				continue
			var text: String = fa.get_as_text()
			if text.contains("\"%s\"" % target) or (not uid.is_empty() and text.contains(uid)):
				found.append({"path": full, "type": RU.file_type(full), "via": "text"})
	for d: String in dir.get_directories():
		if d.begins_with("."):
			continue
		_find_dependents(dir_path.path_join(d), target, uid, limit, found, state)
