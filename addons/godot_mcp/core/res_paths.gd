@tool
extends RefCounted
## Helpers for `res://` paths given by the client.
##
## Clients (LLMs) often send "main.tscn" or "/main.tscn" instead of "res://main.tscn", or a
## "uid://..." reference copied from a .tscn file. We normalise all of those to a canonical
## `res://` path so the rest of the code only deals with one form.

const R := preload("mcp_result.gd")


## Normalises a user-supplied resource path. Returns {"value": "res://..."} or an error.
static func normalize(path: String, param_name: String = "path") -> Dictionary:
	var p: String = path.strip_edges().replace("\\", "/")
	if p.is_empty():
		return R.err(R.BAD_PARAMS, "Parameter '%s' is empty; pass a project path such as \"res://main.tscn\"." % param_name)
	if p.begins_with("uid://"):
		var id: int = ResourceUID.text_to_id(p)
		if id == ResourceUID.INVALID_ID or not ResourceUID.has_id(id):
			return R.err(R.NOT_FOUND, "Unknown resource UID '%s' in parameter '%s'. Use a res:// path instead." % [p, param_name])
		return R.value(ResourceUID.get_id_path(id))
	if p.begins_with("user://"):
		return R.err(R.BAD_PARAMS, "Parameter '%s' must point inside the project (res://), not user:// ('%s')." % [param_name, p])
	if not p.begins_with("res://"):
		# An absolute OS path inside the project folder can be localised; anything else is
		# treated as relative to the project root.
		var localized: String = ProjectSettings.localize_path(p)
		if localized.begins_with("res://"):
			p = localized
		else:
			p = "res://" + p.trim_prefix("/")
	if p.contains("/../") or p.ends_with("/.."):
		p = p.simplify_path()
		# simplify_path() keeps a ".." it can't resolve: "res://../x.tscn" and
		# "res://a/../../x.tscn" both come back as "res://../x.tscn", which still starts with
		# "res://" but points at the folder ABOVE the project (verified on 4.7.2; scene.create
		# wrote files there). So check for a leading ".." segment, not just the prefix.
		if not p.begins_with("res://") or p == "res://.." or p.begins_with("res://../"):
			return R.err(R.BAD_PARAMS, "Parameter '%s' escapes the project folder ('%s')." % [param_name, path])
	return R.value(p)


## Like `normalize`, but also requires a scene file extension (.tscn or .scn).
static func normalize_scene(path: String, param_name: String = "scene") -> Dictionary:
	var res: Dictionary = normalize(path, param_name)
	if R.is_err(res):
		return res
	var p: String = res["value"]
	var ext: String = p.get_extension().to_lower()
	if ext != "tscn" and ext != "scn":
		return R.err(R.BAD_PARAMS, "Parameter '%s' must be a scene file ending in .tscn or .scn, got '%s'." % [param_name, p])
	return res


## True if `path` exists as a file (works for both imported and plain files).
static func file_exists(path: String) -> bool:
	return FileAccess.file_exists(path) or ResourceLoader.exists(path)


## Lists up to `limit` project files with one of the given extensions (lower-case, no dot).
## Skips `.godot/` and hidden folders. Used to make NOT_FOUND errors actionable
## ("scene not found; existing scenes are: ...").
static func list_files(extensions: PackedStringArray, limit: int = 20) -> PackedStringArray:
	var out: PackedStringArray = []
	_walk("res://", extensions, limit, out)
	return out


static func _walk(dir_path: String, extensions: PackedStringArray, limit: int, out: PackedStringArray) -> void:
	if out.size() >= limit:
		return
	var dir: DirAccess = DirAccess.open(dir_path)
	if dir == null:
		return
	dir.include_hidden = false
	for f: String in dir.get_files():
		if out.size() >= limit:
			return
		if f.get_extension().to_lower() in extensions:
			out.append(dir_path.path_join(f))
	for d: String in dir.get_directories():
		if d.begins_with("."):
			continue
		_walk(dir_path.path_join(d), extensions, limit, out)


## Builds a NOT_FOUND error for a missing scene, listing scenes that do exist.
static func scene_not_found(path: String) -> Dictionary:
	var scenes: PackedStringArray = list_files(PackedStringArray(["tscn", "scn"]), 30)
	var msg: String = "Scene '%s' does not exist." % path
	if scenes.is_empty():
		msg += " The project has no scenes yet; create one with scene.create."
	else:
		msg += " Existing scenes: %s." % ", ".join(scenes)
	return R.err(R.NOT_FOUND, msg, {"scenes": Array(scenes)})
