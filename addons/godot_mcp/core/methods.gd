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
	"filesystem.refresh", "logs.read",
]

## (E/H) methods: available in both the editor bridge and the headless runner.
const SHARED: PackedStringArray = [
	"ping", "scene.tree", "node.get", "node.add", "node.set", "node.remove", "node.rename",
	"node.reparent", "node.duplicate", "script.attach", "script.validate", "scene.create",
	"scene.save",
]


static func all_methods() -> PackedStringArray:
	var out: PackedStringArray = SHARED.duplicate()
	out.append_array(EDITOR_ONLY)
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
