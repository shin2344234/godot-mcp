extends RefCounted
## Runtime output capture: the game's print() lines, warnings and errors, for runs started
## from the editor.
##
## Why: a game the MCP server launches itself (run.start mode "process") writes to a pipe
## the server reads, so godot_run_output works. A game started from the editor sends its
## output to the editor's Output panel over the debugger connection instead, and the
## editor gives plugins no way to read it: EditorDebuggerPlugin only receives messages
## with a "prefix:" of its own choosing, and the editor's "output" and "error" messages are
## handled before plugins see anything (ScriptEditorDebugger::_parse_message, 4.7.2). The
## dogfood test could not read the errors of an editor run at all and had to find a bug
## from screenshots.
##
## So the runtime keeps its own copy: a Logger (Godot 4.5+, OS.add_logger) receives every
## message and error the game logs, from any thread, and keeps the newest MAX_LINES in a
## ring buffer that the server pages with "rt.output" (same shape as run.output's lines
## and errors views). Only installed while a debugger is attached (see mcp_runtime.gd).

const R := preload("../../core/mcp_result.gd")

## Entries kept; older ones are dropped (reported as `dropped`).
const MAX_LINES: int = 2000
## Longest text kept per entry (a huge print would otherwise fill the reply).
const MAX_TEXT: int = 2000

## The installed logger, or null.
static var _logger: OutputLogger = null


static func methods() -> Dictionary:
	return {
		"rt.output": {"fn": output},
	}


## Starts capturing (idempotent). Called by the runtime when a debugger is attached.
static func install() -> void:
	if _logger != null:
		return
	_logger = OutputLogger.new()
	OS.add_logger(_logger)


## Stops capturing.
static func uninstall() -> void:
	if _logger == null:
		return
	OS.remove_logger(_logger)
	_logger = null


## rt.output {since, limit, level ("all" | "warning" | "error"), errors (bool)}
## Lines view: {lines: ["<seq> [ERROR |WARNING ]text"], next, more, dropped, error_count, warning_count}
## Errors view (errors: true): {errors: [{seq, warning?, message, at?, callers?, source?, count?}], ...}
static func output(_rt: Node, params: Dictionary) -> Dictionary:
	if _logger == null:
		return R.err(R.UNSUPPORTED, "Output capture is not active in this game (no debugger attached when it started).")
	var since: int = int(params.get("since", 0))
	var limit: int = clampi(int(params.get("limit", 200)), 1, 2000)
	var level: String = str(params.get("level", "all"))
	var want_errors: bool = bool(params.get("errors", false))
	var snap: Dictionary = _logger.snapshot()
	var entries: Array = snap["entries"]
	var filtered: Array = []
	for e: Dictionary in entries:
		if int(e["seq"]) < since:
			continue
		if want_errors and e["level"] == "info":
			continue
		if level == "error" and e["level"] != "error":
			continue
		if level == "warning" and e["level"] == "info":
			continue
		filtered.append(e)
	var page: Array = filtered.slice(0, limit)
	var result: Dictionary = {
		"error_count": snap["error_count"],
		"warning_count": snap["warning_count"],
		"next": int(page.back()["seq"]) + 1 if not page.is_empty() else since,
		"more": filtered.size() > page.size(),
	}
	if int(snap["dropped"]) > 0 and since < int(snap["first_seq"]):
		result["dropped"] = int(snap["first_seq"]) - since
	if want_errors:
		result["errors"] = _merge_errors(page)
	else:
		var lines: Array = []
		for e: Dictionary in page:
			var tag: String = "" if e["level"] == "info" else str(e["level"]).to_upper() + " "
			var text: String = str(e["text"])
			if e.has("at"):
				text += " (at %s)" % e["at"]
			lines.append("%d %s%s" % [e["seq"], tag, text])
		result["lines"] = lines
	return R.ok(result)


## Identical errors in one page (same text and stack, e.g. raised every frame) are merged
## into the first with a count, like run.output's errors view does for process runs.
static func _merge_errors(page: Array) -> Array:
	var out: Array = []
	var index: Dictionary = {}
	for e: Dictionary in page:
		var key: String = JSON.stringify([e["level"], e["text"], e.get("at", ""), e.get("callers", []), e.get("source", "")])
		if index.has(key):
			var seen: Dictionary = out[index[key]]
			seen["count"] = int(seen.get("count", 1)) + 1
			continue
		var item: Dictionary = {"seq": e["seq"], "message": e["text"]}
		if e["level"] == "warning":
			item["warning"] = true
		for k: String in ["at", "callers", "source"]:
			if e.has(k):
				item[k] = e[k]
		index[key] = out.size()
		out.append(item)
	return out


## Receives everything the game logs. Godot calls these from whatever thread logs, so the
## buffer is guarded by a Mutex, and nothing in here may print (that would recurse).
class OutputLogger extends Logger:
	var _mutex := Mutex.new()
	var _entries: Array = []
	var _next_seq: int = 0
	var _errors: int = 0
	var _warnings: int = 0

	func _log_message(message: String, error: bool) -> void:
		# print() ends lines with "\n"; one print of several lines stays one entry.
		var text: String = message.trim_suffix("\n")
		# printerr() goes to stderr (error = true). Godot's Output panel shows it in red,
		# but it is not a script error, so it is tagged "stderr" and not counted.
		_add({"level": "info", "text": ("[stderr] " + text) if error else text})

	func _log_error(function: String, file: String, line: int, code: String, rationale: String,
			_editor_notify: bool, error_type: int, script_backtraces: Array[ScriptBacktrace]) -> void:
		var is_warning: bool = error_type == ERROR_TYPE_WARNING
		# push_error("x") arrives as code "x" with an empty rationale; engine errors often
		# carry both (code = the failed condition, rationale = the explanation).
		var text: String = rationale if not rationale.is_empty() else code
		if not rationale.is_empty() and not code.is_empty() and code != rationale:
			text = "%s: %s" % [code, rationale]
		var e: Dictionary = {"level": "warning" if is_warning else "error", "text": text}
		var frames: Array = []
		for bt: ScriptBacktrace in script_backtraces:
			for i: int in bt.get_frame_count():
				frames.append("%s:%d in %s()" % [bt.get_frame_file(i), bt.get_frame_line(i), bt.get_frame_function(i)])
		if not frames.is_empty():
			# The script line that raised it, then its callers (innermost first).
			e["at"] = frames[0]
			if frames.size() > 1:
				e["callers"] = frames.slice(1, 8)
		else:
			# No script on the stack: the engine's C++ location is all there is.
			e["source"] = "%s:%d in %s()" % [file, line, function]
		_mutex.lock()
		if is_warning:
			_warnings += 1
		else:
			_errors += 1
		_mutex.unlock()
		_add(e)

	func _add(e: Dictionary) -> void:
		if str(e["text"]).length() > MAX_TEXT:
			e["text"] = str(e["text"]).left(MAX_TEXT) + " [...]"
		_mutex.lock()
		e["seq"] = _next_seq
		_next_seq += 1
		_entries.append(e)
		if _entries.size() > MAX_LINES:
			_entries.pop_front()
		_mutex.unlock()

	## A consistent copy for the main thread.
	func snapshot() -> Dictionary:
		_mutex.lock()
		var copy: Array = _entries.duplicate(true)
		var d: Dictionary = {
			"entries": copy,
			"error_count": _errors,
			"warning_count": _warnings,
			"dropped": _next_seq - _entries.size(),
			"first_seq": int(_entries[0]["seq"]) if not _entries.is_empty() else _next_seq,
		}
		_mutex.unlock()
		return d
