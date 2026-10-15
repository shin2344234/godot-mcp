@tool
extends RefCounted
## Save a resource (.tscn / .tres / ...) without losing its UIDs in headless runs.
##
## Why this exists: Godot's text saver writes `uid="uid://..."` (in the [gd_scene] /
## [gd_resource] header and on every [ext_resource] line) only when
## ResourceSaver.get_resource_id_for_path() returns an id, and that callback is installed
## by the editor's EditorFileSystem. In a headless `--script` run there is no
## EditorFileSystem, so ResourceSaver.save() silently DROPS every UID from the file
## (verified on 4.7.2, see resource_format_text.cpp and the ResourceSaver docs: "When the
## project is running, any generated UID ... will not be saved"). The file still loads
## through the path fallback, but the user gets noisy diffs and loses the protection UIDs
## give against moved files.
##
## So in headless runs we put them back after saving:
##   * the header uid: the file's previous uid (read before saving), or a new one for a new
##     file (the editor registers it on its next scan, like any file created outside it);
##   * each [ext_resource] uid: the dependency's uid from the project's UID cache / .uid
##     sidecar / its own header (ResourceLoader.get_resource_uid).
## In the editor (Engine.is_editor_hint()) the saver already writes UIDs, so we do nothing.
## Binary formats (.scn/.res) are left alone: their UIDs aren't patchable as text.

const TEXT_EXTENSIONS: PackedStringArray = ["tscn", "tres", "escn"]


## Drop-in replacement for ResourceSaver.save(). Returns an Error code.
static func save(resource: Resource, path: String, flags: int = 0) -> int:
	var headless: bool = not Engine.is_editor_hint()
	var previous_uid: int = ResourceUID.INVALID_ID
	if headless and FileAccess.file_exists(path):
		previous_uid = uid_of(path)
	var err: int = ResourceSaver.save(resource, path, flags)
	if err != OK or not headless or not path.get_extension().to_lower() in TEXT_EXTENSIONS:
		return err
	return restore_uids(path, previous_uid)


## Rewrites the saved text file at `path` so the header and [ext_resource] lines carry
## UIDs. `header_uid` is used for the header when valid; otherwise a new id is created.
## Lines that already have a uid are not touched. Returns an Error code.
static func restore_uids(path: String, header_uid: int) -> int:
	var text: String = FileAccess.get_file_as_string(path)
	if text.is_empty():
		return FileAccess.get_open_error()
	var lines: PackedStringArray = text.split("\n")
	var changed: bool = false
	for i: int in lines.size():
		var line: String = lines[i]
		if i == 0 and (line.begins_with("[gd_scene") or line.begins_with("[gd_resource")) and not line.contains(" uid=\""):
			var uid: int = header_uid
			if uid == ResourceUID.INVALID_ID:
				uid = ResourceUID.create_id()
			# The editor writes the uid last in the header: [gd_scene format=3 uid="uid://..."]
			lines[i] = line.trim_suffix("]") + " uid=\"%s\"]" % ResourceUID.id_to_text(uid)
			changed = true
		elif line.begins_with("[ext_resource") and not line.contains(" uid=\""):
			var dep_path: String = _attr(line, "path")
			if dep_path.is_empty():
				continue
			var dep_uid: int = uid_of(dep_path)
			if dep_uid == ResourceUID.INVALID_ID:
				continue  # the dependency has no uid (e.g. never imported); path still works
			# Editor order: [ext_resource type="Script" uid="uid://..." path="res://x.gd" id="1_x"]
			lines[i] = line.replace(" path=\"", " uid=\"%s\" path=\"" % ResourceUID.id_to_text(dep_uid))
			changed = true
	if not changed:
		return OK
	var file := FileAccess.open(path, FileAccess.WRITE)
	if file == null:
		return FileAccess.get_open_error()
	file.store_string("\n".join(lines))
	file.close()
	return OK


## The UID of the file at `path`, or ResourceUID.INVALID_ID. Checked in this order:
##   1. text resources (.tscn/.tres): the uid="..." in their header. ResourceLoader's own
##      get_resource_uid() returns -1 for these in headless runs on 4.7.2 (verified), so we
##      read the header ourselves;
##   2. ResourceLoader.get_resource_uid(): scripts/shaders via their .uid sidecar, imported
##      assets via their .import file;
##   3. the .uid sidecar / .import file directly, as a last resort.
static func uid_of(path: String) -> int:
	if path.get_extension().to_lower() in TEXT_EXTENSIONS and FileAccess.file_exists(path):
		var file := FileAccess.open(path, FileAccess.READ)
		if file != null:
			var header_uid: String = _attr(file.get_line(), "uid")
			if header_uid.begins_with("uid://"):
				return ResourceUID.text_to_id(header_uid)
	var uid: int = ResourceLoader.get_resource_uid(path)
	if uid != ResourceUID.INVALID_ID:
		return uid
	if FileAccess.file_exists(path + ".uid"):
		var text: String = FileAccess.get_file_as_string(path + ".uid").strip_edges()
		if text.begins_with("uid://"):
			return ResourceUID.text_to_id(text)
	if FileAccess.file_exists(path + ".import"):
		var cfg := ConfigFile.new()
		if cfg.load(path + ".import") == OK:
			var text: String = str(cfg.get_value("remap", "uid", ""))
			if text.begins_with("uid://"):
				return ResourceUID.text_to_id(text)
	return ResourceUID.INVALID_ID


## Value of attribute `name="..."` on a tag line, or "".
static func _attr(line: String, name: String) -> String:
	var key: String = " %s=\"" % name
	var start: int = line.find(key)
	if start < 0:
		return ""
	start += key.length()
	var end: int = line.find("\"", start)
	return line.substr(start, end - start) if end > start else ""
