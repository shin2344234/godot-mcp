@tool
extends RefCounted
## Typed accessor for request params that remembers the first validation error.
##
## Usage:
##     var p := Params.new(params, "node.add")
##     var parent: String = p.opt_string("parent", ".")
##     var index: int = p.opt_int("index", -1)
##     if p.failed():
##         return p.error
##
## This keeps handlers readable without exceptions. Note that JSON numbers always arrive
## as floats in Godot (JSON.parse_string never yields int), so `opt_int` accepts integral
## floats and rejects fractional ones.

const R := preload("mcp_result.gd")

var error: Dictionary = {}
var _params: Dictionary
var _method: String


func _init(params: Variant, method: String = "") -> void:
	_method = method
	if params == null:
		_params = {}
	elif params is Dictionary:
		_params = params
	else:
		_params = {}
		_fail("'params' must be a JSON object, got %s." % type_string(typeof(params)))


func failed() -> bool:
	return not error.is_empty()


func has(key: String) -> bool:
	return _params.has(key) and _params[key] != null


func raw(key: String, default: Variant = null) -> Variant:
	return _params.get(key, default)


func req_string(key: String) -> String:
	if not has(key):
		_fail("Missing required parameter '%s' (string)." % key)
		return ""
	return opt_string(key, "")


func opt_string(key: String, default: String = "") -> String:
	if not has(key):
		return default
	var v: Variant = _params[key]
	if v is String or v is StringName:
		return str(v)
	_fail("Parameter '%s' must be a string, got %s (%s)." % [key, JSON.stringify(v), type_string(typeof(v))])
	return default


func opt_int(key: String, default: int = 0) -> int:
	if not has(key):
		return default
	var v: Variant = _params[key]
	if v is int:
		return v
	if v is float and is_finite(v) and float(v) == floorf(v):
		return int(v)
	if v is String and (v as String).is_valid_int():
		return (v as String).to_int()
	_fail("Parameter '%s' must be an integer, got %s." % [key, JSON.stringify(v)])
	return default


func opt_bool(key: String, default: bool = false) -> bool:
	if not has(key):
		return default
	var v: Variant = _params[key]
	if v is bool:
		return v
	_fail("Parameter '%s' must be true or false, got %s." % [key, JSON.stringify(v)])
	return default


func opt_dict(key: String, default: Dictionary = {}) -> Dictionary:
	if not has(key):
		return default
	var v: Variant = _params[key]
	if v is Dictionary:
		return v
	_fail("Parameter '%s' must be a JSON object, got %s." % [key, JSON.stringify(v)])
	return default


func opt_array(key: String, default: Array = []) -> Array:
	if not has(key):
		return default
	var v: Variant = _params[key]
	if v is Array:
		return v
	_fail("Parameter '%s' must be a JSON array, got %s." % [key, JSON.stringify(v)])
	return default


func _fail(message: String) -> void:
	# Only the first problem is reported; fixing it usually reveals the next one anyway.
	if error.is_empty():
		var prefix: String = ("%s: " % _method) if not _method.is_empty() else ""
		error = R.err(R.BAD_PARAMS, prefix + message)
