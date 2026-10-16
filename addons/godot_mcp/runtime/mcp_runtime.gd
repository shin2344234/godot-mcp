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
	preload("ops/rt_live.gd"),
	preload("ops/rt_input.gd"),
	preload("ops/rt_view.gd"),
	preload("ops/rt_output.gd"),
]

## Captures the game's output for runs started from the editor (rt.output; see the file).
const Output := preload("ops/rt_output.gd")

var _methods: Dictionary = {}
var _registered: bool = false

## Methods whose replies say when the current scene was replaced since the previous one of
## them (`scene_changed`, see _scene_hint). These are the calls an agent chains on the
## current scene ("read the player, then set it, then click"). Server-internal calls
## (time.state, time.step_wait, rt.output polling for godot_run_output) are left out so
## they can't swallow the hint before the agent sees it.
const SCENE_TRACKED: Array[String] = ["game.tree", "game.get", "game.edit", "game.eval", "input.run", "time.wait_for", "game.screenshot"]
## Instance id of the current scene at the end of the last SCENE_TRACKED request (0 = none yet).
var _seen_scene_id: int = 0


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
	Output.install()


func _ready() -> void:
	if not _registered:
		return
	# Deferred so the main scene is in the tree and other autoloads have run _ready().
	_send_hello.call_deferred()


func _exit_tree() -> void:
	if _registered and EngineDebugger.has_capture("mcp"):
		EngineDebugger.unregister_message_capture("mcp")
	if _registered:
		Output.uninstall()
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
		if method in SCENE_TRACKED:
			_scene_hint(reply)
	reply["id"] = id
	_send("mcp:reply", reply)


## Adds `scene_changed: "<scene file>"` to a reply when the current scene is a different
## instance than at the end of the previous tracked request. A game that reloads its level
## by itself (game over, "Play again") otherwise gave no sign of it: a game.edit set or call
## then silently changed the NEW scene's nodes, and an agent teleported a player into a fresh
## level without noticing. Instance ids change on every reload, also when the file is the
## same. Checked when the request ENDS, so a change made by this very request (a click on a
## "Restart" button, game.edit change_scene) is reported too. On an error the hint goes
## into the message, where it explains a NOT_FOUND for a node of the old scene.
func _scene_hint(reply: Dictionary) -> void:
	var scene: Node = get_tree().current_scene
	# No current scene: a scene change is in progress (change_scene_to_* frees the old scene
	# first and adds the new one at the end of the frame). Keep the old id, so the next call,
	# which sees the new scene, reports it.
	if scene == null:
		return
	var now: int = scene.get_instance_id()
	var before: int = _seen_scene_id
	_seen_scene_id = now
	if before == 0 or now == before:
		return
	var label: String = scene.scene_file_path if not scene.scene_file_path.is_empty() else String(scene.name)
	if reply.get("result") is Dictionary:
		(reply["result"] as Dictionary)["scene_changed"] = label
	elif reply.get("error") is Dictionary:
		var e: Dictionary = reply["error"]
		e["message"] = str(e.get("message", "")) + " Note: the current scene was replaced since your previous game call (now '%s')." % label


## Names and values of the globals an Expression should see, for Expression.parse/execute.
## Godot's Expression only resolves its inputs, `self`'s members and built-ins (PI,
## Vector2(), abs()...): `GameState.lives` failed with "Invalid named index 'GameState'",
## although GDScript (and godot_debug_control evaluate, which runs in a GDScript frame)
## sees autoloads and engine singletons by name. So every autoload (ProjectSettings
## "autoload/<Name>", looked up as /root/<Name>) and engine singleton (Input, Engine, OS,
## Time...: Engine.get_singleton_list()) whose name appears in `code` as a word is passed as
## an input. Only names that occur are passed, so a node property that happens to share a
## name with an unused singleton is never shadowed. `explicit` (the caller's own inputs)
## wins over both. Returns [PackedStringArray names, Array values].
func expression_globals(code: String, explicit: Dictionary) -> Array:
	var names := PackedStringArray()
	var values: Array = []
	for k: Variant in explicit:
		names.append(str(k))
		values.append(explicit[k])
	var candidates: Dictionary = {}
	for p: Dictionary in ProjectSettings.get_property_list():
		var key: String = p["name"]
		if key.begins_with("autoload/"):
			var autoload: String = key.trim_prefix("autoload/")
			if autoload != AUTOLOAD_NAME:
				candidates[autoload] = true
	for s: StringName in Engine.get_singleton_list():
		candidates[String(s)] = false
	for cand: String in candidates:
		if names.has(cand) or not _mentions(code, cand):
			continue
		var value: Object = null
		if candidates[cand]:
			value = get_tree().root.get_node_or_null(NodePath(cand))
		elif Engine.has_singleton(cand):
			value = Engine.get_singleton(cand)
		if value != null:
			names.append(cand)
			values.append(value)
	return [names, values]


## True when `word` occurs in `code` as an identifier (not inside a longer name).
static func _mentions(code: String, word: String) -> bool:
	var from: int = 0
	while from < code.length():
		var at: int = code.find(word, from)
		if at < 0:
			return false
		var before_ok: bool = at == 0 or not _ident_char(code.unicode_at(at - 1))
		var end: int = at + word.length()
		var after_ok: bool = end >= code.length() or not _ident_char(code.unicode_at(end))
		if before_ok and after_ok:
			return true
		from = at + 1
	return false


static func _ident_char(c: int) -> bool:
	return c == 95 or (c >= 48 and c <= 57) or (c >= 65 and c <= 90) or (c >= 97 and c <= 122)


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
