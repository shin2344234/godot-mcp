@tool
extends RefCounted
## Editor UI helpers (editor only): the Scene dock selection, opening a script at a line,
## saving everything, and toast messages. One protocol method, `editor.ui`, with an
## `action` parameter (MCP tool godot_editor_ui, server/src/ops/testing.ts).
##
## Registered in core/methods.gd (MODULES) as kind "project" with "editor_only": true, so
## the headless runner answers UNSUPPORTED. Editor objects come from env["interface"]
## (EditorInterface) and are called dynamically, like scene_extra_ops.gd does, so this
## file also compiles where no editor singleton exists.
##
## Godot facts these functions rely on (verified against the 4.7.2 class reference and
## editor sources, doc/classes/*.xml and editor/*.cpp at tag 4.7.2-stable):
## * EditorInterface.get_selection() -> EditorSelection: clear(), add_node(node),
##   get_selected_nodes(). add_node does not show the node in the Inspector;
##   EditorInterface.edit_node(node) does (and selects it).
## * EditorInterface.edit_script(script, line = -1, column = 0, grab_focus = true) passes
##   line - 1 / column - 1 to ScriptEditor.edit(), i.e. line and column are 1-based. It
##   opens the script in the configured editor, which may be an external one
##   (EditorSettings text_editor/external/use_external_editor).
## * EditorInterface.save_all_scenes() first stops the running game
##   (EditorNode::save_all_scenes calls project_run_bar->stop_playing()) and opens a
##   "Save As" dialog for never-saved scenes. save_all therefore saves each unsaved scene
##   itself: switch to its tab, EditorInterface.save_scene() (returns OK or
##   ERR_CANT_CREATE), and switch back afterwards.
## * EditorInterface.get_unsaved_scenes() and ScriptEditor.get_unsaved_files() (both 4.7)
##   list what is unsaved; ScriptEditor.save_all_scripts() saves open scripts (built-in
##   scripts by saving their scene).
## * EditorInterface.get_editor_toaster() -> EditorToaster.push_toast(message,
##   severity = SEVERITY_INFO, tooltip = ""); SEVERITY_INFO / WARNING / ERROR = 0 / 1 / 2.

const R := preload("../core/mcp_result.gd")
const Params := preload("../core/params.gd")
const NodePaths := preload("../core/node_paths.gd")
const ResPaths := preload("../core/res_paths.gd")
const Fuzzy := preload("../core/fuzzy.gd")
const EditorScenes := preload("../core/editor_scenes.gd")

const ACTIONS: PackedStringArray = ["get_selection", "select", "open_script", "save_all", "toast"]
## EditorToaster.Severity values by name.
const SEVERITIES: Dictionary = {"info": 0, "warning": 1, "error": 2}
## Longest toast we show; the toaster is meant for one-liners.
const MAX_TOAST_CHARS: int = 500


static func methods() -> Dictionary:
	return {
		"editor.ui": {"kind": "project", "fn": do_editor_ui, "editor_only": true},
	}


## editor.ui: dispatch on params.action.
static func do_editor_ui(params: Variant, env: Dictionary) -> Dictionary:
	var p := Params.new(params, "editor.ui")
	var action: String = p.req_string("action")
	if p.failed():
		return p.error
	var ei: Object = env.get("interface")
	if ei == null:
		return R.err(R.UNSUPPORTED, "editor.ui needs the live Godot editor.")
	match action:
		"get_selection":
			return _get_selection(params, env, ei)
		"select":
			return _select(params, env, ei)
		"open_script":
			return _open_script(params, ei)
		"save_all":
			return _save_all(env, ei)
		"toast":
			return _toast(params, ei)
	var similar: Array[String] = Fuzzy.suggest(action, ACTIONS, 2)
	return R.err(R.BAD_PARAMS, "editor.ui: unknown action '%s'.%s Valid actions: %s." % [action, Fuzzy.did_you_mean(similar), ", ".join(ACTIONS)])


# ---------------------------------------------------------------------------------------
# Selection
# ---------------------------------------------------------------------------------------

## Scene-relative paths of the selected nodes that belong to `root`, in selection order.
static func _selected_paths(ei: Object, root: Node) -> Array:
	var out: Array = []
	var selection: Object = ei.call(&"get_selection")
	for node: Node in selection.call(&"get_selected_nodes"):
		if node == root or root.is_ancestor_of(node):
			out.append(NodePaths.rel_path(root, node))
	return out


static func _get_selection(params: Variant, env: Dictionary, ei: Object) -> Dictionary:
	var t: Dictionary = (env["edited_root"] as Callable).call(params)
	if R.is_err(t):
		return t
	var root: Node = t["value"]
	var selected: Array = _selected_paths(ei, root)
	return R.ok({"scene": _scene_label(root), "selected": selected, "count": selected.size()})


static func _select(params: Variant, env: Dictionary, ei: Object) -> Dictionary:
	var p := Params.new(params, "editor.ui select")
	var raw_paths: Array = p.opt_array("paths", [])
	if p.failed():
		return p.error
	if not p.has("paths"):
		return R.err(R.BAD_PARAMS, "editor.ui select: pass 'paths', a list of node paths relative to the scene root (e.g. [\"Player\", \"Player/Sprite2D\"]); [] clears the selection.")
	var t: Dictionary = (env["edited_root"] as Callable).call(params)
	if R.is_err(t):
		return t
	var root: Node = t["value"]

	# Resolve everything first, so a typo leaves the current selection untouched.
	var nodes: Array[Node] = []
	for raw: Variant in raw_paths:
		if not raw is String:
			return R.err(R.BAD_PARAMS, "editor.ui select: every entry of 'paths' must be a string, got %s." % JSON.stringify(raw))
		var res: Dictionary = NodePaths.resolve(root, raw, "paths")
		if R.is_err(res):
			return _with_close_matches(res, root, raw)
		var node: Node = res["value"]
		if not node in nodes:
			nodes.append(node)

	var selection: Object = ei.call(&"get_selection")
	selection.call(&"clear")
	for node: Node in nodes:
		selection.call(&"add_node", node)
	# One node: also show it in the Inspector, like clicking it in the Scene dock.
	if nodes.size() == 1:
		ei.call(&"edit_node", nodes[0])
	var selected: Array = _selected_paths(ei, root)
	return R.ok({"scene": _scene_label(root), "selected": selected, "count": selected.size()})


## Adds "Did you mean ..." from all node paths in the scene to a NOT_FOUND error from
## NodePaths.resolve (which already lists the children of the deepest matching node).
static func _with_close_matches(error: Dictionary, root: Node, wanted: String) -> Dictionary:
	var all_paths: Array[String] = []
	_collect_paths(root, root, all_paths)
	# Compare the last segment too, so "Sprite" finds "Player/Sprite2D".
	var similar: Array[String] = Fuzzy.suggest(wanted, all_paths, 5)
	var leaf: String = wanted.get_file()
	if similar.is_empty() and leaf != wanted:
		similar = Fuzzy.suggest(leaf, all_paths, 5)
	var e: Dictionary = error["error"]
	if not similar.is_empty():
		e["message"] = str(e["message"]) + Fuzzy.did_you_mean(similar)
		var data: Variant = e.get("data")
		if data is Dictionary:
			(data as Dictionary)["close_matches"] = similar
		else:
			e["data"] = {"close_matches": similar}
	return error


static func _collect_paths(root: Node, node: Node, out: Array[String]) -> void:
	for c: Node in NodePaths.listed_children(root, node):
		out.append(NodePaths.rel_path(root, c))
		if out.size() >= 2000:
			return
		_collect_paths(root, c, out)


static func _scene_label(root: Node) -> Variant:
	if root == null or root.scene_file_path.is_empty():
		return null
	return root.scene_file_path


static func _resource_path_or_null(res: Resource) -> Variant:
	if res == null:
		return null
	return res.resource_path


# ---------------------------------------------------------------------------------------
# open_script
# ---------------------------------------------------------------------------------------

static func _open_script(params: Variant, ei: Object) -> Dictionary:
	var p := Params.new(params, "editor.ui open_script")
	var raw: String = p.req_string("script")
	var line: int = p.opt_int("line", 1)
	var column: int = p.opt_int("column", 1)
	if p.failed():
		return p.error
	if line < 1 or column < 1:
		return R.err(R.BAD_PARAMS, "editor.ui open_script: 'line' and 'column' are 1-based and must be >= 1 (got line %d, column %d)." % [line, column])
	var norm: Dictionary = ResPaths.normalize(raw, "script")
	if R.is_err(norm):
		return norm
	var path: String = norm["value"]
	if not ResPaths.file_exists(path):
		var scripts: PackedStringArray = ResPaths.list_files(PackedStringArray(["gd", "cs"]), 200)
		var similar: Array[String] = Fuzzy.suggest(path, scripts, 5)
		return R.err(R.NOT_FOUND, "editor.ui open_script: '%s' does not exist.%s" % [path, Fuzzy.did_you_mean(similar)])
	var res: Resource = ResourceLoader.load(path)
	if not res is Script:
		return R.err(R.BAD_PARAMS, "editor.ui open_script: '%s' is not a script (it loads as %s). Pass a .gd or .cs file." % [path, res.get_class() if res != null else "nothing"])
	var script: Script = res
	var source: String = script.source_code
	var line_count: int = source.count("\n") + 1 if not source.is_empty() else 0
	if line_count > 0 and line > line_count:
		return R.err(R.BAD_PARAMS, "editor.ui open_script: '%s' has %d lines; 'line' %d is past the end." % [path, line_count, line])

	ei.call(&"edit_script", script, line, column, true)
	var result: Dictionary = {"script": path, "line": line, "column": column}
	var settings: Object = ei.call(&"get_editor_settings")
	if settings != null and bool(settings.call(&"get_setting", "text_editor/external/use_external_editor")):
		result["external_editor"] = true
		result["note"] = "The editor is set to open scripts in an external editor (Editor Settings > Text Editor > External), so the script was opened there."
		return R.ok(result)
	ei.call(&"set_main_screen_editor", "Script")
	# Read back where the script editor actually is.
	var se: Object = ei.call(&"get_script_editor")
	if se != null:
		var current: Script = se.call(&"get_current_script")
		result["current_script"] = _resource_path_or_null(current)
		var seb: Object = se.call(&"get_current_editor")
		var base: Object = seb.call(&"get_base_editor") if seb != null else null
		if base is TextEdit:
			var te: TextEdit = base
			result["caret"] = {"line": te.get_caret_line() + 1, "column": te.get_caret_column() + 1}
			# TextEdit.set_caret_column clamps to the line's length, so a column past the end
			# of the line (or any column on an empty line) lands at the end of the line. The
			# dogfood test saw "column: 5" echoed next to "caret.column: 1" on an empty line
			# and read it as the column being ignored; say what happened instead.
			if te.get_caret_line() == line - 1 and te.get_caret_column() + 1 < column:
				var length: int = te.get_line(line - 1).length()
				result["note"] = "Line %d has %d character%s, so the caret was placed at its end (column %d)." % [
					line, length, "" if length == 1 else "s", te.get_caret_column() + 1]
	return R.ok(result)


# ---------------------------------------------------------------------------------------
# save_all
# ---------------------------------------------------------------------------------------

static func _save_all(env: Dictionary, ei: Object) -> Dictionary:
	var edited_root: Callable = env["edited_root"]
	var current: Node = ei.call(&"get_edited_scene_root")
	var current_path: String = current.scene_file_path if current != null else ""
	var saved_scenes: Array = []
	var skipped: Array = []
	var failed: Array = []

	# Real tab paths (the editor's list is stale after scene.save_as, see core/editor_scenes.gd).
	var unsaved_scenes: PackedStringArray = EditorScenes.unsaved_scenes(ei)
	for path: String in unsaved_scenes:
		if path.is_empty():
			skipped.append({"scene": null, "reason": "a new scene that was never saved; save it with scene.save_as and a res:// path"})
			continue
		var switched: Dictionary = edited_root.call({"scene": path})
		if R.is_err(switched):
			failed.append({"scene": path, "error": str((switched["error"] as Dictionary)["message"])})
			continue
		var err: int = ei.call(&"save_scene")
		if err == OK:
			saved_scenes.append(path)
		else:
			failed.append({"scene": path, "error": error_string(err)})

	# Switch back to the tab the user was on.
	var now: Node = ei.call(&"get_edited_scene_root")
	if not current_path.is_empty() and (now == null or now.scene_file_path != current_path):
		edited_root.call({"scene": current_path})

	var saved_scripts: Array = []
	var still_unsaved: Array = []
	var se: Object = ei.call(&"get_script_editor")
	if se != null:
		var before: PackedStringArray = se.call(&"get_unsaved_files")
		if not before.is_empty():
			se.call(&"save_all_scripts")
			var after: PackedStringArray = se.call(&"get_unsaved_files")
			for path: String in before:
				if path in after:
					still_unsaved.append(path)
				else:
					saved_scripts.append(path)

	var result: Dictionary = {
		"saved_scenes": saved_scenes,
		"saved_scripts": saved_scripts,
		"nothing_to_save": saved_scenes.is_empty() and saved_scripts.is_empty() and skipped.is_empty() and failed.is_empty() and still_unsaved.is_empty(),
	}
	if not skipped.is_empty():
		result["skipped"] = skipped
	if not failed.is_empty():
		result["failed"] = failed
	if not still_unsaved.is_empty():
		result["scripts_still_unsaved"] = still_unsaved
	result["edited_scene"] = _scene_label(ei.call(&"get_edited_scene_root"))
	return R.ok(result)


# ---------------------------------------------------------------------------------------
# toast
# ---------------------------------------------------------------------------------------

static func _toast(params: Variant, ei: Object) -> Dictionary:
	var p := Params.new(params, "editor.ui toast")
	var message: String = p.req_string("message").strip_edges()
	var severity: String = p.opt_string("severity", "info")
	if p.failed():
		return p.error
	if message.is_empty():
		return R.err(R.BAD_PARAMS, "editor.ui toast: 'message' is empty; pass a short text to show.")
	if not SEVERITIES.has(severity):
		return R.err(R.BAD_PARAMS, "editor.ui toast: 'severity' must be one of %s, got '%s'." % [", ".join(PackedStringArray(SEVERITIES.keys())), severity])
	var truncated: bool = message.length() > MAX_TOAST_CHARS
	if truncated:
		message = message.left(MAX_TOAST_CHARS - 3) + "..."
	var toaster: Object = ei.call(&"get_editor_toaster")
	if toaster == null:
		return R.err(R.GODOT_ERROR, "editor.ui toast: the editor has no toaster (EditorInterface.get_editor_toaster() returned null).")
	toaster.call(&"push_toast", message, SEVERITIES[severity])
	var result: Dictionary = {"shown": true, "message": message, "severity": severity}
	if truncated:
		result["truncated"] = true
	return R.ok(result)
