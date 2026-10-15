@tool
extends RefCounted
## Signals: list, connect and disconnect persistent connections in scenes.
##
## Registered in core/methods.gd (MODULES). `methods()` maps each bridge-protocol method
## this module implements to a descriptor (see the comment on Methods.MODULES for kinds).
##
## What "persistent" means: a connection made with CONNECT_PERSIST is stored in the .tscn
## as a `[connection ...]` entry (that is what the editor's Node > Signals dock creates).
## Connections made from code at runtime are not part of the scene and are never listed or
## touched here. Connections that come from an instanced sub-scene carry Godot's internal
## CONNECT_INHERITED flag (32, not exposed to GDScript); they belong to the sub-scene file
## and cannot be removed from the parent scene, so they are reported as `inherited`.
##
## Godot facts these functions rely on (verified on 4.7.2):
## * Object.connect() refuses a Callable whose method does not exist on the target
##   ("the provided callable is not valid"), so a stub handler must be added to the
##   target's script (and the script reloaded) BEFORE connecting.
## * A saved connection with binds/unbinds is rebuilt as Callable.bindv(binds).unbind(n);
##   get_bound_arguments() / get_unbound_arguments_count() read them back, and packing a
##   callable built in that order writes the same `binds=` / `unbinds=` fields.
## * Script.has_method() is Object.has_method() on the Script resource itself, not the
##   script's functions, so script methods are looked up with get_script_method_list().

const R := preload("../core/mcp_result.gd")
const Params := preload("../core/params.gd")
const Codec := preload("../core/variant_codec.gd")
const NodePaths := preload("../core/node_paths.gd")
const Fuzzy := preload("../core/fuzzy.gd")
const ChangeSet := preload("../core/change_set.gd")

## Godot's internal Object::CONNECT_INHERITED: the connection was created by an instanced
## sub-scene (or the base of an inherited scene) rather than by this scene.
const CONNECT_INHERITED_FLAG: int = 32

## Flag names accepted by signal.connect `flags` and reported by signal.list.
const FLAG_NAMES: Dictionary = {
	"deferred": CONNECT_DEFERRED,
	"one_shot": CONNECT_ONE_SHOT,
	"reference_counted": CONNECT_REFERENCE_COUNTED,
}


static func methods() -> Dictionary:
	return {
		"signal.list": {"kind": "scene_read", "fn": read_signal_list},
		"signal.connect": {"kind": "scene_mutation", "fn": plan_signal_connect},
		"signal.disconnect": {"kind": "scene_mutation", "fn": plan_signal_disconnect},
	}


# ---------------------------------------------------------------------------------------
# signal.list
# ---------------------------------------------------------------------------------------

## signal.list: persistent connections of a node (or subtree), plus detected problems.
static func read_signal_list(root: Node, params: Variant) -> Dictionary:
	var p := Params.new(params, "signal.list")
	var path: String = p.opt_string("path", ".")
	var recursive: bool = p.opt_bool("recursive", true)
	var include_available: bool = p.opt_bool("include_available", false)
	if p.failed():
		return p.error
	var res: Dictionary = NodePaths.resolve(root, path)
	if R.is_err(res):
		return res
	var start: Node = res["value"]
	var scope: Array[Node] = [start]
	if recursive:
		_collect_listed(root, start, scope)

	# Problems are attached where they occur (a connection's "problem", the
	# "unconnected_handlers" list) instead of being repeated in a separate text list, to
	# keep the output compact; "problem_count" says whether there is anything to look at.
	var connections: Array = []
	var problem_count: int = 0
	for node: Node in scope:
		for conn: Dictionary in persistent_connections(root, node):
			var entry: Dictionary = _encode_connection(root, conn)
			var target: Node = conn["target"]
			if not has_method_on(target, conn["method"]):
				entry["problem"] = "method '%s' does not exist on '%s' (%s); add it to the script or remove the connection with signal.disconnect" % [conn["method"], entry["to"], _describe_target(target)]
				problem_count += 1
			else:
				var sig: Dictionary = _find_signal(node, conn["signal"])
				var passed: int = (sig.get("args", []) as Array).size() - int(conn["unbinds"]) + (conn["binds"] as Array).size()
				var mismatch: String = arg_count_problem(target, conn["method"], passed)
				if not mismatch.is_empty():
					entry["problem"] = mismatch + "; fix the function's parameters or the connection's binds/unbinds"
					problem_count += 1
			connections.append(entry)

	var result: Dictionary = {"connections": connections}
	var unconnected: Array = _unconnected_handlers(root, scope)
	if not unconnected.is_empty():
		result["unconnected_handlers"] = unconnected
		result["unconnected_note"] = "Script methods named like signal handlers but not connected in the scene. Connect them with signal.connect, unless the script connects them in code."
		problem_count += unconnected.size()
	result["problem_count"] = problem_count
	if include_available:
		var available: Dictionary = {}
		for node: Node in scope:
			available[NodePaths.rel_path(root, node)] = signal_signatures(node)
		result["available"] = available
	return R.ok(result)


static func _collect_listed(root: Node, node: Node, out: Array[Node]) -> void:
	for c: Node in NodePaths.listed_children(root, node):
		out.append(c)
		_collect_listed(root, c, out)


## Persistent connections from `node` to nodes inside the scene, as
## [{signal, target: Node, method, flags, binds: Array, unbinds: int, callable}].
static func persistent_connections(root: Node, node: Node) -> Array[Dictionary]:
	var out: Array[Dictionary] = []
	for sig: Dictionary in node.get_signal_list():
		var sig_name: StringName = sig["name"]
		for conn: Dictionary in node.get_signal_connection_list(sig_name):
			var flags: int = conn.get("flags", 0)
			# The editor connects plenty of internal callbacks to scene nodes; only
			# connections saved with the scene (CONNECT_PERSIST) belong to the user.
			if (flags & CONNECT_PERSIST) == 0:
				continue
			var callable: Callable = conn["callable"]
			var target_obj: Object = callable.get_object()
			if not target_obj is Node:
				continue
			var target: Node = target_obj
			if target != root and not root.is_ancestor_of(target):
				continue
			out.append({
				"signal": String(sig_name),
				"target": target,
				"method": String(callable.get_method()),
				"flags": flags,
				"binds": callable.get_bound_arguments(),
				"unbinds": callable.get_unbound_arguments_count(),
				"callable": callable,
				"from": node,
			})
	return out


## Compact JSON form of a connection: optional fields only when they carry information.
static func _encode_connection(root: Node, conn: Dictionary) -> Dictionary:
	var entry: Dictionary = {
		"from": NodePaths.rel_path(root, conn["from"]),
		"signal": conn["signal"],
		"to": NodePaths.rel_path(root, conn["target"]),
		"method": conn["method"],
	}
	var flags: int = conn["flags"]
	var names: Array[String] = flag_names(flags)
	if not names.is_empty():
		entry["flags"] = names
	if (flags & CONNECT_INHERITED_FLAG) != 0:
		entry["inherited"] = true
	var binds: Array = conn["binds"]
	if not binds.is_empty():
		entry["binds"] = Codec.encode(binds, root)
	var unbinds: int = conn["unbinds"]
	if unbinds > 0:
		entry["unbinds"] = unbinds
	return entry


static func flag_names(flags: int) -> Array[String]:
	var out: Array[String] = []
	for n: String in FLAG_NAMES:
		if (flags & int(FLAG_NAMES[n])) != 0:
			out.append(n)
	return out


## "name(arg: Type, ...)" strings for every signal of `node`.
static func signal_signatures(node: Node) -> Array[String]:
	var out: Array[String] = []
	for sig: Dictionary in node.get_signal_list():
		var args: Array[String] = []
		for a: Dictionary in sig["args"]:
			var t: String = _arg_type(a)
			args.append(String(a["name"]) + ((": " + t) if not t.is_empty() else ""))
		out.append("%s(%s)" % [sig["name"], ", ".join(args)])
	return out


## GDScript type annotation for a signal/method argument description ("" = untyped).
static func _arg_type(a: Dictionary) -> String:
	var t: int = a.get("type", TYPE_NIL)
	if t == TYPE_NIL:
		return ""
	if t == TYPE_OBJECT:
		var cls: String = String(a.get("class_name", ""))
		return cls if not cls.is_empty() else "Object"
	return type_string(t)


static func _describe_target(target: Node) -> String:
	var script: Script = target.get_script() as Script
	if script == null:
		return "%s, no script" % target.get_class()
	return "%s, script %s" % [target.get_class(), script.resource_path if not script.resource_path.is_empty() else "<built-in>"]


## True if `method` can be called on `node`: a method of its class (with inheritance) or a
## function in its script or one of the script's base scripts.
static func has_method_on(node: Node, method: String) -> bool:
	if ClassDB.class_has_method(node.get_class(), method):
		return true
	return not script_method(node.get_script() as Script, method).is_empty()


## The method description of `method` in `script` or its base scripts, or {}.
static func script_method(script: Script, method: String) -> Dictionary:
	var s: Script = script
	while s != null:
		for m: Dictionary in s.get_script_method_list():
			if String(m["name"]) == method:
				return m
		s = s.get_base_script()
	return {}


## Describes an argument-count mismatch between a script handler and what a connection
## passes (signal args - unbinds + binds), or "" when it fits or cannot be checked (engine
## methods, which ClassDB describes less reliably for varargs).
static func arg_count_problem(target: Node, method: String, passed: int) -> String:
	var m: Dictionary = script_method(target.get_script() as Script, method)
	if m.is_empty():
		return ""
	var max_args: int = (m["args"] as Array).size()
	var min_args: int = max_args - (m.get("default_args", []) as Array).size()
	var vararg: bool = (int(m.get("flags", 0)) & METHOD_FLAG_VARARG) != 0
	if passed < min_args or (passed > max_args and not vararg):
		return "'%s' takes %s argument(s) but the connection passes %d, so Godot reports an error when the signal fires" % [method, str(max_args) if min_args == max_args else "%d-%d" % [min_args, max_args], passed]
	return ""


static func _script_method_names(script: Script) -> Array[String]:
	var out: Array[String] = []
	var s: Script = script
	while s != null:
		for m: Dictionary in s.get_script_method_list():
			var n: String = m["name"]
			if not n in out:
				out.append(n)
		s = s.get_base_script()
	return out


## Script methods named like editor-generated handlers (`_on_<node>_<signal>`, or
## `_on_<signal>` for a node's own signals) that no persistent connection uses.
## Handlers whose name appears elsewhere in their script's source are skipped: they are
## most likely connected in code (`timer.timeout.connect(_on_timer_timeout)`).
static func _unconnected_handlers(root: Node, scope: Array[Node]) -> Array:
	# Every connected (target, method) pair in the whole scene, not just the scope: a
	# handler in scope may be connected from a node outside it.
	var connected: Dictionary = {}
	var all_nodes: Array[Node] = [root]
	_collect_listed(root, root, all_nodes)
	for n: Node in all_nodes:
		for conn: Dictionary in persistent_connections(root, n):
			connected["%d:%s" % [(conn["target"] as Node).get_instance_id(), conn["method"]]] = true
	# Map candidate handler names to the (node, signal) they would belong to.
	var candidates: Dictionary = {}
	for n: Node in all_nodes:
		var prefixes: Array[String] = []
		for form: String in [String(n.name).to_snake_case(), String(n.name), String(n.name).to_lower()]:
			if not ("_on_%s_" % form) in prefixes:
				prefixes.append("_on_%s_" % form)
		for sig: Dictionary in n.get_signal_list():
			for prefix: String in prefixes:
				var key: String = prefix + String(sig["name"])
				if not candidates.has(key):
					candidates[key] = [n, String(sig["name"])]
	var out: Array = []
	for target: Node in scope:
		var script: Script = target.get_script() as Script
		if script == null:
			continue
		var source: String = script.source_code if script is GDScript else ""
		for m: Dictionary in script.get_script_method_list():
			var mname: String = m["name"]
			if not mname.begins_with("_on_"):
				continue
			if connected.has("%d:%s" % [target.get_instance_id(), mname]):
				continue
			var match_info: Variant = candidates.get(mname)
			if match_info == null:
				# `_on_<signal>` for one of the target's own signals.
				var own: String = mname.trim_prefix("_on_")
				if target.has_signal(own):
					match_info = [target, own]
			if match_info == null:
				continue
			if not source.is_empty() and source.count(mname) > 1:
				continue
			out.append({
				"to": NodePaths.rel_path(root, target),
				"method": mname,
				"from": NodePaths.rel_path(root, (match_info as Array)[0]),
				"signal": (match_info as Array)[1],
			})
	return out


# ---------------------------------------------------------------------------------------
# signal.connect
# ---------------------------------------------------------------------------------------

## signal.connect
static func plan_signal_connect(root: Node, params: Variant) -> Dictionary:
	var p := Params.new(params, "signal.connect")
	var from_path: String = p.req_string("from")
	var signal_name: String = p.req_string("signal")
	var to_path: String = p.opt_string("to", ".")
	var method: String = p.opt_string("method", "")
	var binds_raw: Array = p.opt_array("binds", [])
	var unbinds: int = p.opt_int("unbinds", 0)
	var flag_list: Array = p.opt_array("flags", [])
	var create_method: bool = p.opt_bool("create_method", false)
	if p.failed():
		return p.error
	if unbinds < 0:
		return R.err(R.BAD_PARAMS, "signal.connect: 'unbinds' must be 0 or more (the number of trailing signal arguments to drop).")
	var fres: Dictionary = NodePaths.resolve(root, from_path, "from")
	if R.is_err(fres):
		return fres
	var source: Node = fres["value"]
	var tres: Dictionary = NodePaths.resolve(root, to_path, "to")
	if R.is_err(tres):
		return tres
	var target: Node = tres["value"]
	var from_label: String = NodePaths.rel_path(root, source)
	var to_label: String = NodePaths.rel_path(root, target)
	# Connections are saved by the scene that owns the source node; a connection from an
	# internal node of a (non-editable) instance would be dropped on save.
	var edit_err: Dictionary = NodePaths.check_editable(root, source, "connect a signal of")
	if not edit_err.is_empty():
		return edit_err
	var sig: Dictionary = _find_signal(source, signal_name)
	if sig.is_empty():
		var names: Array[String] = []
		for s: Dictionary in source.get_signal_list():
			names.append(String(s["name"]))
		var similar: Array[String] = Fuzzy.suggest(signal_name, names, 5)
		return R.err(R.NOT_FOUND, "signal.connect: '%s' (%s) has no signal '%s'.%s Use signal.list with include_available: true to see its signals." % [from_label, source.get_class(), signal_name, Fuzzy.did_you_mean(similar)], {"similar": similar})
	var sig_args: Array = sig["args"]
	if unbinds > sig_args.size():
		return R.err(R.BAD_PARAMS, "signal.connect: 'unbinds' is %d but signal '%s' only has %d argument(s): %s." % [unbinds, signal_name, sig_args.size(), _signature(sig)])
	if method.is_empty():
		method = default_handler_name(source, target, signal_name)
	if not method.is_valid_identifier():
		return R.err(R.BAD_PARAMS, "signal.connect: 'method' must be a valid function name such as \"_on_timer_timeout\", got '%s'." % method)

	var flags: int = CONNECT_PERSIST
	for f: Variant in flag_list:
		var fname: String = str(f).to_lower()
		if not FLAG_NAMES.has(fname):
			return R.err(R.BAD_PARAMS, "signal.connect: unknown flag '%s'. Valid flags: %s." % [str(f), ", ".join(FLAG_NAMES.keys())])
		flags |= int(FLAG_NAMES[fname])

	var binds: Array = []
	for i: int in binds_raw.size():
		var d: Dictionary = Codec.decode_typed(binds_raw[i], {"type": TYPE_NIL, "name": "binds[%d]" % i}, root)
		if R.is_err(d):
			return d
		binds.append(d["value"])

	for conn: Dictionary in persistent_connections(root, source):
		if conn["signal"] == signal_name and conn["target"] == target and conn["method"] == method:
			return R.err(R.CONFLICT, "signal.connect: %s.%s is already connected to '%s' method '%s'. To change binds or flags, call signal.disconnect first." % [from_label, signal_name, to_label, method])

	# Arguments the handler will receive: the signal's arguments minus the unbound ones,
	# then the binds.
	var expected_args: int = sig_args.size() - unbinds + binds.size()
	var stub: Dictionary = {}
	var warnings: Array[String] = []
	if not has_method_on(target, method):
		var script: Script = target.get_script() as Script
		if not create_method:
			var names2: Array[String] = _script_method_names(script)
			var similar2: Array[String] = Fuzzy.suggest(method, names2, 5)
			var hint: String = " Pass create_method: true to append a stub handler to the target's script," if script != null else " The target has no script: attach one with script.attach (or pick another target),"
			return R.err(R.NOT_FOUND, "signal.connect: '%s' (%s) has no method '%s'.%s%s or write the function first." % [to_label, _describe_target(target), method, Fuzzy.did_you_mean(similar2), hint], {"similar": similar2})
		var stub_res: Dictionary = _plan_stub(target, to_label, method, sig, unbinds, binds)
		if R.is_err(stub_res):
			return stub_res
		stub = stub_res["value"]
	else:
		var mismatch: String = arg_count_problem(target, method, expected_args)
		if not mismatch.is_empty():
			warnings.append("%s (signal %s, unbinds %d, binds %d)." % [mismatch, _signature(sig), unbinds, binds.size()])

	# Same construction order as SceneState uses when loading a saved connection.
	var callable := Callable(target, method)
	if not binds.is_empty():
		callable = callable.bindv(binds)
	if unbinds > 0:
		callable = callable.unbind(unbinds)

	var cs := ChangeSet.new()
	if not stub.is_empty():
		var writer := StubWriter.new(stub["path"], stub["text"], method)
		cs.do_method(writer, &"write")
	cs.do_method(source, &"connect", [StringName(signal_name), callable, flags])
	cs.undo_method(source, &"disconnect", [StringName(signal_name), callable])
	var finish := func() -> Dictionary:
		var result: Dictionary = {
			"from": from_label,
			"signal": signal_name,
			"to": to_label,
			"method": method,
			"connected": source.is_connected(StringName(signal_name), callable),
		}
		var fnames: Array[String] = flag_names(flags)
		if not fnames.is_empty():
			result["flags"] = fnames
		if not binds.is_empty():
			result["binds"] = Codec.encode(binds, root)
		if unbinds > 0:
			result["unbinds"] = unbinds
		if not stub.is_empty():
			result["method_created"] = {"script": stub["path"], "code": stub["func"]}
		if not warnings.is_empty():
			result["warnings"] = warnings
		return result
	return {"changes": cs, "finish": finish}


static func _find_signal(node: Node, signal_name: String) -> Dictionary:
	for s: Dictionary in node.get_signal_list():
		if String(s["name"]) == signal_name:
			return s
	return {}


static func _signature(sig: Dictionary) -> String:
	var args: Array[String] = []
	for a: Dictionary in sig["args"]:
		var t: String = _arg_type(a)
		args.append(String(a["name"]) + ((": " + t) if not t.is_empty() else ""))
	return "%s(%s)" % [sig["name"], ", ".join(args)]


## The editor's default handler name: `_on_<source_snake>_<signal>`, or `_on_<signal>`
## when a node connects to itself (the editor settings' defaults).
static func default_handler_name(source: Node, target: Node, signal_name: String) -> String:
	if source == target:
		return "_on_" + signal_name
	return "_on_%s_%s" % [String(source.name).to_snake_case(), signal_name]


## Builds the stub function for create_method. Returns {"value": {path, text, func}}.
static func _plan_stub(target: Node, to_label: String, method: String, sig: Dictionary, unbinds: int, binds: Array) -> Dictionary:
	var script: Script = target.get_script() as Script
	if script == null:
		return R.err(R.BAD_PARAMS, "signal.connect: create_method needs a script on '%s', which has none. Attach one first with script.attach (write the .gd file, then attach it)." % to_label)
	var path: String = script.resource_path
	if not script is GDScript or path.is_empty() or path.contains("::") or path.get_extension().to_lower() != "gd":
		return R.err(R.UNSUPPORTED, "signal.connect: create_method only works for a .gd script file, but '%s' uses %s. Add the method '%s' yourself, then connect without create_method." % [to_label, path if not path.is_empty() else "a built-in script", method])
	if not FileAccess.file_exists(path):
		return R.err(R.NOT_FOUND, "signal.connect: the script file '%s' of '%s' does not exist on disk." % [path, to_label])
	var params_txt: Array[String] = []
	var used: Array[String] = []
	var sig_args: Array = sig["args"]
	for i: int in sig_args.size() - unbinds:
		var a: Dictionary = sig_args[i]
		var aname: String = String(a["name"])
		if not aname.is_valid_identifier() or aname in used:
			aname = "arg%d" % i
		used.append(aname)
		var t: String = _arg_type(a)
		params_txt.append(aname + ((": " + t) if not t.is_empty() else ""))
	for i: int in binds.size():
		var bname: String = "extra_arg_%d" % i
		var bt: int = typeof(binds[i])
		var tname: String = ""
		if bt == TYPE_OBJECT:
			tname = (binds[i] as Object).get_class() if binds[i] != null else ""
		elif bt != TYPE_NIL:
			tname = type_string(bt)
		params_txt.append(bname + ((": " + tname) if not tname.is_empty() else ""))
	# Same body as the editor's own generated handlers.
	var fn: String = "func %s(%s) -> void:\n\tpass # Replace with function body.\n" % [method, ", ".join(params_txt)]
	return R.value({"path": path, "func": fn, "text": fn})


## Appends a stub function to a .gd file and reloads the script so the method exists for
## connect() (headless: on the real script instance; editor: on the placeholder instance
## and in the script editor). Lives in the ChangeSet as a "do" step so it runs right before
## the connect; it is idempotent because batches and redo may run it more than once.
## Undo does not remove the function again (file edits are not part of the scene's
## history); the function is harmless without the connection.
class StubWriter extends RefCounted:
	var _path: String
	var _func_text: String
	var _method: String

	func _init(path: String, func_text: String, method: String) -> void:
		_path = path
		_func_text = func_text
		_method = method

	func write() -> void:
		var script: GDScript = load(_path) as GDScript
		var source: String = FileAccess.get_file_as_string(_path)
		var regex: RegEx = RegEx.create_from_string("(?m)^(static\\s+)?func\\s+%s\\s*\\(" % _method)
		if regex.search(source) == null:
			var text: String = source
			if not text.is_empty() and not text.ends_with("\n"):
				text += "\n"
			text += "\n\n" + _func_text
			var f: FileAccess = FileAccess.open(_path, FileAccess.WRITE)
			if f == null:
				push_error("Godot MCP: cannot write '%s' (%s)" % [_path, error_string(FileAccess.get_open_error())])
				return
			f.store_string(text)
			f.close()
			source = text
		if script != null and script.source_code != source:
			script.source_code = source
			script.reload(true)
		if Engine.is_editor_hint():
			# Make the FileSystem dock and open script tabs pick up the new text. Looked up
			# dynamically: this file also runs in the headless runner, which has no editor.
			var ei: Object = Engine.get_singleton(&"EditorInterface")
			if ei != null:
				(ei.call(&"get_resource_filesystem") as Object).call(&"update_file", _path)
				(ei.call(&"get_script_editor") as Object).call(&"reload_open_files")


# ---------------------------------------------------------------------------------------
# signal.disconnect
# ---------------------------------------------------------------------------------------

## signal.disconnect
static func plan_signal_disconnect(root: Node, params: Variant) -> Dictionary:
	var p := Params.new(params, "signal.disconnect")
	var from_path: String = p.req_string("from")
	var signal_name: String = p.req_string("signal")
	var to_path: String = p.opt_string("to", ".")
	var method: String = p.req_string("method")
	if p.failed():
		return p.error
	var fres: Dictionary = NodePaths.resolve(root, from_path, "from")
	if R.is_err(fres):
		return fres
	var source: Node = fres["value"]
	var tres: Dictionary = NodePaths.resolve(root, to_path, "to")
	if R.is_err(tres):
		return tres
	var target: Node = tres["value"]
	var from_label: String = NodePaths.rel_path(root, source)
	var to_label: String = NodePaths.rel_path(root, target)
	if not source.has_signal(signal_name):
		var names: Array[String] = []
		for s: Dictionary in source.get_signal_list():
			names.append(String(s["name"]))
		var similar: Array[String] = Fuzzy.suggest(signal_name, names, 5)
		return R.err(R.NOT_FOUND, "signal.disconnect: '%s' (%s) has no signal '%s'.%s" % [from_label, source.get_class(), signal_name, Fuzzy.did_you_mean(similar)], {"similar": similar})
	var found: Dictionary = {}
	var existing: Array = []
	for conn: Dictionary in persistent_connections(root, source):
		if conn["signal"] != signal_name:
			continue
		existing.append(_encode_connection(root, conn))
		if conn["target"] == target and conn["method"] == method:
			found = conn
	if found.is_empty():
		var msg: String = "signal.disconnect: no saved connection %s.%s -> '%s' method '%s'." % [from_label, signal_name, to_label, method]
		if existing.is_empty():
			msg += " '%s' has no saved connections for '%s'; use signal.list to see the scene's connections." % [from_label, signal_name]
		else:
			var descr: Array[String] = []
			for e: Dictionary in existing:
				descr.append("-> '%s' method '%s'" % [e["to"], e["method"]])
			msg += " Existing connections of that signal: %s." % ", ".join(descr)
		return R.err(R.NOT_FOUND, msg, {"existing": existing})
	if (int(found["flags"]) & CONNECT_INHERITED_FLAG) != 0:
		return R.err(R.BAD_PARAMS, "signal.disconnect: %s.%s -> '%s' method '%s' is defined in an instanced or inherited sub-scene, not in this scene; disconnect it in that scene's file instead." % [from_label, signal_name, to_label, method])
	var callable: Callable = found["callable"]
	var flags: int = found["flags"]
	var cs := ChangeSet.new()
	cs.do_method(source, &"disconnect", [StringName(signal_name), callable])
	cs.undo_method(source, &"connect", [StringName(signal_name), callable, flags])
	var finish := func() -> Dictionary:
		return {"from": from_label, "signal": signal_name, "to": to_label, "method": method, "disconnected": not source.is_connected(StringName(signal_name), callable)}
	return {"changes": cs, "finish": finish}
