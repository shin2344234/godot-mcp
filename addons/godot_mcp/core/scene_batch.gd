@tool
extends RefCounted
## batch.apply: many scene mutations on ONE scene, all-or-nothing (worker: scene/signals).
##
## Registered as a "project" method by ops/scene_extra_ops.gd. The backends put every
## scene-mutation planner (step 1 methods and module ones) into `env.scene_mutations`
## (name -> Callable(root, params)), so this file needs no reference to core/methods.gd
## (which preloads the modules, so preloading it here would be circular).
##
## How the editor gets exactly one undo step, and why it does not use UndoRedo merging:
## UndoRedo's MERGE_ALL (verified in Godot 4.7.2 core/object/undo_redo.cpp) only merges an
## action into the previous one when it has the same name AND was created within 800 ms,
## and it appends the new action's undo operations AFTER the earlier ones. Undo runs them
## first-to-last, so undoing "add Foo, then reparent Foo" would try to remove Foo from its
## old parent before moving it back: dependent operations undo in the wrong order. A later
## batch within 800 ms of an earlier one would also merge into it. So instead:
##   1. plan op k against the live scene and apply its ChangeSet directly (so op k+1 sees
##      the result, e.g. a node added by op k), and compute its result right away;
##   2. after the last op, revert everything directly (undo operations, last op first);
##   3. commit ONE combined action: all "do" operations in order, and the "undo" operations
##      of the last op first. Committing re-executes the do operations.
## If op k fails to plan, the ops before it are reverted directly and nothing reaches the
## undo history at all (no stray redo entry either).
##
## Headless: ops are applied in order on the freshly loaded scene and the file is saved
## once, only if every op succeeded.
##
## Side effects outside the scene are not rolled back: signal.connect with create_method
## appends a stub function to a .gd file, which stays even if a later op fails.
##
## Direct undo and combining use ChangeSet's apply_undo_direct / free_created_direct /
## absorb_in_order.

const R := preload("mcp_result.gd")
const Params := preload("params.gd")
const Fuzzy := preload("fuzzy.gd")
const ResPaths := preload("res_paths.gd")
const ChangeSet := preload("change_set.gd")

const MAX_OPS: int = 100
const ACTION_NAME: String = "MCP: batch.apply"


## Entry point (descriptor kind "project").
static func apply(params: Variant, env: Dictionary) -> Dictionary:
	var p := Params.new(params, "batch.apply")
	var ops: Array = p.opt_array("ops", [])
	var scene_raw: String = p.opt_string("scene", "")
	if p.failed():
		return p.error
	if ops.is_empty():
		return R.err(R.BAD_PARAMS, "batch.apply: 'ops' must be a non-empty array like [{\"method\": \"node.add\", \"params\": {\"type\": \"Sprite2D\", \"name\": \"Icon\"}}, {\"method\": \"node.set\", \"params\": {\"path\": \"Icon\", \"properties\": {\"position\": [10, 20]}}}].")
	if ops.size() > MAX_OPS:
		return R.err(R.BAD_PARAMS, "batch.apply: at most %d ops per batch, got %d. Split the work into several batches." % [MAX_OPS, ops.size()])
	var planners: Dictionary = env.get("scene_mutations", {})
	if planners.is_empty():
		return R.err(R.INTERNAL, "batch.apply: the backend did not provide the scene mutation list (addon bug).")
	var scene_norm: String = ""
	if not scene_raw.is_empty():
		var sres: Dictionary = ResPaths.normalize_scene(scene_raw, "scene")
		if R.is_err(sres):
			return sres
		scene_norm = sres["value"]

	# Validate the whole list before touching the scene.
	var steps: Array = []
	for i: int in ops.size():
		var op: Variant = ops[i]
		if not op is Dictionary or not (op as Dictionary).get("method") is String:
			return R.err(R.BAD_PARAMS, "batch.apply: ops[%d] must be an object {\"method\": \"node.set\", \"params\": {...}}, got %s." % [i, JSON.stringify(op).left(120)], {"failed_index": i})
		var method: String = (op as Dictionary)["method"]
		if method == "batch.apply":
			return R.err(R.BAD_PARAMS, "batch.apply: ops[%d]: batches cannot be nested; put the inner ops directly in this list." % i, {"failed_index": i})
		if not planners.has(method):
			var names: Array[String] = []
			for k: String in planners:
				names.append(k)
			names.sort()
			var similar: Array[String] = Fuzzy.suggest(method, names, 3)
			return R.err(R.BAD_PARAMS, "batch.apply: ops[%d]: '%s' is not a scene mutation that can be batched.%s Allowed methods: %s." % [i, method, Fuzzy.did_you_mean(similar), ", ".join(names)], {"failed_index": i, "methods": names})
		var op_params: Variant = (op as Dictionary).get("params", {})
		if op_params == null:
			op_params = {}
		if not op_params is Dictionary:
			return R.err(R.BAD_PARAMS, "batch.apply: ops[%d].params must be an object." % i, {"failed_index": i})
		var own: Dictionary = (op_params as Dictionary).duplicate()
		if own.has("scene") and own["scene"] != null:
			var ores: Dictionary = ResPaths.normalize_scene(str(own["scene"]), "ops[%d].params.scene" % i)
			if R.is_err(ores):
				return ores
			if ores["value"] != scene_norm:
				return R.err(R.BAD_PARAMS, "batch.apply: ops[%d] targets scene '%s' but a batch edits one scene%s. Set 'scene' once at the top level and leave it out of the ops." % [i, ores["value"], (" ('%s')" % scene_norm) if not scene_norm.is_empty() else ""], {"failed_index": i})
		own.erase("scene")
		steps.append({"method": method, "params": own, "planner": planners[method]})

	if bool(env.get("editor", false)):
		return _apply_editor(params, steps, env)
	return _apply_headless(params, steps, env)


static func _apply_editor(params: Dictionary, steps: Array, env: Dictionary) -> Dictionary:
	var t: Dictionary = (env["edited_root"] as Callable).call(params)
	if R.is_err(t):
		return t
	var root: Node = t["value"]
	var run: Dictionary = _run(root, steps)
	var applied: Array[ChangeSet] = run["applied"]
	# Back to the original state either way: on success the combined action re-applies it.
	_revert_direct(applied)
	if run.has("error"):
		_free_created(applied)
		return run["error"]
	var combined: ChangeSet = _combine(applied)
	if not combined.is_empty():
		combined.commit_to_undo_redo(env["undo_redo"], ACTION_NAME, root)
	return R.ok({"scene": root.scene_file_path, "saved": false, "count": steps.size(), "results": run["results"]})


static func _apply_headless(params: Dictionary, steps: Array, env: Dictionary) -> Dictionary:
	var loaded: Dictionary = (env["load_scene"] as Callable).call(params)
	if R.is_err(loaded):
		return loaded
	var root: Node = loaded["value"]
	var path: String = loaded["path"]
	var run: Dictionary = _run(root, steps)
	var applied: Array[ChangeSet] = run["applied"]
	var save_err: Dictionary = {}
	if not run.has("error"):
		save_err = (env["save_scene"] as Callable).call(root, path)
	for cs: ChangeSet in applied:
		cs.release_direct()
	root.free()
	if run.has("error"):
		return run["error"]
	if not save_err.is_empty():
		return save_err
	return R.ok({"scene": path, "saved": true, "count": steps.size(), "results": run["results"]})


## Plans and directly applies each step in order. Returns {"applied": [ChangeSet],
## "results": [...]} plus "error" (already wrapped with the failing index) on failure.
static func _run(root: Node, steps: Array) -> Dictionary:
	var applied: Array[ChangeSet] = []
	var results: Array = []
	for i: int in steps.size():
		var step: Dictionary = steps[i]
		var method: String = step["method"]
		var plan: Variant = (step["planner"] as Callable).call(root, step["params"])
		if not plan is Dictionary or not ((plan as Dictionary).has("changes") or R.is_err(plan)):
			return {"applied": applied, "results": results, "error": R.err(R.INTERNAL, "batch.apply: ops[%d] (%s) failed unexpectedly in the addon (bug); nothing was applied." % [i, method], {"failed_index": i})}
		if R.is_err(plan):
			return {"applied": applied, "results": results, "error": _wrap_error(plan, i, method)}
		var cs: ChangeSet = (plan as Dictionary)["changes"]
		cs.apply_direct()
		applied.append(cs)
		var result: Dictionary = ((plan as Dictionary)["finish"] as Callable).call()
		# Each entry is tagged with its op's method name. signal.connect / signal.disconnect
		# results already have a "method" key (the handler, e.g. "_on_hit_body_entered"),
		# which the tag used to overwrite (MCP_TEST_LOG): keep it as "handler".
		if result.has("method"):
			result["handler"] = result["method"]
		result["method"] = method
		results.append(result)
	return {"applied": applied, "results": results}


static func _wrap_error(err: Dictionary, index: int, method: String) -> Dictionary:
	var e: Dictionary = (err["error"] as Dictionary).duplicate()
	e["message"] = "batch.apply: ops[%d] (%s) failed, so nothing was applied: %s" % [index, method, e.get("message", "")]
	var data: Dictionary = {"failed_index": index, "method": method}
	if e.has("data"):
		data["error_data"] = e["data"]
	e["data"] = data
	return {"error": e}


## Runs the undo operations of `applied`, last ChangeSet first, each in its own order
## (the same order EditorUndoRedoManager would use).
static func _revert_direct(applied: Array[ChangeSet]) -> void:
	for i: int in range(applied.size() - 1, -1, -1):
		applied[i].apply_undo_direct()


## After a failed batch was reverted, nodes created by its ops are detached orphans.
static func _free_created(applied: Array[ChangeSet]) -> void:
	for cs: ChangeSet in applied:
		cs.free_created_direct()


## One ChangeSet equivalent to applying `applied` in order.
static func _combine(applied: Array[ChangeSet]) -> ChangeSet:
	var out := ChangeSet.new()
	out.absorb_in_order(applied)
	return out
