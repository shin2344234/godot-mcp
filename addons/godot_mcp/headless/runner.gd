extends SceneTree
## Headless runner: executes one bridge-protocol request without the editor.
##
## Invocation (see docs/bridge-protocol.md section 2):
##     godot --headless --path <project> --script res://addons/godot_mcp/headless/runner.gd -- <request.json>
##
## <request.json> contains {"method": "...", "params": {...}}. We print exactly one line
##     @@GODOT_MCP_RESULT@@{"result": ...}   or   @@GODOT_MCP_RESULT@@{"error": ...}
## and exit with code 0 (result) or 1 (error). Everything else Godot prints is noise to the
## server. Editor-only methods answer UNSUPPORTED.
##
## Note: autoloads of the project are instantiated even in --script mode, but the main
## scene is not, and the scenes we edit are never added to the SceneTree, so game scripts'
## _ready()/_process() do not run while we edit them.

const Constants := preload("../core/constants.gd")
const R := preload("../core/mcp_result.gd")
const LogBuffer := preload("../core/log_buffer.gd")
const Codec := preload("../core/variant_codec.gd")
const HeadlessBackend := preload("headless_backend.gd")

var _done: bool = false


func _initialize() -> void:
	# Capture engine errors during the request so an INTERNAL failure can say what broke.
	var logs := LogBuffer.new(500)
	OS.add_logger(logs)
	var response: Dictionary = _run(logs)
	OS.remove_logger(logs)
	_finish(response)


func _run(logs: LogBuffer) -> Dictionary:
	var args: PackedStringArray = OS.get_cmdline_user_args()
	if args.is_empty():
		return R.err(R.BAD_PARAMS, "Usage: godot --headless --path <project> --script res://addons/godot_mcp/headless/runner.gd -- <absolute path to request.json>")
	var request_path: String = args[0]
	if not FileAccess.file_exists(request_path):
		return R.err(R.BAD_PARAMS, "Request file '%s' does not exist (pass an absolute path after `--`)." % request_path)
	var json := JSON.new()
	var parse_err: int = json.parse(FileAccess.get_file_as_string(request_path))
	if parse_err != OK:
		return R.err(R.BAD_PARAMS, "Request file '%s' is not valid JSON: %s at line %d." % [request_path, json.get_error_message(), json.get_error_line()])
	var request: Variant = json.data
	if not request is Dictionary or not (request as Dictionary).get("method") is String:
		return R.err(R.BAD_PARAMS, "Request must be a JSON object like {\"method\": \"scene.tree\", \"params\": {...}}.")
	var method: String = request["method"]
	var since: int = logs.last_seq() + 1
	var backend := HeadlessBackend.new()
	var response: Variant = backend.handle(method, (request as Dictionary).get("params", {}))
	# A GDScript runtime error inside a handler makes it return null instead of aborting
	# the process; turn that into an INTERNAL error with the captured engine errors.
	# The same happens if an error occurs deeper down, so also check for addon script errors.
	var script_errors: Array[String] = logs.addon_script_errors(since)
	var malformed: bool = not response is Dictionary or not ((response as Dictionary).has("result") or (response as Dictionary).has("error"))
	if malformed or not script_errors.is_empty():
		var errors: Array[String] = script_errors if not script_errors.is_empty() else logs.recent_errors(since)
		var detail: String = (" Engine errors: " + " | ".join(errors)) if not errors.is_empty() else ""
		return R.err(R.INTERNAL, "Method '%s' failed unexpectedly inside the headless runner (this is a bug in the Godot MCP addon).%s" % [method, detail], {"engine_errors": errors})
	return response


func _finish(response: Dictionary) -> void:
	_done = true
	print(Constants.RESULT_MARKER + Codec.to_json(response))
	quit(0 if response.has("result") else 1)


## Safety net: if _initialize() was aborted by a script error before printing a result,
## the SceneTree would otherwise idle forever. Report an INTERNAL error and exit instead.
func _process(_delta: float) -> bool:
	if not _done:
		_finish(R.err(R.INTERNAL, "The headless runner stopped before producing a result (a script error aborted the request). See the process's stderr for the Godot error message."))
	return false
