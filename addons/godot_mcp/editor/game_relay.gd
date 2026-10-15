@tool
extends EditorDebuggerPlugin
## Relays the runtime's debugger messages between games started from the editor and the
## MCP server (docs/runtime-protocol.md, "Editor relay").
##
## Game -> server: every "mcp:*" message the game sends (hello, reply, event) is broadcast
## to the bridge clients as {"type": "event", "event": "game.message",
## "data": {"session": id, "message": "mcp:reply", "data": [json]}}.
## Server -> game: the bridge method "game.send" calls EditorDebuggerSession.send_message.
## Session start/stop are broadcast as "game.started" / "game.stopped".
##
## The editor's own debugger keeps working as usual: we only capture the "mcp" prefix.

const Override := preload("../core/runtime_override.gd")

## Callable(event: String, data: Dictionary): sends a bridge event to connected servers.
var broadcast: Callable
## session id -> last "mcp:hello" JSON text, so a server that connects after the game
## started can still learn about it (game.status).
var _hello: Dictionary = {}


func _has_capture(prefix: String) -> bool:
	return prefix == "mcp"


func _capture(message: String, data: Array, session_id: int) -> bool:
	if message == "mcp:hello" and not data.is_empty():
		_hello[session_id] = str(data[0])
	if broadcast.is_valid():
		broadcast.call("game.message", {"session": session_id, "message": message, "data": data})
	return true


func _setup_session(session_id: int) -> void:
	var session: EditorDebuggerSession = get_session(session_id)
	session.started.connect(_on_started.bind(session_id))
	session.stopped.connect(_on_stopped.bind(session_id))
	# Breakpoint/error stops in the editor's debugger. The server fails its pending runtime
	# requests on "game.breaked" right away (a stopped game can't answer them) instead of
	# letting them run into their timeout (server/src/game/hub.ts, EditorTransport).
	session.breaked.connect(_on_breaked.bind(session_id))
	session.continued.connect(_on_continued.bind(session_id))


func _on_started(session_id: int) -> void:
	# The game has read override.cfg by the time its debugger connects.
	Override.restore()
	if broadcast.is_valid():
		broadcast.call("game.started", {"session": session_id})


## EditorDebuggerSession.breaked(can_debug): the game entered its debug loop.
func _on_breaked(can_debug: bool, session_id: int) -> void:
	if broadcast.is_valid():
		broadcast.call("game.breaked", {"session": session_id, "can_debug": can_debug})


func _on_continued(session_id: int) -> void:
	if broadcast.is_valid():
		broadcast.call("game.continued", {"session": session_id})


func _on_stopped(session_id: int) -> void:
	_hello.erase(session_id)
	Override.restore()
	if broadcast.is_valid():
		broadcast.call("game.stopped", {"session": session_id})


## Sends a debugger message to a running game. session_id < 0 picks the newest active one.
func send(session_id: int, command: String, data: Array) -> Dictionary:
	var s: EditorDebuggerSession = _session(session_id)
	if s == null:
		return {"error": {"code": "GAME_NOT_RUNNING", "message": "No game started from the editor is running. Start one with godot_run_start."}}
	s.send_message(command, data)
	return {"result": {"sent": true}}


## Running editor sessions, newest first, with the runtime hello if the runtime is loaded.
func status() -> Dictionary:
	var sessions: Array = []
	var all: Array = get_sessions()
	for i: int in range(all.size() - 1, -1, -1):
		var s: EditorDebuggerSession = all[i]
		if s == null or not s.is_active():
			continue
		sessions.append({"session": i, "breaked": s.is_breaked(), "hello": _hello.get(i, "")})
	return {"result": {"sessions": sessions}}


func _session(session_id: int) -> EditorDebuggerSession:
	var all: Array = get_sessions()
	if session_id >= 0:
		if session_id < all.size() and all[session_id] != null and (all[session_id] as EditorDebuggerSession).is_active():
			return all[session_id]
		return null
	for i: int in range(all.size() - 1, -1, -1):
		if all[i] != null and (all[i] as EditorDebuggerSession).is_active():
			return all[i]
	return null
