@tool
extends RefCounted
## JSON <-> Variant conversion, per docs/bridge-protocol.md section 3.
##
## Encoding (Godot -> JSON) must never fail and never produce huge payloads: arrays and
## dictionaries are capped, resources become references, nodes become scene paths.
##
## Decoding (JSON -> Godot) is *type-directed*: JSON has no Vector2 or Color, so we look
## up the declared type of the target property (get_property_list) and coerce the JSON
## value into it. This lets an LLM write `[10, 20]`, `{"x": 10, "y": 20}` or
## `"Vector2(10, 20)"` and get the same result. When coercion fails we return a
## BAD_PARAMS error that names the expected type and shows example values.

const R := preload("mcp_result.gd")
const NodePaths := preload("node_paths.gd")
const Fuzzy := preload("fuzzy.gd")

## Maximum number of elements/keys encoded per container (protocol: 200).
const MAX_ITEMS: int = 200
## Recursion limit for nested containers (protects against self-referencing dictionaries).
const MAX_DEPTH: int = 8

## Number of components for vector-like types when built from a JSON array.
const _VECTOR_SIZES: Dictionary = {
	TYPE_VECTOR2: 2, TYPE_VECTOR2I: 2, TYPE_VECTOR3: 3, TYPE_VECTOR3I: 3,
	TYPE_VECTOR4: 4, TYPE_VECTOR4I: 4, TYPE_QUATERNION: 4, TYPE_PLANE: 4,
	TYPE_RECT2: 4, TYPE_RECT2I: 4,
}

## Element type for each packed array type (used to decode elements one by one).
const _PACKED_ELEMENT_TYPES: Dictionary = {
	TYPE_PACKED_BYTE_ARRAY: TYPE_INT, TYPE_PACKED_INT32_ARRAY: TYPE_INT,
	TYPE_PACKED_INT64_ARRAY: TYPE_INT, TYPE_PACKED_FLOAT32_ARRAY: TYPE_FLOAT,
	TYPE_PACKED_FLOAT64_ARRAY: TYPE_FLOAT, TYPE_PACKED_STRING_ARRAY: TYPE_STRING,
	TYPE_PACKED_VECTOR2_ARRAY: TYPE_VECTOR2, TYPE_PACKED_VECTOR3_ARRAY: TYPE_VECTOR3,
	TYPE_PACKED_COLOR_ARRAY: TYPE_COLOR, TYPE_PACKED_VECTOR4_ARRAY: TYPE_VECTOR4,
}

## Example values shown in error messages, keyed by Variant type.
const _EXAMPLES: Dictionary = {
	TYPE_BOOL: "true or false",
	TYPE_INT: "3",
	TYPE_FLOAT: "1.5",
	TYPE_STRING: "\"some text\"",
	TYPE_STRING_NAME: "\"some_name\"",
	TYPE_NODE_PATH: "\"../Sibling\" (relative to the node being edited) or {\"node\": \"Path/From/Scene/Root\"}",
	TYPE_VECTOR2: "[10, 20], {\"x\": 10, \"y\": 20} or \"Vector2(10, 20)\"",
	TYPE_VECTOR2I: "[10, 20], {\"x\": 10, \"y\": 20} or \"Vector2i(10, 20)\"",
	TYPE_VECTOR3: "[1, 2, 3], {\"x\": 1, \"y\": 2, \"z\": 3} or \"Vector3(1, 2, 3)\"",
	TYPE_VECTOR3I: "[1, 2, 3] or \"Vector3i(1, 2, 3)\"",
	TYPE_VECTOR4: "[1, 2, 3, 4] or \"Vector4(1, 2, 3, 4)\"",
	TYPE_VECTOR4I: "[1, 2, 3, 4] or \"Vector4i(1, 2, 3, 4)\"",
	TYPE_RECT2: "[x, y, width, height], {\"position\": [0, 0], \"size\": [32, 32]} or \"Rect2(0, 0, 32, 32)\"",
	TYPE_RECT2I: "[x, y, width, height] or \"Rect2i(0, 0, 32, 32)\"",
	TYPE_COLOR: "\"#ff8800\", \"red\", [1, 0.5, 0] / [1, 0.5, 0, 1], {\"r\": 1, \"g\": 0.5, \"b\": 0} or \"Color(1, 0.5, 0, 1)\"",
	TYPE_QUATERNION: "[0, 0, 0, 1] or \"Quaternion(0, 0, 0, 1)\"",
	TYPE_PLANE: "[0, 1, 0, 0] (normal x, y, z, d) or \"Plane(0, 1, 0, 0)\"",
	TYPE_TRANSFORM2D: "\"Transform2D(1, 0, 0, 1, 0, 0)\" (x axis, y axis, origin)",
	TYPE_BASIS: "\"Basis(1, 0, 0, 0, 1, 0, 0, 0, 1)\"",
	TYPE_TRANSFORM3D: "\"Transform3D(1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0)\" (basis columns, then origin)",
	TYPE_AABB: "\"AABB(0, 0, 0, 1, 1, 1)\" (position, size)",
	TYPE_PROJECTION: "\"Projection(1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1)\"",
	TYPE_OBJECT: "\"res://path/to/resource.tres\", {\"new\": \"ClassName\", \"properties\": {...}} or null",
	TYPE_DICTIONARY: "{\"key\": \"value\"}",
	TYPE_ARRAY: "[1, 2, 3]",
}


# ---------------------------------------------------------------------------------------
# JSON text
# ---------------------------------------------------------------------------------------

static var _control_char_re: RegEx


## JSON.stringify() replacement that always produces valid JSON.
##
## Godot's JSON.stringify escapes \n, \t, quotes etc. but leaves other control characters
## (e.g. the ESC of ANSI color codes in editor log lines) raw, which strict parsers such as
## JavaScript's JSON.parse reject. Raw control characters can only occur inside string
## literals in the output, so replacing each with a \u00XX escape is always safe.
static func to_json(v: Variant) -> String:
	var s: String = JSON.stringify(v)
	if _control_char_re == null:
		_control_char_re = RegEx.create_from_string("[\\x01-\\x1f]")
	var matches: Array[RegExMatch] = _control_char_re.search_all(s)
	if matches.is_empty():
		return s
	var parts: PackedStringArray = []
	var last: int = 0
	for m: RegExMatch in matches:
		parts.append(s.substr(last, m.get_start() - last))
		parts.append("\\u%04x" % s.unicode_at(m.get_start()))
		last = m.get_end()
	parts.append(s.substr(last))
	return "".join(parts)


# ---------------------------------------------------------------------------------------
# Encoding
# ---------------------------------------------------------------------------------------

## True when a value read back after a set is not what was set (Godot clamped it, or a
## setter changed it), for the "reads back as" warnings of node.set, resource.set and
## game.set. Floats compare approximately: a GDScript float is 64-bit, but many engine
## properties store a 32-bit float, so 1.6 reads back as 1.60000002384186 (float32 keeps
## about 7 significant digits; is_equal_approx allows a relative 1e-5). Vectors, colors,
## quaternions and transforms use their own is_equal_approx for the same reason.
static func read_back_differs(now: Variant, wanted: Variant) -> bool:
	if typeof(now) != typeof(wanted) or wanted is Object:
		return false
	if now is float:
		return not is_equal_approx(now, wanted)
	match typeof(now):
		TYPE_VECTOR2, TYPE_VECTOR3, TYPE_VECTOR4, TYPE_COLOR, TYPE_QUATERNION, TYPE_PLANE, \
		TYPE_RECT2, TYPE_AABB, TYPE_TRANSFORM2D, TYPE_TRANSFORM3D, TYPE_BASIS:
			return not now.is_equal_approx(wanted)
	return now != wanted


## Converts any Variant into a JSON-safe value. `root` is the scene root used to express
## Node references as scene-relative paths (may be null).
static func encode(v: Variant, root: Node = null, depth: int = 0) -> Variant:
	if depth > MAX_DEPTH:
		return "…(max depth)"
	var t: int = typeof(v)
	match t:
		TYPE_NIL, TYPE_BOOL, TYPE_INT, TYPE_STRING:
			return v
		TYPE_FLOAT:
			# JSON cannot represent inf/nan; JSON.stringify would emit "1e99999" or null.
			# var_to_str gives "inf", "-inf" or "nan", which is unambiguous for the reader.
			return v if is_finite(v) else var_to_str(v)
		TYPE_STRING_NAME, TYPE_NODE_PATH:
			return str(v)
		TYPE_ARRAY:
			return _encode_list(v, root, depth)
		TYPE_DICTIONARY:
			return _encode_dict(v, root, depth)
		TYPE_OBJECT:
			return _encode_object(v, root, depth)
		_:
			if _PACKED_ELEMENT_TYPES.has(t):
				return _encode_list(v, root, depth)
			# Every other built-in (Vector2, Color, Transform3D, RID, Callable, ...) uses the
			# same text form as .tscn files, which str_to_var() can read back.
			return var_to_str(v)


static func _encode_list(list: Variant, root: Node, depth: int) -> Array:
	var out: Array = []
	var n: int = list.size()
	for i: int in range(mini(n, MAX_ITEMS)):
		out.append(encode(list[i], root, depth + 1))
	if n > MAX_ITEMS:
		out.append("…(+%d more)" % (n - MAX_ITEMS))
	return out


static func _encode_dict(d: Dictionary, root: Node, depth: int) -> Dictionary:
	var out: Dictionary = {}
	var count: int = 0
	for key: Variant in d:
		if count >= MAX_ITEMS:
			out["…"] = "(+%d more keys)" % (d.size() - MAX_ITEMS)
			break
		var k: String = str(key) if (key is String or key is StringName) else var_to_str(key)
		out[k] = encode(d[key], root, depth + 1)
		count += 1
	return out


static func _encode_object(obj: Object, root: Node, depth: int) -> Variant:
	if obj == null:
		return null
	if not is_instance_valid(obj):
		return {"object": "<freed>"}
	if obj is Node:
		return {"node": NodePaths.rel_path(root, obj), "class": obj.get_class()}
	if obj is Resource:
		var res: Resource = obj
		var path: String = res.resource_path
		if not path.is_empty() and not path.contains("::"):
			return {"resource": path, "class": res.get_class()}
		var out: Dictionary = {"resource": null, "class": res.get_class(), "embedded": true}
		# Extension to the protocol (extra keys are allowed): for top-level embedded
		# resources also show their stored properties, otherwise e.g. a CollisionShape2D's
		# RectangleShape2D size would be invisible to the client. Only the non-default ones
		# (with a count of the rest): a StandardMaterial3D has ~150 stored properties, and
		# node.get / node.set read-backs used to list all of them.
		if depth == 0:
			var omitted: Array = [0]
			out["properties"] = encode_object_properties(res, root, depth + 1, omitted)
			if int(omitted[0]) > 0:
				out["defaults_omitted"] = omitted[0]
		return out
	return {"object": obj.get_class()}


## Encodes the stored, non-internal properties of an object (used for embedded resources).
## When `omitted` is given (a one-element Array used as an out-parameter), properties equal
## to their class/script default are skipped and counted in omitted[0]; without it every
## stored property is encoded (audio effect listings rely on that).
static func encode_object_properties(obj: Object, root: Node, depth: int = 1, omitted: Variant = null) -> Dictionary:
	var out: Dictionary = {}
	var skip_defaults: bool = omitted is Array and not (omitted as Array).is_empty()
	var script: Script = obj.get_script() as Script
	for info: Dictionary in obj.get_property_list():
		var usage: int = info["usage"]
		if (usage & PROPERTY_USAGE_STORAGE) == 0:
			continue
		var pname: String = info["name"]
		if pname.begins_with("resource_") or pname == "script" or pname.begins_with("_"):
			continue
		var v: Variant = obj.get(pname)
		if skip_defaults and _is_default_value(obj, script, pname, v):
			omitted[0] = int(omitted[0]) + 1
			continue
		out[pname] = encode(v, root, depth)
	if obj is Curve2D or obj is Curve3D:
		out["points"] = curve_points(obj)
	return out


## Maximum curve points listed by curve_points().
const MAX_CURVE_POINTS: int = 100


## The points of a Curve2D/Curve3D, compactly: [x, y(, z)] for a point without handles,
## {"position", "in", "out"(, "tilt")} otherwise. Needed because a curve stores its points
## in the internal `_data` property and lists them only as editor-only "point_N/..."
## properties, so stored-property readbacks (node.get on a Path2D, node.set) showed nothing
## but point_count (MCP_TEST_LOG). Points are edited with node.set "curve:point_0/position".
static func curve_points(curve: Object) -> Array:
	var out: Array = []
	var count: int = curve.get("point_count")
	var is_3d: bool = curve is Curve3D
	var zero: Variant = Vector2.ZERO
	if is_3d:
		zero = Vector3.ZERO
	for i: int in range(mini(count, MAX_CURVE_POINTS)):
		var pos: Variant = curve.call("get_point_position", i)
		var p_in: Variant = curve.call("get_point_in", i)
		var p_out: Variant = curve.call("get_point_out", i)
		var tilt: float = 0.0
		if is_3d:
			tilt = curve.call("get_point_tilt", i)
		if p_in == zero and p_out == zero and tilt == 0.0:
			out.append(_components(pos))
		else:
			var entry: Dictionary = {"position": _components(pos), "in": _components(p_in), "out": _components(p_out)}
			if tilt != 0.0:
				entry["tilt"] = tilt
			out.append(entry)
	if count > MAX_CURVE_POINTS:
		out.append("…(+%d more)" % (count - MAX_CURVE_POINTS))
	return out


## Vector2/Vector3 -> [x, y(, z)] with whole numbers as ints.
static func _components(v: Variant) -> Array:
	var out: Array = []
	var n: int = 3 if v is Vector3 else 2
	for i: int in range(n):
		var f: float = v[i]
		if f == floorf(f) and absf(f) < 1e9:
			out.append(int(f))
		else:
			out.append(f)
	return out


## True when `v` equals the class default of `pname` (or the script default when the class
## has none). Unknown defaults (null) only match a null value, so nothing is hidden by mistake.
static func _is_default_value(obj: Object, script: Script, pname: String, v: Variant) -> bool:
	var default: Variant = ClassDB.class_get_property_default_value(obj.get_class(), pname)
	if default == null and script != null:
		default = script.get_property_default_value(pname)
	if default == null:
		return v == null
	return typeof(v) == typeof(default) and v == default


# ---------------------------------------------------------------------------------------
# Property lookup
# ---------------------------------------------------------------------------------------

## Returns the property info dictionary for `prop` on `obj`, or {} if it does not exist.
## "metadata/<name>" is always accepted (it maps to Object.set_meta).
static func find_property(obj: Object, prop: String) -> Dictionary:
	for info: Dictionary in obj.get_property_list():
		if info["name"] == prop:
			var usage: int = info["usage"]
			if usage & (PROPERTY_USAGE_GROUP | PROPERTY_USAGE_SUBGROUP | PROPERTY_USAGE_CATEGORY):
				return {}
			if is_array_header(info):
				return {}
			return info
	if prop.begins_with("metadata/") and prop.length() > 9:
		return {"name": prop, "type": TYPE_NIL, "hint": PROPERTY_HINT_NONE, "hint_string": "", "usage": PROPERTY_USAGE_DEFAULT, "class_name": &""}
	return {}


## Names of settable, user-facing properties of `obj` (for suggestions and listings).
static func property_names(obj: Object) -> Array[String]:
	var out: Array[String] = []
	for info: Dictionary in obj.get_property_list():
		var usage: int = info["usage"]
		if usage & (PROPERTY_USAGE_GROUP | PROPERTY_USAGE_SUBGROUP | PROPERTY_USAGE_CATEGORY):
			continue
		if (usage & (PROPERTY_USAGE_STORAGE | PROPERTY_USAGE_EDITOR)) == 0:
			continue
		if is_array_header(info):
			continue
		out.append(str(info["name"]))
	return out


## True for the inspector's array headers that engine classes add with ADD_ARRAY (C++):
## e.g. TileSet "physics_layers", "navigation_layers", "occlusion_layers" are listed as
## {type: NIL, usage: EDITOR | ARRAY} (verified on 4.7.2) but are not properties: set()
## ignores them and get() returns null. The real values live in "physics_layer_0/..." etc.
## Array COUNT properties ("point_count", type INT with the ARRAY flag) are real and kept.
static func is_array_header(info: Dictionary) -> bool:
	return int(info.get("type", TYPE_NIL)) == TYPE_NIL and (int(info.get("usage", 0)) & PROPERTY_USAGE_ARRAY) != 0


## NOT_FOUND error for an unknown property, with up to 10 similar names.
static func unknown_property_error(obj: Object, prop: String, label: String) -> Dictionary:
	var names: Array[String] = property_names(obj)
	var similar: Array[String] = Fuzzy.suggest(prop, names, 10)
	var msg: String = "%s has no property '%s'." % [label, prop]
	if not similar.is_empty():
		msg += " Similar properties: %s." % ", ".join(similar)
	msg += " Use node.get to list all properties and their current values."
	return R.err(R.NOT_FOUND, msg, {"similar": similar})


# ---------------------------------------------------------------------------------------
# Decoding
# ---------------------------------------------------------------------------------------

## Decodes `value` for property `prop` of `obj`. Returns {"value": v} or an error.
## `root` is the scene root, used to resolve node references ({"node": "Path"}).
static func decode_property(obj: Object, prop: String, value: Variant, root: Node) -> Dictionary:
	var info: Dictionary = find_property(obj, prop)
	if info.is_empty():
		return unknown_property_error(obj, prop, _label(obj))
	return decode_typed(value, info, root, obj)


## Decodes `value` according to a property info dictionary. `obj` (optional) is the object
## the value is for; it lets typed arrays/dictionaries keep their element types.
static func decode_typed(value: Variant, info: Dictionary, root: Node, obj: Object = null) -> Dictionary:
	var t: int = info.get("type", TYPE_NIL)
	var prop: String = str(info.get("name", "value"))
	var hint: int = info.get("hint", PROPERTY_HINT_NONE)
	var hint_string: String = str(info.get("hint_string", ""))

	if value == null:
		if t == TYPE_NIL or t == TYPE_OBJECT:
			return R.value(null)
		return _type_error(prop, t, value, "null is only allowed for Object/Resource or untyped properties")

	match t:
		TYPE_NIL:
			return _decode_untyped(value, root)
		TYPE_BOOL:
			if value is bool:
				return R.value(value)
			if (value is float or value is int) and (value == 0 or value == 1):
				return R.value(value == 1)
			if value is String and (value as String).to_lower() in ["true", "false"]:
				return R.value((value as String).to_lower() == "true")
		TYPE_INT:
			return _decode_int(value, info, obj)
		TYPE_FLOAT:
			if value is float or value is int:
				return R.value(float(value))
			if value is String and (value as String).is_valid_float():
				return R.value((value as String).to_float())
		TYPE_STRING:
			if value is String or value is StringName:
				return R.value(str(value))
			if value is float or value is int or value is bool:
				# Numbers for a String property are almost certainly intended as text.
				return R.value(_number_to_text(value))
		TYPE_STRING_NAME:
			if value is String or value is StringName:
				return R.value(StringName(value))
		TYPE_NODE_PATH:
			return _decode_node_path(value, info, root, obj)
		TYPE_COLOR:
			return _decode_color(value, prop)
		TYPE_ARRAY:
			return _decode_array(value, info, root, obj)
		TYPE_DICTIONARY:
			return _decode_dictionary(value, info, root, obj)
		TYPE_OBJECT:
			return _decode_object(value, prop, hint, hint_string, root)
		TYPE_CALLABLE, TYPE_SIGNAL, TYPE_RID:
			return R.err(R.BAD_PARAMS, "Property '%s' has type %s, which cannot be set from JSON." % [prop, type_string(t)])
		_:
			if _PACKED_ELEMENT_TYPES.has(t):
				return _decode_packed(value, t, prop, root)
			return _decode_math(value, t, prop)
	return _type_error(prop, t, value)


static func _label(obj: Object) -> String:
	if obj is Node:
		return "Node '%s' (%s)" % [(obj as Node).name, obj.get_class()]
	return obj.get_class()


static func _number_to_text(v: Variant) -> String:
	if v is float and float(v) == floorf(v) and absf(v) < 1e15:
		return str(int(v))
	return str(v)


static func _type_error(prop: String, t: int, value: Variant, extra: String = "") -> Dictionary:
	var expected: String = type_string(t) if t != TYPE_NIL else "Variant"
	var msg: String = "Cannot set '%s' (expected %s) from %s." % [prop, expected, _short_json(value)]
	if not extra.is_empty():
		msg += " " + extra + "."
	if _EXAMPLES.has(t):
		msg += " Valid examples: %s." % _EXAMPLES[t]
	return R.err(R.BAD_PARAMS, msg, {"property": prop, "expected_type": expected})


static func _short_json(value: Variant) -> String:
	var s: String = JSON.stringify(value)
	return s if s.length() <= 120 else s.left(117) + "..."


## Untyped (Variant) properties: script variables without a type, metadata, dictionary
## values. We cannot know the intended type, so we only convert unambiguous forms:
## "Vector2(1, 2)"-style constructor strings, {"new": ...}/{"resource": ...} objects and
## integral floats (JSON has no int type).
static func _decode_untyped(value: Variant, root: Node) -> Dictionary:
	if value is float:
		if is_finite(value) and float(value) == floorf(value) and absf(value) < 9.0e15:
			return R.value(int(value))
		return R.value(value)
	if value is String:
		var s: String = value
		if _looks_like_constructor(s):
			var parsed: Variant = str_to_var(s)
			if parsed != null:
				return R.value(parsed)
		return R.value(s)
	if value is Array:
		var out: Array = []
		for item: Variant in value:
			var r: Dictionary = _decode_untyped(item, root)
			if R.is_err(r):
				return r
			out.append(r["value"])
		return R.value(out)
	if value is Dictionary:
		var d: Dictionary = value
		if d.has("new") or d.has("resource"):
			return _decode_object(value, "value", PROPERTY_HINT_NONE, "", root)
		var out_d: Dictionary = {}
		for k: Variant in d:
			var r2: Dictionary = _decode_untyped(d[k], root)
			if R.is_err(r2):
				return r2
			out_d[k] = r2["value"]
		return R.value(out_d)
	return R.value(value)


static func _looks_like_constructor(s: String) -> bool:
	var re: RegEx = RegEx.create_from_string("^[A-Z][A-Za-z0-9]*\\(.*\\)$")
	return re.search(s.strip_edges()) != null


static func _decode_int(value: Variant, info: Dictionary, obj: Object = null) -> Dictionary:
	var prop: String = str(info.get("name", "value"))
	if value is int:
		return R.value(value)
	if value is float:
		if is_finite(value) and float(value) == floorf(value):
			return R.value(int(value))
		return _type_error(prop, TYPE_INT, value, "the value must be a whole number")
	if value is bool:
		return R.value(1 if value else 0)
	if value is String:
		var s: String = (value as String).strip_edges()
		if s.is_valid_int():
			return R.value(s.to_int())
		var enum_value: Variant = _lookup_enum(s, info, obj)
		if enum_value != null:
			return R.value(enum_value)
		var names: PackedStringArray = _enum_names(info, obj)
		if not names.is_empty():
			return _type_error(prop, TYPE_INT, value, "valid values for this enum: %s; pass the name or the number" % ", ".join(names))
	return _type_error(prop, TYPE_INT, value)


## Resolves an enum name for an int property. Accepted, case/space/underscore-insensitive:
## * the inspector labels from hint_string ("Floating" for motion_mode, "Texture2D" for
##   VisualShaderNodeTexture.source);
## * the C++/GDScript constant names ("MOTION_MODE_FLOATING", "SOURCE_2D_TEXTURE",
##   "OP_TYPE_VECTOR_3D_SCALAR"), with or without the enum's common prefix ("2D_TEXTURE",
##   "VECTOR_3D_SCALAR").
## Constant names matter because the labels and the documented constants often differ:
## VisualShaderNodeMix.op_type's label is "Vector3Scalar" while the class reference says
## OP_TYPE_VECTOR_3D_SCALAR, and the source label "Texture" is SOURCE_TEXTURE, not the 2D
## texture (MCP_TEST_LOG: both were guessed wrong by number). `obj` lets us find the enum
## when the property info itself does not name it (see _enum_ref).
static func _lookup_enum(s: String, info: Dictionary, obj: Object = null) -> Variant:
	var want: String = _norm_enum(s)
	for entry: Array in _hint_entries(info):
		if _norm_enum(entry[0]) == want:
			return entry[1]
	var consts: Dictionary = _enum_constants(info, obj)
	if consts.is_empty():
		return null
	var prefix: String = _common_prefix(consts.keys())
	var tail_hits: Array[String] = []
	for c: String in consts:
		if _norm_enum(c) == want or _norm_enum(c.trim_prefix(prefix)) == want:
			return consts[c]
		if _norm_enum(c).ends_with(want):
			tail_hits.append(c)
	# Last resort: a unique suffix ("FLOATING"), never an ambiguous one ("TEXTURE" would
	# match SOURCE_TEXTURE and SOURCE_2D_TEXTURE).
	if tail_hits.size() == 1:
		return consts[tail_hits[0]]
	return null


## [label, value] pairs of a PROPERTY_HINT_ENUM hint_string ("A,B:5,C" -> A=0, B=5, C=6).
static func _hint_entries(info: Dictionary) -> Array:
	var out: Array = []
	var hint: int = info.get("hint", PROPERTY_HINT_NONE)
	if hint != PROPERTY_HINT_ENUM and hint != PROPERTY_HINT_ENUM_SUGGESTION:
		return out
	var next_value: int = 0
	for item: String in str(info.get("hint_string", "")).split(",", false):
		var label: String = item
		var val: int = next_value
		var colon: int = item.rfind(":")
		if colon >= 0 and item.substr(colon + 1).strip_edges().is_valid_int():
			label = item.left(colon)
			val = item.substr(colon + 1).strip_edges().to_int()
		out.append([label, val])
		next_value = val + 1
	return out


## The native enum behind an int property as "Class.Enum", or "". The property info names
## it for some classes ("CharacterBody2D.MotionMode"), but many engine properties are
## registered with an empty class_name (all VisualShaderNode enums, verified on 4.7.2). Their
## setter's argument still carries the enum ("set_source(value: VisualShaderNodeTexture.Source)"),
## so we look there. Global enums ("HorizontalAlignment") are not in ClassDB and return "".
static func _enum_ref(info: Dictionary, obj: Object) -> String:
	var ref: String = str(info.get("class_name", ""))
	if ref.contains(".") or obj == null:
		return ref if ref.contains(".") else ""
	var prop: String = str(info.get("name", ""))
	var cls: String = obj.get_class()
	if prop.is_empty():
		return ""
	# "" for script and dynamic properties (no error printed, verified on 4.7.2).
	var setter: StringName = ClassDB.class_get_property_setter(cls, prop)
	if setter == &"":
		return ""
	for m: Dictionary in ClassDB.class_get_method_list(cls):
		if m["name"] == setter:
			var args: Array = m["args"]
			if args.is_empty():
				return ""
			var cn: String = str((args[args.size() - 1] as Dictionary).get("class_name", ""))
			return cn if cn.contains(".") else ""
	return ""


## constant name -> value for the property's native enum (without the "<PREFIX>_MAX"
## sentinel), or {} when unknown.
static func _enum_constants(info: Dictionary, obj: Object) -> Dictionary:
	var out: Dictionary = {}
	var ref: String = _enum_ref(info, obj)
	if ref.is_empty():
		return out
	var cls: String = ref.get_slice(".", 0)
	var enum_name: String = ref.get_slice(".", 1)
	if not ClassDB.class_exists(cls):
		return out
	for c: String in ClassDB.class_get_enum_constants(cls, enum_name):
		if c.ends_with("_MAX"):
			continue
		out[c] = ClassDB.class_get_integer_constant(cls, c)
	return out


## Longest common prefix of the names that ends in "_" ("SOURCE_", "OP_TYPE_"), or "".
static func _common_prefix(names: Array) -> String:
	if names.size() < 2:
		return ""
	var prefix: String = str(names[0])
	for n: Variant in names:
		var s: String = str(n)
		while not prefix.is_empty() and not s.begins_with(prefix):
			prefix = prefix.left(prefix.length() - 1)
	var cut: int = prefix.rfind("_")
	return prefix.left(cut + 1) if cut >= 0 else ""


## "Label = value (CONSTANT)" for every value of the property's enum, for error messages.
static func _enum_names(info: Dictionary, obj: Object = null) -> PackedStringArray:
	var out: PackedStringArray = []
	var consts: Dictionary = _enum_constants(info, obj)
	var by_value: Dictionary = {}
	for c: String in consts:
		if not by_value.has(consts[c]):
			by_value[consts[c]] = c
	var entries: Array = _hint_entries(info)
	for entry: Array in entries:
		var text: String = "%s = %d" % [entry[0], entry[1]]
		if by_value.has(entry[1]):
			text += " (%s)" % by_value[entry[1]]
		out.append(text)
	if entries.is_empty():
		for c: String in consts:
			out.append("%s = %d" % [c, consts[c]])
	return out


## The name of an enum value for read-backs: the constant name when the enum is known
## ("SOURCE_2D_TEXTURE"), else the inspector label, else "" (not an enum property).
static func enum_value_name(obj: Object, prop: String, value: Variant) -> String:
	if not (value is int):
		return ""
	var info: Dictionary = find_property(obj, prop)
	if info.is_empty() or int(info.get("type", TYPE_NIL)) != TYPE_INT:
		return ""
	var consts: Dictionary = _enum_constants(info, obj)
	for c: String in consts:
		if consts[c] == value:
			return c
	for entry: Array in _hint_entries(info):
		if entry[1] == value:
			return entry[0]
	return ""


static func _norm_enum(s: String) -> String:
	return s.to_lower().replace(" ", "").replace("_", "").replace("-", "")


static func _decode_node_path(value: Variant, info: Dictionary, root: Node, obj: Object) -> Dictionary:
	var prop: String = str(info.get("name", "value"))
	if value is String or value is StringName:
		# Plain strings are taken as-is: NodePath properties are relative to the node that
		# owns them (exactly like in the inspector / .tscn files).
		return R.value(NodePath(str(value)))
	if value is Dictionary and (value as Dictionary).has("node") and root != null:
		# {"node": "Path/From/Root"} (the encoder's node form) is converted to a path
		# relative to the node being edited.
		var res: Dictionary = NodePaths.resolve(root, str(value["node"]), prop)
		if R.is_err(res):
			return res
		var target: Node = res["value"]
		if obj is Node:
			return R.value((obj as Node).get_path_to(target))
		return R.value(NodePath(NodePaths.rel_path(root, target)))
	return _type_error(prop, TYPE_NODE_PATH, value)


static func _decode_color(value: Variant, prop: String) -> Dictionary:
	if value is String:
		var s: String = (value as String).strip_edges()
		if s.begins_with("Color("):
			var parsed: Variant = str_to_var(s)
			if parsed is Color:
				return R.value(parsed)
		else:
			# Color.from_string has no failure signal, so parse twice with two different
			# fallbacks: if both results agree, the string really was parsed.
			var a: Color = Color.from_string(s, Color(0, 0, 0, 0))
			var b: Color = Color.from_string(s, Color(1, 1, 1, 1))
			if a == b:
				return R.value(a)
	elif value is Array:
		var arr: Array = value
		if (arr.size() == 3 or arr.size() == 4) and _all_numbers(arr):
			return R.value(Color(arr[0], arr[1], arr[2], arr[3] if arr.size() == 4 else 1.0))
	elif value is Dictionary:
		var d: Dictionary = value
		if d.has("r") and d.has("g") and d.has("b") and _all_numbers([d["r"], d["g"], d["b"], d.get("a", 1.0)]):
			return R.value(Color(d["r"], d["g"], d["b"], d.get("a", 1.0)))
	return _type_error(prop, TYPE_COLOR, value)


static func _all_numbers(arr: Array) -> bool:
	for x: Variant in arr:
		if not (x is float or x is int):
			return false
	return true


## Vectors, rects, quaternions, planes, transforms, bases, AABBs, projections.
static func _decode_math(value: Variant, t: int, prop: String) -> Dictionary:
	if value is String:
		var s: String = (value as String).strip_edges()
		var parsed: Variant = str_to_var(s) if _looks_like_constructor(s) else null
		if parsed != null:
			if typeof(parsed) == t:
				return R.value(parsed)
			# Allow e.g. "Vector2(1, 2)" for a Vector2i property.
			var converted: Variant = _convert_sibling(parsed, t)
			if converted != null:
				return R.value(converted)
		elif _VECTOR_SIZES.has(t):
			# Also accept the str() form "(10, 20)" or a bare "10, 20".
			var nums: Array = _parse_number_list(s)
			if nums.size() == _VECTOR_SIZES[t]:
				return _build_from_array(nums, t, prop, value)
	elif value is Array:
		return _build_from_array(value, t, prop, value)
	elif value is Dictionary:
		var built: Variant = _build_from_dict(value, t)
		if built != null:
			return R.value(built)
	return _type_error(prop, t, value)


static func _convert_sibling(v: Variant, t: int) -> Variant:
	var pairs: Dictionary = {
		TYPE_VECTOR2: TYPE_VECTOR2I, TYPE_VECTOR2I: TYPE_VECTOR2,
		TYPE_VECTOR3: TYPE_VECTOR3I, TYPE_VECTOR3I: TYPE_VECTOR3,
		TYPE_VECTOR4: TYPE_VECTOR4I, TYPE_VECTOR4I: TYPE_VECTOR4,
		TYPE_RECT2: TYPE_RECT2I, TYPE_RECT2I: TYPE_RECT2,
	}
	if pairs.get(typeof(v), -1) == t:
		return type_convert(v, t)
	return null


static func _parse_number_list(s: String) -> Array:
	var inner: String = s.trim_prefix("(").trim_suffix(")")
	var out: Array = []
	for part: String in inner.split(",", false):
		var p: String = part.strip_edges()
		if not p.is_valid_float():
			return []
		out.append(p.to_float())
	return out


static func _build_from_array(arr: Array, t: int, prop: String, original: Variant) -> Dictionary:
	if not _VECTOR_SIZES.has(t) or arr.size() != _VECTOR_SIZES[t] or not _all_numbers(arr):
		return _type_error(prop, t, original)
	match t:
		TYPE_VECTOR2: return R.value(Vector2(arr[0], arr[1]))
		TYPE_VECTOR2I: return R.value(Vector2i(int(arr[0]), int(arr[1])))
		TYPE_VECTOR3: return R.value(Vector3(arr[0], arr[1], arr[2]))
		TYPE_VECTOR3I: return R.value(Vector3i(int(arr[0]), int(arr[1]), int(arr[2])))
		TYPE_VECTOR4: return R.value(Vector4(arr[0], arr[1], arr[2], arr[3]))
		TYPE_VECTOR4I: return R.value(Vector4i(int(arr[0]), int(arr[1]), int(arr[2]), int(arr[3])))
		TYPE_QUATERNION: return R.value(Quaternion(arr[0], arr[1], arr[2], arr[3]))
		TYPE_PLANE: return R.value(Plane(arr[0], arr[1], arr[2], arr[3]))
		TYPE_RECT2: return R.value(Rect2(arr[0], arr[1], arr[2], arr[3]))
		TYPE_RECT2I: return R.value(Rect2i(int(arr[0]), int(arr[1]), int(arr[2]), int(arr[3])))
	return _type_error(prop, t, original)


static func _build_from_dict(d: Dictionary, t: int) -> Variant:
	var x: Variant = d.get("x")
	var y: Variant = d.get("y")
	var z: Variant = d.get("z")
	var w: Variant = d.get("w")
	match t:
		TYPE_VECTOR2, TYPE_VECTOR2I:
			if _all_numbers([x, y]):
				if t == TYPE_VECTOR2:
					return Vector2(x, y)
				return Vector2i(int(x), int(y))
		TYPE_VECTOR3, TYPE_VECTOR3I:
			if _all_numbers([x, y, z]):
				if t == TYPE_VECTOR3:
					return Vector3(x, y, z)
				return Vector3i(int(x), int(y), int(z))
		TYPE_VECTOR4, TYPE_VECTOR4I, TYPE_QUATERNION:
			if _all_numbers([x, y, z, w]):
				if t == TYPE_VECTOR4:
					return Vector4(x, y, z, w)
				if t == TYPE_VECTOR4I:
					return Vector4i(int(x), int(y), int(z), int(w))
				return Quaternion(x, y, z, w)
		TYPE_RECT2, TYPE_RECT2I:
			var pos: Variant = d.get("position")
			var size: Variant = d.get("size")
			if pos is Array and size is Array and (pos as Array).size() == 2 and (size as Array).size() == 2 \
					and _all_numbers(pos) and _all_numbers(size):
				var r := Rect2(pos[0], pos[1], size[0], size[1])
				if t == TYPE_RECT2:
					return r
				return Rect2i(r)
			var width: Variant = d.get("width", d.get("w"))
			var height: Variant = d.get("height", d.get("h"))
			if _all_numbers([x, y, width, height]):
				var r2 := Rect2(x, y, width, height)
				if t == TYPE_RECT2:
					return r2
				return Rect2i(r2)
	return null


static func _decode_packed(value: Variant, t: int, prop: String, root: Node) -> Dictionary:
	if not value is Array:
		return _type_error(prop, t, value, "expected a JSON array")
	var elem_type: int = _PACKED_ELEMENT_TYPES[t]
	var elem_info: Dictionary = {"name": prop + "[]", "type": elem_type}
	var out: Array = []
	for item: Variant in value:
		var r: Dictionary = decode_typed(item, elem_info, root)
		if R.is_err(r):
			return r
		out.append(r["value"])
	# Variant construction of a packed array from an Array of matching elements.
	return R.value(type_convert(out, t))


static func _decode_array(value: Variant, info: Dictionary, root: Node, obj: Object) -> Dictionary:
	var prop: String = str(info.get("name", "value"))
	if not value is Array:
		return _type_error(prop, TYPE_ARRAY, value)
	# If the target is a typed array (Array[int], Array[Texture2D], ...), decode each element
	# with that type and assign() into a typed copy, so Godot accepts the value.
	var current: Variant = obj.get(prop) if obj != null and info.has("usage") else null
	var elem_info: Dictionary = {"name": prop + "[]", "type": TYPE_NIL}
	if current is Array and (current as Array).is_typed():
		var cur: Array = current
		elem_info["type"] = cur.get_typed_builtin()
		if cur.get_typed_builtin() == TYPE_OBJECT:
			elem_info["hint"] = PROPERTY_HINT_RESOURCE_TYPE
			elem_info["hint_string"] = str(cur.get_typed_class_name())
	var decoded: Array = []
	for item: Variant in value:
		var r: Dictionary = decode_typed(item, elem_info, root)
		if R.is_err(r):
			return r
		decoded.append(r["value"])
	if current is Array and (current as Array).is_typed():
		var typed: Array = (current as Array).duplicate()
		typed.clear()
		typed.assign(decoded)
		return R.value(typed)
	return R.value(decoded)


static func _decode_dictionary(value: Variant, info: Dictionary, root: Node, obj: Object) -> Dictionary:
	var prop: String = str(info.get("name", "value"))
	if not value is Dictionary:
		return _type_error(prop, TYPE_DICTIONARY, value)
	var r: Dictionary = _decode_untyped(value, root)
	if R.is_err(r):
		return r
	var current: Variant = obj.get(prop) if obj != null and info.has("usage") else null
	if current is Dictionary and (current as Dictionary).is_typed():
		var typed: Dictionary = (current as Dictionary).duplicate()
		typed.clear()
		typed.assign(r["value"])
		return R.value(typed)
	return r


## Object/Resource properties: "res://..." loads a resource, {"new": "Class", ...}
## creates one, {"node": "Path"} / a path string references a node for Node-typed exports.
static func _decode_object(value: Variant, prop: String, hint: int, hint_string: String, root: Node) -> Dictionary:
	var wants_node: bool = hint == PROPERTY_HINT_NODE_TYPE or _hint_is_node_class(hint_string)
	if wants_node:
		var node_path: String = ""
		if value is String:
			node_path = value
		elif value is Dictionary and (value as Dictionary).has("node"):
			node_path = str(value["node"])
		if not node_path.is_empty() and root != null:
			var res: Dictionary = NodePaths.resolve(root, node_path, prop)
			if R.is_err(res):
				return res
			var n: Node = res["value"]
			if not hint_string.is_empty() and not _matches_class(n, hint_string):
				return R.err(R.BAD_PARAMS, "Property '%s' expects a %s node, but '%s' is a %s." % [prop, hint_string, node_path, n.get_class()])
			return R.value(n)
		return R.err(R.BAD_PARAMS, "Property '%s' expects a node reference: pass its path relative to the scene root, e.g. \"Player\" or {\"node\": \"Player\"}." % prop)

	var path: String = ""
	if value is String:
		path = value
	elif value is Dictionary and (value as Dictionary).has("resource") and (value as Dictionary)["resource"] is String:
		path = str(value["resource"])
	if not path.is_empty():
		if not (path.begins_with("res://") or path.begins_with("uid://")):
			path = "res://" + path.trim_prefix("/")
		if not ResourceLoader.exists(path):
			return R.err(R.NOT_FOUND, "Cannot set '%s': resource '%s' does not exist. Check the path (it must be a res:// path to an existing, imported file)." % [prop, path])
		var loaded: Resource = load(path)
		if loaded == null:
			return R.err(R.GODOT_ERROR, "Cannot set '%s': failed to load '%s'." % [prop, path])
		if not hint_string.is_empty() and hint == PROPERTY_HINT_RESOURCE_TYPE and not _matches_class(loaded, hint_string):
			return R.err(R.BAD_PARAMS, "Property '%s' expects a %s, but '%s' is a %s." % [prop, hint_string, path, loaded.get_class()])
		return R.value(loaded)

	if value is Dictionary and (value as Dictionary).has("new"):
		var d: Dictionary = value
		var cls: String = str(d["new"])
		var created: Dictionary = instantiate_class(cls, "Resource")
		if R.is_err(created):
			return created
		var inst: Object = created["value"]
		if not hint_string.is_empty() and hint == PROPERTY_HINT_RESOURCE_TYPE and not _matches_class(inst, hint_string):
			if not inst is RefCounted:
				inst.free()
			return R.err(R.BAD_PARAMS, "Property '%s' expects a %s, but %s is not one. Pick a class that inherits %s." % [prop, hint_string, cls, hint_string])
		var props: Variant = d.get("properties", {})
		if not props is Dictionary:
			return R.err(R.BAD_PARAMS, "In {\"new\": \"%s\", ...} for '%s', 'properties' must be a JSON object." % [cls, prop])
		for key: Variant in props:
			var r: Dictionary = decode_property(inst, str(key), props[key], root)
			if R.is_err(r):
				return r
			inst.set(str(key), r["value"])
		return R.value(inst)

	var hint_txt: String = (" (a %s)" % hint_string) if not hint_string.is_empty() else ""
	return R.err(R.BAD_PARAMS, ("Cannot set '%s'%s from %s. Valid forms: \"res://path/to/resource.tres\", " +
		"{\"new\": \"ClassName\", \"properties\": {...}} or null.") % [prop, hint_txt, _short_json(value)],
		{"property": prop, "expected_type": hint_string if not hint_string.is_empty() else "Object"})


static func _hint_is_node_class(hint_string: String) -> bool:
	return not hint_string.is_empty() and ClassDB.class_exists(hint_string) and ClassDB.is_parent_class(hint_string, "Node")


## True if `obj` is an instance of any class in the comma-separated `class_list`
## (native classes or global script classes).
static func _matches_class(obj: Object, class_list: String) -> bool:
	for raw_name: String in class_list.split(","):
		var cname: String = raw_name.strip_edges()
		if cname.is_empty() or obj.is_class(cname):
			return true
		var script: Script = obj.get_script() as Script
		while script != null:
			if String(script.get_global_name()) == cname:
				return true
			script = script.get_base_script()
	return false


## Instantiates a native class or global script class by name, requiring it to inherit
## `required_base` ("Resource", "Node", ...). Returns {"value": Object} or an error.
static func instantiate_class(cls: String, required_base: String) -> Dictionary:
	if ClassDB.class_exists(cls):
		if not ClassDB.is_parent_class(cls, required_base):
			return R.err(R.BAD_PARAMS, "'%s' is not a %s type." % [cls, required_base])
		# Editor-only classes (EditorPlugin, EditorProperty, ...) exist in the editor binary
		# but would break the scene in an exported game. APIType 1 = API_EDITOR,
		# 3 = API_EDITOR_EXTENSION (numeric because ClassDB enum access varies by version).
		var api: int = ClassDB.class_get_api_type(cls)
		if api == 1 or api == 3:
			return R.err(R.BAD_PARAMS, "'%s' is an editor-only class and cannot be used in a scene." % cls)
		if not ClassDB.can_instantiate(cls):
			return R.err(R.BAD_PARAMS, "'%s' is abstract and cannot be instantiated; use one of its subclasses: %s." %
				[cls, ", ".join(_instantiable_inheriters(cls).slice(0, 10))])
		return R.value(ClassDB.instantiate(cls))
	for entry: Dictionary in ProjectSettings.get_global_class_list():
		if str(entry.get("class", "")) == cls:
			var script: Script = load(str(entry["path"])) as Script
			if script == null:
				return R.err(R.GODOT_ERROR, "Failed to load script '%s' for class '%s'." % [entry["path"], cls])
			var base: String = String(script.get_instance_base_type())
			if not ClassDB.is_parent_class(base, required_base):
				return R.err(R.BAD_PARAMS, "Script class '%s' extends %s, which is not a %s type." % [cls, base, required_base])
			# Instantiate the native base and attach the script (rather than script.new()),
			# which is what the editor does and works for non-@tool scripts in the editor.
			var obj: Object = ClassDB.instantiate(base)
			obj.set_script(script)
			return R.value(obj)
	var candidates: Array = Array(ClassDB.get_inheriters_from_class(required_base))
	for entry2: Dictionary in ProjectSettings.get_global_class_list():
		candidates.append(str(entry2.get("class", "")))
	var similar: Array[String] = Fuzzy.suggest(cls, candidates, 5)
	return R.err(R.BAD_PARAMS, "Unknown %s class '%s'.%s" % [required_base, cls, Fuzzy.did_you_mean(similar)], {"suggestions": similar})


static func _instantiable_inheriters(cls: String) -> Array[String]:
	var out: Array[String] = []
	for c: String in ClassDB.get_inheriters_from_class(cls):
		if ClassDB.can_instantiate(c):
			out.append(c)
	out.sort()
	return out
