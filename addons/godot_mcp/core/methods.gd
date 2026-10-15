@tool
extends RefCounted
## Registry of protocol method names (docs/bridge-protocol.md section 5), shared by both
## backends so they agree on which methods exist and which need the live editor.

const R := preload("mcp_result.gd")
const Fuzzy := preload("fuzzy.gd")
const SceneOps := preload("scene_ops.gd")

## (E) methods: need the running editor (edited scene, play controls, editor log, ...).
const EDITOR_ONLY: PackedStringArray = [
	"editor.status", "scene.open", "scene.save_as", "run.play", "run.stop",
	"filesystem.refresh", "logs.read", "game.send", "game.status",
]

## (E/H) methods: available in both the editor bridge and the headless runner.
const SHARED: PackedStringArray = [
	"ping", "scene.tree", "node.get", "node.add", "node.set", "node.remove", "node.rename",
	"node.reparent", "node.duplicate", "script.attach", "script.validate", "scene.create",
	"scene.save",
]


## Area modules (addons/godot_mcp/ops/*.gd), added in step 2. Each one has
## `static func methods() -> Dictionary` mapping a method name to a descriptor:
##
##   {"kind": "scene_mutation", "fn": Callable(root: Node, params) -> {"changes", "finish"} | error}
##       Planned like node.add: the editor commits the ChangeSet as one undo step on the
##       edited scene; headless applies it to params.scene and saves the file.
##   {"kind": "scene_read", "fn": Callable(root: Node, params) -> R.ok(...) | error}
##       Read-only work on a scene root (edited scene in the editor, params.scene headless).
##   {"kind": "project", "fn": Callable(params, env: Dictionary) -> R.ok(...) | error}
##       Anything not tied to one scene (resources, settings, imports...). `env` describes
##       the backend; see EditorBackend._env() / HeadlessBackend._env() for its keys.
##
## Optional descriptor keys: "editor_only": true (headless answers UNSUPPORTED).
const MODULES: Array = [
	preload("../ops/scene_extra_ops.gd"),
	preload("../ops/signal_ops.gd"),
	preload("../ops/resource_ops.gd"),
	preload("../ops/visual_ops.gd"),
	preload("../ops/import_ops.gd"),
	preload("../ops/anim_ops.gd"),
	preload("../ops/audio_ops.gd"),
	preload("../ops/world_ops.gd"),
	preload("../ops/project_ops.gd"),
	preload("../ops/export_ops.gd"),
	# Step 3.
	preload("../ops/editor_view_ops.gd"),
	preload("../ops/editor_ui_ops.gd"),
]

## Built once per process from MODULES (static vars persist for the script's lifetime).
static var _module_methods: Dictionary = {}


## method name -> descriptor, merged from every module.
static func module_methods() -> Dictionary:
	if _module_methods.is_empty():
		for module: Variant in MODULES:
			var entries: Dictionary = module.methods()
			for method: String in entries:
				assert(not _module_methods.has(method), "Godot MCP: method '%s' registered twice" % method)
				_module_methods[method] = entries[method]
	return _module_methods


## True if the method only works with the live editor (step 1 list or a module flag).
static func is_editor_only(method: String) -> bool:
	if method in EDITOR_ONLY:
		return true
	var d: Variant = module_methods().get(method)
	return d is Dictionary and bool((d as Dictionary).get("editor_only", false))


static func all_methods() -> PackedStringArray:
	var out: PackedStringArray = SHARED.duplicate()
	out.append_array(EDITOR_ONLY)
	for method: String in module_methods():
		out.append(method)
	return out


## Scene mutations: method name -> planner (static Callable on scene_ops.gd). Each planner
## takes (root: Node, params) and returns {"changes", "finish"} or {"error"}.
static func scene_mutations() -> Dictionary:
	return {
		"node.add": SceneOps.plan_node_add,
		"node.set": SceneOps.plan_node_set,
		"node.remove": SceneOps.plan_node_remove,
		"node.rename": SceneOps.plan_node_rename,
		"node.reparent": SceneOps.plan_node_reparent,
		"node.duplicate": SceneOps.plan_node_duplicate,
		"script.attach": SceneOps.plan_script_attach,
	}


static func unknown_method_error(method: String) -> Dictionary:
	var similar: Array[String] = Fuzzy.suggest(method, all_methods(), 3)
	return R.err(R.UNKNOWN_METHOD, "Unknown method '%s'.%s Available methods: %s." % [method, Fuzzy.did_you_mean(similar), ", ".join(all_methods())],
		{"methods": Array(all_methods())})


static func editor_only_error(method: String) -> Dictionary:
	return R.err(R.UNSUPPORTED, ("Method '%s' needs the live Godot editor, but this request ran in the headless backend. " +
		"Open the project in the Godot editor with the 'Godot MCP' plugin enabled (Project > Project Settings > Plugins) and retry.") % method)
