@tool
extends RefCounted
## Visual authoring: visual shader graphs, Control layout presets, shader checks.
##
## Registered in core/methods.gd (MODULES). `methods()` maps each bridge-protocol method
## this module implements to a descriptor (see the comment on Methods.MODULES for kinds).
##
## * visual.shader_graph / visual.shader_graph_read edit and read VisualShader .tres files.
##   Godot keeps port counts and names C++-only, so connections are validated with the
##   engine's own can_connect_nodes() and, when that refuses, diagnosed by probing the graph
##   with temporary helper nodes (see _count_output_ports). Output-node and Input-node port
##   names come from core/visual_shader_ports.gd. Graph edits are saved immediately and are
##   not part of the editor's undo history (a VisualShader is a file resource, not a scene).
## * visual.layout applies Control anchor/offset presets as one undoable scene change.
## * visual.shader_check compiles shader code and reports the compiler's errors. Godot 4.7's
##   dummy renderer (used by --headless) runs the real ShaderLanguage compiler and reports
##   "SHADER ERROR" through the engine error stream (Logger error type 3), so this works
##   headless as well as in the editor. See docs/methods/resources-visual-import.md.

const R := preload("../core/mcp_result.gd")
const Params := preload("../core/params.gd")
const Codec := preload("../core/variant_codec.gd")
const ResPaths := preload("../core/res_paths.gd")
const NodePaths := preload("../core/node_paths.gd")
const Fuzzy := preload("../core/fuzzy.gd")
const ChangeSet := preload("../core/change_set.gd")
const RU := preload("../core/resource_util.gd")
const Ports := preload("../core/visual_shader_ports.gd")

## Shader.Mode values by name (4.7 adds texture_blit).
const MODES: Dictionary = {"spatial": 0, "canvas_item": 1, "particles": 2, "sky": 3, "fog": 4, "texture_blit": 5}
## VisualShader.Type values by name.
const TYPES: Dictionary = {
	"vertex": 0, "fragment": 1, "light": 2, "start": 3, "process": 4, "collide": 5,
	"start_custom": 6, "process_custom": 7, "sky": 8, "fog": 9, "texture_blit": 10,
}
## Shader types that exist for each mode, and the default one used when none is given.
const MODE_TYPES: Dictionary = {
	0: ["vertex", "fragment", "light"], 1: ["vertex", "fragment", "light"],
	2: ["start", "process", "collide", "start_custom", "process_custom"],
	3: ["sky"], 4: ["fog"], 5: ["texture_blit"],
}
const DEFAULT_TYPE: Dictionary = {0: "fragment", 1: "fragment", 2: "process", 3: "sky", 4: "fog", 5: "texture_blit"}
const GRAPH_OPS: PackedStringArray = ["add_node", "connect", "disconnect", "remove_node", "set"]
## Node properties that are graph bookkeeping rather than user settings (hidden in reads).
const NODE_INTERNAL_PROPS: PackedStringArray = ["output_port_for_preview", "expanded_output_ports", "linked_parent_graph_frame", "default_input_values", "resource_name"]
## Highest port index probed when counting ports (no built-in node has nearly this many).
const MAX_PORTS: int = 64

## Control.LayoutPreset values by name.
const PRESETS: Dictionary = {
	"top_left": 0, "top_right": 1, "bottom_left": 2, "bottom_right": 3, "center_left": 4,
	"center_top": 5, "center_right": 6, "center_bottom": 7, "center": 8, "left_wide": 9,
	"top_wide": 10, "right_wide": 11, "bottom_wide": 12, "vcenter_wide": 13,
	"hcenter_wide": 14, "full_rect": 15,
}
## Control.LayoutPresetMode values by name.
const RESIZE_MODES: Dictionary = {"minsize": 0, "keep_width": 1, "keep_height": 2, "keep_size": 3}
## Control.SizeFlags by name ("expand_fill" = fill | expand).
const SIZE_FLAGS: Dictionary = {"shrink_begin": 0, "fill": 1, "expand": 2, "expand_fill": 3, "shrink_center": 4, "shrink_end": 8}
const SIDE_NAMES: PackedStringArray = ["left", "top", "right", "bottom"]


static func methods() -> Dictionary:
	return {
		"visual.shader_graph": {"kind": "project", "fn": shader_graph},
		"visual.shader_graph_read": {"kind": "project", "fn": shader_graph_read},
		"visual.layout": {"kind": "scene_mutation", "fn": plan_layout},
		"visual.shader_check": {"kind": "project", "fn": shader_check},
	}


# ---------------------------------------------------------------------------------------
# visual.shader_graph
# ---------------------------------------------------------------------------------------

## params: {path, create?: false, mode?: "spatial", shader_type?: <mode default>, ops: [...]}
static func shader_graph(params: Variant, env: Dictionary) -> Dictionary:
	var p := Params.new(params, "visual.shader_graph")
	var raw: String = p.req_string("path")
	var create: bool = p.opt_bool("create", false)
	var mode_name: String = p.opt_string("mode", "")
	var type_name: String = p.opt_string("shader_type", "")
	var ops: Array = p.opt_array("ops", [])
	if p.failed():
		return p.error
	var where: Dictionary = RU.resolve(raw)
	if R.is_err(where):
		return where
	var path: String = where["value"]
	var editor: bool = bool(env.get("editor", false))
	var vs: VisualShader
	var created: bool = false
	if not ResPaths.file_exists(path):
		if not create:
			return R.err(R.NOT_FOUND, "visual.shader_graph: '%s' does not exist. Pass create: true (and mode, e.g. \"spatial\") to create a new VisualShader there." % path)
		if not path.get_extension().to_lower() in ["tres", "res"]:
			return R.err(R.BAD_PARAMS, "visual.shader_graph: a VisualShader is saved as a .tres (or .res) file, got '%s'." % path)
		var mode_res: Dictionary = _lookup(MODES, mode_name if not mode_name.is_empty() else "spatial", "mode")
		if R.is_err(mode_res):
			return mode_res
		vs = VisualShader.new()
		vs.set_mode(int(mode_res["value"]))
		created = true
	else:
		var loaded: Dictionary = RU.load_existing(path, "visual.shader_graph")
		if R.is_err(loaded):
			return loaded
		if not loaded["value"] is VisualShader:
			return R.err(R.BAD_PARAMS, "visual.shader_graph: '%s' is a %s, not a VisualShader. For text shaders (.gdshader) edit the code with files.edit and check it with visual.shader_check." % [path, (loaded["value"] as Object).get_class()])
		vs = loaded["value"]
		if not mode_name.is_empty() and MODES.get(mode_name, -1) != vs.get_mode():
			return R.err(R.BAD_PARAMS, "visual.shader_graph: 'mode' can only be chosen when creating a shader; '%s' is a %s shader." % [path, _mode_name(vs.get_mode())])
	var mode: int = vs.get_mode()
	if type_name.is_empty():
		type_name = DEFAULT_TYPE[mode]
	var type_check: Dictionary = _check_type(type_name, mode)
	if R.is_err(type_check):
		return type_check
	if ops.is_empty() and not created:
		return R.err(R.BAD_PARAMS, "visual.shader_graph: 'ops' is empty. Example: [{\"op\": \"add_node\", \"type\": \"ColorConstant\", \"id\": 2, \"properties\": {\"constant\": \"#ff0000\"}}, {\"op\": \"connect\", \"from\": 2, \"from_port\": 0, \"to\": 0, \"to_port\": \"albedo\"}].")

	# In the editor the loaded VisualShader is the shared, cached instance (possibly open in
	# the visual shader editor): rehearse on a deep copy first so a bad op in the middle of
	# the list leaves it untouched. Headless the instance is private and simply not saved.
	if editor and not created:
		var rehearsal: Dictionary = _apply_ops(vs.duplicate(true) as VisualShader, ops, type_name)
		if R.is_err(rehearsal):
			return rehearsal
	var applied: Dictionary = _apply_ops(vs, ops, type_name)
	if R.is_err(applied):
		return applied

	var uid: String = str(where["uid"])
	if created:
		var mk: int = DirAccess.make_dir_recursive_absolute(path.get_base_dir())
		if mk != OK and not DirAccess.dir_exists_absolute(path.get_base_dir()):
			return R.godot_err("Creating folder '%s'" % path.get_base_dir(), mk)
		vs.resource_path = path
	var saved: Dictionary = RU.save(vs, path)
	if not saved.is_empty():
		return saved
	if created:
		if editor and env.get("filesystem") != null:
			(env["filesystem"] as Object).call("update_file", path)
		uid = RU.uid_text(path)
		if uid.is_empty() and not editor:
			uid = RU.assign_uid(path)
	var out: Dictionary = {"path": path, "mode": _mode_name(mode), "created": created, "results": applied["value"], "saved": true}
	if not uid.is_empty():
		out["uid"] = uid
	return R.ok(out)


## Applies graph ops in order. Returns {"value": [per-op results]} or the first error,
## prefixed with the op's index.
static func _apply_ops(vs: VisualShader, ops: Array, default_type: String) -> Dictionary:
	var results: Array = []
	var mode: int = vs.get_mode()
	for i: int in ops.size():
		var op_v: Variant = ops[i]
		if not op_v is Dictionary:
			return R.err(R.BAD_PARAMS, "visual.shader_graph: ops[%d] must be an object like {\"op\": \"add_node\", ...}." % i)
		var op: Dictionary = op_v
		var kind: String = str(op.get("op", ""))
		var tname: String = str(op.get("shader_type", default_type))
		var tc: Dictionary = _check_type(tname, mode)
		var r: Dictionary
		if R.is_err(tc):
			r = tc
		else:
			var t: int = TYPES[tname]
			var key: String = "%s/%s" % [_mode_name(mode), tname]
			match kind:
				"add_node":
					r = _op_add_node(vs, t, key, op)
				"connect":
					r = _op_connect(vs, t, key, op)
				"disconnect":
					r = _op_disconnect(vs, t, op)
				"remove_node":
					r = _op_remove_node(vs, t, op)
				"set":
					r = _op_set(vs, t, key, op)
				_:
					r = R.err(R.BAD_PARAMS, "'op' must be one of %s, got '%s'.%s" % [", ".join(GRAPH_OPS), kind, Fuzzy.did_you_mean(Fuzzy.suggest(kind, GRAPH_OPS, 2))])
		if R.is_err(r):
			var e: Dictionary = r["error"]
			e["message"] = "visual.shader_graph ops[%d] (%s): %s" % [i, kind, e["message"]]
			return r
		var entry: Dictionary = r["value"]
		entry["op"] = kind
		results.append(entry)
	return R.value(results)


static func _op_add_node(vs: VisualShader, t: int, key: String, op: Dictionary) -> Dictionary:
	var type: String = str(op.get("type", ""))
	if type.is_empty():
		return R.err(R.BAD_PARAMS, "add_node needs 'type', a VisualShaderNode class such as \"ColorConstant\", \"Input\", \"Texture\", \"FloatOp\" (the \"VisualShaderNode\" prefix is optional).")
	var made: Dictionary = _make_node(type)
	if R.is_err(made):
		return made
	var node: VisualShaderNode = made["value"]
	var id: int
	if op.has("id") and op["id"] != null:
		id = int(op["id"])
		if id < 2:
			return R.err(R.BAD_PARAMS, "node ids 0 and 1 are reserved (0 is the Output node); use 2 or higher, or omit 'id' to get the next free one.")
		if vs.get_node_list(t).has(id):
			return R.err(R.CONFLICT, "node id %d is already used in the %s graph (a %s). Omit 'id' to get a free one (next free: %d)." % [id, _type_name(t), vs.get_node(t, id).get_class(), vs.get_valid_node_id(t)])
	else:
		id = vs.get_valid_node_id(t)
	var pos: Vector2 = Vector2(-300, 150 * (vs.get_node_list(t).size() - 1))
	if op.has("position"):
		var pr: Dictionary = Codec.decode_typed(op["position"], {"name": "position", "type": TYPE_VECTOR2}, null)
		if R.is_err(pr):
			return pr
		pos = pr["value"]
	var props: Dictionary = _decode_node_props(node, key, op.get("properties", {}))
	if R.is_err(props):
		return props
	for pname: String in props["value"]:
		node.set(pname, props["value"][pname])
	vs.add_node(t, node, pos, id)
	if op.has("inputs"):
		var ir: Dictionary = _set_port_defaults(vs, t, id, op["inputs"])
		if R.is_err(ir):
			return ir
	var out: Dictionary = {"id": id, "class": node.get_class(), "shader_type": _type_name(t)}
	if not (props["value"] as Dictionary).is_empty():
		# Echo what was set (read back, non-default only), with enum names.
		var now: Dictionary = RU.non_default_properties(node, 0)
		for internal: String in NODE_INTERNAL_PROPS:
			now.erase(internal)
		out["properties"] = now
		var names: Dictionary = _enum_names(node, now)
		if not names.is_empty():
			out["enum_names"] = names
	return R.value(out)


static func _op_connect(vs: VisualShader, t: int, key: String, op: Dictionary) -> Dictionary:
	var ends: Dictionary = _connection_ends(vs, t, key, op, true)
	if R.is_err(ends):
		return ends
	var from: int = ends["from"]
	var from_port: int = ends["from_port"]
	var to: int = ends["to"]
	var to_port: int = ends["to_port"]
	var out: Dictionary = {"from": from, "from_port": from_port, "to": to, "to_port": to_port}
	for extra: String in ["from_port_spec", "expanded_port"]:
		if ends.has(extra):
			out[extra] = ends[extra]
	if vs.is_node_connection(t, from, from_port, to, to_port):
		out["already_connected"] = true
		return R.value(out)
	if not vs.can_connect_nodes(t, from, from_port, to, to_port):
		return _explain_connect_failure(vs, t, key, from, from_port, to, to_port)
	# An input port takes a single link; replace an existing one like the graph editor does.
	for c: Dictionary in vs.get_node_connections(t):
		if int(c["to_node"]) == to and int(c["to_port"]) == to_port:
			vs.disconnect_nodes(t, int(c["from_node"]), int(c["from_port"]), to, to_port)
			out["replaced"] = {"from": int(c["from_node"]), "from_port": int(c["from_port"])}
	var err: int = vs.connect_nodes(t, from, from_port, to, to_port)
	if err != OK:
		return R.godot_err("Connecting node %d port %d to node %d port %d" % [from, from_port, to, to_port], err)
	return R.value(out)


static func _op_disconnect(vs: VisualShader, t: int, op: Dictionary) -> Dictionary:
	var ends: Dictionary = _connection_ends(vs, t, "", op)
	if R.is_err(ends):
		return ends
	var from: int = ends["from"]
	var to: int = ends["to"]
	if not vs.is_node_connection(t, from, ends["from_port"], to, ends["to_port"]):
		var related: Array = []
		for c: Dictionary in vs.get_node_connections(t):
			if int(c["from_node"]) in [from, to] or int(c["to_node"]) in [from, to]:
				related.append(_conn_json(c))
		return R.err(R.NOT_FOUND, "there is no connection from node %d port %d to node %d port %d. Connections of these nodes: %s." % [from, ends["from_port"], to, ends["to_port"], JSON.stringify(related)], {"connections": related})
	vs.disconnect_nodes(t, from, ends["from_port"], to, ends["to_port"])
	return R.value({"from": from, "from_port": ends["from_port"], "to": to, "to_port": ends["to_port"]})


static func _op_remove_node(vs: VisualShader, t: int, op: Dictionary) -> Dictionary:
	var idr: Dictionary = _existing_id(vs, t, op, "id")
	if R.is_err(idr):
		return idr
	var id: int = idr["value"]
	if id == 0:
		return R.err(R.BAD_PARAMS, "the Output node (id 0) cannot be removed; disconnect its inputs instead.")
	var dropped: int = 0
	for c: Dictionary in vs.get_node_connections(t):
		if int(c["from_node"]) == id or int(c["to_node"]) == id:
			dropped += 1
	var cls: String = vs.get_node(t, id).get_class()
	vs.remove_node(t, id)
	return R.value({"id": id, "class": cls, "connections_removed": dropped})


static func _op_set(vs: VisualShader, t: int, key: String, op: Dictionary) -> Dictionary:
	var idr: Dictionary = _existing_id(vs, t, op, "id")
	if R.is_err(idr):
		return idr
	var id: int = idr["value"]
	var node: VisualShaderNode = vs.get_node(t, id)
	var props: Dictionary = _decode_node_props(node, key, op.get("properties", {}))
	if R.is_err(props):
		return props
	for pname: String in props["value"]:
		node.set(pname, props["value"][pname])
	if op.has("position"):
		var pr: Dictionary = Codec.decode_typed(op["position"], {"name": "position", "type": TYPE_VECTOR2}, null)
		if R.is_err(pr):
			return pr
		vs.set_node_position(t, id, pr["value"])
	if op.has("inputs"):
		var ir: Dictionary = _set_port_defaults(vs, t, id, op["inputs"])
		if R.is_err(ir):
			return ir
	var now: Dictionary = RU.non_default_properties(node, 0)
	for internal: String in NODE_INTERNAL_PROPS:
		now.erase(internal)
	var out: Dictionary = {"id": id, "class": node.get_class(), "properties": now}
	var names: Dictionary = _enum_names(node, now)
	if not names.is_empty():
		out["enum_names"] = names
	return R.value(out)


## {property: constant name} for the int enum properties among `props` (e.g. source: 2 ->
## "SOURCE_2D_TEXTURE"), so a reader does not have to look the numbers up. Names are also
## accepted as input (core/variant_codec.gd _lookup_enum).
static func _enum_names(node: VisualShaderNode, props: Dictionary) -> Dictionary:
	var out: Dictionary = {}
	for pname: String in props:
		var label: String = Codec.enum_value_name(node, pname, props[pname])
		if not label.is_empty():
			out[pname] = label
	return out


## Instantiates a VisualShaderNode class; the "VisualShaderNode" prefix is optional.
static func _make_node(type: String) -> Dictionary:
	var cls: String = type.strip_edges()
	# Prefer the prefixed name: "Input" is also the Input singleton's class and "Texture" a
	# resource, so the bare name is only used when no VisualShaderNode<name> exists.
	if not cls.begins_with("VisualShaderNode") and ClassDB.class_exists("VisualShaderNode" + cls):
		cls = "VisualShaderNode" + cls
	var is_global: bool = false
	for entry: Dictionary in ProjectSettings.get_global_class_list():
		if str(entry.get("class", "")) == cls:
			is_global = true
	if not ClassDB.class_exists(cls) and not is_global:
		var names: Array[String] = []
		for c: String in ClassDB.get_inheriters_from_class("VisualShaderNode"):
			if ClassDB.can_instantiate(c):
				names.append(c.trim_prefix("VisualShaderNode"))
		var similar: Array[String] = Fuzzy.suggest(cls.trim_prefix("VisualShaderNode"), names, 6)
		return R.err(R.BAD_PARAMS, "unknown VisualShaderNode type '%s'.%s Common types: ColorConstant, FloatConstant, Input, Texture, FloatOp, VectorOp, Mix, ColorParameter, FloatParameter, Texture2DParameter, UVFunc." % [type, Fuzzy.did_you_mean(similar)], {"suggestions": similar})
	if cls == "VisualShaderNodeOutput":
		return R.err(R.BAD_PARAMS, "every graph already has its Output node (id 0); connect to it instead of adding one.")
	var made: Dictionary = Codec.instantiate_class(cls, "VisualShaderNode")
	if R.is_err(made):
		return made
	return made


## Decodes node properties (validating VisualShaderNodeInput.input_name against the names
## valid for this mode/type). Returns {"value": {name: value}} or an error.
static func _decode_node_props(node: VisualShaderNode, key: String, props_v: Variant) -> Dictionary:
	if not props_v is Dictionary:
		return R.err(R.BAD_PARAMS, "'properties' must be an object, e.g. {\"constant\": \"#ff0000\"}.")
	var props: Dictionary = props_v
	var out: Dictionary = {}
	for k: Variant in props:
		var pname: String = str(k)
		if Codec.find_property(node, pname).is_empty():
			var names: Array[String] = []
			for n: String in Codec.property_names(node):
				if not n in NODE_INTERNAL_PROPS and not n.begins_with("resource_") and n != "script":
					names.append(n)
			return R.err(R.NOT_FOUND, "%s has no property '%s'. Its properties: %s." % [node.get_class(), pname, ", ".join(names)], {"properties": names})
		if node is VisualShaderNodeInput and pname == "input_name":
			var valid: PackedStringArray = Ports.input_names(key)
			var wanted: String = str(props[k])
			if not valid.is_empty() and not wanted in valid:
				return R.err(R.BAD_PARAMS, "'%s' is not an input of a %s shader.%s Valid inputs: %s." % [wanted, key.replace("/", " "), Fuzzy.did_you_mean(Fuzzy.suggest(wanted, valid, 3)), ", ".join(valid)], {"valid": Array(valid)})
		var r: Dictionary = Codec.decode_property(node, pname, props[k], null)
		if R.is_err(r):
			return r
		out[pname] = r["value"]
	return R.value(out)


## Sets input-port default values: {"1": 2.5, "0": [1, 0, 0]}.
static func _set_port_defaults(vs: VisualShader, t: int, id: int, inputs_v: Variant) -> Dictionary:
	if not inputs_v is Dictionary:
		return R.err(R.BAD_PARAMS, "'inputs' must map input port numbers to values, e.g. {\"1\": 2.0}.")
	var inputs: Dictionary = inputs_v
	var node: VisualShaderNode = vs.get_node(t, id)
	var count: int = _count_input_ports(vs, t, id)
	for k: Variant in inputs:
		var key: String = str(k)
		if not key.is_valid_int() or key.to_int() < 0 or key.to_int() >= count:
			return R.err(R.BAD_PARAMS, "'inputs' key '%s' is not an input port of node %d (%s), which has %d input port(s): 0..%d." % [key, id, node.get_class(), count, count - 1])
		var v: Variant = inputs[k]
		var value: Variant
		if v is bool:
			value = v
		elif v is float or v is int:
			value = float(v)
		elif v is Array and (v as Array).size() >= 2 and (v as Array).size() <= 4:
			var a: Array = v
			match a.size():
				2:
					value = Vector2(float(a[0]), float(a[1]))
				3:
					value = Vector3(float(a[0]), float(a[1]), float(a[2]))
				_:
					value = Vector4(float(a[0]), float(a[1]), float(a[2]), float(a[3]))
		elif v is String and str_to_var(v) != null:
			value = str_to_var(v)
		else:
			return R.err(R.BAD_PARAMS, "input port %s value %s is not supported; use a number, a bool, [x, y(, z, w)] or a literal like \"Vector3(1, 0, 0)\"." % [key, JSON.stringify(v)])
		node.set_input_port_default_value(key.to_int(), value)
	return R.value(true)


## Reads from/from_port/to/to_port. `to_port` may name an Output-node port ("albedo").
## `from_port` may name one component of a vector output ("0.a", "color.a"); with `expand`
## (connect) that port is expanded first, see _component_port. The result then also has
## "from_port_spec" (what was asked) and, when this call expanded it, "expanded_port".
static func _connection_ends(vs: VisualShader, t: int, key: String, op: Dictionary, expand: bool = false) -> Dictionary:
	var f: Dictionary = _existing_id(vs, t, op, "from")
	if R.is_err(f):
		return f
	var to_r: Dictionary = _existing_id(vs, t, op, "to")
	if R.is_err(to_r):
		return to_r
	var from_port_v: Variant = op.get("from_port", 0)
	var to_port_v: Variant = op.get("to_port", 0)
	var extra: Dictionary = {}
	if from_port_v is String and (from_port_v as String).is_valid_int():
		from_port_v = (from_port_v as String).to_int()
	elif from_port_v is String:
		var cp: Dictionary = _component_port(vs, t, int(f["value"]), from_port_v, expand)
		if R.is_err(cp):
			return cp
		extra["from_port_spec"] = from_port_v
		if int(cp["expanded"]) >= 0:
			extra["expanded_port"] = cp["expanded"]
		from_port_v = cp["value"]
	if not (from_port_v is float or from_port_v is int):
		return R.err(R.BAD_PARAMS, "'from_port' must be an output port number (0 = first), or one component of a vector output such as \"0.a\".")
	var to_port: int
	if to_port_v is String:
		if int(to_r["value"]) != 0 or key.is_empty():
			return R.err(R.BAD_PARAMS, "port names are only known for the Output node (to: 0); pass 'to_port' as a number.")
		to_port = Ports.output_port_index(key, to_port_v)
		if to_port < 0:
			var names: PackedStringArray = Ports.output_ports(key)
			return R.err(R.BAD_PARAMS, "the %s Output node has no port '%s'.%s Its ports in order: %s." % [key.replace("/", " "), to_port_v, Fuzzy.did_you_mean(Fuzzy.suggest(str(to_port_v), names, 3)), _indexed(names)])
	elif to_port_v is float or to_port_v is int:
		to_port = int(to_port_v)
	else:
		return R.err(R.BAD_PARAMS, "'to_port' must be an input port number (or an Output port name such as \"albedo\" when to is 0).")
	var ends: Dictionary = {"from": f["value"], "from_port": int(from_port_v), "to": to_r["value"], "to_port": to_port}
	ends.merge(extra)
	return ends


# --- expanded vector ports ----------------------------------------------------------------
#
# Godot 4 nodes output whole vectors: VisualShaderNodeTexture has ONE output, "color"
# (vec4), not the separate rgb/alpha ports of Godot 3 (verified on 4.7.2: port 1 cannot be
# connected). The graph editor's arrow button "expands" a vector output into extra scalar
# sub-ports placed right after it: an expanded vec4 at port p adds p+1..p+4 (r, g, b, a),
# and every later output port moves up by 4. The state is the node's
# `expanded_output_ports` (base port indices); can_connect_nodes() and the generated code
# use the expanded numbering (expanding Texture port 0 and linking port 4 to Alpha
# generates `n_out2p4 = n_out2p0.a`, verified). Only expandable ports grow: by default
# (VisualShaderNode::is_output_port_expandable) that is the output of a node with a SINGLE
# vector output (Texture, ColorConstant, VectorCompose, Input...); multi-output nodes such as
# TransformDecompose or ParticleMeshEmitter do not expand (verified: the port count stays
# the same). For a node that does have later ports, the editor shifts their links when it
# expands one; _component_port does the same.

## Component names -> index inside a vector port.
const COMPONENTS: Dictionary = {"x": 0, "y": 1, "z": 2, "w": 3, "r": 0, "g": 1, "b": 2, "a": 3, "alpha": 3}


## For each base (unexpanded) output port of node `id`: how many component sub-ports it gets
## when expanded (0 = not a vector port). Godot exposes no port types to scripts, so each
## port is expanded alone and the extra connectable ports are counted; the node's own
## expansion state is restored afterwards.
static func _port_layout(vs: VisualShader, t: int, id: int) -> Array[int]:
	var node: VisualShaderNode = vs.get_node(t, id)
	# Toggle with _set_output_port_expanded: assigning `expanded_output_ports` only ADDS
	# ports (set([]) clears nothing, verified on 4.7.2).
	var saved: Array = (node.get("expanded_output_ports") as Array).duplicate()
	for b: Variant in saved:
		node.call("_set_output_port_expanded", int(b), false)
	var base: int = _count_output_ports(vs, t, id)
	var sizes: Array[int] = []
	for p: int in range(base):
		node.call("_set_output_port_expanded", p, true)
		sizes.append(_count_output_ports(vs, t, id) - base)
		node.call("_set_output_port_expanded", p, false)
	for b: Variant in saved:
		node.call("_set_output_port_expanded", int(b), true)
	return sizes


## Resolves "<port>.<component>" ("0.a", "color.a", "1.x") to an expanded port index.
## The port is a base output index, or a name: names are not exposed by Godot, so a name is
## accepted when the node has exactly one vector output (Texture, ColorParameter...). With
## `expand` the port is expanded if needed (later links shifted like the editor does).
## Returns {"value": index, "expanded": base port expanded by this call or -1} or an error.
static func _component_port(vs: VisualShader, t: int, id: int, spec: String, expand: bool) -> Dictionary:
	var node: VisualShaderNode = vs.get_node(t, id)
	var dot: int = spec.rfind(".")
	var comp_name: String = spec.substr(dot + 1).to_lower() if dot > 0 else ""
	if dot <= 0 or not COMPONENTS.has(comp_name):
		return R.err(R.BAD_PARAMS, "'from_port' \"%s\" is not a port: pass a number, or one component of a vector output as \"<port>.<x|y|z|w or r|g|b|a>\", e.g. \"0.a\" for the alpha of a Texture node's color." % spec)
	var base_name: String = spec.left(dot)
	var sizes: Array[int] = _port_layout(vs, t, id)
	var vectors: Array[int] = []
	for p: int in range(sizes.size()):
		if sizes[p] > 0:
			vectors.append(p)
	var base: int = -1
	if base_name.is_valid_int():
		base = base_name.to_int()
		if base < 0 or base >= sizes.size():
			return R.err(R.BAD_PARAMS, "node %d (%s) has %d output port(s) (0..%d) before expansion; there is no port %d." % [id, node.get_class(), sizes.size(), sizes.size() - 1, base])
	elif vectors.size() == 1:
		base = vectors[0]
	else:
		return R.err(R.BAD_PARAMS, "Godot does not expose port names, so \"%s\" only works on a node with one expandable vector output; node %d (%s) has them at %s. Use the port number, e.g. \"%d.%s\"." % [spec, id, node.get_class(), str(vectors) if not vectors.is_empty() else "(none)", vectors[0] if not vectors.is_empty() else 0, comp_name])
	if sizes[base] == 0:
		return R.err(R.BAD_PARAMS, "output port %d of node %d (%s) cannot be split into components (only vector outputs the graph editor shows with an expand arrow can), so it has no .%s. Expandable outputs: %s." % [base, id, node.get_class(), comp_name, str(vectors) if not vectors.is_empty() else "(none)"])
	var comp: int = COMPONENTS[comp_name]
	if comp >= sizes[base]:
		return R.err(R.BAD_PARAMS, "output port %d of node %d (%s) is a %d-component vector; it has no .%s component." % [base, id, node.get_class(), sizes[base], comp_name])
	var expanded: Array = node.get("expanded_output_ports")
	# Where the base port sits in the expanded numbering: after the sub-ports of every
	# expanded port before it.
	var start: int = base
	for b: Variant in expanded:
		if int(b) < base and int(b) < sizes.size():
			start += sizes[int(b)]
	var did_expand: int = -1
	if not expanded.has(base):
		if not expand:
			return R.err(R.NOT_FOUND, "output port %d of node %d is not expanded, so nothing is connected to its components." % [base, id])
		var shift: int = sizes[base]
		var moved: Array = []
		for c: Dictionary in vs.get_node_connections(t):
			if int(c["from_node"]) == id and int(c["from_port"]) > start:
				moved.append(c)
		for c: Dictionary in moved:
			vs.disconnect_nodes(t, id, int(c["from_port"]), int(c["to_node"]), int(c["to_port"]))
		node.call("_set_output_port_expanded", base, true)
		for c: Dictionary in moved:
			vs.connect_nodes(t, id, int(c["from_port"]) + shift, int(c["to_node"]), int(c["to_port"]))
		did_expand = base
	return {"value": start + 1 + comp, "expanded": did_expand}


static func _existing_id(vs: VisualShader, t: int, op: Dictionary, field: String) -> Dictionary:
	var v: Variant = op.get(field)
	if not (v is float or v is int):
		return R.err(R.BAD_PARAMS, "'%s' must be a node id (number). Node ids in the %s graph: %s." % [field, _type_name(t), Array(vs.get_node_list(t))])
	var id: int = int(v)
	if not vs.get_node_list(t).has(id):
		return R.err(R.NOT_FOUND, "no node with id %d in the %s graph. Existing ids: %s (0 is the Output node). Use visual.shader_graph_read to list nodes." % [id, _type_name(t), Array(vs.get_node_list(t))])
	return R.value(id)


## can_connect_nodes() said no; work out why so the model can fix the call.
static func _explain_connect_failure(vs: VisualShader, t: int, key: String, from: int, from_port: int, to: int, to_port: int) -> Dictionary:
	var from_cls: String = vs.get_node(t, from).get_class()
	var to_cls: String = vs.get_node(t, to).get_class()
	if from == to:
		return R.err(R.BAD_PARAMS, "a node cannot be connected to itself.")
	var n_out: int = _count_output_ports(vs, t, from)
	if from_port < 0 or from_port >= n_out:
		# Usually a Godot 3 habit: separate alpha/rgb ports. Point at the vector component form.
		var hint: String = ""
		var sizes: Array[int] = _port_layout(vs, t, from)
		var expanded: Array = vs.get_node(t, from).get("expanded_output_ports")
		for p: int in range(sizes.size()):
			if sizes[p] > 0 and not expanded.has(p):
				hint = (" Port %d is a %d-component vector: to use one component pass from_port \"%d.%s\" (components x/y/z/w or r/g/b/a; a Texture node's alpha is \"0.a\")." +
					" That expands the port like the graph editor's arrow button; its components then get the port numbers right after it.") % [p, sizes[p], p, "a" if sizes[p] == 4 else "x"]
				break
		return R.err(R.BAD_PARAMS, "node %d (%s) has %d output port(s) (0..%d); from_port %d does not exist.%s" % [from, from_cls, n_out, n_out - 1, from_port, hint])
	var n_in: int = _count_input_ports(vs, t, to)
	if to_port < 0 or to_port >= n_in:
		var extra: String = ""
		if to == 0 and not Ports.output_ports(key).is_empty():
			extra = " Output ports: %s." % _indexed(Ports.output_ports(key))
		return R.err(R.BAD_PARAMS, "node %d (%s) has %d input port(s) (0..%d); to_port %d does not exist.%s" % [to, to_cls, n_in, n_in - 1, to_port, extra])
	var out_family: String = _output_family(vs, t, from, from_port)
	var in_family: String = _input_family(vs, t, to, to_port)
	if out_family != in_family:
		return R.err(R.BAD_PARAMS, "incompatible port types: node %d (%s) output %d carries %s values but node %d (%s) input %d expects %s. Scalars, vectors and booleans convert into each other; transforms and samplers only connect to their own kind." % [from, from_cls, from_port, out_family, to, to_cls, to_port, in_family])
	return R.err(R.BAD_PARAMS, "connecting node %d to node %d would create a cycle (node %d already feeds into node %d)." % [from, to, to, from])


## Number of (expanded) output ports of a node. A fresh VisualShaderNodeReroute accepts any
## port type, so can_connect_nodes(node, port, reroute, 0) is true exactly for valid ports.
static func _count_output_ports(vs: VisualShader, t: int, id: int) -> int:
	var probe := VisualShaderNodeReroute.new()
	var pid: int = vs.get_valid_node_id(t)
	vs.add_node(t, probe, Vector2(), pid)
	var n: int = 0
	while n < MAX_PORTS and vs.can_connect_nodes(t, id, n, pid, 0):
		n += 1
	vs.remove_node(t, pid)
	return n


## Number of input ports of a node: a port exists if a scalar, transform or sampler source
## (one of the three port families) can connect to it.
static func _count_input_ports(vs: VisualShader, t: int, id: int) -> int:
	var sources: Array[int] = _add_family_probes(vs, t, true)
	var n: int = 0
	while n < MAX_PORTS:
		var ok: bool = false
		for s: int in sources:
			if vs.can_connect_nodes(t, s, 0, id, n):
				ok = true
				break
		if not ok:
			break
		n += 1
	for s2: int in sources:
		vs.remove_node(t, s2)
	return n


static func _input_family(vs: VisualShader, t: int, id: int, port: int) -> String:
	var sources: Array[int] = _add_family_probes(vs, t, true)
	var family: String = "unknown"
	var names: PackedStringArray = ["scalar/vector/boolean", "transform", "sampler"]
	for i: int in sources.size():
		if family == "unknown" and vs.can_connect_nodes(t, sources[i], 0, id, port):
			family = names[i]
	for s: int in sources:
		vs.remove_node(t, s)
	return family


static func _output_family(vs: VisualShader, t: int, id: int, port: int) -> String:
	var sinks: Array[int] = _add_family_probes(vs, t, false)
	var sink_ports: Array[int] = [0, 0, 2]
	var family: String = "unknown"
	var names: PackedStringArray = ["scalar/vector/boolean", "transform", "sampler"]
	for i: int in sinks.size():
		if family == "unknown" and vs.can_connect_nodes(t, id, port, sinks[i], sink_ports[i]):
			family = names[i]
	for s: int in sinks:
		vs.remove_node(t, s)
	return family


## Adds three temporary probe nodes, one per port family (scalar-ish, transform, sampler):
## sources (output port 0 of that family) or sinks (FloatOp in 0, TransformOp in 0,
## Texture in 2 "sampler2D"). Returns their ids; the caller removes them.
static func _add_family_probes(vs: VisualShader, t: int, sources: bool) -> Array[int]:
	var nodes: Array[VisualShaderNode] = []
	if sources:
		nodes = [VisualShaderNodeFloatConstant.new(), VisualShaderNodeTransformConstant.new(), VisualShaderNodeTexture2DParameter.new()]
	else:
		nodes = [VisualShaderNodeFloatOp.new(), VisualShaderNodeTransformOp.new(), VisualShaderNodeTexture.new()]
	var ids: Array[int] = []
	for n: VisualShaderNode in nodes:
		var pid: int = vs.get_valid_node_id(t)
		vs.add_node(t, n, Vector2(), pid)
		ids.append(pid)
	return ids


# ---------------------------------------------------------------------------------------
# visual.shader_graph_read
# ---------------------------------------------------------------------------------------

## params: {path, shader_type?} -> nodes and connections per shader type.
static func shader_graph_read(params: Variant, _env: Dictionary) -> Dictionary:
	var p := Params.new(params, "visual.shader_graph_read")
	var raw: String = p.req_string("path")
	var type_name: String = p.opt_string("shader_type", "")
	if p.failed():
		return p.error
	var where: Dictionary = RU.resolve(raw)
	if R.is_err(where):
		return where
	var path: String = where["value"]
	var loaded: Dictionary = RU.load_existing(path, "visual.shader_graph_read")
	if R.is_err(loaded):
		return loaded
	if not loaded["value"] is VisualShader:
		return R.err(R.BAD_PARAMS, "visual.shader_graph_read: '%s' is a %s, not a VisualShader. Use resource.read for other resources." % [path, (loaded["value"] as Object).get_class()])
	var vs: VisualShader = loaded["value"]
	var mode: int = vs.get_mode()
	var names: Array = MODE_TYPES[mode]
	if not type_name.is_empty():
		var tc: Dictionary = _check_type(type_name, mode)
		if R.is_err(tc):
			return tc
		names = [type_name]
	var types: Dictionary = {}
	for tname: String in names:
		var t: int = TYPES[tname]
		var ids: PackedInt32Array = vs.get_node_list(t)
		var conns: Array = vs.get_node_connections(t)
		if type_name.is_empty() and ids.size() <= 1 and conns.is_empty():
			continue # untouched graph: only the Output node
		var key: String = "%s/%s" % [_mode_name(mode), tname]
		var nodes: Array = []
		for id: int in ids:
			var node: VisualShaderNode = vs.get_node(t, id)
			var pos: Vector2 = vs.get_node_position(t, id)
			var entry: Dictionary = {"id": id, "class": node.get_class(), "position": [pos.x, pos.y]}
			var props: Dictionary = RU.non_default_properties(node, 0)
			for internal: String in NODE_INTERNAL_PROPS:
				props.erase(internal)
			if not props.is_empty():
				entry["properties"] = props
				var enum_names: Dictionary = _enum_names(node, props)
				if not enum_names.is_empty():
					entry["enum_names"] = enum_names
			# Expanded vector outputs change the port numbering (see _component_port).
			var expanded: Array = node.get("expanded_output_ports")
			if not expanded.is_empty():
				entry["expanded_ports"] = expanded
			var defaults: Array = node.get_default_input_values()
			if not defaults.is_empty():
				var d: Dictionary = {}
				for i: int in range(0, defaults.size() - 1, 2):
					d[str(defaults[i])] = Codec.encode(defaults[i + 1])
				entry["inputs"] = d
			if id == 0 and not Ports.output_ports(key).is_empty():
				entry["ports"] = _indexed(Ports.output_ports(key))
			nodes.append(entry)
		var links: Array = []
		for c: Dictionary in conns:
			links.append(_conn_json(c))
		types[tname] = {"nodes": nodes, "connections": links}
	var out: Dictionary = {"path": path, "mode": _mode_name(mode), "types": types}
	if not str(where["uid"]).is_empty():
		out["uid"] = where["uid"]
	return R.ok(out)


# ---------------------------------------------------------------------------------------
# visual.layout
# ---------------------------------------------------------------------------------------

## params: {scene?, path, preset?, resize_mode?, margin?, anchors?, offsets?, size_flags?,
##          custom_minimum_size?}
static func plan_layout(root: Node, params: Variant) -> Dictionary:
	var p := Params.new(params, "visual.layout")
	var path: String = p.req_string("path")
	var preset_v: Variant = p.raw("preset")
	var resize_name: String = p.opt_string("resize_mode", "minsize")
	var margin: int = p.opt_int("margin", 0)
	var anchors: Array = p.opt_array("anchors", [])
	var offsets: Array = p.opt_array("offsets", [])
	var flags: Dictionary = p.opt_dict("size_flags", {})
	var min_size_v: Variant = p.raw("custom_minimum_size")
	if p.failed():
		return p.error
	var res: Dictionary = NodePaths.resolve(root, path)
	if R.is_err(res):
		return res
	var node: Node = res["value"]
	var edit_err: Dictionary = NodePaths.check_editable(root, node, "change the layout of")
	if not edit_err.is_empty():
		return edit_err
	if not node is Control:
		return R.err(R.BAD_PARAMS, "visual.layout: '%s' is a %s; layout presets apply to Control (UI) nodes. For 2D/3D nodes set position with node.set." % [path, node.get_class()])
	var ctl: Control = node
	if preset_v == null and anchors.is_empty() and offsets.is_empty() and flags.is_empty() and min_size_v == null:
		return R.err(R.BAD_PARAMS, "visual.layout: pass at least one of preset (e.g. \"full_rect\", \"center\"), anchors, offsets, size_flags or custom_minimum_size.")
	var parent: Node = ctl.get_parent()
	var in_container: bool = parent is Container
	if in_container and (preset_v != null or not anchors.is_empty() or not offsets.is_empty()):
		return R.err(R.BAD_PARAMS, "visual.layout: '%s' is inside the %s '%s', which positions its children; anchors/offsets/presets have no effect there. Use size_flags (e.g. {\"horizontal\": \"expand_fill\"}) and custom_minimum_size, or move the node out of the container." % [path, parent.get_class(), NodePaths.rel_path(root, parent)])

	var preset: int = -1
	if preset_v != null:
		var pr: Dictionary = _preset_value(preset_v)
		if R.is_err(pr):
			return pr
		preset = pr["value"]
	var rm: Dictionary = _lookup(RESIZE_MODES, resize_name, "resize_mode")
	if R.is_err(rm):
		return rm
	var anchor_vals: Array[float] = []
	if not anchors.is_empty():
		var ar: Dictionary = _four_numbers(anchors, "anchors")
		if R.is_err(ar):
			return ar
		anchor_vals = ar["value"]
	var offset_vals: Array[float] = []
	if not offsets.is_empty():
		var orr: Dictionary = _four_numbers(offsets, "offsets")
		if R.is_err(orr):
			return orr
		offset_vals = orr["value"]
	var flag_vals: Dictionary = {}
	for axis: Variant in flags:
		var prop: String = {"horizontal": "size_flags_horizontal", "vertical": "size_flags_vertical", "stretch_ratio": "size_flags_stretch_ratio"}.get(str(axis), "")
		if prop.is_empty():
			return R.err(R.BAD_PARAMS, "visual.layout: size_flags keys are horizontal, vertical and stretch_ratio, got '%s'." % axis)
		if prop == "size_flags_stretch_ratio":
			if not (flags[axis] is float or flags[axis] is int):
				return R.err(R.BAD_PARAMS, "visual.layout: size_flags.stretch_ratio must be a number.")
			flag_vals[prop] = float(flags[axis])
			continue
		var fr: Dictionary = _size_flags_value(flags[axis], str(axis))
		if R.is_err(fr):
			return fr
		flag_vals[prop] = fr["value"]
	var min_size: Variant = null
	if min_size_v != null:
		var mr: Dictionary = Codec.decode_typed(min_size_v, {"name": "custom_minimum_size", "type": TYPE_VECTOR2}, root)
		if R.is_err(mr):
			return mr
		min_size = mr["value"]

	# The rect before the change, so the result can say when the size changed (the dogfood
	# test only noticed by comparing offsets that a top_wide preset shrank a bar 23 -> 20 px).
	var size_before: Vector2 = _shown_size(ctl)
	var cs := ChangeSet.new()
	# Do: switch to anchor layout mode (what the inspector does when a preset is picked)
	# unless the node is a scene root / under a non-Control parent ("uncontrolled").
	var uses_anchors: bool = preset >= 0 or not anchor_vals.is_empty() or not offset_vals.is_empty()
	if uses_anchors and parent is Control and int(ctl.get("layout_mode")) != 1:
		cs.do_property(ctl, &"layout_mode", 1)
	if preset >= 0:
		cs.do_method(ctl, &"set_anchors_and_offsets_preset", [preset, int(rm["value"]), margin])
		var grow: Vector2i = _grow_for_preset(preset)
		cs.do_property(ctl, &"grow_horizontal", grow.x)
		cs.do_property(ctl, &"grow_vertical", grow.y)
		if min_size != null:
			# Control::set_offsets_preset sizes the rect from get_minimum_size() (the content
			# minimum) and ignores custom_minimum_size (scene/gui/control.cpp, Godot 4.7.2).
			# At runtime Control::_size_changed then grows the rect to the combined minimum
			# in the grow direction, so the stored offsets no longer describe what is shown
			# (MCP_TEST_LOG: top_right + [200, 0] reported a 65 px wide rect). Write the
			# offsets of the rect Godot will actually show instead.
			var fixed: Array = _offsets_with_min_size(ctl, preset, int(rm["value"]), margin, min_size, grow)
			for i: int in 4:
				if fixed[i] != null:
					cs.do_property(ctl, StringName("offset_" + SIDE_NAMES[i]), fixed[i])
	for i: int in anchor_vals.size():
		# keep_offset = true: anchors are set as given and offsets stay as they are (in the
		# headless runner the parent has no size, so "keep the rect" would mean nothing).
		cs.do_method(ctl, &"set_anchor", [i, anchor_vals[i], true, false])
	for i: int in offset_vals.size():
		cs.do_property(ctl, StringName("offset_" + SIDE_NAMES[i]), offset_vals[i])
	for prop: String in flag_vals:
		cs.do_property(ctl, StringName(prop), flag_vals[prop])
	if min_size != null:
		cs.do_property(ctl, &"custom_minimum_size", min_size)
	# Undo: restore every value we may have touched, raw anchors first, then offsets.
	cs.undo_property(ctl, &"layout_mode", int(ctl.get("layout_mode")))
	for i: int in 4:
		cs.undo_method(ctl, &"set_anchor", [i, ctl.get_anchor(i), true, false])
	for i: int in 4:
		cs.undo_property(ctl, StringName("offset_" + SIDE_NAMES[i]), ctl.get_offset(i))
	cs.undo_property(ctl, &"grow_horizontal", ctl.grow_horizontal)
	cs.undo_property(ctl, &"grow_vertical", ctl.grow_vertical)
	for prop: String in flag_vals:
		cs.undo_property(ctl, StringName(prop), ctl.get(prop))
	if min_size != null:
		cs.undo_property(ctl, &"custom_minimum_size", ctl.custom_minimum_size)

	var finish := func() -> Dictionary:
		var out: Dictionary = {
			"path": NodePaths.rel_path(root, ctl),
			"layout_mode": _layout_mode_name(ctl),
			"anchors": [ctl.anchor_left, ctl.anchor_top, ctl.anchor_right, ctl.anchor_bottom],
			"offsets": [ctl.offset_left, ctl.offset_top, ctl.offset_right, ctl.offset_bottom],
			"grow": [ctl.grow_horizontal, ctl.grow_vertical],
		}
		if preset >= 0:
			out["preset"] = PRESETS.find_key(preset)
		# The resulting size, so callers don't have to work it out from anchors and offsets.
		var size_after: Vector2 = _shown_size(ctl)
		if size_after.x >= 0.0:
			out["size"] = [size_after.x, size_after.y]
			if size_before.x >= 0.0 and not size_before.is_equal_approx(size_after):
				out["previous_size"] = [size_before.x, size_before.y]
		if not flag_vals.is_empty():
			out["size_flags"] = [ctl.size_flags_horizontal, ctl.size_flags_vertical]
		if min_size != null:
			out["custom_minimum_size"] = Codec.encode(ctl.custom_minimum_size)
		# Headless the scene is not in a SceneTree, so parents have no computed rect and a
		# control stretched by its anchors reports size 0; presets that keep the size then
		# produce a zero-size rect. Say so instead of silently writing it.
		if preset >= 0 and not ctl.is_inside_tree() and ctl.size == Vector2.ZERO and int(rm["value"]) != 0:
			out["warnings"] = ["The control's size is unknown outside the editor (its anchors stretch it), so '%s' kept a size of 0. Pass offsets explicitly, use resize_mode \"minsize\" with custom_minimum_size, or run this with the editor open." % resize_name]
		return out
	return {"changes": cs, "finish": finish}


## The layout mode as the result reports it. Godot's LAYOUT_MODE_UNCONTROLLED (3) means the
## control has no parent Control (a scene root, or a child of a CanvasLayer / Node2D); its
## anchors then work relative to the viewport (Control::_get_layout_mode, and the anchors
## branch of Control::_set_state treats UNCONTROLLED like ANCHORS; scene/gui/control.cpp,
## 4.7.2). The dogfood test found the raw name "uncontrolled" confusing for a HUD under a
## CanvasLayer, so it is reported as what it does.
static func _layout_mode_name(ctl: Control) -> String:
	match int(ctl.get("layout_mode")):
		0:
			return "position"
		1:
			return "anchors"
		2:
			return "container"
		_:
			return "anchors (to the viewport: no parent Control)"


## The size the control is shown at, or (-1, -1) when it can't be known. In the editor the
## control is in the tree and Godot computed its rect. Outside the tree (headless runner)
## the size is only known on axes whose two anchors are equal: then it is the offset span.
static func _shown_size(ctl: Control) -> Vector2:
	if ctl.is_inside_tree():
		return ctl.size
	if is_equal_approx(ctl.anchor_left, ctl.anchor_right) and is_equal_approx(ctl.anchor_top, ctl.anchor_bottom):
		return Vector2(ctl.offset_right - ctl.offset_left, ctl.offset_bottom - ctl.offset_top)
	return Vector2(-1, -1)


## Offsets [left, top, right, bottom] after applying `preset` and growing the rect to
## `min_size` along each axis whose anchors don't stretch it, the way Control::_size_changed
## grows a too-small rect (GROW_DIRECTION_BEGIN moves the begin edge, END the end edge,
## BOTH splits the difference). Entries are null where nothing changes. The preset is run
## on the control and its anchors/offsets restored at once, because its offsets depend on
## the parent rect that only Godot computes.
static func _offsets_with_min_size(ctl: Control, preset: int, resize_mode: int, margin: int, min_size: Vector2, grow: Vector2i) -> Array:
	var saved_anchors: Array[float] = []
	var saved_offsets: Array[float] = []
	for i: int in 4:
		saved_anchors.append(ctl.get_anchor(i))
		saved_offsets.append(ctl.get_offset(i))
	ctl.set_anchors_and_offsets_preset(preset, resize_mode, margin)
	var anchors: Array[float] = []
	var offsets: Array[float] = []
	for i: int in 4:
		anchors.append(ctl.get_anchor(i))
		offsets.append(ctl.get_offset(i))
	for i: int in 4:
		ctl.set_anchor(i, saved_anchors[i], true, false)
	for i: int in 4:
		ctl.set_offset(i, saved_offsets[i])
	var wanted: Vector2 = min_size.max(ctl.get_minimum_size())
	var out: Array = [null, null, null, null]
	for axis: int in 2:
		var b: int = axis  # SIDE_LEFT / SIDE_TOP
		var e: int = axis + 2  # SIDE_RIGHT / SIDE_BOTTOM
		if not is_equal_approx(anchors[b], anchors[e]):
			continue  # stretched by its anchors: the size depends on the parent
		var have: float = offsets[e] - offsets[b]
		var need: float = wanted[axis]
		if have >= need:
			continue
		match grow[axis]:
			0:
				out[b] = offsets[e] - need
			1:
				out[e] = offsets[b] + need
			_:
				out[b] = offsets[b] - (need - have) / 2.0
				out[e] = offsets[e] + (need - have) / 2.0
	return out


## Control.set_grow_direction_preset() is not exposed to scripts; same mapping as the
## engine (Control::set_grow_direction_preset): 0 = begin, 1 = end, 2 = both.
static func _grow_for_preset(preset: int) -> Vector2i:
	var h: int = 2
	if preset in [0, 2, 4, 9]:
		h = 1
	elif preset in [1, 3, 6, 11]:
		h = 0
	var v: int = 2
	if preset in [0, 1, 5, 10]:
		v = 1
	elif preset in [2, 3, 7, 12]:
		v = 0
	return Vector2i(h, v)


static func _preset_value(v: Variant) -> Dictionary:
	if v is float or v is int:
		var n: int = int(v)
		if n < 0 or n > 15:
			return R.err(R.BAD_PARAMS, "visual.layout: preset number must be 0..15 (Control.LayoutPreset), got %d." % n)
		return R.value(n)
	var s: String = str(v).strip_edges().to_lower().replace(" ", "_").replace("-", "_").trim_prefix("preset_")
	return _lookup(PRESETS, s, "preset")


static func _size_flags_value(v: Variant, axis: String) -> Dictionary:
	if v is float or v is int:
		return R.value(int(v))
	var parts: Array = []
	if v is Array:
		parts = v
	elif v is String:
		parts = Array((v as String).replace("|", ",").split(","))
	else:
		return R.err(R.BAD_PARAMS, "visual.layout: size_flags.%s must be a name (fill, expand, expand_fill, shrink_center, shrink_end, shrink_begin), a list of names or a number." % axis)
	var total: int = 0
	for part: Variant in parts:
		var name: String = str(part).strip_edges().to_lower().trim_prefix("size_")
		var r: Dictionary = _lookup(SIZE_FLAGS, name, "size_flags." + axis)
		if R.is_err(r):
			return r
		total |= int(r["value"])
	return R.value(total)


static func _four_numbers(arr: Array, field: String) -> Dictionary:
	if arr.size() != 4:
		return R.err(R.BAD_PARAMS, "visual.layout: '%s' must be 4 numbers [left, top, right, bottom], got %d." % [field, arr.size()])
	var out: Array[float] = []
	for v: Variant in arr:
		if not (v is float or v is int):
			return R.err(R.BAD_PARAMS, "visual.layout: '%s' must contain numbers only, got %s." % [field, JSON.stringify(v)])
		out.append(float(v))
	return R.value(out)


# ---------------------------------------------------------------------------------------
# visual.shader_check
# ---------------------------------------------------------------------------------------

## Collects shader compiler errors (Logger error type 3 = ERROR_TYPE_SHADER).
class ShaderErrorCollector extends Logger:
	var errors: Array[Dictionary] = []
	var _mutex := Mutex.new()

	func _log_error(_function: String, file: String, line: int, code: String, rationale: String,
			_editor_notify: bool, error_type: int, _script_backtraces: Array[ScriptBacktrace]) -> void:
		if error_type != 3:
			return
		_mutex.lock()
		var e: Dictionary = {"line": line, "message": rationale if not rationale.is_empty() else code}
		if not file.is_empty():
			e["file"] = file
		errors.append(e)
		_mutex.unlock()

	func _log_message(_message: String, _error: bool) -> void:
		pass


## params: {path?: .gdshader / VisualShader .tres / ShaderMaterial .tres, code?: string}
static func shader_check(params: Variant, _env: Dictionary) -> Dictionary:
	var p := Params.new(params, "visual.shader_check")
	var raw: String = p.opt_string("path", "")
	var code: String = p.opt_string("code", "")
	var has_code: bool = p.has("code")
	if p.failed():
		return p.error
	if raw.is_empty() and not has_code:
		return R.err(R.BAD_PARAMS, "visual.shader_check: pass 'code' (shader source starting with e.g. \"shader_type spatial;\") or 'path' (a .gdshader file, or a VisualShader/ShaderMaterial .tres).")
	var path: String = ""
	var source_kind: String = "code"
	if has_code and not raw.is_empty():
		# Code checked as if saved at `path` (relative #includes resolve from there).
		var at: Dictionary = RU.resolve(raw)
		if R.is_err(at):
			return at
		path = at["value"]
	if not has_code:
		var where: Dictionary = RU.resolve(raw)
		if R.is_err(where):
			return where
		path = where["value"]
		if not ResPaths.file_exists(path):
			return RU.load_existing(path, "visual.shader_check")
		var ext: String = path.get_extension().to_lower()
		if ext == "gdshaderinc":
			return R.err(R.BAD_PARAMS, "visual.shader_check: '%s' is a shader include; it cannot be compiled on its own. Check a .gdshader that #includes it." % path)
		if ext == "gdshader":
			code = FileAccess.get_file_as_string(path)
			source_kind = "file"
		else:
			# Load a private copy: VisualShader regenerates its code lazily, and we must not
			# disturb the cached instance the editor may be showing.
			var res: Resource = ResourceLoader.load(path, "", ResourceLoader.CACHE_MODE_IGNORE)
			if res is ShaderMaterial:
				res = (res as ShaderMaterial).shader
			if res is VisualShader:
				code = (res as VisualShader).get_code()
				source_kind = "visual_shader"
			elif res is Shader:
				code = (res as Shader).code
				source_kind = "file"
			else:
				return R.err(R.BAD_PARAMS, "visual.shader_check: '%s' is not a shader (got %s). Pass a .gdshader, a VisualShader .tres or a ShaderMaterial .tres." % [path, res.get_class() if res != null else "nothing loadable"])
	if not code.strip_edges().begins_with("shader_type") and not code.contains("shader_type"):
		return R.ok({"valid": false, "errors": [{"line": 1, "message": "Missing 'shader_type' declaration (e.g. \"shader_type spatial;\", \"shader_type canvas_item;\")."}], "source": source_kind})
	var shader := Shader.new()
	if not path.is_empty():
		# Lets relative #include paths resolve, without touching the resource cache.
		shader.set_path_cache(path)
	var collector := ShaderErrorCollector.new()
	OS.add_logger(collector)
	shader.code = code
	# With a threaded RenderingServer, shader_set_code is queued and compiled on the render
	# thread; a synchronous query flushes the queue so the errors arrive before we stop
	# listening.
	var uniform_list: Array = shader.get_shader_uniform_list()
	OS.remove_logger(collector)
	var errors: Array = []
	var seen: Dictionary = {}
	for e: Dictionary in collector.errors:
		var k: String = "%s:%d:%s" % [e.get("file", ""), int(e["line"]), e["message"]]
		if not seen.has(k):
			seen[k] = true
			# Shader.set_code() runs the preprocessor first but drops its error text; when it
			# fails, the raw "#..." line reaches the compiler, which reports this instead.
			if str(e["message"]).contains("Unknown character #35"):
				e["message"] = "Preprocessor directive failed on this line (e.g. #include of a file that does not exist, or a malformed #define/#if)."
			errors.append(e)
	var out: Dictionary = {"valid": errors.is_empty(), "errors": errors, "source": source_kind, "mode": _shader_mode_name(shader.get_mode())}
	if not path.is_empty():
		out["path"] = path
	if errors.is_empty():
		var uniforms: Array = []
		for u: Dictionary in uniform_list:
			uniforms.append({"name": u["name"], "type": type_string(int(u["type"]))})
		out["uniforms"] = uniforms
	return R.ok(out)


# ---------------------------------------------------------------------------------------
# Small helpers
# ---------------------------------------------------------------------------------------

static func _lookup(table: Dictionary, name: String, field: String) -> Dictionary:
	var key: String = name.strip_edges().to_lower()
	if table.has(key):
		return R.value(table[key])
	var names: Array = table.keys()
	return R.err(R.BAD_PARAMS, "'%s' is not a valid %s.%s Valid values: %s." % [name, field, Fuzzy.did_you_mean(Fuzzy.suggest(key, names, 3)), ", ".join(names)], {"valid": names})


static func _check_type(type_name: String, mode: int) -> Dictionary:
	var valid: Array = MODE_TYPES[mode]
	if not type_name in valid:
		return R.err(R.BAD_PARAMS, "shader_type '%s' does not exist in a %s shader; use one of: %s." % [type_name, _mode_name(mode), ", ".join(valid)], {"valid": valid})
	return R.value(TYPES[type_name])


static func _mode_name(mode: int) -> String:
	var k: Variant = MODES.find_key(mode)
	return str(k) if k != null else str(mode)


static func _shader_mode_name(mode: int) -> String:
	return _mode_name(mode)


static func _type_name(t: int) -> String:
	return str(TYPES.find_key(t))


static func _conn_json(c: Dictionary) -> Dictionary:
	return {"from": int(c["from_node"]), "from_port": int(c["from_port"]), "to": int(c["to_node"]), "to_port": int(c["to_port"])}


## ["Albedo", "Alpha"] -> "0 Albedo, 1 Alpha"
static func _indexed(names: PackedStringArray) -> String:
	var parts: PackedStringArray = []
	for i: int in names.size():
		parts.append("%d %s" % [i, names[i]])
	return ", ".join(parts)
