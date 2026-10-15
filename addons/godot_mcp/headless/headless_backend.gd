extends RefCounted
## Headless backend: executes (E/H) methods without an editor.
##
## There is no "edited scene" and no undo history here. Scene methods therefore require an
## explicit `scene` parameter; each call loads the scene fresh from disk (ignoring the
## resource cache), instantiates it with GEN_EDIT_STATE_MAIN so instanced/inherited state
## is preserved exactly as the editor would see it, applies the change directly, then packs
## and saves the scene before returning. One call == one load/modify/save cycle.

const R := preload("../core/mcp_result.gd")
const Params := preload("../core/params.gd")
const Methods := preload("../core/methods.gd")
const SceneOps := preload("../core/scene_ops.gd")
const ScriptValidate := preload("../core/script_validate.gd")
const ResPaths := preload("../core/res_paths.gd")
const ChangeSet := preload("../core/change_set.gd")


func handle(method: String, params: Variant) -> Dictionary:
	if params == null:
		params = {}
	if not params is Dictionary:
		return R.err(R.BAD_PARAMS, "'params' must be a JSON object.")
	if Methods.is_editor_only(method):
		return Methods.editor_only_error(method)
	match method:
		"ping":
			return R.ok({"pong": true, "backend": "headless"})
		"script.validate":
			return ScriptValidate.validate(params)
		"scene.create":
			# `open` is meaningless without an editor and is ignored.
			return SceneOps.create_scene_file(params)
		"scene.save":
			return _scene_save(params)
		"scene.tree":
			return _with_scene(params, func(root: Node, path: String) -> Dictionary:
				return SceneOps.tree(root, path, params))
		"node.get":
			return _with_scene(params, func(root: Node, _path: String) -> Dictionary:
				return SceneOps.node_info(root, params))
	var mutations: Dictionary = Methods.scene_mutations()
	if mutations.has(method):
		return _mutate(mutations[method], params)
	var descriptor: Variant = Methods.module_methods().get(method)
	if descriptor is Dictionary:
		return _dispatch_module(method, descriptor, params)
	return Methods.unknown_method_error(method)


## Runs a method registered by an area module (see Methods.MODULES for the kinds).
func _dispatch_module(method: String, descriptor: Dictionary, params: Dictionary) -> Dictionary:
	var fn: Callable = descriptor["fn"]
	match str(descriptor.get("kind", "")):
		"scene_mutation":
			return _mutate(fn, params)
		"scene_read":
			return _with_scene(params, func(root: Node, _path: String) -> Dictionary:
				return fn.call(root, params))
		"project":
			return fn.call(params, _env())
	return R.err(R.INTERNAL, "Method '%s' has an unknown descriptor kind '%s' (addon bug)." % [method, descriptor.get("kind")])


## The headless counterpart of EditorBackend._env(): same keys, no editor objects.
##   load_scene  Callable(params) -> {"value": root, "path": path} | error (loads params.scene;
##               the caller must free the root)
##   save_scene  Callable(root, path) -> {} on success or an error Dictionary
##   scene_mutations  method name -> planner Callable(root, params) for every scene
##               mutation (step 1 and modules); used by batch.apply (core/scene_batch.gd)
func _env() -> Dictionary:
	return {
		"editor": false,
		"interface": null,
		"undo_redo": null,
		"filesystem": null,
		"plugin": null,
		"logs": null,
		"load_scene": _load_scene,
		"save_scene": SceneOps.pack_and_save,
		"scene_mutations": _scene_mutation_planners(),
	}


## Every scene-mutation planner: the step 1 ones plus module methods of kind
## "scene_mutation" (same as EditorBackend.scene_mutation_planners; the editor backend
## cannot be preloaded here because it references editor-only classes).
static func _scene_mutation_planners() -> Dictionary:
	var out: Dictionary = Methods.scene_mutations()
	var modules: Dictionary = Methods.module_methods()
	for method: String in modules:
		var d: Dictionary = modules[method]
		if str(d.get("kind", "")) == "scene_mutation":
			out[method] = d["fn"]
	return out


## scene.save is a no-op headless: every mutation already saved its scene.
func _scene_save(params: Dictionary) -> Dictionary:
	var p := Params.new(params, "scene.save")
	var raw: String = p.opt_string("path", p.opt_string("scene", ""))
	if p.failed():
		return p.error
	if raw.is_empty():
		return R.ok({"saved": null, "note": "Headless edits are saved to disk immediately; nothing to do."})
	var res: Dictionary = ResPaths.normalize_scene(raw, "path")
	if R.is_err(res):
		return res
	if not ResPaths.file_exists(res["value"]):
		return ResPaths.scene_not_found(res["value"])
	return R.ok({"saved": res["value"], "note": "Headless edits are saved to disk immediately; nothing to do."})


## Loads the scene named by params.scene. Returns {"value": root, "path": path} or an error.
func _load_scene(params: Dictionary) -> Dictionary:
	var p := Params.new(params)
	var raw: String = p.opt_string("scene", "")
	if p.failed():
		return p.error
	if raw.is_empty():
		return R.err(R.BAD_PARAMS, "The headless backend has no open scene: pass 'scene' (the res:// path of the .tscn to work on), e.g. \"scene\": \"res://main.tscn\".")
	var res: Dictionary = ResPaths.normalize_scene(raw, "scene")
	if R.is_err(res):
		return res
	var path: String = res["value"]
	if not ResPaths.file_exists(path):
		return ResPaths.scene_not_found(path)
	# CACHE_MODE_IGNORE: always read the current file, even if something else loaded it.
	var packed: PackedScene = ResourceLoader.load(path, "PackedScene", ResourceLoader.CACHE_MODE_IGNORE) as PackedScene
	if packed == null:
		return R.err(R.GODOT_ERROR, "Failed to load scene '%s'. The file may be corrupt or reference missing resources; check the Godot output for details." % path)
	var root: Node = packed.instantiate(PackedScene.GEN_EDIT_STATE_MAIN)
	if root == null:
		return R.err(R.GODOT_ERROR, "Failed to instantiate scene '%s' (missing dependencies or broken sub-scenes)." % path)
	return {"value": root, "path": path}


func _with_scene(params: Dictionary, fn: Callable) -> Dictionary:
	var loaded: Dictionary = _load_scene(params)
	if R.is_err(loaded):
		return loaded
	var root: Node = loaded["value"]
	var result: Dictionary = fn.call(root, loaded["path"])
	root.free()
	return result


func _mutate(planner: Callable, params: Dictionary) -> Dictionary:
	var loaded: Dictionary = _load_scene(params)
	if R.is_err(loaded):
		return loaded
	var root: Node = loaded["value"]
	var path: String = loaded["path"]
	var plan: Dictionary = planner.call(root, params)
	if R.is_err(plan):
		root.free()
		return plan
	var changes: ChangeSet = plan["changes"]
	changes.apply_direct()
	var result: Dictionary = (plan["finish"] as Callable).call()
	var save_err: Dictionary = SceneOps.pack_and_save(root, path)
	changes.release_direct()
	root.free()
	if not save_err.is_empty():
		return save_err
	result["scene"] = path
	result["saved"] = true
	return R.ok(result)
