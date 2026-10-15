@tool
extends EditorPlugin
## Godot MCP editor plugin: entry point of the editor bridge.
##
## On enable (_enter_tree) it
##   1. registers the `godot_mcp/bridge/port` project setting (default 6520) if missing,
##   2. installs a Logger so `logs.read` can return the editor's output,
##   3. starts the WebSocket server on 127.0.0.1 (trying the next ports if busy),
##   4. writes res://.godot/godot_mcp/session.json with the port and a fresh auth token.
## On disable or editor exit (_exit_tree) it undoes all of that, in reverse order.
##
## The server is polled from _process() on the main thread, because editor APIs are not
## thread-safe.

const Constants := preload("core/constants.gd")
const LogBuffer := preload("core/log_buffer.gd")
const BridgeServer := preload("bridge/bridge_server.gd")
const SessionFile := preload("bridge/session_file.gd")
const EditorBackend := preload("editor/editor_backend.gd")

var _logs: LogBuffer
var _backend: EditorBackend
var _server: BridgeServer


func _enter_tree() -> void:
	_register_settings()

	_logs = LogBuffer.new(2000)
	OS.add_logger(_logs)

	_backend = EditorBackend.new(_logs, self)
	_server = BridgeServer.new(_backend.handle, _welcome_payload)
	var base_port: int = int(ProjectSettings.get_setting(Constants.PORT_SETTING, Constants.DEFAULT_PORT))
	var err: int = _server.start(base_port)
	if err != OK:
		push_error("Godot MCP: could not listen on 127.0.0.1 ports %d-%d (%s). Change the '%s' project setting to a free port and re-enable the plugin." %
			[base_port, base_port + Constants.PORT_FALLBACK_COUNT, error_string(err), Constants.PORT_SETTING])
		set_process(false)
		return
	var write_err: int = SessionFile.write(_server.port, _server.token)
	if write_err != OK:
		push_error("Godot MCP: bridge is listening on port %d but writing %s failed (%s); the MCP server will not find this editor." %
			[_server.port, Constants.SESSION_FILE, error_string(write_err)])
	print("Godot MCP: bridge listening on 127.0.0.1:%d" % _server.port)
	set_process(true)


func _exit_tree() -> void:
	set_process(false)
	if _server != null:
		_server.stop()
		_server = null
	SessionFile.remove()
	if _logs != null:
		OS.remove_logger(_logs)
		_logs = null
	_backend = null


func _process(_delta: float) -> void:
	if _server != null:
		_server.poll()


func _register_settings() -> void:
	if not ProjectSettings.has_setting(Constants.PORT_SETTING):
		ProjectSettings.set_setting(Constants.PORT_SETTING, Constants.DEFAULT_PORT)
	# Initial value + property info make it show up (with a range) in Project Settings and
	# keep project.godot clean while the default is used.
	ProjectSettings.set_initial_value(Constants.PORT_SETTING, Constants.DEFAULT_PORT)
	ProjectSettings.add_property_info({
		"name": Constants.PORT_SETTING,
		"type": TYPE_INT,
		"hint": PROPERTY_HINT_RANGE,
		"hint_string": "1024,65535",
	})


func _welcome_payload() -> Dictionary:
	return {
		"godot_version": Constants.godot_version_string(),
		"plugin_version": Constants.PLUGIN_VERSION,
		"project_path": Constants.project_path(),
		"project_name": Constants.project_name(),
	}
