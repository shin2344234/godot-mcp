@tool
extends Logger
## Ring buffer of engine log output, installed with OS.add_logger() (Godot 4.5+).
##
## The editor plugin installs one instance at startup so `logs.read` can return the editor
## process's messages and errors (script errors, failed loads, warnings, print() output).
## The headless runner installs one too, to attach recent engine errors to INTERNAL errors.
##
## Thread safety: Godot calls _log_message/_log_error from whatever thread logged the
## message (resource loading threads, rendering, ...), possibly concurrently, so every
## access to the buffer goes through a Mutex. We must never print from inside these
## callbacks (that would recurse back into the logger).

## Logger.ErrorType values, copied as ints so the mapping is explicit.
const _ERROR_TYPE_NAMES: Dictionary = {0: "error", 1: "warning", 2: "script_error", 3: "shader_error"}

## Matches ANSI terminal escape sequences (colors in editor output), stripped from messages.
static var _ansi_re: RegEx = RegEx.create_from_string("\\x1b\\[[0-9;?]*[ -/]*[@-~]")

var _mutex := Mutex.new()
var _entries: Array[Dictionary] = []
## Index in _entries of the oldest entry once the buffer has wrapped around.
var _head: int = 0
var _capacity: int
## Sequence number the next entry will get. Starts at 1 so "since: 0" means "everything".
var _next_seq: int = 1


func _init(capacity: int = 2000) -> void:
	_capacity = maxi(1, capacity)


func _log_message(message: String, error: bool) -> void:
	_push({
		"level": "error" if error else "info",
		"message": message.strip_edges(false, true),
	})


func _log_error(function: String, file: String, line: int, code: String, rationale: String,
		_editor_notify: bool, error_type: int, _script_backtraces: Array[ScriptBacktrace]) -> void:
	# `rationale` is the human-readable message when present; `code` is the failing
	# condition/expression (e.g. "p_child->data.parent != this") otherwise.
	var text: String = rationale if not rationale.is_empty() else code
	var kind: String = _ERROR_TYPE_NAMES.get(error_type, "error")
	_push({
		"level": "warning" if kind == "warning" else "error",
		"kind": kind,
		"message": text,
		"file": file,
		"line": line,
		"function": function,
	})


func _push(entry: Dictionary) -> void:
	entry["time"] = _timestamp()
	_mutex.lock()
	entry["message"] = _ansi_re.sub(str(entry["message"]), "", true)
	entry["seq"] = _next_seq
	_next_seq += 1
	if _entries.size() < _capacity:
		_entries.append(entry)
	else:
		_entries[_head] = entry
		_head = (_head + 1) % _capacity
	_mutex.unlock()


static func _timestamp() -> String:
	var now: float = Time.get_unix_time_from_system()
	var ms: int = int((now - floorf(now)) * 1000.0)
	return "%s.%03dZ" % [Time.get_datetime_string_from_unix_time(int(now)), ms]


## Returns entries with seq >= `since`, oldest first, at most `limit` of them.
## `level`: "all", "warning" (warnings and errors) or "error" (errors only).
## Result: {"entries": [...], "next": <since value for the next call>, "dropped": <number of
## entries at or after `since` that were already evicted from the ring buffer>}.
func read(since: int, limit: int, level: String) -> Dictionary:
	_mutex.lock()
	var ordered: Array[Dictionary] = []
	for i: int in range(_entries.size()):
		ordered.append(_entries[(_head + i) % _entries.size()] if _entries.size() == _capacity else _entries[i])
	var next_seq: int = _next_seq
	_mutex.unlock()

	var oldest: int = int(ordered[0]["seq"]) if not ordered.is_empty() else next_seq
	var dropped: int = maxi(0, oldest - maxi(since, 1))
	var out: Array = []
	# `next` is the first sequence number the client has not seen yet: the newest one when
	# we scanned everything, or the first entry we stopped at because of `limit`.
	var next: int = next_seq
	for e: Dictionary in ordered:
		var seq: int = e["seq"]
		if seq < since:
			continue
		if out.size() >= limit:
			next = seq
			break
		if level == "error" and e["level"] != "error":
			continue
		if level == "warning" and e["level"] == "info":
			continue
		out.append(e.duplicate())
	return {"entries": out, "next": next, "dropped": dropped}


## Messages of error/warning entries logged at or after `since` (newest last), for
## attaching to INTERNAL errors.
func recent_errors(since: int, max_count: int = 10) -> Array[String]:
	var res: Dictionary = read(since, 100000, "warning")
	var out: Array[String] = []
	for e: Dictionary in res["entries"]:
		var loc: String = ""
		if e.has("file") and not str(e["file"]).is_empty():
			loc = " (%s:%d)" % [e["file"], int(e.get("line", 0))]
		out.append("%s: %s%s" % [e["level"], e["message"], loc])
	return out.slice(maxi(0, out.size() - max_count))


func last_seq() -> int:
	_mutex.lock()
	var s: int = _next_seq - 1
	_mutex.unlock()
	return s


## Runtime script errors raised by the addon's own code at or after `since`.
##
## A GDScript runtime error (null access, bad call, ...) does not abort the process: the
## failing function just returns null and its callers carry on, which could produce a
## half-built but "successful" response. The dispatchers check this after every request and
## turn such responses into INTERNAL errors. Compile errors reported by script.validate
## (function "GDScript::reload") are excluded because they are expected output.
func addon_script_errors(since: int) -> Array[String]:
	var res: Dictionary = read(since, 100000, "error")
	var out: Array[String] = []
	for e: Dictionary in res["entries"]:
		if e.get("kind", "") != "script_error":
			continue
		if str(e.get("function", "")).begins_with("GDScript::"):
			continue
		if not str(e.get("file", "")).begins_with("res://addons/godot_mcp/"):
			continue
		out.append("%s (%s:%d in %s)" % [e["message"], e["file"], int(e.get("line", 0)), e.get("function", "?")])
	return out
