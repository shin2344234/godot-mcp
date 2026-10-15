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
##
## [code/docs area] LSP-only mode: the MCP server may start a private headless editor just
## for the GDScript language server (server/src/lsp/manager.ts), with the user arguments
## `-- --godot-mcp-lsp-only --godot-mcp-lsp-port=<port>`. In that mode the session goes to
## lsp_session.json instead of session.json, so the server never routes scene edits into
## that invisible editor. The server keeps one bridge connection open to it for as long as
## it wants the editor; when no client has been connected for a while (the server exited,
## even if it was killed with SIGKILL and could not clean up) the editor quits by itself,
## so no orphaned Godot process is left behind. (OS.is_process_running() cannot be used
## for this: on Unix it only works for child processes, not for the parent.)
## In every mode the session file and the welcome payload report `lsp_port`, the port of
## this editor's GDScript language server.

const Constants := preload("core/constants.gd")
const LogBuffer := preload("core/log_buffer.gd")
const BridgeServer := preload("bridge/bridge_server.gd")
const SessionFile := preload("bridge/session_file.gd")
const EditorBackend := preload("editor/editor_backend.gd")
const GameRelay := preload("editor/game_relay.gd")
const RuntimeOverride := preload("core/runtime_override.gd")

var _logs: LogBuffer
var _backend: EditorBackend
var _server: BridgeServer
## [runtime] Relays the runtime autoload's messages for games started from this editor.
var _relay: GameRelay

## [code/docs area] LSP-only mode flags (see the header comment).
const LSP_ONLY_ARG: String = "--godot-mcp-lsp-only"
## Godot consumes `--lsp-port` itself and does not expose it to scripts, so the server repeats
## the port in this user argument for the session file.
const LSP_PORT_ARG: String = "--godot-mcp-lsp-port="
const DEFAULT_LSP_PORT: int = 6005
## The MCP server's own one-shot `godot --headless --import` runs pass this user argument:
## such a run must not open a bridge, or for its few seconds it would look like a user's
## editor to the server (session.json), which then routes edits and LSP requests to it.
const NO_BRIDGE_ARG: String = "--godot-mcp-no-bridge"
## LSP-only watchdog: quit after this long without any bridge client...
const ORPHAN_TIMEOUT_SEC: float = 15.0
## ...or this long after startup if the server never connected at all.
const FIRST_CLIENT_TIMEOUT_SEC: float = 120.0
var _lsp_only: bool = false
var _no_bridge: bool = false
var _lsp_port_arg: int = 0
var _had_client: bool = false
var _no_client_sec: float = 0.0


func _enter_tree() -> void:
	_parse_user_args()
	if _no_bridge:
		return
	# One bridge per project. Command-line editor runs (`godot --import`, `--export-release`
	# ...) load enabled plugins too, and Godot hides those flags from scripts
	# (OS.get_cmdline_args() returns just ["--editor"] there, verified on 4.7.2). Without
	# this check such a run would overwrite the open editor's session.json and delete it on
	# exit, cutting the MCP server off from the editor the user is working in.
	if not _lsp_only:
		var other_pid: int = _other_editor_serving()
		if other_pid > 0:
			print("Godot MCP: another Godot editor (pid %d) is already serving this project's MCP bridge; not starting a second one here." % other_pid)
			return
	_register_settings()

	_logs = LogBuffer.new(2000)
	OS.add_logger(_logs)

	_backend = EditorBackend.new(_logs, self)
	_server = BridgeServer.new(_backend.handle, _welcome_payload)
	# [runtime] Not in LSP-only mode: that editor never runs games.
	if not _lsp_only:
		RuntimeOverride.restore_if_stale()
		_relay = GameRelay.new()
		_relay.broadcast = _server.broadcast_event
		add_debugger_plugin(_relay)
	var base_port: int = int(ProjectSettings.get_setting(Constants.PORT_SETTING, Constants.DEFAULT_PORT))
	var err: int = _server.start(base_port)
	if err != OK:
		push_error("Godot MCP: could not listen on 127.0.0.1 ports %d-%d (%s). Change the '%s' project setting to a free port and re-enable the plugin." %
			[base_port, base_port + Constants.PORT_FALLBACK_COUNT, error_string(err), Constants.PORT_SETTING])
		set_process(false)
		_server = null  # never wrote a session file, so _exit_tree must not remove one
		return
	var write_err: int = SessionFile.write(_server.port, _server.token, _session_file(), {"lsp_port": _lsp_port(), "lsp_only": _lsp_only})
	if write_err != OK:
		push_error("Godot MCP: bridge is listening on port %d but writing %s failed (%s); the MCP server will not find this editor." %
			[_server.port, _session_file(), error_string(write_err)])
	print("Godot MCP: bridge listening on 127.0.0.1:%d" % _server.port)
	set_process(true)


func _exit_tree() -> void:
	set_process(false)
	if _relay != null:
		remove_debugger_plugin(_relay)
		_relay = null
		RuntimeOverride.restore()
	if _server != null:
		_server.stop()
		_server = null
		# remove() also checks the file's pid, so a file another editor wrote survives.
		SessionFile.remove(_session_file())
	if _logs != null:
		OS.remove_logger(_logs)
		_logs = null
	_backend = null


func _process(delta: float) -> void:
	if _server != null:
		_server.poll()
	# [code/docs area] A private LSP editor must not outlive the MCP server that started it.
	if _lsp_only and _server != null:
		if _server.client_count() > 0:
			_had_client = true
			_no_client_sec = 0.0
		else:
			_no_client_sec += delta
			var limit: float = ORPHAN_TIMEOUT_SEC if _had_client else FIRST_CLIENT_TIMEOUT_SEC
			if _no_client_sec > limit:
				print("Godot MCP: no MCP server connected for %d s; closing this LSP-only editor." % int(_no_client_sec))
				_lsp_only = false # quit once
				get_tree().quit()


## [runtime] Called right before the editor runs the project: load the runtime autoload
## into that game through a temporary override.cfg (core/runtime_override.gd). The relay
## restores the file when the game's debugger session starts; the timer is a fallback for
## a game that never connects.
func _build() -> bool:
	if _relay == null:
		return true
	if RuntimeOverride.inject() == OK:
		get_tree().create_timer(20.0).timeout.connect(RuntimeOverride.restore)
	return true


## [runtime] For the bridge methods game.send / game.status (editor/editor_backend.gd).
func get_game_relay() -> GameRelay:
	return _relay


## If session.json belongs to another live editor whose bridge accepts connections, returns
## that editor's pid; otherwise 0. A stale file (editor crashed or was killed) has nobody
## listening on its port, so this editor takes over as usual. The probe is a plain TCP
## connect to 127.0.0.1 with a short timeout; it doesn't authenticate, so it never shows
## up as a client in the other editor beyond an immediately closed socket.
func _other_editor_serving() -> int:
	var path_abs: String = ProjectSettings.globalize_path(Constants.SESSION_FILE)
	if not FileAccess.file_exists(path_abs):
		return 0
	var parsed: Variant = JSON.parse_string(FileAccess.get_file_as_string(path_abs))
	if not parsed is Dictionary:
		return 0
	var pid: int = int((parsed as Dictionary).get("pid", -1))
	var port: int = int((parsed as Dictionary).get("port", -1))
	if pid <= 0 or pid == OS.get_process_id() or port <= 0:
		return 0
	var tcp := StreamPeerTCP.new()
	if tcp.connect_to_host("127.0.0.1", port) != OK:
		return 0
	var deadline: int = Time.get_ticks_msec() + 500
	while Time.get_ticks_msec() < deadline:
		tcp.poll()
		match tcp.get_status():
			StreamPeerTCP.STATUS_CONNECTED:
				tcp.disconnect_from_host()
				return pid
			StreamPeerTCP.STATUS_ERROR, StreamPeerTCP.STATUS_NONE:
				return 0
		OS.delay_msec(10)
	tcp.disconnect_from_host()
	return 0


## [code/docs area] Reads the LSP-only flags from the user arguments (after `--`).
func _parse_user_args() -> void:
	for arg: String in OS.get_cmdline_user_args():
		if arg == LSP_ONLY_ARG:
			_lsp_only = true
		elif arg == NO_BRIDGE_ARG:
			_no_bridge = true
		elif arg.begins_with(LSP_PORT_ARG) and arg.trim_prefix(LSP_PORT_ARG).is_valid_int():
			_lsp_port_arg = arg.trim_prefix(LSP_PORT_ARG).to_int()


## [code/docs area] Which session file this editor owns (session.json, or lsp_session.json
## in LSP-only mode).
func _session_file() -> String:
	return SessionFile.LSP_SESSION_FILE if _lsp_only else Constants.SESSION_FILE


## [code/docs area] Port of this editor's GDScript language server: the server-provided
## override (LSP_PORT_ARG) if present, else the `network/language_server/remote_port` editor
## setting. The MCP server only ever connects to it on 127.0.0.1.
func _lsp_port() -> int:
	if _lsp_port_arg > 0:
		return _lsp_port_arg
	var settings: EditorSettings = EditorInterface.get_editor_settings()
	if settings != null and settings.has_setting("network/language_server/remote_port"):
		return int(settings.get_setting("network/language_server/remote_port"))
	return DEFAULT_LSP_PORT


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
		# [code/docs area] lets the MCP server talk to this editor's language server.
		"lsp_port": _lsp_port(),
		"lsp_only": _lsp_only,
	}
