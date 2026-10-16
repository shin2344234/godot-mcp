@tool
extends RefCounted
## Editor backend: executes protocol methods against the live editor.
##
## Differences from the headless backend:
## * Scene methods work on the *edited* scene. `scene` is optional; when given and it is not
##   the edited scene, it is opened (or switched to) first.
## * Every mutation is committed through EditorUndoRedoManager as one action named
##   "MCP: <method>", so the user can undo it with Ctrl+Z and the scene tab is marked
##   unsaved. Nothing is written to disk until scene.save (or the user saves).

const Constants := preload("../core/constants.gd")
const R := preload("../core/mcp_result.gd")
const Params := preload("../core/params.gd")
const Methods := preload("../core/methods.gd")
const SceneOps := preload("../core/scene_ops.gd")
const ScriptValidate := preload("../core/script_validate.gd")
const ResPaths := preload("../core/res_paths.gd")
const ChangeSet := preload("../core/change_set.gd")
const LogBuffer := preload("../core/log_buffer.gd")
const EditorScenes := preload("../core/editor_scenes.gd")

var _logs: LogBuffer
## The EditorPlugin that owns this backend (for add_autoload_singleton and friends).
var _plugin: EditorPlugin


func _init(logs: LogBuffer, plugin: EditorPlugin = null) -> void:
	_logs = logs
	_plugin = plugin


## Entry point used by the bridge server. Wraps `_dispatch` with a check for runtime
## script errors in the addon (see LogBuffer.addon_script_errors).
func handle(method: String, params: Variant) -> Dictionary:
	var since: int = _logs.last_seq() + 1 if _logs != null else 0
	var response: Variant = _dispatch(method, params)
	var script_errors: Array[String] = _logs.addon_script_errors(since) if _logs != null else []
	var malformed: bool = not response is Dictionary or not ((response as Dictionary).has("result") or (response as Dictionary).has("error"))
	if malformed or not script_errors.is_empty():
		return R.err(R.INTERNAL, "Method '%s' failed unexpectedly in the editor plugin (this is a bug in the Godot MCP addon).%s" %
			[method, (" Engine errors: " + " | ".join(script_errors)) if not script_errors.is_empty() else ""], {"engine_errors": script_errors})
	return response


func _dispatch(method: String, params: Variant) -> Dictionary:
	if params == null:
		params = {}
	if not params is Dictionary:
		return R.err(R.BAD_PARAMS, "'params' must be a JSON object.")
	match method:
		"ping":
			return R.ok({"pong": true, "backend": "editor"})
		"editor.status":
			return R.ok(status())
		"scene.open":
			return _scene_open(params)
		"scene.save":
			return _scene_save(params)
		"scene.save_as":
			return _scene_save_as(params)
		"scene.create":
			return _scene_create(params)
		"game.send":
			return _game_send(params)
		"game.status":
			var relay: Variant = _plugin.get_game_relay() if _plugin != null and _plugin.has_method("get_game_relay") else null
			if relay == null:
				return R.ok({"sessions": []})
			return relay.status()
		"run.play":
			return _run_play(params)
		"run.stop":
			EditorInterface.stop_playing_scene()
			return R.ok({"playing": false})
		"filesystem.refresh":
			return _filesystem_refresh(params)
		"logs.read":
			return _logs_read(params)
		"script.validate":
			return ScriptValidate.validate(params)
		"scene.tree":
			var t: Dictionary = _edited_root(params)
			if R.is_err(t):
				return t
			return SceneOps.tree(t["value"], (t["value"] as Node).scene_file_path, params)
		"node.get":
			var g: Dictionary = _edited_root(params)
			if R.is_err(g):
				return g
			return SceneOps.node_info(g["value"], params)
	var mutations: Dictionary = Methods.scene_mutations()
	if mutations.has(method):
		return _mutate(method, mutations[method], params)
	var descriptor: Variant = Methods.module_methods().get(method)
	if descriptor is Dictionary:
		return _dispatch_module(method, descriptor, params)
	return Methods.unknown_method_error(method)


## Runs a method registered by an area module (see Methods.MODULES for the kinds).
func _dispatch_module(method: String, descriptor: Dictionary, params: Dictionary) -> Dictionary:
	var fn: Callable = descriptor["fn"]
	match str(descriptor.get("kind", "")):
		"scene_mutation":
			return _mutate(method, fn, params)
		"scene_read":
			var t: Dictionary = _edited_root(params)
			if R.is_err(t):
				return t
			return fn.call(t["value"], params)
		"project":
			return fn.call(params, _env())
	return R.err(R.INTERNAL, "Method '%s' has an unknown descriptor kind '%s' (addon bug)." % [method, descriptor.get("kind")])


## What "project" methods get to know about the editor backend. The headless backend
## builds the same keys with null editor objects (HeadlessBackend._env).
##   editor       true here, false headless
##   interface    the EditorInterface singleton
##   undo_redo    EditorUndoRedoManager (for undoable edits outside a scene planner)
##   filesystem   EditorFileSystem (update_file / reimport_files / scan after writing files)
##   plugin       the EditorPlugin (add_autoload_singleton, ...); may be null in tests
##   logs         the LogBuffer
##   edited_root  Callable(params) -> {"value": root} | error: the edited scene, opening
##                params.scene first when given (same rules as scene methods)
##   scene_mutations  method name -> planner Callable(root, params) for every scene
##                mutation (step 1 and modules); used by batch.apply (core/scene_batch.gd)
func _env() -> Dictionary:
	return {
		"editor": true,
		"interface": EditorInterface,
		"undo_redo": EditorInterface.get_editor_undo_redo(),
		"filesystem": EditorInterface.get_resource_filesystem(),
		"plugin": _plugin,
		"logs": _logs,
		"edited_root": _edited_root,
		"scene_mutations": scene_mutation_planners(),
	}


## Every scene-mutation planner: the step 1 ones plus module methods of kind
## "scene_mutation". Shared with HeadlessBackend through _env() so batch.apply can run any
## of them.
static func scene_mutation_planners() -> Dictionary:
	var out: Dictionary = Methods.scene_mutations()
	var modules: Dictionary = Methods.module_methods()
	for method: String in modules:
		var d: Dictionary = modules[method]
		if str(d.get("kind", "")) == "scene_mutation":
			out[method] = d["fn"]
	return out


## Payload for editor.status (also merged into the bridge's `welcome` frame).
func status() -> Dictionary:
	var edited: Node = EditorInterface.get_edited_scene_root()
	var playing: Variant = EditorInterface.get_playing_scene()
	if str(playing).is_empty():
		playing = null
	# EditorInterface.get_unsaved_scenes() only exists since Godot 4.7. Calling it directly
	# is a parse error on 4.5/4.6, which would stop the whole plugin from loading there,
	# so EditorScenes looks it up at runtime. EditorScenes also maps the editor's cached
	# tab paths to the real ones, which differ after scene.save_as (see core/editor_scenes.gd).
	var unsaved: Array = Array(EditorScenes.unsaved_scenes(EditorInterface))
	return {
		"godot_version": Constants.godot_version_string(),
		"plugin_version": Constants.PLUGIN_VERSION,
		"project_name": Constants.project_name(),
		"project_path": Constants.project_path(),
		"edited_scene": _scene_path_or_null(edited),
		"open_scenes": Array(EditorScenes.open_scenes(EditorInterface)),
		"unsaved_scenes": unsaved,
		"is_playing": EditorInterface.is_playing_scene(),
		"playing_scene": playing,
	}


static func _scene_path_or_null(root: Node) -> Variant:
	if root == null:
		return null
	if root.scene_file_path.is_empty():
		return null
	return root.scene_file_path


## Returns {"value": edited scene root} after making params.scene (if any) the edited scene.
func _edited_root(params: Dictionary) -> Dictionary:
	var p := Params.new(params)
	var raw: String = p.opt_string("scene", "")
	if p.failed():
		return p.error
	if raw.is_empty():
		var current: Node = EditorInterface.get_edited_scene_root()
		if current == null:
			return R.err(R.NO_SCENE, "No scene is open in the editor. Pass 'scene' (a res:// .tscn path) or call scene.open first.")
		return R.value(current)
	var res: Dictionary = _open_scene(raw, "scene")
	if R.is_err(res):
		return res
	return R.value(EditorInterface.get_edited_scene_root())


## Opens (or switches to) a scene. Returns {"value": path} or an error.
func _open_scene(raw: String, param_name: String) -> Dictionary:
	var res: Dictionary = ResPaths.normalize_scene(raw, param_name)
	if R.is_err(res):
		return res
	var path: String = res["value"]
	var current: Node = EditorInterface.get_edited_scene_root()
	if current != null and current.scene_file_path == path:
		return R.value(path)
	if not ResPaths.file_exists(path):
		return ResPaths.scene_not_found(path)
	# Switching tabs can make Godot forget that the target tab has unsaved changes (see
	# EditorScenes.restore_unsaved), so remember which tabs were dirty before the switch.
	var dirty_before: PackedStringArray = EditorScenes.unsaved_scenes(EditorInterface)
	EditorInterface.open_scene_from_path(path)
	EditorScenes.restore_unsaved(EditorInterface, dirty_before)
	current = EditorInterface.get_edited_scene_root()
	if current == null or current.scene_file_path != path:
		return R.err(R.GODOT_ERROR, "The editor could not open '%s' (it may be broken or have missing dependencies). Check logs.read for the editor's error messages." % path)
	return R.value(path)


func _mutate(method: String, planner: Callable, params: Dictionary) -> Dictionary:
	var before: Node = EditorInterface.get_edited_scene_root()
	var t: Dictionary = _edited_root(params)
	if R.is_err(t):
		return t
	var root: Node = t["value"]
	# In the editor, `scene` works by opening that scene's tab and making it the edited one
	# (edits must go through that tab's undo history). It stays current afterwards, so later
	# calls without `scene` hit it too: say so instead of switching silently.
	var switched_note: String = ""
	if before != null and before != root:
		switched_note = "The editor switched from %s to this scene's tab; calls without 'scene' now edit it." % _scene_label(before)
	var plan: Dictionary = planner.call(root, params)
	if R.is_err(plan):
		return plan
	var changes: ChangeSet = plan["changes"]
	if not changes.is_empty():
		changes.commit_to_undo_redo(EditorInterface.get_editor_undo_redo(), "MCP: " + method, root)
	var result: Dictionary = (plan["finish"] as Callable).call()
	result["scene"] = root.scene_file_path
	# Editor edits live in memory until saved; say so, so the caller remembers scene.save.
	result["saved"] = false
	if not switched_note.is_empty():
		# null when the previous tab's root is gone (the editor freed it on the switch).
		var from: Variant = null
		if is_instance_valid(before):
			from = before.scene_file_path
		result["switched_from"] = from
		result["note"] = (str(result["note"]) + " " + switched_note) if result.has("note") else switched_note
	return R.ok(result)


static func _scene_label(root: Node) -> String:
	if not is_instance_valid(root):
		return "the previous scene"
	return root.scene_file_path if not root.scene_file_path.is_empty() else "an unsaved scene"


func _scene_open(params: Dictionary) -> Dictionary:
	var p := Params.new(params, "scene.open")
	var raw: String = p.req_string("path")
	if p.failed():
		return p.error
	var res: Dictionary = _open_scene(raw, "path")
	if R.is_err(res):
		return res
	return R.ok({"edited_scene": res["value"]})


func _scene_save(params: Dictionary) -> Dictionary:
	var p := Params.new(params, "scene.save")
	var raw: String = p.opt_string("path", p.opt_string("scene", ""))
	if p.failed():
		return p.error
	if not raw.is_empty():
		var norm: Dictionary = ResPaths.normalize_scene(raw, "path")
		if R.is_err(norm):
			return norm
		var path: String = norm["value"]
		var open_paths: PackedStringArray = EditorScenes.open_scenes(EditorInterface)
		if not path in open_paths:
			return R.err(R.NOT_FOUND, "scene.save: '%s' is not open in the editor, so there is nothing to save. Open scenes: %s." % [path, ", ".join(open_paths)])
		var opened: Dictionary = _open_scene(path, "path")
		if R.is_err(opened):
			return opened
	var root: Node = EditorInterface.get_edited_scene_root()
	if root == null:
		return R.err(R.NO_SCENE, "scene.save: no scene is open in the editor.")
	if root.scene_file_path.is_empty():
		return R.err(R.BAD_PARAMS, "scene.save: the edited scene has never been saved and has no path; use scene.save_as with a res:// path.")
	var err: int = EditorInterface.save_scene()
	if err != OK:
		return R.godot_err("Saving '%s'" % root.scene_file_path, err)
	return R.ok({"saved": root.scene_file_path})


func _scene_save_as(params: Dictionary) -> Dictionary:
	var p := Params.new(params, "scene.save_as")
	var raw: String = p.req_string("path")
	if p.failed():
		return p.error
	var norm: Dictionary = ResPaths.normalize_scene(raw, "path")
	if R.is_err(norm):
		return norm
	var path: String = norm["value"]
	if EditorInterface.get_edited_scene_root() == null:
		return R.err(R.NO_SCENE, "scene.save_as: no scene is open in the editor. Open one with scene.open first.")
	var dir_err: int = DirAccess.make_dir_recursive_absolute(ProjectSettings.globalize_path(path.get_base_dir()))
	if dir_err != OK and dir_err != ERR_ALREADY_EXISTS:
		return R.godot_err("Creating folder '%s'" % path.get_base_dir(), dir_err)
	# with_preview = false: thumbnail generation needs a rendering viewport and is useless here.
	EditorInterface.save_scene_as(path, false)
	if not FileAccess.file_exists(path):
		return R.err(R.GODOT_ERROR, "scene.save_as: the editor did not write '%s'. Check logs.read for errors." % path)
	return R.ok({"saved": path})


func _scene_create(params: Dictionary) -> Dictionary:
	var created: Dictionary = SceneOps.create_scene_file(params)
	if R.is_err(created):
		return created
	var result: Dictionary = created["result"]
	var path: String = result["path"]
	# Make the FileSystem dock aware of the new file before opening it.
	EditorInterface.get_resource_filesystem().update_file(path)
	var p := Params.new(params, "scene.create")
	var should_open: bool = p.opt_bool("open", true)
	if p.failed():
		return p.error
	result["opened"] = false
	if should_open:
		var opened: Dictionary = _open_scene(path, "path")
		if R.is_err(opened):
			return opened
		result["opened"] = true
	return R.ok(result)


func _run_play(params: Dictionary) -> Dictionary:
	var p := Params.new(params, "run.play")
	var which: String = p.opt_string("scene", "main")
	if p.failed():
		return p.error
	var scene_path: String = ""
	match which:
		"main":
			scene_path = str(ProjectSettings.get_setting("application/run/main_scene", ""))
			if scene_path.is_empty():
				return R.err(R.BAD_PARAMS, "run.play: the project has no main scene (application/run/main_scene). Pass a scene path, e.g. {\"scene\": \"res://main.tscn\"}, or \"current\".")
			if scene_path.begins_with("uid://"):
				var id: int = ResourceUID.text_to_id(scene_path)
				if ResourceUID.has_id(id):
					scene_path = ResourceUID.get_id_path(id)
			EditorInterface.play_main_scene()
		"current":
			var root: Node = EditorInterface.get_edited_scene_root()
			if root == null:
				return R.err(R.NO_SCENE, "run.play: no scene is open, so there is no current scene to play. Use \"main\" or pass a scene path.")
			scene_path = root.scene_file_path
			EditorInterface.play_current_scene()
		_:
			var norm: Dictionary = ResPaths.normalize_scene(which, "scene")
			if R.is_err(norm):
				return norm
			scene_path = norm["value"]
			if not ResPaths.file_exists(scene_path):
				return ResPaths.scene_not_found(scene_path)
			EditorInterface.play_custom_scene(scene_path)
	return R.ok({"playing": EditorInterface.is_playing_scene(), "scene": scene_path})


## [runtime] game.send {session?: int, command: String, data?: Array}: sends a debugger
## message to a game started from this editor (see editor/game_relay.gd).
func _game_send(params: Variant) -> Dictionary:
	var p: Dictionary = params if params is Dictionary else {}
	var relay: Variant = _plugin.get_game_relay() if _plugin != null and _plugin.has_method("get_game_relay") else null
	if relay == null:
		return R.err("GAME_NOT_RUNNING", "This editor has no game relay (plugin not fully started).")
	var command: String = str(p.get("command", ""))
	if not command.contains(":") and not command in ["step", "next", "out", "continue", "get_stack_dump", "get_stack_frame_vars", "evaluate"]:
		return R.err(R.BAD_PARAMS, "game.send: '%s' is not a debugger command." % command)
	var data: Variant = p.get("data", [])
	return relay.send(int(p.get("session", -1)), command, data if data is Array else [])


func _filesystem_refresh(params: Dictionary) -> Dictionary:
	var p := Params.new(params, "filesystem.refresh")
	var paths: Array = p.opt_array("paths", [])
	if p.failed():
		return p.error
	var fs: EditorFileSystem = EditorInterface.get_resource_filesystem()
	var refreshed: int = 0
	if paths.is_empty():
		# Full rescan: asynchronous, the dock updates over the next frames.
		fs.scan()
	else:
		for raw: Variant in paths:
			var norm: Dictionary = ResPaths.normalize(str(raw), "paths")
			if R.is_err(norm):
				return norm
			fs.update_file(norm["value"])
			refreshed += 1
	# Open script tabs keep their own copy of the text; reload them from disk so the user
	# (and later saves) see the server's changes instead of overwriting them.
	EditorInterface.get_script_editor().reload_open_files()
	return R.ok({"refreshed": refreshed, "full_scan": paths.is_empty()})


func _logs_read(params: Dictionary) -> Dictionary:
	var p := Params.new(params, "logs.read")
	var since: int = p.opt_int("since", 0)
	var limit: int = p.opt_int("limit", 200)
	var level: String = p.opt_string("level", "all")
	if p.failed():
		return p.error
	if not level in ["all", "error", "warning"]:
		return R.err(R.BAD_PARAMS, "logs.read: 'level' must be \"all\", \"warning\" (warnings and errors) or \"error\", got '%s'." % level)
	if limit < 1 or limit > 2000:
		return R.err(R.BAD_PARAMS, "logs.read: 'limit' must be between 1 and 2000.")
	if _logs == null:
		return R.err(R.INTERNAL, "logs.read: the log buffer is not installed.")
	return R.ok(_logs.read(since, limit, level))
