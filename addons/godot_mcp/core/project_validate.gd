@tool
extends RefCounted
## project.validate: project-wide health check (used by ops/project_ops.gd).
##
## Finds the problems that make a project fail to open, run or export, without the cost
## of loading every asset:
## * project: main scene, autoloads and enabled plugins point at files that exist;
## * scenes/resources (.tscn/.scn/.tres/.res): every dependency resolves. We use
##   ResourceLoader.get_dependencies(), which reads only the ext_resource list (text
##   formats are not fully parsed and no texture/mesh is loaded). Entries come back as
##   "uid://...::Type::res://path" when the reference has a UID (verified on 4.7.2), so we
##   can report both a missing file and a stale UID (Godot then falls back to the path).
##   `deep: true` additionally loads each scene/resource (CACHE_MODE_IGNORE) and reports
##   engine errors printed while loading (broken sub-scenes, parse errors). A broken scene
##   still loads as a PackedScene, so errors are captured with a temporary Logger;
## * scripts (.gd): compiled with core/script_validate.gd (the same check as
##   script.validate);
## * uids: scripts/shaders without their `.uid` sidecar, orphan `.uid` files and UIDs
##   claimed by more than one file (from .uid files, .tscn/.tres headers and .import files).
##
## Output is capped: issues are collected in a stable order (project, then files sorted by
## path) and `offset`/`limit` select a page; `counts` always cover every issue found.

const R := preload("mcp_result.gd")
const Params := preload("params.gd")
const ResPaths := preload("res_paths.gd")
const ScriptValidate := preload("script_validate.gd")

const SCOPES: PackedStringArray = ["all", "project", "scenes", "resources", "scripts", "uids"]
## Vendored plugins live here; skipped unless params.addons is true (see run()).
const ADDONS_DIR: String = "res://addons/"
const SCENE_EXT: PackedStringArray = ["tscn", "scn"]
const RESOURCE_EXT: PackedStringArray = ["tres", "res"]
## Files that get a `.uid` sidecar in Godot 4.4+ (their formats cannot store a UID).
const UID_SIDECAR_EXT: PackedStringArray = ["gd", "cs", "gdshader", "gdshaderinc"]
## Compile errors reported per script (the first one is what matters most).
const MAX_ERRORS_PER_SCRIPT: int = 3


## Collects engine errors printed while a resource loads (for deep checks).
class LoadErrors extends Logger:
	var messages: PackedStringArray = []
	var _mutex := Mutex.new()

	func _log_error(_function: String, _file: String, _line: int, code: String, rationale: String,
			_editor_notify: bool, error_type: int, _script_backtraces: Array[ScriptBacktrace]) -> void:
		# 1 = Logger.ERROR_TYPE_WARNING: Godot warns on stale UIDs and falls back to the
		# path; the dependency check reports those already.
		if error_type == 1:
			return
		_mutex.lock()
		messages.append(rationale if not rationale.is_empty() else code)
		_mutex.unlock()

	func _log_message(_message: String, _error: bool) -> void:
		pass


## Accumulates issues and the page to return.
class Collector:
	var issues: Array = []
	var total: int = 0
	var errors: int = 0
	var warnings: int = 0
	var by_kind: Dictionary = {}
	var offset: int = 0
	var limit: int = 200

	func add(severity: String, kind: String, path: String, message: String, fix_hint: String) -> void:
		if severity == "error":
			errors += 1
		else:
			warnings += 1
		by_kind[kind] = int(by_kind.get(kind, 0)) + 1
		if total >= offset and issues.size() < limit:
			issues.append({"severity": severity, "kind": kind, "path": path, "message": message, "fix_hint": fix_hint})
		total += 1


static func run(params: Dictionary, _env: Dictionary) -> Dictionary:
	var p := Params.new(params, "project.validate")
	var scope: String = p.opt_string("scope", "all")
	var prefix_raw: String = p.opt_string("path_prefix", "res://")
	var deep: bool = p.opt_bool("deep", false)
	var include_addons: bool = p.opt_bool("addons", false)
	var c := Collector.new()
	c.limit = p.opt_int("limit", 200)
	c.offset = p.opt_int("offset", 0)
	if p.failed():
		return p.error
	if not scope in SCOPES:
		return R.err(R.BAD_PARAMS, "project.validate: 'scope' must be one of %s, got '%s'." % [", ".join(SCOPES), scope])
	if c.limit < 1 or c.limit > 1000 or c.offset < 0:
		return R.err(R.BAD_PARAMS, "project.validate: 'limit' must be 1-1000 and 'offset' >= 0.")
	var norm: Dictionary = ResPaths.normalize(prefix_raw, "path_prefix")
	if R.is_err(norm):
		return norm
	var prefix: String = norm["value"]
	var root_dir: String = prefix if DirAccess.dir_exists_absolute(prefix) else prefix.get_base_dir()

	var files: PackedStringArray = []
	_walk(root_dir, files)
	# Vendored plugins under res://addons/ (GUT, this addon, ...) are someone else's files:
	# their orphan .uid files and warnings are noise the user can't act on (MCP_TEST_LOG
	# Phase A: addons/gut/menu_manager.gd.uid flagged as orphan_uid). They are skipped
	# unless `addons` is set or path_prefix points inside res://addons/ (then the caller
	# asked for them). Project files that depend on addon files are still checked.
	var skip_addons: bool = not include_addons and not prefix.begins_with(ADDONS_DIR)
	var filtered: PackedStringArray = []
	var skipped_addons: int = 0
	for f: String in files:
		if not f.begins_with(prefix):
			continue
		if skip_addons and f.begins_with(ADDONS_DIR):
			skipped_addons += 1
			continue
		filtered.append(f)
	filtered.sort()

	var checked: Dictionary = {"files": filtered.size(), "scenes": 0, "resources": 0, "scripts": 0}
	if skipped_addons > 0:
		checked["addons_skipped"] = skipped_addons
	if scope in ["all", "project"]:
		_check_project(c)
	for f: String in filtered:
		var ext: String = f.get_extension().to_lower()
		if ext in SCENE_EXT and scope in ["all", "scenes"]:
			checked["scenes"] += 1
			_check_resource(c, f, deep)
		elif ext in RESOURCE_EXT and scope in ["all", "resources"]:
			checked["resources"] += 1
			_check_resource(c, f, deep)
		elif ext == "gd" and scope in ["all", "scripts"]:
			checked["scripts"] += 1
			_check_script(c, f)
	if scope in ["all", "uids"]:
		_check_uids(c, filtered)

	var result: Dictionary = {
		"issues": c.issues,
		"counts": {"total": c.total, "error": c.errors, "warning": c.warnings, "by_kind": c.by_kind},
		"checked": checked,
		"scope": scope,
		"path_prefix": prefix,
		"deep": deep,
		"truncated": c.total > c.offset + c.issues.size(),
	}
	if result["truncated"]:
		result["next_offset"] = c.offset + c.issues.size()
	return R.ok(result)


## Every project file under `dir_path`, skipping hidden folders (.godot, .git...) and
## folders with a .gdignore (Godot ignores those too).
static func _walk(dir_path: String, out: PackedStringArray) -> void:
	var dir: DirAccess = DirAccess.open(dir_path)
	if dir == null:
		return
	if dir.file_exists(".gdignore") and dir_path != "res://":
		return
	dir.include_hidden = false
	for f: String in dir.get_files():
		out.append(dir_path.path_join(f))
	for d: String in dir.get_directories():
		if d.begins_with("."):
			continue
		_walk(dir_path.path_join(d), out)


## Resolves "uid://..." (or a res:// path) to a res:// path; "" when the UID is unknown.
static func _resolve(path: String) -> String:
	if path.begins_with("uid://"):
		var id: int = ResourceUID.text_to_id(path)
		return ResourceUID.get_id_path(id) if ResourceUID.has_id(id) else ""
	return path


static func _check_project(c: Collector) -> void:
	var main: String = str(ProjectSettings.get_setting("application/run/main_scene", ""))
	if main.is_empty():
		c.add("warning", "main_scene", "project.godot", "No main scene is set (application/run/main_scene), so the game cannot be run or exported as is.",
			"godot_project_set {\"settings\": {\"application/run/main_scene\": \"res://main.tscn\"}}")
	else:
		var resolved: String = _resolve(main)
		if resolved.is_empty() or not ResPaths.file_exists(resolved):
			c.add("error", "main_scene", "project.godot", "The main scene '%s' does not exist." % main,
				"Point application/run/main_scene at an existing scene with godot_project_set.")

	for info: Dictionary in ProjectSettings.get_property_list():
		var key: String = info["name"]
		if not key.begins_with("autoload/"):
			continue
		var raw: String = str(ProjectSettings.get_setting(key, "")).trim_prefix("*")
		var resolved_a: String = _resolve(raw)
		if resolved_a.is_empty() or not FileAccess.file_exists(resolved_a):
			c.add("error", "autoload", "project.godot", "Autoload '%s' points at '%s', which does not exist; the game fails to start." % [key.trim_prefix("autoload/"), raw],
				"Fix the path or remove it: godot_autoload_edit {\"op\": \"remove\", \"name\": \"%s\"}." % key.trim_prefix("autoload/"))

	var plugins: Variant = ProjectSettings.get_setting("editor_plugins/enabled", PackedStringArray())
	if plugins is PackedStringArray or plugins is Array:
		for cfg_path: String in plugins:
			if not FileAccess.file_exists(cfg_path):
				c.add("error", "plugin", cfg_path, "Enabled editor plugin '%s' does not exist." % cfg_path,
					"godot_project_plugins {\"disable\": [\"%s\"]}" % cfg_path)
				continue
			var cfg := ConfigFile.new()
			if cfg.load(cfg_path) != OK:
				c.add("error", "plugin", cfg_path, "plugin.cfg cannot be parsed.", "Fix the [plugin] section (name, script, ...).")
				continue
			var script_rel: String = str(cfg.get_value("plugin", "script", ""))
			if not script_rel.is_empty() and not FileAccess.file_exists(cfg_path.get_base_dir().path_join(script_rel)):
				c.add("error", "plugin", cfg_path, "Plugin script '%s' is missing." % cfg_path.get_base_dir().path_join(script_rel),
					"Restore the script or disable the plugin with godot_project_plugins.")

	var icon: String = str(ProjectSettings.get_setting("application/config/icon", ""))
	if not icon.is_empty():
		var resolved_i: String = _resolve(icon)
		if resolved_i.is_empty() or not ResPaths.file_exists(resolved_i):
			c.add("warning", "icon", "project.godot", "The project icon '%s' does not exist." % icon,
				"Set application/config/icon to an existing image with godot_project_set.")


static func _check_resource(c: Collector, path: String, deep: bool) -> void:
	for dep: String in ResourceLoader.get_dependencies(path):
		var parts: PackedStringArray = dep.split("::")
		var dep_path: String = parts[parts.size() - 1]
		var uid_text: String = parts[0] if parts.size() > 1 and parts[0].begins_with("uid://") else ""
		var uid_target: String = _resolve(uid_text) if not uid_text.is_empty() else ""
		var path_ok: bool = not dep_path.is_empty() and ResPaths.file_exists(dep_path)
		if path_ok:
			if not uid_text.is_empty() and uid_target.is_empty():
				c.add("warning", "stale_uid", path, "References '%s' with an unknown UID (%s); Godot falls back to the path." % [dep_path, uid_text],
					"Open and re-save the file in the editor (or godot_scene_save) to rewrite the UID.")
		elif not uid_target.is_empty() and ResPaths.file_exists(uid_target):
			c.add("warning", "moved_dependency", path, "References '%s', which no longer exists; its UID resolves to '%s', so it still loads." % [dep_path, uid_target],
				"Re-save the file in the editor to update the stored path.")
		else:
			c.add("error", "missing_dependency", path, "Depends on '%s', which does not exist." % dep_path,
				"Restore the file, or fix the reference (e.g. godot_node_set / godot_script_attach on the node using it, or godot_files_edit on the ext_resource line).")
	if deep:
		var logger := LoadErrors.new()
		OS.add_logger(logger)
		var res: Resource = ResourceLoader.load(path, "", ResourceLoader.CACHE_MODE_IGNORE)
		OS.remove_logger(logger)
		if res == null:
			c.add("error", "load_failed", path, "Fails to load.%s" % ((" " + logger.messages[0]) if not logger.messages.is_empty() else ""),
				"Open it in the editor to see the full error, or check its dependencies.")
		elif not logger.messages.is_empty():
			c.add("error", "load_errors", path, "Loads with errors: %s" % " | ".join(logger.messages.slice(0, 3)),
				"Fix the reported references (missing scripts, sub-scenes or resources).")


static func _check_script(c: Collector, path: String) -> void:
	var source: String = FileAccess.get_file_as_string(path)
	var check: Dictionary = ScriptValidate.validate_source(source, path)
	if bool(check["valid"]):
		return
	var errors: Array = check["errors"]
	for i: int in mini(errors.size(), MAX_ERRORS_PER_SCRIPT):
		var e: Dictionary = errors[i]
		var where: String = str(e.get("file", path))
		c.add("error", "script_error", path, "Line %d: %s%s" % [int(e.get("line", 0)), str(e.get("message", "")), (" (in %s)" % where) if where != path else ""],
			"Fix the code (godot_files_edit), then re-check with godot_script_validate.")
	if errors.size() > MAX_ERRORS_PER_SCRIPT:
		c.add("error", "script_error", path, "%d more compile error(s) not shown." % (errors.size() - MAX_ERRORS_PER_SCRIPT), "Run godot_script_validate on this file for the full list.")


static func _check_uids(c: Collector, files: PackedStringArray) -> void:
	var file_set: Dictionary = {}
	for f: String in files:
		file_set[f] = true
	var owners: Dictionary = {} # uid text -> Array of paths claiming it
	for f: String in files:
		var ext: String = f.get_extension().to_lower()
		if ext in UID_SIDECAR_EXT:
			if not file_set.has(f + ".uid"):
				c.add("warning", "missing_uid", f, "Has no '%s.uid' file, so references to it by UID cannot resolve." % f.get_file(),
					"Open the project in the editor (or run godot --headless --import) to generate it; commit .uid files to version control.")
		elif ext == "uid":
			var source: String = f.trim_suffix(".uid")
			if not file_set.has(source):
				c.add("warning", "orphan_uid", f, "'%s' has no matching '%s'." % [f.get_file(), source.get_file()],
					"Delete the orphan .uid file (godot_files_delete), or restore the file it belonged to.")
			_claim(owners, FileAccess.get_file_as_string(f).strip_edges(), source)
		elif ext in ["tscn", "tres"]:
			_claim(owners, _header_uid(f), f)
		elif ext == "import":
			_claim(owners, _import_uid(f), f.trim_suffix(".import"))
	for uid: String in owners:
		var paths: Array = owners[uid]
		if paths.size() > 1:
			c.add("error", "duplicate_uid", str(paths[0]), "UID %s is claimed by %d files: %s. References may load the wrong file." % [uid, paths.size(), ", ".join(PackedStringArray(paths))],
				"Give all but one a new UID: delete their .uid file (scripts) or the uid=\"...\" attribute (scenes/resources), then reopen the project in the editor.")


static func _claim(owners: Dictionary, uid: String, path: String) -> void:
	if not uid.begins_with("uid://"):
		return
	if not owners.has(uid):
		owners[uid] = []
	(owners[uid] as Array).append(path)


## uid="uid://..." from the first line of a text scene/resource, or "".
static func _header_uid(path: String) -> String:
	var f: FileAccess = FileAccess.open(path, FileAccess.READ)
	if f == null:
		return ""
	var line: String = f.get_line()
	var at: int = line.find("uid=\"uid://")
	if at < 0:
		return ""
	var start: int = at + 5
	var end: int = line.find("\"", start)
	return line.substr(start, end - start) if end > start else ""


## uid="uid://..." from an .import file's [remap] section, or "".
static func _import_uid(path: String) -> String:
	var f: FileAccess = FileAccess.open(path, FileAccess.READ)
	if f == null:
		return ""
	while not f.eof_reached():
		var line: String = f.get_line().strip_edges()
		if line.begins_with("uid=\"uid://"):
			return line.substr(5, line.length() - 6)
		if line.begins_with("[") and line != "[remap]":
			break
	return ""
