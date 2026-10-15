@tool
extends RefCounted
## script.validate: compile GDScript source without attaching or saving it.
##
## Godot has no public "parse and give me the diagnostics" API, so we compile the source
## into a throw-away GDScript and capture the errors the compiler reports through the
## engine's error stream, using a temporary Logger (OS.add_logger, Godot 4.5+).
##
## Notes / limitations:
## * The compiler only reports a line per error, not a column, so `column` is omitted.
## * After the first *parse* (syntax) error the parser stops; analyzer (type) errors are
##   all reported. Fixing the first error and validating again reveals the rest.
## * When `path` is given we use Resource.set_path_cache() so the compiler sees the real
##   path (needed for relative preloads and for `class_name` checks: a script that declares
##   the global class registered at that path must not be reported as "hides a global
##   class"), without touching the resource cache that the editor's loaded copy lives in.

const R := preload("mcp_result.gd")
const Params := preload("params.gd")
const ResPaths := preload("res_paths.gd")


## Collects errors reported while the logger is installed.
class ErrorCollector extends Logger:
	var errors: Array[Dictionary] = []
	var _mutex := Mutex.new()

	func _log_error(function: String, file: String, line: int, code: String, rationale: String,
			_editor_notify: bool, error_type: int, _script_backtraces: Array[ScriptBacktrace]) -> void:
		# 2 = Logger.ERROR_TYPE_SCRIPT; compiler errors are reported from GDScript::reload.
		if error_type != 2 and not function.begins_with("GDScript"):
			return
		var text: String = rationale if not rationale.is_empty() else code
		_mutex.lock()
		errors.append({"file": file, "line": line, "message": text})
		_mutex.unlock()

	func _log_message(_message: String, _error: bool) -> void:
		pass


static func validate(params: Variant) -> Dictionary:
	var p := Params.new(params, "script.validate")
	var raw_path: String = p.opt_string("path", "")
	var source: String = p.opt_string("source", "")
	var has_source: bool = p.has("source")
	if p.failed():
		return p.error
	if raw_path.is_empty() and not has_source:
		return R.err(R.BAD_PARAMS, "script.validate: pass 'path' (a res:// .gd file) and/or 'source' (GDScript code). With both, 'source' is validated as if it were saved at 'path'.")
	var path: String = ""
	if not raw_path.is_empty():
		var pres: Dictionary = ResPaths.normalize(raw_path, "path")
		if R.is_err(pres):
			return pres
		path = pres["value"]
		if path.get_extension().to_lower() != "gd":
			return R.err(R.BAD_PARAMS, "script.validate: only GDScript (.gd) files can be validated, got '%s'." % path)
		if not has_source:
			if not FileAccess.file_exists(path):
				return R.err(R.NOT_FOUND, "script.validate: '%s' does not exist. Pass 'source' to validate code that is not saved yet." % path)
			source = FileAccess.get_file_as_string(path)
	return R.ok(validate_source(source, path))


## Compiles `source` (as if located at `path`, which may be empty) and returns
## {"valid": bool, "errors": [{"line", "message"}...]}.
static func validate_source(source: String, path: String) -> Dictionary:
	var script := GDScript.new()
	script.source_code = source
	if not path.is_empty():
		script.set_path_cache(path)
	var collector := ErrorCollector.new()
	OS.add_logger(collector)
	var err: int = script.reload()
	OS.remove_logger(collector)

	var errors: Array = []
	var seen: Dictionary = {}
	for e: Dictionary in collector.errors:
		var message: String = str(e["message"]).trim_prefix("Parse Error: ")
		var key: String = "%s:%d:%s" % [e["file"], int(e["line"]), message]
		if seen.has(key):
			continue
		seen[key] = true
		var entry: Dictionary = {"line": int(e["line"]), "message": message}
		# Errors can come from scripts this one depends on (preload/extends); name the file
		# then, so the reader knows where to look.
		var file: String = str(e["file"])
		if not file.is_empty() and file != path and not file.begins_with("gdscript://"):
			entry["file"] = file
		errors.append(entry)
	if err != OK and errors.is_empty():
		# Compilation failed without a captured message (should be rare).
		errors.append({"line": 0, "message": "Compilation failed: %s." % error_string(err)})
	return {"valid": err == OK and errors.is_empty(), "errors": errors}
