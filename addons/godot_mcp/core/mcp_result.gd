@tool
extends RefCounted
## Helpers for building protocol results and errors.
##
## GDScript has no exceptions, so every operation in the addon returns a Dictionary that is
## either `{"result": {...}}` or `{"error": {"code", "message", "data"?}}` - exactly the
## shape that goes over the wire (see docs/bridge-protocol.md, "Requests and responses").
## Internal helpers that produce a value use `{"value": v}` instead of `{"result": ...}`
## but share the same `{"error": ...}` shape, so errors can be passed straight up the stack.
##
## Error messages are read by an LLM, so they should always say (1) what was wrong and
## (2) what to do instead - list valid names, show an example value, name the method
## that would help.

const BAD_PARAMS: String = "BAD_PARAMS"
const NOT_FOUND: String = "NOT_FOUND"
const NO_SCENE: String = "NO_SCENE"
const CONFLICT: String = "CONFLICT"
const UNSUPPORTED: String = "UNSUPPORTED"
const GODOT_ERROR: String = "GODOT_ERROR"
const INTERNAL: String = "INTERNAL"
const UNKNOWN_METHOD: String = "UNKNOWN_METHOD"


## Builds an error dictionary. `data` is optional structured detail (e.g. valid names).
static func err(code: String, message: String, data: Variant = null) -> Dictionary:
	var e: Dictionary = {"code": code, "message": message}
	if data != null:
		e["data"] = data
	return {"error": e}


## Builds an error for a failed Godot call, always including `error_string(code)` so the
## reader sees e.g. "File not found" rather than a bare number.
static func godot_err(what: String, code: int) -> Dictionary:
	return err(GODOT_ERROR, "%s failed: %s (Error %d)." % [what, error_string(code), code], {"godot_error": code})


static func ok(result: Dictionary) -> Dictionary:
	return {"result": result}


## Wraps an intermediate value (internal helpers only; never sent over the wire).
static func value(v: Variant) -> Dictionary:
	return {"value": v}


static func is_err(d: Variant) -> bool:
	return d is Dictionary and (d as Dictionary).has("error")
