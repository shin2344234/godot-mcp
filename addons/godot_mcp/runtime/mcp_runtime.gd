extends Node
## Godot MCP runtime: the agent's hands inside the running game.
##
## This script is added to the game as an autoload ONLY for runs the MCP server can talk to,
## through a temporary `res://override.cfg` that is removed again as soon as the game has
## started (see docs/runtime-protocol.md, "Getting the runtime into the game"). It never
## stays in project.godot, and it does nothing unless a debugger is attached
## (EngineDebugger.is_active()), so it can't do anything in an exported game even if a
## stale override.cfg were ever exported by accident.
##
## Transport: the debugger connection Godot already opens between a game and its debugger.
## That debugger is either the Godot editor (when the game was started from the editor; the
## plugin's EditorDebuggerPlugin relays our messages to the MCP server over the bridge) or
## the MCP server itself (games it launches with --remote-debug). Either way this script
## only sees EngineDebugger messages:
##   debugger -> game  "mcp:request"  [json]   json = {"id": 7, "method": "game.tree", "params": {...}}
##   game -> debugger  "mcp:reply"    [json]   json = {"id": 7, "result": {...}} or {"id": 7, "error": {...}}
##   game -> debugger  "mcp:hello"    [json]   sent once, when the runtime is ready
##   game -> debugger  "mcp:event"    [json]   unsolicited events, e.g. {"event": "...", ...}
## Payloads are JSON text (not Variants) so both debugger hosts can pass them through
## untouched and values follow the addon's usual JSON conventions (core/variant_codec.gd).
##
## Methods live in area modules under runtime/ops/, each with
## `static func methods() -> Dictionary` mapping a method name to
## {"fn": Callable(runtime, params) -> Dictionary}, where the Dictionary is the usual
## {"result": {...}} / {"error": {...}} shape from core/mcp_result.gd. A method may be a
## coroutine (use `await`), e.g. to wait for frames or signals; replies are sent when it
## finishes, and other requests keep being served meanwhile.

const R := preload("../core/mcp_result.gd")
const Codec := preload("../core/variant_codec.gd")

## Bumped when the request/reply format changes; the server checks it in "mcp:hello".
const PROTOCOL_VERSION: int = 1
## Name used for the autoload in override.cfg (the server and the plugin use the same).
const AUTOLOAD_NAME: String = "GodotMcpRuntime"

## Area modules. Each worker area adds its module here.
const MODULES: Array = [
	preload("ops/rt_core.gd"),
]

var _methods: Dictionary = {}
var _registered: bool = false


func _enter_tree() -> void:
	if not EngineDebugger.is_active():
		# No debugger attached: an ordinary run (or an exported game). Stay out of the way.
		set_process(false)
		return
	# Keep answering while the game's SceneTree is paused (get_tree().paused = true).
	process_mode = Node.PROCESS_MODE_ALWAYS
	for m: Variant in MODULES:
		_methods.merge((m as GDScript).call("methods"), true)
	EngineDebugger.register_message_capture("mcp", _on_message)
	_registered = true


func _ready() -> void:
	if not _registered:
		return
	# Deferred so the main scene is in the tree and other autoloads have run _ready().
	_send_hello.call_deferred()


func _exit_tree() -> void:
	if _registered and EngineDebugger.has_capture("mcp"):
		EngineDebugger.unregister_message_capture("mcp")
	_registered = false


func _send_hello() -> void:
	var scene: Node = get_tree().current_scene
	_send("mcp:hello", {
		"protocol": PROTOCOL_VERSION,
		"godot_version": Engine.get_version_info().get("string", ""),
		"pid": OS.get_process_id(),
		"current_scene": scene.scene_file_path if scene != null else "",
		"display": DisplayServer.get_name(),
		"methods": _sorted_method_names(),
	})


## Sends an unsolicited event to the debugger host (and from there to the MCP server).
func send_event(event: String, data: Dictionary = {}) -> void:
	var payload: Dictionary = data.duplicate()
	payload["event"] = event
	_send("mcp:event", payload)


func _send(message: String, payload: Dictionary) -> void:
	if EngineDebugger.is_active():
		EngineDebugger.send_message(message, [Codec.to_json(payload)])


## Message capture callback. `message` arrives without the "mcp:" prefix.
func _on_message(message: String, data: Array) -> bool:
	if message != "request":
		return false
	if data.is_empty() or not data[0] is String:
		push_warning("Godot MCP runtime: malformed request %s" % [data])
		return true
	var req: Variant = JSON.parse_string(data[0])
	if not req is Dictionary:
		push_warning("Godot MCP runtime: request is not a JSON object")
		return true
	# Not awaited: a long method (waiting for a signal) must not block later requests.
	_handle(req as Dictionary)
	return true


func _handle(req: Dictionary) -> void:
	var id: Variant = req.get("id")
	var method: String = str(req.get("method", ""))
	var params: Variant = req.get("params", {})
	if params == null:
		params = {}
	var reply: Dictionary
	if not _methods.has(method):
		reply = R.err(R.UNKNOWN_METHOD, "The game runtime has no method '%s'. Available: %s." % [method, ", ".join(_sorted_method_names())])
	elif not params is Dictionary:
		reply = R.err(R.BAD_PARAMS, "%s: params must be an object." % method)
	else:
		var fn: Callable = (_methods[method] as Dictionary)["fn"]
		var out: Variant = await fn.call(self, params)
		if out is Dictionary and ((out as Dictionary).has("result") or (out as Dictionary).has("error")):
			reply = out
		else:
			reply = R.err(R.INTERNAL, "%s returned an unexpected value (runtime bug)." % method)
	reply["id"] = id
	_send("mcp:reply", reply)


func _sorted_method_names() -> Array:
	var names: Array = _methods.keys()
	names.sort()
	return names


# ---------------------------------------------------------------------------------------
# Helpers for runtime modules
# ---------------------------------------------------------------------------------------

## The node node paths are relative to: the current scene if there is one, else the root.
func scene_root() -> Node:
	var scene: Node = get_tree().current_scene
	return scene if scene != null else get_tree().root


## Resolves a node path from the agent. Accepts paths relative to the current scene
## ("Player/Sprite2D", "." for the scene itself) and absolute ones ("/root/Main/Player",
## "/root/SomeAutoload"). Returns {"value": Node} or an error listing close matches.
func find_node(path: String) -> Dictionary:
	var root: Node = scene_root()
	var p: String = path.strip_edges()
	var node: Node = null
	if p == "" or p == ".":
		node = root
	elif p.begins_with("/"):
		node = get_tree().root.get_node_or_null(NodePath(p))
	else:
		node = root.get_node_or_null(NodePath(p))
		if node == null:
			# Also accept a path relative to /root (autoloads: "GameState").
			node = get_tree().root.get_node_or_null(NodePath(p))
	if node == null:
		return R.err(R.NOT_FOUND, "No node at '%s' in the running game (paths are relative to the current scene '%s', or absolute like /root/Name). Use godot_game_tree to list nodes." % [path, root.name])
	return R.value(node)


## Path of `node` as the agent should write it: relative to the current scene when inside
## it, otherwise absolute (/root/...).
func path_of(node: Node) -> String:
	var root: Node = scene_root()
	if node == root:
		return "."
	if root.is_ancestor_of(node):
		return str(root.get_path_to(node))
	return str(node.get_path())


## JSON-safe encoding of a value from the game (nodes become paths relative to the scene).
func encode(v: Variant) -> Variant:
	return Codec.encode(v, scene_root())
