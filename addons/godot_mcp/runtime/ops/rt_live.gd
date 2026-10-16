extends RefCounted
## Runtime methods: live inspection, live changes and opt-in code eval.
##
##   game.tree  the running game's node tree as a flat list, with filters (name, class,
##              group, visible text) so the agent can find e.g. the button to click
##   game.get   current property values of one live node (+ signals, script methods)
##   game.edit  a list of live changes applied in order: set / call / spawn / remove /
##              change_scene
##   game.eval  evaluate an Expression or a small GDScript snippet in the game (the MCP
##              server only sends this when the user started it with --allow-eval)
##
## See runtime/mcp_runtime.gd for the method contract and the helpers used on `rt`
## (find_node, path_of, encode, scene_root) and docs/methods/live-game.md for the params.
##
## A rule for everything in this file: never cause a GDScript runtime error. In a game
## started from the editor, a script error stops the game in the editor's debugger
## (the editor does not ignore error breaks), so every lookup is validated first and
## problems are returned as {"error": ...} results instead.

const R := preload("../../core/mcp_result.gd")
const Codec := preload("../../core/variant_codec.gd")
const Params := preload("../../core/params.gd")
const Fuzzy := preload("../../core/fuzzy.gd")

## game.tree: default and hard maximum number of listed nodes.
const TREE_DEFAULT_MAX: int = 150
const TREE_HARD_MAX: int = 2000
## Visible text is cut to this many characters in game.tree (filters see the full text).
const TEXT_MAX: int = 60
## How long one game.edit / game.eval request may wait in total for coroutines (methods
## using `await`) and scene changes before it answers anyway. The server waits a bit longer.
const AWAIT_BUDGET_S: int = 10
const AWAIT_BUDGET_MS: int = AWAIT_BUDGET_S * 1000
## Caps on what game.eval reports from the log.
const OUTPUT_MAX_LINES: int = 50
const OUTPUT_MAX_CHARS: int = 4000
## Usage flags that mark inspector grouping entries rather than real properties.
const _GROUPING_USAGE: int = PROPERTY_USAGE_GROUP | PROPERTY_USAGE_SUBGROUP | PROPERTY_USAGE_CATEGORY
## Lines the wrapper puts before a gdscript-mode snippet body (extends, blank, func run).
const _WRAPPER_LINES: int = 3
## Value types whose components ("position:x", "modulate:a") can be read and set.
const _COMPONENT_TYPES: Array[int] = [
	TYPE_VECTOR2, TYPE_VECTOR2I, TYPE_VECTOR3, TYPE_VECTOR3I, TYPE_VECTOR4, TYPE_VECTOR4I,
	TYPE_COLOR, TYPE_QUATERNION, TYPE_RECT2, TYPE_RECT2I, TYPE_TRANSFORM2D, TYPE_TRANSFORM3D,
	TYPE_BASIS, TYPE_PLANE, TYPE_AABB, TYPE_DICTIONARY,
]


## Collects what the engine logs while game.eval runs (prints, errors, warnings).
## Godot calls Logger methods from any thread, possibly at the same time, hence the Mutex
## (Logger docs, 4.7). It must not print itself (that would recurse).
class LogCapture extends Logger:
	var messages: PackedStringArray = []
	## Each entry: {"type": Logger.ErrorType int, "message", "file", "line"}.
	var errors: Array[Dictionary] = []
	var _mutex: Mutex = Mutex.new()

	func _log_message(message: String, _error: bool) -> void:
		_mutex.lock()
		if messages.size() < OUTPUT_MAX_LINES:
			messages.append(message.trim_suffix("\n"))
		_mutex.unlock()

	func _log_error(_function: String, file: String, line: int, code: String, rationale: String,
			_editor_notify: bool, error_type: int, _script_backtraces: Array[ScriptBacktrace]) -> void:
		_mutex.lock()
		if errors.size() < OUTPUT_MAX_LINES:
			# `code` is the failed condition or the script error text; `rationale` the
			# explanation of an engine error macro (empty for script errors).
			var text: String = rationale if not rationale.is_empty() else code
			errors.append({"type": error_type, "message": text, "file": file, "line": line})
		_mutex.unlock()


static func methods() -> Dictionary:
	return {
		"game.tree": {"fn": tree},
		"game.get": {"fn": get_node_info},
		"game.edit": {"fn": edit},
		"game.eval": {"fn": eval_code},
	}


# ---------------------------------------------------------------------------------------
# game.tree
# ---------------------------------------------------------------------------------------

## Flat, pre-order list of live nodes under `root`. With any filter (name, class, group,
## text) only matching nodes are listed, but the whole subtree is searched.
static func tree(rt: Node, params: Dictionary) -> Dictionary:
	var p := Params.new(params, "game.tree")
	var root_path: String = p.opt_string("root", ".")
	var depth: int = p.opt_int("depth", -1)
	var max_nodes: int = p.opt_int("max_nodes", TREE_DEFAULT_MAX)
	var name_f: String = p.opt_string("name", "").to_lower()
	var class_f: String = p.opt_string("class", "")
	var group_f: String = p.opt_string("group", "")
	var text_f: String = p.opt_string("text", "").to_lower()
	if p.failed():
		return p.error
	if max_nodes < 1 or max_nodes > TREE_HARD_MAX:
		return R.err(R.BAD_PARAMS, "game.tree: 'max_nodes' must be 1..%d (default %d)." % [TREE_HARD_MAX, TREE_DEFAULT_MAX])
	if not class_f.is_empty() and not _class_known(class_f):
		var names: Array = Array(ClassDB.get_inheriters_from_class("Node"))
		for entry: Dictionary in ProjectSettings.get_global_class_list():
			names.append(str(entry.get("class", "")))
		return R.err(R.BAD_PARAMS, "game.tree: unknown class '%s'.%s Use a Godot class like \"Button\" or a script class_name." %
			[class_f, Fuzzy.did_you_mean(Fuzzy.suggest(class_f, names, 5))])
	var found: Dictionary = rt.find_node(root_path)
	if R.is_err(found):
		return found
	var start: Node = found["value"]
	var filtering: bool = not (name_f.is_empty() and class_f.is_empty() and group_f.is_empty() and text_f.is_empty())

	var nodes: Array = []
	var total: int = 0
	# Explicit stack instead of recursion: live trees can be deep. Children are pushed in
	# reverse so they come out in scene order.
	var stack: Array = [[start, 0]]
	while not stack.is_empty():
		var item: Array = stack.pop_back()
		var node: Node = item[0]
		var level: int = item[1]
		# The runtime autoload is ours, not the game's: keep it out of listings.
		if node == rt:
			continue
		# Visible text is only needed for the text filter or for an entry still to be listed.
		var text: String = _visible_text(node) if (not text_f.is_empty() or nodes.size() < max_nodes) else ""
		var matches: bool = true
		if filtering:
			matches = (name_f.is_empty() or String(node.name).to_lower().contains(name_f)) \
				and (class_f.is_empty() or _is_kind(node, class_f)) \
				and (group_f.is_empty() or node.is_in_group(group_f)) \
				and (text_f.is_empty() or text.to_lower().contains(text_f))
		if matches:
			total += 1
			if nodes.size() < max_nodes:
				nodes.append(_summary(rt, node, text))
		if depth >= 0 and level >= depth:
			continue
		var children: Array[Node] = node.get_children()
		for i: int in range(children.size() - 1, -1, -1):
			stack.append([children[i], level + 1])

	var result: Dictionary = {
		"root": rt.path_of(start),
		"nodes": nodes,
		"count": nodes.size(),
		"truncated": total > nodes.size(),
	}
	if total > nodes.size():
		result["total"] = total
		result["hint"] = "Only the first %d of %d nodes are listed. Narrow with root, depth or filters (name, class, group, text), or raise max_nodes." % [nodes.size(), total]
	return R.ok(result)


## One game.tree entry, kept small: path, class, child count, script, and only the
## spatial/visibility facts that help locate the node (rect for Controls, global
## position for 2D/3D nodes, hidden when not visible in the tree, visible text).
static func _summary(rt: Node, node: Node, text: String) -> Dictionary:
	var path: String = rt.path_of(node)
	var e: Dictionary = {"path": path, "class": node.get_class()}
	# The path already ends with the name, except for the scene root ".".
	if path == "." or path == "/root":
		e["name"] = String(node.name)
	var kids: int = node.get_child_count()
	if kids > 0:
		e["children"] = kids
	var script: Script = node.get_script() as Script
	if script != null:
		e["script"] = script.resource_path if not script.resource_path.is_empty() else "<built-in>"
	if node is CanvasItem:
		if not (node as CanvasItem).is_visible_in_tree():
			e["hidden"] = true
		if node is Control:
			var r: Rect2 = (node as Control).get_global_rect()
			e["rect"] = "Rect2(%s)" % _nums([r.position.x, r.position.y, r.size.x, r.size.y])
		elif node is Node2D:
			var gp: Vector2 = (node as Node2D).global_position
			e["pos"] = "Vector2(%s)" % _nums([gp.x, gp.y])
	elif node is Node3D:
		var n3: Node3D = node
		if not n3.is_visible_in_tree():
			e["hidden"] = true
		var gp3: Vector3 = n3.global_position
		e["pos"] = "Vector3(%s)" % _nums([gp3.x, gp3.y, gp3.z])
	if not text.is_empty():
		e["text"] = text if text.length() <= TEXT_MAX else text.left(TEXT_MAX - 1) + "…"
	return e


## "10, 20.5": numbers rounded to 0.1, whole ones without ".0". Used inside the
## "Vector2(...)"/"Rect2(...)" strings of the protocol's value conventions, which read
## better and cost fewer tokens than JSON arrays.
static func _nums(values: Array) -> String:
	var parts: PackedStringArray = []
	for v: float in values:
		var s: float = snappedf(v, 0.1)
		parts.append(str(int(s)) if s == floorf(s) and absf(s) < 1e9 else str(s))
	return ", ".join(parts)


## The text a player sees on a UI node (empty for nodes that show no text).
## RichTextLabel: the text without BBCode tags. LineEdit/TextEdit: the placeholder when empty.
static func _visible_text(node: Node) -> String:
	if node is RichTextLabel:
		return (node as RichTextLabel).get_parsed_text()
	if node is LineEdit:
		var le: LineEdit = node
		return le.text if not le.text.is_empty() else le.placeholder_text
	if node is TextEdit:
		var te: TextEdit = node
		return te.text if not te.text.is_empty() else te.placeholder_text
	if node is Label or node is Button or node is LinkButton or node is Label3D:
		return str(node.get("text"))
	return ""


## True for a native class (ClassDB) or a global script class (class_name).
static func _class_known(cls: String) -> bool:
	if ClassDB.class_exists(cls):
		return true
	for entry: Dictionary in ProjectSettings.get_global_class_list():
		if str(entry.get("class", "")) == cls:
			return true
	return false


## is_class() for native classes, plus script class_name inheritance (a script that
## extends a script with that class_name also matches).
static func _is_kind(node: Node, cls: String) -> bool:
	if node.is_class(cls):
		return true
	var script: Script = node.get_script() as Script
	while script != null:
		if String(script.get_global_name()) == cls:
			return true
		script = script.get_base_script()
	return false


# ---------------------------------------------------------------------------------------
# game.get
# ---------------------------------------------------------------------------------------

## Current values of one live node: all script/inspector-visible properties (or the
## requested ones, nested "a:b" paths allowed), plus signals and script methods on request.
static func get_node_info(rt: Node, params: Dictionary) -> Dictionary:
	var p := Params.new(params, "game.get")
	var path: String = p.opt_string("path", ".")
	var wanted: Array = p.opt_array("properties", [])
	var want_signals: bool = p.opt_bool("signals", false)
	var want_methods: bool = p.opt_bool("methods", false)
	if p.failed():
		return p.error
	var found: Dictionary = rt.find_node(path)
	if R.is_err(found):
		return found
	var node: Node = found["value"]
	var info: Dictionary = {"path": rt.path_of(node), "class": node.get_class()}
	var script: Script = node.get_script() as Script
	if script != null:
		info["script"] = script.resource_path if not script.resource_path.is_empty() else "<built-in>"
		if not String(script.get_global_name()).is_empty():
			info["script_class"] = String(script.get_global_name())
	var props: Dictionary = {}
	var everything: bool = wanted.size() == 1 and str(wanted[0]) == "*"
	if p.has("properties") and not everything:
		for w: Variant in wanted:
			var wname: String = str(w).strip_edges()
			var r: Dictionary = _call_getter(rt, node, wname) if wname.ends_with("()") else _read_path(rt, node, wname)
			if R.is_err(r):
				return r
			props[str(w)] = rt.encode(r["value"])
	else:
		# Script variables are always listed (even without @export, and their "_private"
		# ones: that is what you debug). Engine properties are listed when they differ from
		# the class default, unless ["*"] asked for everything: a Control alone has ~100
		# inspector properties, mostly defaults.
		var omitted: int = 0
		for pinfo: Dictionary in node.get_property_list():
			var usage: int = pinfo["usage"]
			if (usage & _GROUPING_USAGE) != 0:
				continue
			var script_var: bool = (usage & PROPERTY_USAGE_SCRIPT_VARIABLE) != 0
			if not script_var and (usage & (PROPERTY_USAGE_STORAGE | PROPERTY_USAGE_EDITOR)) == 0:
				continue
			var pname: String = pinfo["name"]
			if pname == "script" or (pname.begins_with("_") and not script_var):
				continue
			var v: Variant = node.get(pname)
			if not script_var and not everything and _is_class_default(node, pname, v):
				omitted += 1
				continue
			props[pname] = rt.encode(v)
		if omitted > 0:
			info["defaults_omitted"] = omitted
	info["properties"] = props
	var groups: Array[String] = []
	for g: StringName in node.get_groups():
		# "_"-prefixed groups are Godot's internal ones (Node.get_groups docs).
		if not String(g).begins_with("_"):
			groups.append(String(g))
	if not groups.is_empty():
		info["groups"] = groups
	info["child_count"] = node.get_child_count()
	if want_signals:
		info["signals"] = _signals(rt, node)
	if want_methods:
		info["methods"] = _script_methods(node)
	return R.ok(info)


## True when `v` equals the engine default of property `pname` for the node's class.
static func _is_class_default(node: Node, pname: String, v: Variant) -> bool:
	var default: Variant = ClassDB.class_get_property_default_value(node.get_class(), pname)
	if default == null:
		return v == null
	return typeof(v) == typeof(default) and v == default


## Prefixes that mark a non-const method as a getter (script methods are never flagged
## const, so `get_health()` in a script is only recognised by its name).
const GETTER_PREFIXES: Array[String] = ["get_", "is_", "has_", "can_"]


## Reads a derived value through an argument-less getter: "get_screen_center_position()",
## "is_playing()". Values like these exist only as methods, and reading them needed
## godot_game_eval (off by default). To keep game.get read-only in spirit, only methods
## that need no arguments and are either const in the engine (METHOD_FLAG_CONST: Camera2D,
## AnimationPlayer... getters) or named like a getter (get_/is_/has_/can_, which covers
## script methods) are called. A coroutine's result is not awaited (encoded as is).
static func _call_getter(rt: Node, node: Node, entry: String) -> Dictionary:
	var mname: String = entry.trim_suffix("()").strip_edges()
	var info: Dictionary = {}
	for m: Dictionary in node.get_method_list():
		if m["name"] == mname:
			info = m
			break
	if info.is_empty():
		return R.err(R.NOT_FOUND, "Node '%s' (%s) has no method '%s'.%s" % [rt.path_of(node), node.get_class(), mname, _similar_methods(node, mname)])
	var required: int = (info["args"] as Array).size() - (info["default_args"] as Array).size()
	if required > 0:
		return R.err(R.BAD_PARAMS, "'%s()' needs %d argument(s), so game.get can't call it. Use godot_game_edit {action: \"call\", method: \"%s\", args: [...]}." % [mname, required, mname])
	var is_const: bool = (int(info["flags"]) & METHOD_FLAG_CONST) != 0
	var getter_name: bool = GETTER_PREFIXES.any(func(pre: String) -> bool: return mname.begins_with(pre))
	if not is_const and not getter_name:
		return R.err(R.BAD_PARAMS, "'%s()' is not a getter (not const, and not named get_/is_/has_/can_), and game.get only reads. To run it, use godot_game_edit {action: \"call\", method: \"%s\"}." % [mname, mname])
	return R.value(node.call(mname))


static func _similar_methods(node: Node, mname: String) -> String:
	var names: Array[String] = []
	for m: Dictionary in node.get_method_list():
		var n: String = m["name"]
		if not n.begins_with("_") and not names.has(n):
			names.append(n)
	var similar: Array[String] = Fuzzy.suggest(mname, names, 8)
	return (" Similar methods: %s." % ", ".join(similar)) if not similar.is_empty() else ""


## Reads a property or a nested path ("material:albedo_color", "position:x") without
## risking a runtime error. Returns {"value": v} or an error naming valid names.
static func _read_path(rt: Node, node: Node, pname: String) -> Dictionary:
	var parts: PackedStringArray = pname.split(":", false)
	if parts.is_empty():
		return R.err(R.BAD_PARAMS, "game.get: empty property name. Omit 'properties' to list all of them.")
	var obj: Object = node
	var walked: String = ""
	for i: int in parts.size():
		var part: String = parts[i]
		if Codec.find_property(obj, part).is_empty():
			var e: Dictionary = Codec.unknown_property_error(obj, part, _label(rt, node, obj, walked))
			# The codec's generic advice names the editor tool; in a running game, say what
			# works here, and point out argument-less getters (the agent asked for
			# "is_playing", a method, and only learned that it wasn't a property).
			var err: Dictionary = e["error"]
			var msg: String = str(err["message"]).replace(" Use node.get to list all properties and their current values.", "")
			if i == 0 and obj.has_method(part):
				msg += " '%s' is a method: write \"%s()\" to read what it returns (argument-less getters only)." % [part, part]
			else:
				msg += " Omit 'properties' to list them; derived values can be read with argument-less getters, e.g. \"get_screen_center_position()\"."
			err["message"] = msg
			return e
		var v: Variant = obj.get(part)
		walked = part if walked.is_empty() else walked + ":" + part
		if i == parts.size() - 1:
			return R.value(v)
		if v is Object and is_instance_valid(v):
			obj = v
			continue
		# The rest of the path goes into a built-in value (Vector2, Color, Dictionary...).
		# Object.get_indexed() returns null for an invalid component (and logs nothing).
		var got: Variant = node.get_indexed(NodePath(pname))
		if got == null:
			return R.err(R.NOT_FOUND, "'%s' is a %s; '%s' is not one of its components (e.g. x/y/z for vectors, r/g/b/a for colors)." %
				[walked, type_string(typeof(v)), ":".join(parts.slice(i + 1))])
		return R.value(got)
	return R.err(R.INTERNAL, "unreachable")


static func _label(rt: Node, node: Node, obj: Object, walked: String) -> String:
	if obj == node:
		return "Node '%s' (%s)" % [rt.path_of(node), node.get_class()]
	return "'%s' (%s)" % [walked, obj.get_class()]


## Signals of the node with their live connections, as {"signature": [{"to", "method"}]}.
## Script signals are always listed; built-in signals only when something is connected.
static func _signals(rt: Node, node: Node) -> Dictionary:
	var out: Dictionary = {}
	var script_signals: Dictionary = {}
	var script: Script = node.get_script() as Script
	if script != null:
		for s: Dictionary in script.get_script_signal_list():
			script_signals[str(s["name"])] = true
	for sig: Dictionary in node.get_signal_list():
		var sname: String = str(sig["name"])
		var conns: Array = []
		for conn: Dictionary in node.get_signal_connection_list(sname):
			var callable: Callable = conn["callable"]
			var target: Object = callable.get_object()
			var to: String = "?"
			if target is Node:
				to = rt.path_of(target as Node)
			elif target != null:
				to = target.get_class()
			var method: String = String(callable.get_method()) if not callable.is_custom() else str(callable)
			# Engine-internal connections (C++ method pointers print as "Class::method")
			# are noise for the agent; lambdas and script methods are kept.
			if method.contains("::"):
				continue
			conns.append({"to": to, "method": method})
		if conns.is_empty() and not script_signals.has(sname):
			continue
		out["%s(%s)" % [sname, _arg_list(sig.get("args", []))]] = conns
	return out


## Script methods (including inherited script methods) as "name(arg: Type) -> Type".
static func _script_methods(node: Node) -> Array[String]:
	var out: Array[String] = []
	var script: Script = node.get_script() as Script
	if script == null:
		return out
	var seen: Dictionary = {}
	for m: Dictionary in script.get_script_method_list():
		var mname: String = str(m["name"])
		# "@"-names are compiler-generated (implicit initializers, lambdas).
		if mname.begins_with("@") or seen.has(mname):
			continue
		seen[mname] = true
		var sig: String = "%s(%s)" % [mname, _arg_list(m.get("args", []))]
		var ret: String = _type_name(m.get("return", {}))
		if not ret.is_empty():
			sig += " -> " + ret
		out.append(sig)
	return out


static func _arg_list(args: Array) -> String:
	var parts: PackedStringArray = []
	for a: Dictionary in args:
		var t: String = _type_name(a)
		parts.append(str(a.get("name", "")) + (": " + t if not t.is_empty() else ""))
	return ", ".join(parts)


## Readable type of a property/argument info dictionary ("" for untyped).
static func _type_name(info: Dictionary) -> String:
	var t: int = info.get("type", TYPE_NIL)
	if t == TYPE_NIL:
		# Untyped (Variant) arguments and void/untyped returns: nothing to show.
		return ""
	if t == TYPE_OBJECT and not str(info.get("class_name", "")).is_empty():
		return str(info["class_name"])
	return type_string(t)


# ---------------------------------------------------------------------------------------
# game.edit
# ---------------------------------------------------------------------------------------

## Applies `ops` in order and stops at the first failure. Nothing is rolled back: a live
## game has no undo history, and earlier ops may already have had effects (signals,
## _ready, physics), so the error says which ops were applied.
static func edit(rt: Node, params: Dictionary) -> Dictionary:
	var p := Params.new(params, "game.edit")
	var ops: Array = p.opt_array("ops", [])
	if p.failed():
		return p.error
	if ops.is_empty():
		return R.err(R.BAD_PARAMS, "game.edit: 'ops' must be a non-empty array, e.g. [{\"action\": \"set\", \"path\": \"Player\", \"properties\": {\"position\": [100, 50]}}].")
	var deadline: int = Time.get_ticks_msec() + AWAIT_BUDGET_MS
	var results: Array = []
	for i: int in ops.size():
		var op: Variant = ops[i]
		var r: Dictionary
		if not op is Dictionary:
			r = R.err(R.BAD_PARAMS, "each op must be an object with an 'action'.")
		else:
			r = await _apply_op(rt, op as Dictionary, deadline)
		if R.is_err(r):
			var e: Dictionary = r["error"]
			var action: String = str((op as Dictionary).get("action", "?")) if op is Dictionary else "?"
			var msg: String = "ops[%d] (%s) failed: %s" % [i, action, e.get("message", "")]
			if i > 0:
				msg += " ops[0..%d] were applied and stay applied (a live game has no undo)." % (i - 1)
			var data: Dictionary = {"failed_index": i, "results": results}
			if e.has("data"):
				data["detail"] = e["data"]
			return R.err(str(e.get("code", R.INTERNAL)), msg, data)
		results.append(r["value"])
	return R.ok({"results": results})


static func _apply_op(rt: Node, op: Dictionary, deadline: int) -> Dictionary:
	var action: String = str(op.get("action", ""))
	match action:
		"set":
			return _op_set(rt, op)
		"call":
			return await _op_call(rt, op, deadline)
		"spawn":
			return _op_spawn(rt, op)
		"remove":
			return _op_remove(rt, op)
		"change_scene":
			return await _op_change_scene(rt, op, deadline)
	return R.err(R.BAD_PARAMS, "unknown action '%s'. Valid actions: set, call, spawn, remove, change_scene." % action)


## set {path, properties}: type-directed decoding like node.set (JSON [10, 20] becomes a
## Vector2 for a Vector2 property), nested "prop:sub" paths, all-or-nothing per op.
static func _op_set(rt: Node, op: Dictionary) -> Dictionary:
	var found: Dictionary = rt.find_node(str(op.get("path", ".")))
	if R.is_err(found):
		return found
	var node: Node = found["value"]
	var props: Variant = op.get("properties")
	if not props is Dictionary or (props as Dictionary).is_empty():
		return R.err(R.BAD_PARAMS, "set needs 'properties', an object like {\"position\": [10, 20], \"modulate\": \"#ff0000\", \"material:albedo_color\": \"red\"}.")
	# Decode everything first so a bad value leaves the node untouched.
	var decoded: Dictionary = {}
	var warnings: Array[String] = []
	for key: Variant in props:
		var r: Dictionary = _decode_set(rt, node, str(key), (props as Dictionary)[key], warnings)
		if R.is_err(r):
			return r
		decoded[str(key)] = r["value"]
	var changed: Dictionary = {}
	for pname: String in decoded:
		var wanted: Variant = decoded[pname]
		if pname.contains(":"):
			node.set_indexed(NodePath(pname), wanted)
		else:
			node.set(pname, wanted)
		var now: Variant = node.get_indexed(NodePath(pname))
		changed[pname] = rt.encode(now)
		if Codec.read_back_differs(now, wanted):
			warnings.append("'%s' reads back as %s, not the requested value (Godot clamped or adjusted it, or a script setter changed it)." % [pname, JSON.stringify(changed[pname])])
	var out: Dictionary = {"action": "set", "path": rt.path_of(node), "changed": changed}
	if not warnings.is_empty():
		out["warnings"] = warnings
	return R.value(out)




## Decodes one value for `pname` on `node`: a property, or a nested path whose steps are
## sub-resources/objects and whose tail may be a component of a built-in value.
static func _decode_set(rt: Node, node: Node, pname: String, value: Variant, warnings: Array[String]) -> Dictionary:
	var parts: PackedStringArray = pname.split(":", false)
	if parts.is_empty():
		return R.err(R.BAD_PARAMS, "empty property name.")
	var obj: Object = node
	var walked: String = ""
	for i: int in parts.size():
		var part: String = parts[i]
		var info: Dictionary = Codec.find_property(obj, part)
		if info.is_empty():
			return Codec.unknown_property_error(obj, part, _label(rt, node, obj, walked))
		walked = part if walked.is_empty() else walked + ":" + part
		if i == parts.size() - 1:
			return _decode_value(rt, info, value, obj)
		var sub: Variant = obj.get(part)
		if sub is Object and is_instance_valid(sub):
			obj = sub
			if obj is Resource:
				var rpath: String = (obj as Resource).resource_path
				if not rpath.is_empty() and not rpath.contains("::"):
					# In the editor this would be refused; in a live game it is only memory,
					# but every user of the resource in the game sees the change.
					warnings.append("'%s' is the shared resource %s: the change applies to everything using it in the running game (not saved to the file)." % [walked, rpath])
			continue
		if sub == null:
			return R.err(R.BAD_PARAMS, "'%s' is empty (null), so '%s' can't be set. Set '%s' first, e.g. {\"%s\": {\"new\": \"<ResourceType>\"}}." % [walked, pname, walked, walked])
		if not typeof(sub) in _COMPONENT_TYPES:
			return R.err(R.BAD_PARAMS, "'%s' holds a %s, which has no sub-properties." % [walked, type_string(typeof(sub))])
		# The remaining path is inside a built-in value: decode by the component's current
		# type (a float for position:x, a Vector3 for transform:origin).
		var current: Variant = node.get_indexed(NodePath(pname))
		if current == null and typeof(sub) != TYPE_DICTIONARY:
			return R.err(R.NOT_FOUND, "'%s' is a %s; '%s' is not one of its components (e.g. x/y/z for vectors, r/g/b/a for colors)." %
				[walked, type_string(typeof(sub)), ":".join(parts.slice(i + 1))])
		return Codec.decode_typed(value, {"name": pname, "type": typeof(current)}, rt.scene_root())
	return R.err(R.INTERNAL, "unreachable")


## Type-directed decode of one value for a property or method argument (`info` from
## get_property_list / get_method_list). Node references accept any live path through
## rt.find_node (including autoloads under /root), as "Path" for Node-typed targets or
## {"node": "Path"} anywhere; everything else goes through the addon codec.
static func _decode_value(rt: Node, info: Dictionary, value: Variant, obj: Object = null) -> Dictionary:
	var t: int = info.get("type", TYPE_NIL)
	var node_ref: String = ""
	var has_ref: bool = false
	if value is Dictionary and (value as Dictionary).size() == 1 and (value as Dictionary).has("node") and (t == TYPE_OBJECT or t == TYPE_NIL):
		node_ref = str(value["node"])
		has_ref = true
	elif value is String and t == TYPE_OBJECT and _wants_node(info):
		node_ref = value
		has_ref = true
	if has_ref:
		var found: Dictionary = rt.find_node(node_ref)
		if R.is_err(found):
			return found
		var n: Node = found["value"]
		var cls: String = _object_class(info)
		if not cls.is_empty() and not _is_kind(n, cls):
			return R.err(R.BAD_PARAMS, "'%s' expects a %s, but '%s' is a %s." % [info.get("name", "value"), cls, node_ref, n.get_class()])
		return R.value(n)
	return Codec.decode_typed(value, info, rt.scene_root(), obj)


## The class an Object-typed property/argument requires ("" when any object is fine).
static func _object_class(info: Dictionary) -> String:
	var cls: String = str(info.get("class_name", ""))
	if cls.is_empty() and int(info.get("hint", PROPERTY_HINT_NONE)) in [PROPERTY_HINT_NODE_TYPE, PROPERTY_HINT_RESOURCE_TYPE]:
		cls = str(info.get("hint_string", ""))
	# A comma list ("Texture2D,AnimatedTexture") can't be checked with one is_class().
	return "" if cls.contains(",") else cls


static func _wants_node(info: Dictionary) -> bool:
	if int(info.get("hint", PROPERTY_HINT_NONE)) == PROPERTY_HINT_NODE_TYPE:
		return true
	var cls: String = _object_class(info)
	if cls.is_empty():
		return false
	if ClassDB.class_exists(cls):
		return ClassDB.is_parent_class(cls, "Node")
	for entry: Dictionary in ProjectSettings.get_global_class_list():
		if str(entry.get("class", "")) == cls:
			return ClassDB.is_parent_class(str(entry.get("base", "")), "Node") or str(entry.get("base", "")) == "Node"
	return false


## call {path, method, args}: arguments are decoded by the method's declared argument
## types when known; the return value is encoded. A coroutine (a method that uses
## `await`) is awaited within the request's budget; if it hasn't finished by then the
## result says "pending" and the coroutine keeps running in the game.
static func _op_call(rt: Node, op: Dictionary, deadline: int) -> Dictionary:
	var found: Dictionary = rt.find_node(str(op.get("path", ".")))
	if R.is_err(found):
		return found
	var node: Node = found["value"]
	var method: String = str(op.get("method", ""))
	var raw_args: Variant = op.get("args", [])
	if raw_args == null:
		raw_args = []
	if not raw_args is Array:
		return R.err(R.BAD_PARAMS, "call: 'args' must be an array of JSON values, e.g. [\"hello\", 3].")
	if method.is_empty():
		return R.err(R.BAD_PARAMS, "call needs 'method', e.g. {\"action\": \"call\", \"path\": \"Player\", \"method\": \"jump\", \"args\": []}.")
	if not node.has_method(method):
		var names: Array = []
		for m: Dictionary in node.get_method_list():
			names.append(str(m["name"]))
		return R.err(R.NOT_FOUND, "Node '%s' (%s) has no method '%s'.%s List script methods with godot_game_get (methods: true)." %
			[rt.path_of(node), node.get_class(), method, Fuzzy.did_you_mean(Fuzzy.suggest(method, names, 5))])
	var args: Array = raw_args
	var minfo: Dictionary = {}
	for m: Dictionary in node.get_method_list():
		if str(m["name"]) == method:
			minfo = m
			break
	var decoded: Array = []
	if minfo.is_empty():
		# Callable but not listed (rare): no type information, decode untyped.
		for a: Variant in args:
			var r0: Dictionary = _decode_value(rt, {"type": TYPE_NIL}, a)
			if R.is_err(r0):
				return r0
			decoded.append(r0["value"])
	else:
		var arg_infos: Array = minfo.get("args", [])
		var n_defaults: int = (minfo.get("default_args", []) as Array).size()
		var vararg: bool = (int(minfo.get("flags", 0)) & METHOD_FLAG_VARARG) != 0
		var required: int = arg_infos.size() - n_defaults
		if args.size() < required or (args.size() > arg_infos.size() and not vararg):
			var count: String = str(required) if n_defaults == 0 else "%d to %d" % [required, arg_infos.size()]
			if vararg:
				count = "at least %d" % required
			return R.err(R.BAD_PARAMS, "%s(%s) takes %s argument(s), got %d." % [method, _arg_list(arg_infos), count, args.size()])
		for i: int in args.size():
			var info: Dictionary = arg_infos[i] if i < arg_infos.size() else {"type": TYPE_NIL}
			if not info.has("name") or str(info["name"]).is_empty():
				info = info.duplicate()
				info["name"] = "argument %d" % (i + 1)
			var r: Dictionary = _decode_value(rt, info, args[i])
			if R.is_err(r):
				var e: Dictionary = r["error"]
				return R.err(str(e["code"]), "%s(%s): %s" % [method, _arg_list(arg_infos), e["message"]], e.get("data"))
			decoded.append(r["value"])
	var ret: Variant = node.callv(method, decoded)
	var out: Dictionary = {"action": "call", "path": rt.path_of(node), "method": method}
	var awaited: Dictionary = await _await_result(rt, ret, deadline)
	if awaited["pending"]:
		out["pending"] = true
		out["note"] = "The method is a coroutine that had not finished within %d s; it keeps running in the game." % AWAIT_BUDGET_S
	else:
		out["return"] = rt.encode(awaited["value"])
	return R.value(out)


## If `ret` is a suspended GDScript coroutine (GDScriptFunctionState, what calling a
## function that hits `await` returns), waits for its `completed(result)` signal until
## `deadline`; otherwise returns `ret` as is. Waits frame by frame (SceneTree.process_frame
## is emitted even while the tree is paused), so other runtime requests keep running.
static func _await_result(rt: Node, ret: Variant, deadline: int) -> Dictionary:
	if not (ret is Object and is_instance_valid(ret) and (ret as Object).get_class() == "GDScriptFunctionState"):
		return {"pending": false, "value": ret}
	var state: Object = ret
	var box: Dictionary = {"done": false, "value": null}
	var on_done := func(result: Variant) -> void:
		box["done"] = true
		box["value"] = result
	state.connect("completed", on_done, CONNECT_ONE_SHOT)
	while not box["done"] and Time.get_ticks_msec() < deadline:
		await rt.get_tree().process_frame
	return {"pending": not box["done"], "value": box["value"]}


## spawn {class | scene, parent, name, properties}: properties are set before the node
## enters the tree (like a scene file), so _ready sees them.
static func _op_spawn(rt: Node, op: Dictionary) -> Dictionary:
	var found: Dictionary = rt.find_node(str(op.get("parent", ".")))
	if R.is_err(found):
		return found
	var parent: Node = found["value"]
	var cls: String = str(op.get("class", "")) if op.get("class") != null else ""
	var scene: String = str(op.get("scene", "")) if op.get("scene") != null else ""
	if cls.is_empty() == scene.is_empty():
		return R.err(R.BAD_PARAMS, "spawn needs exactly one of 'class' (e.g. \"Sprite2D\") or 'scene' (e.g. \"res://enemy.tscn\").")
	var node: Node = null
	if not scene.is_empty():
		var spath: String = _res_path(scene)
		if not ResourceLoader.exists(spath):
			return R.err(R.NOT_FOUND, "spawn: scene '%s' does not exist. Find scenes with godot_files_list or godot_scene_list." % spath)
		var packed: PackedScene = load(spath) as PackedScene
		if packed == null:
			return R.err(R.BAD_PARAMS, "spawn: '%s' is not a scene (PackedScene)." % spath)
		node = packed.instantiate()
		if node == null:
			return R.err(R.GODOT_ERROR, "spawn: instantiating '%s' failed (see godot_run_output for the engine error)." % spath)
	else:
		var made: Dictionary = Codec.instantiate_class(cls, "Node")
		if R.is_err(made):
			return made
		node = made["value"]
	var wanted_name: String = str(op.get("name", "")) if op.get("name") != null else ""
	if not wanted_name.is_empty():
		if wanted_name.validate_node_name() != wanted_name:
			node.free()
			return R.err(R.BAD_PARAMS, "spawn: invalid node name '%s' (no . : @ / \" %%)." % wanted_name)
		node.name = wanted_name
	var props: Variant = op.get("properties", {})
	if props == null:
		props = {}
	if not props is Dictionary:
		node.free()
		return R.err(R.BAD_PARAMS, "spawn: 'properties' must be an object.")
	var warnings: Array[String] = []
	for key: Variant in props:
		var r: Dictionary = _decode_set(rt, node, str(key), (props as Dictionary)[key], warnings)
		if R.is_err(r):
			node.free()
			return r
		if str(key).contains(":"):
			node.set_indexed(NodePath(str(key)), r["value"])
		else:
			node.set(str(key), r["value"])
	# force_readable_name: a clashing name becomes "Enemy2" rather than "@Enemy@123".
	parent.add_child(node, true)
	var out: Dictionary = {"action": "spawn", "path": rt.path_of(node), "class": node.get_class()}
	if not warnings.is_empty():
		out["warnings"] = warnings
	return R.value(out)


## remove {path}: takes the node out of the tree now (so later ops and game.tree no longer
## see it) and frees it at the end of the frame (queue_free).
static func _op_remove(rt: Node, op: Dictionary) -> Dictionary:
	if op.get("path") == null or str(op.get("path")).is_empty():
		return R.err(R.BAD_PARAMS, "remove needs 'path', the node to delete.")
	var found: Dictionary = rt.find_node(str(op["path"]))
	if R.is_err(found):
		return found
	var node: Node = found["value"]
	var tree_: SceneTree = rt.get_tree()
	if node == tree_.root or node == rt or node.is_ancestor_of(rt):
		return R.err(R.BAD_PARAMS, "remove: refusing to remove '%s' (the root window or the Godot MCP runtime)." % rt.path_of(node))
	if node == tree_.current_scene:
		return R.err(R.BAD_PARAMS, "remove: '%s' is the current scene. Use {\"action\": \"change_scene\", \"scene\": \"res://...\"} to replace it." % rt.path_of(node))
	var path: String = rt.path_of(node)
	node.get_parent().remove_child(node)
	node.queue_free()
	return R.value({"action": "remove", "removed": path})


## change_scene {scene?}: SceneTree.change_scene_to_file, or reload_current_scene without
## `scene`. Waits for SceneTree.scene_changed so later ops see the new scene.
static func _op_change_scene(rt: Node, op: Dictionary, deadline: int) -> Dictionary:
	var tree_: SceneTree = rt.get_tree()
	var scene: String = str(op.get("scene", "")) if op.get("scene") != null else ""
	var box: Dictionary = {"done": false}
	var on_changed := func() -> void:
		box["done"] = true
	var err: int
	if scene.is_empty():
		if tree_.current_scene == null:
			return R.err(R.NO_SCENE, "change_scene: there is no current scene to reload; pass 'scene', e.g. \"res://main.tscn\".")
		tree_.scene_changed.connect(on_changed, CONNECT_ONE_SHOT)
		err = tree_.reload_current_scene()
	else:
		var spath: String = _res_path(scene)
		if not ResourceLoader.exists(spath):
			return R.err(R.NOT_FOUND, "change_scene: scene '%s' does not exist. Find scenes with godot_files_list or godot_scene_list." % spath)
		tree_.scene_changed.connect(on_changed, CONNECT_ONE_SHOT)
		err = tree_.change_scene_to_file(spath)
	if err != OK:
		if tree_.scene_changed.is_connected(on_changed):
			tree_.scene_changed.disconnect(on_changed)
		return R.godot_err("change_scene", err)
	while not box["done"] and Time.get_ticks_msec() < deadline:
		await tree_.process_frame
	var current: Node = tree_.current_scene
	var out: Dictionary = {"action": "change_scene", "current_scene": current.scene_file_path if current != null else ""}
	if not box["done"]:
		out["note"] = "The scene change had not completed yet when the request answered."
	return R.value(out)


## "enemy.tscn" / "/enemy.tscn" -> "res://enemy.tscn"; res:// and uid:// stay as they are.
static func _res_path(p: String) -> String:
	if p.begins_with("res://") or p.begins_with("uid://"):
		return p
	return "res://" + p.trim_prefix("/")


# ---------------------------------------------------------------------------------------
# game.eval
# ---------------------------------------------------------------------------------------

## Evaluates code in the game. The MCP server refuses this method unless the user enabled
## eval (--allow-eval); the runtime trusts its debugger (the server or the editor).
##   mode "expression" (default): Godot's Expression class, with `self` = the node at
##     `path` and `inputs` as named variables. One expression, no statements.
##   mode "gdscript": the code is the body of `func run(node, tree, inputs)` in a
##     temporary script (or a whole script defining that function); use `return`.
## Prints and errors logged while it runs are returned ("output", "errors").
static func eval_code(rt: Node, params: Dictionary) -> Dictionary:
	var p := Params.new(params, "game.eval")
	var code: String = p.req_string("code")
	var mode: String = p.opt_string("mode", "expression")
	var path: String = p.opt_string("path", ".")
	var raw_inputs: Dictionary = p.opt_dict("inputs", {})
	if p.failed():
		return p.error
	if mode != "expression" and mode != "gdscript":
		return R.err(R.BAD_PARAMS, "game.eval: 'mode' must be \"expression\" or \"gdscript\".")
	var found: Dictionary = rt.find_node(path)
	if R.is_err(found):
		return found
	var node: Node = found["value"]
	var inputs: Dictionary = {}
	for key: Variant in raw_inputs:
		var r: Dictionary = _decode_value(rt, {"name": str(key), "type": TYPE_NIL}, raw_inputs[key])
		if R.is_err(r):
			return r
		inputs[str(key)] = r["value"]

	var capture := LogCapture.new()
	OS.add_logger(capture)
	var res: Dictionary
	if mode == "expression":
		res = await _eval_expression(rt, node, code, inputs)
	else:
		res = await _eval_gdscript(rt, node, code, inputs)
	OS.remove_logger(capture)
	return _eval_result(rt, res, capture)


static func _eval_expression(rt: Node, node: Node, code: String, inputs: Dictionary) -> Dictionary:
	var expr := Expression.new()
	# The caller's inputs plus every autoload / engine singleton the code names (GameState,
	# Input, Engine...), which an Expression can't see by itself (rt.expression_globals).
	var globals: Array = rt.expression_globals(code, inputs)
	var names: PackedStringArray = globals[0]
	if expr.parse(code, names) != OK:
		return R.err(R.BAD_PARAMS, ("Expression parse error: %s Expression mode takes ONE expression, e.g. " +
			"`get_node(\"Player\").position` or `score * 2` (self = the node at 'path'); use mode \"gdscript\" for statements.") % _sentence(expr.get_error_text()))
	var ret: Variant = expr.execute(globals[1], node, false)
	if expr.has_execute_failed():
		return R.err(R.GODOT_ERROR, "Expression failed: %s (self is %s %s; check method names and argument types with godot_game_get)." %
			[expr.get_error_text(), rt.path_of(node), node.get_class()])
	return await _await_result(rt, ret, Time.get_ticks_msec() + AWAIT_BUDGET_MS)


## Ensures a message ends with exactly one period (Expression errors sometimes have one).
static func _sentence(text: String) -> String:
	var t: String = text.strip_edges()
	return t if t.ends_with(".") else t + "."


static func _eval_gdscript(rt: Node, node: Node, code: String, inputs: Dictionary) -> Dictionary:
	var source: String
	var offset: int = 0
	var re := RegEx.create_from_string("(?m)^func\\s+run\\s*\\(")
	if re.search(code) != null:
		# A whole script: add `extends RefCounted` when it has no extends line.
		source = code
		if RegEx.create_from_string("(?m)^extends\\s").search(code) == null:
			source = "extends RefCounted\n" + code
			offset = 1
	else:
		# Indent the body with what the snippet itself uses for blocks (GDScript refuses a
		# mix of tabs and spaces): spaces if any line starts with one, else tabs.
		var indent: String = "    " if RegEx.create_from_string("(?m)^ ").search(code) != null else "\t"
		var body: PackedStringArray = []
		for line: String in code.split("\n"):
			body.append(indent + line)
		# The trailing `return null` keeps a body of only comments valid.
		source = "extends RefCounted\n\nfunc run(node, tree, inputs):\n" + "\n".join(body) + "\n" + indent + "return null\n"
		offset = _WRAPPER_LINES
	var script := GDScript.new()
	script.source_code = source
	# Compile on a worker thread: on the main thread a parse error makes GDScript call
	# debug_break_parse(), which (with a debugger attached and error breaks not ignored, as
	# in editor runs) stops the whole game in a break that cannot be continued
	# (modules/gdscript/gdscript_editor.cpp only breaks when called on the main thread).
	var thread := Thread.new()
	var err: int
	if thread.start(Callable(script, "reload")) == OK:
		while thread.is_alive():
			await rt.get_tree().process_frame
		err = thread.wait_to_finish()
	else:
		# No threads on this platform (e.g. a web build without thread support): compile
		# here; only a snippet that doesn't parse risks the editor break described above.
		err = script.reload()
	if err != OK:
		return {"compile_error": err, "script": script, "offset": offset}
	if not script.can_instantiate():
		return R.err(R.GODOT_ERROR, "The snippet compiled but cannot be instantiated.")
	var instance: Object = script.new()
	if not instance.has_method("run"):
		return R.err(R.BAD_PARAMS, "The script defines no `func run(node, tree, inputs)`.")
	# Pass only as many arguments as run() declares (a full script may use fewer).
	var n_args: int = 3
	for m: Dictionary in script.get_script_method_list():
		if str(m["name"]) == "run":
			n_args = mini((m.get("args", []) as Array).size(), 3)
	var all_args: Array = [node, rt.get_tree(), inputs]
	var ret: Variant = instance.callv("run", all_args.slice(0, n_args))
	var awaited: Dictionary = await _await_result(rt, ret, Time.get_ticks_msec() + AWAIT_BUDGET_MS)
	awaited["script"] = script
	awaited["offset"] = offset
	return awaited


## Builds the game.eval reply from the evaluation outcome and what was logged meanwhile.
## Script errors (Logger ERROR_TYPE_SCRIPT) mean the snippet stopped early, so they make
## the call fail; engine errors and warnings are reported alongside the result.
static func _eval_result(rt: Node, res: Dictionary, capture: LogCapture) -> Dictionary:
	var script: GDScript = res.get("script") as GDScript
	var snippet_file: String = ("gdscript://%d.gd" % script.get_instance_id()) if script != null else ""
	var offset: int = int(res.get("offset", 0))
	var errors: Array = []
	var warnings: Array = []
	var script_error: String = ""
	for e: Dictionary in capture.errors:
		var where: String = str(e["file"])
		var line: int = int(e["line"])
		if where == snippet_file:
			where = "snippet"
			line -= offset
		var text: String = "%s (%s:%d)" % [e["message"], where, line]
		if int(e["type"]) == Logger.ERROR_TYPE_WARNING:
			warnings.append(text)
		else:
			errors.append(text)
			if int(e["type"]) == Logger.ERROR_TYPE_SCRIPT and script_error.is_empty():
				script_error = text
	var output: Array = []
	var chars: int = 0
	for line_text: String in capture.messages:
		chars += line_text.length()
		if chars > OUTPUT_MAX_CHARS:
			output.append("…(output cut)")
			break
		output.append(line_text)
	var extra: Dictionary = {}
	if not output.is_empty():
		extra["output"] = output
	if not errors.is_empty():
		extra["errors"] = errors
	if not warnings.is_empty():
		extra["warnings"] = warnings

	if res.has("compile_error"):
		return R.err(R.BAD_PARAMS, ("The GDScript snippet does not compile: %s. Write the body of `func run(node, tree, inputs)` " +
			"(tab or space indented blocks are fine; use `return` for the result), e.g. `var p = node.get_node(\"Player\")\\nreturn p.position`.") %
			("; ".join(errors) if not errors.is_empty() else error_string(int(res["compile_error"]))), extra)
	if R.is_err(res):
		var e2: Dictionary = res["error"]
		var detail: Variant = null
		if not extra.is_empty():
			detail = extra
		return R.err(str(e2["code"]), str(e2["message"]), detail)
	if not script_error.is_empty():
		return R.err(R.GODOT_ERROR, "The snippet stopped with a script error: %s." % script_error, extra)
	var out: Dictionary = {}
	if res.get("pending", false):
		out["pending"] = true
		out["note"] = "The code awaited something that had not finished within %d s; it keeps running in the game." % AWAIT_BUDGET_S
	else:
		out["result"] = rt.encode(res.get("value"))
	out.merge(extra)
	return R.ok(out)
