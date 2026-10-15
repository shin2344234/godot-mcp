@tool
extends RefCounted
## AnimationTree authoring for the animation area (ops/anim_ops.gd registers these methods):
## anim.tree_read (scene_read) and anim.tree (scene_mutation).
##
## An AnimationTree's graph lives in its `tree_root` resource: an AnimationNodeStateMachine,
## AnimationNodeBlendSpace1D/2D or AnimationNodeBlendTree, whose states/points/nodes are
## nested AnimationNode sub-resources and whose transitions are
## AnimationNodeStateMachineTransition sub-resources.
##
## Undo strategy: copy-on-write of the whole graph. anim.tree deep-duplicates tree_root
## (Resource.duplicate(true) copies every embedded sub-resource: nested nodes, transitions,
## curves; verified on 4.7.2), applies all ops to the copy - which doubles as validation,
## since nothing live is touched until every op succeeded - and the ChangeSet swaps the
## property: do tree_root = copy, undo tree_root = original object. That is exactly what the
## inspector does when a new root resource is assigned, so the AnimationTree editor copes
## with it, and undo restores the original graph objects untouched. Per-op inverse
## operations would be much more fragile here: removing a state silently drops its
## transitions, blend point indices shift, and 2D blend spaces regenerate triangles.
## (Side effect: tree parameters such as conditions and blend positions are rebuilt for the
## new root and so reset to their defaults, as after any root change in the inspector.)
##
## State machines in Godot 4 always contain the built-in "Start" and "End" states; the
## start state is chosen by a transition Start -> state (set_start), and End is reached by
## a transition state -> End (set_end).

const R := preload("mcp_result.gd")
const Params := preload("params.gd")
const Codec := preload("variant_codec.gd")
const NodePaths := preload("node_paths.gd")
const ChangeSet := preload("change_set.gd")
const Fuzzy := preload("fuzzy.gd")

## Short type names accepted in params and used in results.
const NODE_TYPES: Dictionary = {
	"state_machine": "AnimationNodeStateMachine",
	"blend_space_1d": "AnimationNodeBlendSpace1D",
	"blend_space_2d": "AnimationNodeBlendSpace2D",
	"blend_tree": "AnimationNodeBlendTree",
	"animation": "AnimationNodeAnimation",
}
const ROOT_TYPES: PackedStringArray = ["state_machine", "blend_space_1d", "blend_space_2d", "blend_tree"]
## Indexed by AnimationNodeStateMachineTransition.SwitchMode / AdvanceMode.
const SWITCH_MODES: PackedStringArray = ["immediate", "sync", "at_end"]
const ADVANCE_MODES: PackedStringArray = ["disabled", "enabled", "auto"]
const TREE_OPS: PackedStringArray = ["set_root", "add_state", "remove_state", "rename_state", "add_transition", "remove_transition",
	"set_start", "set_end", "add_blend_point", "remove_blend_point", "set"]
## Runtime-only parameters that every node exposes; left out of anim.tree_read for brevity.
const _NOISY_PARAM_SUFFIXES: PackedStringArray = ["/current_length", "/current_position", "/current_delta"]
## How deep anim.tree_read expands nested state machines / blend spaces.
const _MAX_DEPTH: int = 4


static func _find_tree(root: Node, path: String, method: String) -> Dictionary:
	# Shared with anim_ops.gd, which preloads this file (so we cannot preload it back).
	var candidates: Array[String] = []
	_collect_trees(root, root, candidates)
	if path.is_empty():
		if candidates.size() == 1:
			return R.value(root if candidates[0] == "." else root.get_node(candidates[0]))
		if candidates.is_empty():
			return R.err(R.NOT_FOUND, "%s: the scene has no AnimationTree node. Add one with node.add {\"type\": \"AnimationTree\", \"properties\": {\"anim_player\": \"../AnimationPlayer\"}} first." % method)
		return R.err(R.BAD_PARAMS, "%s: the scene has several AnimationTree nodes; pass 'tree' with one of: %s." % [method, ", ".join(candidates)], {"candidates": candidates})
	var res: Dictionary = NodePaths.resolve(root, path, "tree")
	if R.is_err(res):
		return res
	if not res["value"] is AnimationTree:
		return R.err(R.BAD_PARAMS, "%s: '%s' is a %s, not an AnimationTree. AnimationTree nodes in this scene: %s." % [method, path, (res["value"] as Node).get_class(), ", ".join(candidates) if not candidates.is_empty() else "(none)"])
	return res


static func _collect_trees(root: Node, node: Node, out: Array[String]) -> void:
	if node is AnimationTree:
		out.append(NodePaths.rel_path(root, node))
	for c: Node in NodePaths.listed_children(root, node):
		_collect_trees(root, c, out)


## Short type name of an AnimationNode ("state_machine", ...) or its class name.
static func type_name(node: AnimationNode) -> String:
	if node == null:
		return "none"
	var cls: String = node.get_class()
	for k: String in NODE_TYPES:
		if NODE_TYPES[k] == cls:
			return k
	return cls


static func _vec(v: Vector2) -> Array:
	return [v.x, v.y]


# ---------------------------------------------------------------------------------------
# anim.tree_read
# ---------------------------------------------------------------------------------------

static func read_tree(root: Node, params: Variant) -> Dictionary:
	var p := Params.new(params, "anim.tree_read")
	var tree_path: String = p.opt_string("tree", "")
	var include_params: bool = p.opt_bool("parameters", true)
	if p.failed():
		return p.error
	var found: Dictionary = _find_tree(root, tree_path, "anim.tree_read")
	if R.is_err(found):
		return found
	var tree: AnimationTree = found["value"]
	var result: Dictionary = {
		"tree": NodePaths.rel_path(root, tree),
		"anim_player": String(tree.anim_player),
		"active": tree.active,
		"root": describe(tree.tree_root, 0),
		"animations": Array(known_animations(tree)),
	}
	if include_params:
		var params_out: Dictionary = {}
		for info: Dictionary in tree.get_property_list():
			var pname: String = info["name"]
			if not pname.begins_with("parameters/"):
				continue
			var noisy: bool = false
			for suffix: String in _NOISY_PARAM_SUFFIXES:
				if pname.ends_with(suffix):
					noisy = true
			if noisy:
				continue  # runtime positions, not authorable
			var v: Variant = tree.get(pname)
			if v is Object or int(info["type"]) == TYPE_OBJECT:
				# Runtime objects, above all "parameters/playback" (an
				# AnimationNodeStateMachinePlayback per state machine), which is what scripts
				# use: get("parameters/playback").travel("state"). Not authorable, but worth
				# listing with its type (MCP_TEST_LOG: it was missing entirely).
				var cls: String = (v as Object).get_class() if v is Object else str(info.get("hint_string", ""))
				if cls.is_empty():
					cls = str(info.get("class_name", "Object"))
				var entry: Dictionary = {"object": cls}
				if cls == "AnimationNodeStateMachinePlayback":
					entry["use"] = "$%s.get(\"%s\").travel(\"<state>\")" % [NodePaths.rel_path(root, tree), pname]
				params_out[pname] = entry
				continue
			params_out[pname] = Codec.encode(v, root)
		result["parameters"] = params_out
	return R.ok(result)


## JSON view of an AnimationNode graph, expanding nested graphs up to _MAX_DEPTH.
static func describe(node: AnimationNode, depth: int) -> Variant:
	if node == null:
		return null
	var out: Dictionary = {"type": type_name(node)}
	if node is AnimationNodeAnimation:
		out["animation"] = String((node as AnimationNodeAnimation).animation)
		return out
	if depth >= _MAX_DEPTH:
		out["truncated"] = true
		return out
	if node is AnimationNodeStateMachine:
		var sm: AnimationNodeStateMachine = node
		var states: Array = []
		for state_name: StringName in sm.get_node_list():
			if state_name in [&"Start", &"End"]:
				continue
			var entry: Dictionary = {"name": String(state_name), "position": _vec(sm.get_node_position(state_name))}
			entry.merge(_child_entry(sm.get_node(state_name), depth))
			states.append(entry)
		out["states"] = states
		var transitions: Array = []
		var starts: Array[String] = []
		for t: int in range(sm.get_transition_count()):
			var trans: AnimationNodeStateMachineTransition = sm.get_transition(t)
			var from: String = String(sm.get_transition_from(t))
			if from == "Start":
				starts.append(String(sm.get_transition_to(t)))
			var te: Dictionary = {
				"from": from,
				"to": String(sm.get_transition_to(t)),
				"switch_mode": SWITCH_MODES[trans.switch_mode],
				"advance_mode": ADVANCE_MODES[trans.advance_mode],
				"xfade_time": snappedf(trans.xfade_time, 0.0001),
			}
			if not String(trans.advance_condition).is_empty():
				te["advance_condition"] = String(trans.advance_condition)
			if not trans.advance_expression.is_empty():
				te["advance_expression"] = trans.advance_expression
			if trans.priority != 1:
				te["priority"] = trans.priority
			transitions.append(te)
		out["transitions"] = transitions
		out["start"] = starts
	elif node is AnimationNodeBlendSpace1D or node is AnimationNodeBlendSpace2D:
		var two_d: bool = node is AnimationNodeBlendSpace2D
		for prop: String in (["min_space", "max_space", "snap", "x_label", "y_label", "auto_triangles"] if two_d else ["min_space", "max_space", "snap", "value_label"]):
			out[prop] = Codec.encode(node.get(prop))
		out["blend_mode"] = ["interpolated", "discrete", "carry"][int(node.get("blend_mode"))]
		var points: Array = []
		var count: int = int(node.call("get_blend_point_count"))
		for i: int in range(count):
			var pos: Variant = node.call("get_blend_point_position", i)
			var entry: Dictionary = {"index": i, "name": String(node.call("get_blend_point_name", i)), "position": _vec(pos) if pos is Vector2 else pos}
			entry.merge(_child_entry(node.call("get_blend_point_node", i), depth))
			points.append(entry)
		out["points"] = points
		if two_d:
			out["triangle_count"] = (node as AnimationNodeBlendSpace2D).get_triangle_count()
	elif node is AnimationNodeBlendTree:
		var bt: AnimationNodeBlendTree = node
		var nodes: Array = []
		for n: StringName in bt.get_node_list():
			if n == &"output":
				continue
			var entry: Dictionary = {"name": String(n), "position": _vec(bt.get_node_position(n))}
			entry.merge(_child_entry(bt.get_node(n), depth))
			nodes.append(entry)
		out["nodes"] = nodes
		out["connections"] = blend_tree_connections(bt)
	return out


## Fields describing a child node (state, blend point, blend tree node).
static func _child_entry(child: AnimationNode, depth: int) -> Dictionary:
	if child is AnimationNodeAnimation:
		return {"type": "animation", "animation": String((child as AnimationNodeAnimation).animation)}
	var d: Variant = describe(child, depth + 1)
	return {"type": type_name(child), "node": d}


## [{"from": source node, "to": target node, "input": port}] from the blend tree's stored
## "node_connections" triples [target, input index, source] (verified on 4.7.2).
static func blend_tree_connections(bt: AnimationNodeBlendTree) -> Array:
	var raw: Array = bt.get("node_connections")
	var out: Array = []
	for i: int in range(0, raw.size() - 2, 3):
		out.append({"from": String(raw[i + 2]), "to": String(raw[i]), "input": int(raw[i + 1])})
	return out


## Animation names an AnimationNodeAnimation in this tree can use: the tree's own libraries
## plus those of its anim_player.
static func known_animations(tree: AnimationTree) -> PackedStringArray:
	var out: PackedStringArray = []
	for a: StringName in tree.get_animation_list():
		out.append(String(a))
	var player := tree.get_node_or_null(tree.anim_player) as AnimationPlayer
	if player != null:
		for a: StringName in player.get_animation_list():
			if not String(a) in out:
				out.append(String(a))
	return out


# ---------------------------------------------------------------------------------------
# anim.tree
# ---------------------------------------------------------------------------------------

## anim.tree: ordered ops on an AnimationTree's graph, as one undo step.
static func plan_tree(root: Node, params: Variant) -> Dictionary:
	var p := Params.new(params, "anim.tree")
	var tree_path: String = p.opt_string("tree", "")
	var nested: String = p.opt_string("nested", "")
	var ops: Array = p.opt_array("ops", [])
	var allow_missing: bool = p.opt_bool("allow_missing", false)
	if p.failed():
		return p.error
	if ops.is_empty():
		return R.err(R.BAD_PARAMS, "anim.tree: 'ops' must be a non-empty array, e.g. [{\"op\": \"set_root\", \"type\": \"state_machine\"}, {\"op\": \"add_state\", \"name\": \"Idle\", \"animation\": \"idle\"}, {\"op\": \"set_start\", \"name\": \"Idle\"}].")
	var found: Dictionary = _find_tree(root, tree_path, "anim.tree")
	if R.is_err(found):
		return found
	var tree: AnimationTree = found["value"]
	var edit_err: Dictionary = NodePaths.check_editable(root, tree, "edit")
	if not edit_err.is_empty():
		return edit_err
	var original: AnimationRootNode = tree.tree_root
	var work: AnimationRootNode = original.duplicate(true) as AnimationRootNode if original != null else null
	var ctx: Dictionary = {
		"known": known_animations(tree),
		"allow_missing": allow_missing,
		"warnings": [] as Array[String],
		"root": root,
	}
	var results: Array = []
	for i: int in range(ops.size()):
		if not ops[i] is Dictionary:
			return R.err(R.BAD_PARAMS, "anim.tree: ops[%d] must be an object like {\"op\": \"add_state\", ...}." % i)
		var op: Dictionary = ops[i]
		var kind: String = str(op.get("op", ""))
		var where: String = "anim.tree: ops[%d] (%s)" % [i, kind]
		if kind == "set_root":
			if not nested.is_empty():
				return R.err(R.BAD_PARAMS, "%s: set_root replaces the whole tree, so it cannot be combined with 'nested'. To replace a nested graph, remove_state + add_state with a 'type' on its parent." % where)
			var made: Dictionary = _new_node(str(op.get("type", "")), ROOT_TYPES, where, "AnimationRootNode")
			if R.is_err(made):
				return made
			work = made["value"]
			results.append({"op": "set_root", "type": type_name(work)})
			continue
		if not kind in TREE_OPS:
			return R.err(R.BAD_PARAMS, "anim.tree: ops[%d].op must be one of %s, got '%s'." % [i, ", ".join(TREE_OPS), kind])
		if work == null:
			return R.err(R.BAD_PARAMS, "%s: the AnimationTree has no tree_root yet. Start with {\"op\": \"set_root\", \"type\": \"state_machine\"} (or blend_space_1d, blend_space_2d, blend_tree)." % where)
		var target: Dictionary = _navigate(work, nested)
		if R.is_err(target):
			return target
		var r: Dictionary = _apply_op(target["value"], kind, op, where, ctx)
		if R.is_err(r):
			return r
		results.append(r["value"])

	var cs := ChangeSet.new()
	if work != original:
		cs.do_property(tree, &"tree_root", work)
		cs.undo_property(tree, &"tree_root", original)
	var finish := func() -> Dictionary:
		var result: Dictionary = {"tree": NodePaths.rel_path(root, tree), "results": results}
		var now: Dictionary = _navigate(tree.tree_root, nested) if tree.tree_root != null else {}
		result["graph"] = describe(now.get("value"), _MAX_DEPTH - 2) if not R.is_err(now) else null
		if not (ctx["warnings"] as Array).is_empty():
			result["warnings"] = ctx["warnings"]
		return result
	return {"changes": cs, "finish": finish}


## Walks "A/B" from the root through state machine states, blend tree nodes and blend
## points (by name). Returns {"value": AnimationNode} or an error naming what exists.
static func _navigate(node: AnimationNode, nested: String) -> Dictionary:
	var current: AnimationNode = node
	if nested.strip_edges().is_empty():
		return R.value(current)
	var walked: PackedStringArray = []
	for seg: String in nested.split("/", false):
		var names: PackedStringArray = _child_names(current)
		var next: AnimationNode = null
		if current is AnimationNodeStateMachine or current is AnimationNodeBlendTree:
			if current.call("has_node", StringName(seg)):
				next = current.call("get_node", StringName(seg))
		elif current is AnimationNodeBlendSpace1D or current is AnimationNodeBlendSpace2D:
			var idx: int = int(current.call("find_blend_point_by_name", StringName(seg)))
			if idx >= 0:
				next = current.call("get_blend_point_node", idx)
		if next == null:
			var where: String = "the tree root" if walked.is_empty() else "'%s'" % "/".join(walked)
			return R.err(R.NOT_FOUND, "anim.tree: 'nested' segment '%s' not found in %s (a %s).%s Children: %s." %
				[seg, where, type_name(current), Fuzzy.did_you_mean(Fuzzy.suggest(seg, names, 3)), ", ".join(names) if not names.is_empty() else "(none)"])
		walked.append(seg)
		current = next
	return R.value(current)


static func _child_names(node: AnimationNode) -> PackedStringArray:
	var out: PackedStringArray = []
	if node is AnimationNodeStateMachine or node is AnimationNodeBlendTree:
		for n: StringName in node.call("get_node_list"):
			if not n in [&"Start", &"End", &"output"]:
				out.append(String(n))
	elif node is AnimationNodeBlendSpace1D or node is AnimationNodeBlendSpace2D:
		for i: int in range(int(node.call("get_blend_point_count"))):
			out.append(String(node.call("get_blend_point_name", i)))
	return out


## Creates an AnimationNode from a short type name (or any AnimationNode class name, e.g.
## "AnimationNodeOneShot" inside a blend tree), requiring it to inherit `base`.
static func _new_node(type: String, allowed_short: PackedStringArray, where: String, base: String) -> Dictionary:
	var cls: String = NODE_TYPES.get(type.to_lower(), type)
	if type.to_lower() in NODE_TYPES and not type.to_lower() in allowed_short:
		return R.err(R.BAD_PARAMS, "%s: 'type' must be one of %s, got '%s'." % [where, ", ".join(allowed_short), type])
	if not ClassDB.class_exists(cls) or not ClassDB.is_parent_class(cls, base) or not ClassDB.can_instantiate(cls):
		return R.err(R.BAD_PARAMS, "%s: 'type' must be one of %s (or an %s class such as AnimationNodeOneShot in a blend tree), got '%s'." % [where, ", ".join(allowed_short), base, type])
	return R.value(ClassDB.instantiate(cls))


## Builds the node a new state / blend point / blend tree node holds: an
## AnimationNodeAnimation for `animation`, or a nested graph for `type`.
static func _child_from_op(op: Dictionary, where: String, ctx: Dictionary, base: String) -> Dictionary:
	var anim_name: String = str(op.get("animation", "")) if op.get("animation") != null else ""
	var type: String = str(op.get("type", "")) if op.get("type") != null else ""
	if anim_name.is_empty() and (type.is_empty() or type == "animation"):
		return R.err(R.BAD_PARAMS, "%s: pass 'animation' (an animation name such as \"walk\") or a nested 'type' (%s)." % [where, ", ".join(ROOT_TYPES)])
	if not anim_name.is_empty():
		var known: PackedStringArray = ctx["known"]
		if not anim_name in known:
			var msg: String = "%s: no animation '%s' in the tree's AnimationPlayer.%s Animations: %s." % [where, anim_name, Fuzzy.did_you_mean(Fuzzy.suggest(anim_name, known, 3)), ", ".join(known) if not known.is_empty() else "(none - check the AnimationTree's anim_player)"]
			if not ctx["allow_missing"]:
				return R.err(R.NOT_FOUND, msg + " Create it with anim.edit, or pass allow_missing: true.")
			(ctx["warnings"] as Array).append(msg)
		var a := AnimationNodeAnimation.new()
		a.animation = StringName(anim_name)
		return R.value(a)
	var allowed: PackedStringArray = ROOT_TYPES.duplicate()
	allowed.append("animation")
	return _new_node(type, allowed, where, base)


static func _transition_props(trans: AnimationNodeStateMachineTransition, op: Dictionary, where: String) -> Dictionary:
	if op.get("switch_mode") != null:
		var i: int = SWITCH_MODES.find(str(op["switch_mode"]).to_lower())
		if i < 0:
			return R.err(R.BAD_PARAMS, "%s: 'switch_mode' must be one of %s, got '%s'." % [where, ", ".join(SWITCH_MODES), op["switch_mode"]])
		trans.switch_mode = i as AnimationNodeStateMachineTransition.SwitchMode
	if op.get("advance_mode") != null:
		var j: int = ADVANCE_MODES.find(str(op["advance_mode"]).to_lower())
		if j < 0:
			return R.err(R.BAD_PARAMS, "%s: 'advance_mode' must be one of %s, got '%s'." % [where, ", ".join(ADVANCE_MODES), op["advance_mode"]])
		trans.advance_mode = j as AnimationNodeStateMachineTransition.AdvanceMode
	if op.get("advance_condition") != null:
		trans.advance_condition = StringName(str(op["advance_condition"]))
	if op.get("advance_expression") != null:
		var expr: String = str(op["advance_expression"])
		if not expr.is_empty():
			# Parse it now so a typo is reported here instead of failing silently at runtime.
			var e := Expression.new()
			if e.parse(expr) != OK:
				return R.err(R.BAD_PARAMS, "%s: 'advance_expression' does not parse: %s." % [where, e.get_error_text()])
		trans.advance_expression = expr
	if op.get("xfade_time") != null:
		if not (op["xfade_time"] is float or op["xfade_time"] is int) or float(op["xfade_time"]) < 0.0:
			return R.err(R.BAD_PARAMS, "%s: 'xfade_time' must be a number of seconds >= 0." % where)
		trans.xfade_time = float(op["xfade_time"])
	return {}


static func _check_state_name(state_name: String, where: String) -> Dictionary:
	if state_name.strip_edges().is_empty():
		return R.err(R.BAD_PARAMS, "%s: 'name' is required." % where)
	if state_name.contains("/") or state_name.contains(":"):
		return R.err(R.BAD_PARAMS, "%s: state names cannot contain / or : (got '%s')." % [where, state_name])
	if state_name in ["Start", "End", "output"]:
		return R.err(R.BAD_PARAMS, "%s: '%s' is a built-in node name; pick another name." % [where, state_name])
	return {}


static func _apply_op(target: AnimationNode, kind: String, op: Dictionary, where: String, ctx: Dictionary) -> Dictionary:
	if kind == "set":
		return _op_set(target, op, where, ctx)
	if target is AnimationNodeStateMachine:
		return _sm_op(target as AnimationNodeStateMachine, kind, op, where, ctx)
	if target is AnimationNodeBlendSpace1D or target is AnimationNodeBlendSpace2D:
		return _bs_op(target, kind, op, where, ctx)
	if target is AnimationNodeBlendTree:
		return _bt_op(target as AnimationNodeBlendTree, kind, op, where, ctx)
	return R.err(R.BAD_PARAMS, "%s: the target node is a %s, which has no states or points; only 'set' applies to it." % [where, type_name(target)])


static func _unknown_state(names: PackedStringArray, state_name: String, where: String) -> Dictionary:
	return R.err(R.NOT_FOUND, "%s: no state '%s'.%s States: %s." % [where, state_name, Fuzzy.did_you_mean(Fuzzy.suggest(state_name, names, 3)), ", ".join(names) if not names.is_empty() else "(none)"])


static func _position(op: Dictionary, fallback: Vector2, where: String) -> Dictionary:
	if op.get("position") == null:
		return R.value(fallback)
	return _prefix(Codec.decode_typed(op["position"], {"name": "position", "type": TYPE_VECTOR2}, null), where)


# --- state machine -------------------------------------------------------------------------

static func _sm_op(sm: AnimationNodeStateMachine, kind: String, op: Dictionary, where: String, ctx: Dictionary) -> Dictionary:
	var names: PackedStringArray = _child_names(sm)
	var state_name: String = str(op.get("name", "")) if op.get("name") != null else ""
	match kind:
		"add_state":
			var ne: Dictionary = _check_state_name(state_name, where)
			if not ne.is_empty():
				return ne
			if sm.has_node(StringName(state_name)):
				return R.err(R.CONFLICT, "%s: a state named '%s' already exists." % [where, state_name])
			var child: Dictionary = _child_from_op(op, where, ctx, "AnimationRootNode")
			if R.is_err(child):
				return child
			# Default layout: a row to the right of Start, like states placed by hand.
			var pos: Dictionary = _position(op, Vector2(200 + 180 * names.size(), 100), where)
			if R.is_err(pos):
				return pos
			sm.add_node(StringName(state_name), child["value"], pos["value"])
			return R.value({"op": kind, "name": state_name, "type": type_name(child["value"])})
		"remove_state":
			if state_name in ["Start", "End"]:
				return R.err(R.BAD_PARAMS, "%s: Start and End are built into every state machine and cannot be removed." % where)
			if not sm.has_node(StringName(state_name)):
				return _unknown_state(names, state_name, where)
			var dropped: int = 0
			for t: int in range(sm.get_transition_count()):
				if String(sm.get_transition_from(t)) == state_name or String(sm.get_transition_to(t)) == state_name:
					dropped += 1
			sm.remove_node(StringName(state_name))
			return R.value({"op": kind, "name": state_name, "transitions_removed": dropped})
		"rename_state":
			var to: String = str(op.get("to", "")) if op.get("to") != null else ""
			if not sm.has_node(StringName(state_name)) or state_name in ["Start", "End"]:
				return _unknown_state(names, state_name, where)
			var ne2: Dictionary = _check_state_name(to, where + " 'to'")
			if not ne2.is_empty():
				return ne2
			if sm.has_node(StringName(to)):
				return R.err(R.CONFLICT, "%s: a state named '%s' already exists." % [where, to])
			sm.rename_node(StringName(state_name), StringName(to))
			return R.value({"op": kind, "name": to, "renamed_from": state_name})
		"add_transition", "remove_transition":
			var from: String = str(op.get("from", "")) if op.get("from") != null else ""
			var to2: String = str(op.get("to", "")) if op.get("to") != null else ""
			var all: PackedStringArray = names.duplicate()
			all.append_array(["Start", "End"])
			for end_name: String in [from, to2]:
				if not sm.has_node(StringName(end_name)):
					return R.err(R.NOT_FOUND, "%s: 'from' and 'to' must be states; '%s' does not exist.%s States: %s." % [where, end_name, Fuzzy.did_you_mean(Fuzzy.suggest(end_name, all, 3)), ", ".join(all)])
			if kind == "remove_transition":
				if not sm.has_transition(StringName(from), StringName(to2)):
					return R.err(R.NOT_FOUND, "%s: there is no transition %s -> %s. Use anim.tree_read to list transitions." % [where, from, to2])
				sm.remove_transition(StringName(from), StringName(to2))
				return R.value({"op": kind, "from": from, "to": to2})
			return _add_transition(sm, from, to2, op, where, kind)
		"set_start", "set_end":
			if not sm.has_node(StringName(state_name)) or state_name in ["Start", "End"]:
				return _unknown_state(names, state_name, where)
			if kind == "set_start":
				# Exactly one way in: drop other Start -> X transitions first.
				for t: int in range(sm.get_transition_count() - 1, -1, -1):
					if String(sm.get_transition_from(t)) == "Start" and String(sm.get_transition_to(t)) != state_name:
						sm.remove_transition_by_index(t)
				if sm.has_transition(&"Start", StringName(state_name)):
					return R.value({"op": kind, "name": state_name, "note": "already the start state"})
				return _add_transition(sm, "Start", state_name, op, where, kind)
			if sm.has_transition(StringName(state_name), &"End"):
				return R.value({"op": kind, "name": state_name, "note": "already has a transition to End"})
			var defaults: Dictionary = {"switch_mode": "at_end"}
			defaults.merge(op, true)
			return _add_transition(sm, state_name, "End", defaults, where, kind)
	return R.err(R.BAD_PARAMS, "%s: '%s' does not apply to a state machine; use add_state, remove_state, rename_state, add_transition, remove_transition, set_start, set_end or set." % [where, kind])


static func _add_transition(sm: AnimationNodeStateMachine, from: String, to: String, op: Dictionary, where: String, kind: String) -> Dictionary:
	if sm.has_transition(StringName(from), StringName(to)):
		return R.err(R.CONFLICT, "%s: a transition %s -> %s already exists; remove_transition first to change it, or use set with from/to." % [where, from, to])
	if from == to and not sm.allow_transition_to_self:
		return R.err(R.BAD_PARAMS, "%s: transitions from a state to itself need allow_transition_to_self (set it with {\"op\": \"set\", \"properties\": {\"allow_transition_to_self\": true}})." % where)
	if to == "Start" or from == "End":
		return R.err(R.BAD_PARAMS, "%s: transitions cannot go into Start or out of End." % where)
	var trans := AnimationNodeStateMachineTransition.new()
	# Leaving Start or entering End should happen by itself unless told otherwise; this is
	# what makes the start state actually play.
	if from == "Start" or to == "End":
		trans.advance_mode = AnimationNodeStateMachineTransition.ADVANCE_MODE_AUTO
	var perr: Dictionary = _transition_props(trans, op, where)
	if not perr.is_empty():
		return perr
	sm.add_transition(StringName(from), StringName(to), trans)
	return R.value({"op": kind, "from": from, "to": to, "switch_mode": SWITCH_MODES[trans.switch_mode], "advance_mode": ADVANCE_MODES[trans.advance_mode]})


# --- blend spaces --------------------------------------------------------------------------

static func _bs_op(bs: AnimationRootNode, kind: String, op: Dictionary, where: String, ctx: Dictionary) -> Dictionary:
	var two_d: bool = bs is AnimationNodeBlendSpace2D
	var names: PackedStringArray = _child_names(bs)
	match kind:
		"add_blend_point":
			var child: Dictionary = _child_from_op(op, where, ctx, "AnimationRootNode")
			if R.is_err(child):
				return child
			if op.get("position") == null:
				return R.err(R.BAD_PARAMS, "%s: 'position' is required: %s." % [where, "[x, y]" if two_d else "a number"])
			var pos: Variant = null
			if two_d:
				var dp: Dictionary = _prefix(Codec.decode_typed(op["position"], {"name": "position", "type": TYPE_VECTOR2}, null), where)
				if R.is_err(dp):
					return dp
				pos = dp["value"]
			else:
				if not (op["position"] is float or op["position"] is int):
					return R.err(R.BAD_PARAMS, "%s: a blend_space_1d point position is a single number, got %s." % [where, JSON.stringify(op["position"])])
				pos = float(op["position"])
			var min_s: Variant = bs.get("min_space")
			var max_s: Variant = bs.get("max_space")
			var outside: bool = (pos.x < min_s.x or pos.y < min_s.y or pos.x > max_s.x or pos.y > max_s.y) if two_d else (pos < min_s or pos > max_s)
			if outside:
				(ctx["warnings"] as Array).append("%s: position %s is outside the blend space (min_space %s, max_space %s); widen it with set." % [where, str(pos), str(min_s), str(max_s)])
			# Points have names since 4.5 (an empty name is deprecated and warns), and Godot
			# does not enforce uniqueness, so we do.
			var point_name: String = str(op.get("name", "")) if op.get("name") != null else ""
			if point_name.is_empty():
				point_name = str(op.get("animation", "")) if op.get("animation") != null else type_name(child["value"])
				var base_name: String = point_name.replace("/", "_")
				point_name = base_name
				var n: int = 2
				while point_name in names:
					point_name = "%s%d" % [base_name, n]
					n += 1
			elif point_name in names:
				return R.err(R.CONFLICT, "%s: a blend point named '%s' already exists. Points: %s." % [where, point_name, ", ".join(names)])
			bs.call("add_blend_point", child["value"], pos, -1, StringName(point_name))
			return R.value({"op": kind, "name": point_name, "index": int(bs.call("get_blend_point_count")) - 1, "position": Codec.encode(pos)})
		"remove_blend_point":
			var idx: int = -1
			if op.get("index") is float or op.get("index") is int:
				idx = int(op["index"])
			elif op.get("name") != null:
				idx = int(bs.call("find_blend_point_by_name", StringName(str(op["name"]))))
			else:
				return R.err(R.BAD_PARAMS, "%s: pass 'name' or 'index' of the point to remove." % where)
			if idx < 0 or idx >= int(bs.call("get_blend_point_count")):
				return R.err(R.NOT_FOUND, "%s: no such blend point. Points (index order): %s." % [where, ", ".join(names) if not names.is_empty() else "(none)"])
			var removed: String = String(bs.call("get_blend_point_name", idx))
			bs.call("remove_blend_point", idx)
			return R.value({"op": kind, "name": removed, "index": idx, "note": "Later points moved down by one index."})
	return R.err(R.BAD_PARAMS, "%s: '%s' does not apply to a blend space; use add_blend_point, remove_blend_point or set." % [where, kind])


# --- blend trees ---------------------------------------------------------------------------

static func _bt_op(bt: AnimationNodeBlendTree, kind: String, op: Dictionary, where: String, ctx: Dictionary) -> Dictionary:
	var names: PackedStringArray = _child_names(bt)
	var node_name: String = str(op.get("name", "")) if op.get("name") != null else ""
	match kind:
		"add_state":
			var ne: Dictionary = _check_state_name(node_name, where)
			if not ne.is_empty():
				return ne
			if bt.has_node(StringName(node_name)):
				return R.err(R.CONFLICT, "%s: a node named '%s' already exists." % [where, node_name])
			var child: Dictionary = _child_from_op(op, where, ctx, "AnimationNode")
			if R.is_err(child):
				return child
			# Default layout: a column left of the output node.
			var pos: Dictionary = _position(op, Vector2(-300, 120 * names.size()), where)
			if R.is_err(pos):
				return pos
			bt.add_node(StringName(node_name), child["value"], pos["value"])
			return R.value({"op": kind, "name": node_name, "type": type_name(child["value"])})
		"remove_state":
			if node_name == "output" or not bt.has_node(StringName(node_name)):
				return _unknown_state(names, node_name, where)
			bt.remove_node(StringName(node_name))
			return R.value({"op": kind, "name": node_name})
		"rename_state":
			var to: String = str(op.get("to", "")) if op.get("to") != null else ""
			if node_name == "output" or not bt.has_node(StringName(node_name)):
				return _unknown_state(names, node_name, where)
			var ne2: Dictionary = _check_state_name(to, where + " 'to'")
			if not ne2.is_empty():
				return ne2
			if bt.has_node(StringName(to)):
				return R.err(R.CONFLICT, "%s: a node named '%s' already exists." % [where, to])
			bt.rename_node(StringName(node_name), StringName(to))
			return R.value({"op": kind, "name": to, "renamed_from": node_name})
		"add_transition", "remove_transition":
			# In a blend tree a "transition" is a connection: from's output -> input port
			# `index` (default 0) of `to` ("output" is the tree's final output).
			var from: String = str(op.get("from", "")) if op.get("from") != null else ""
			var to2: String = str(op.get("to", "")) if op.get("to") != null else ""
			var port: int = int(op["index"]) if (op.get("index") is float or op.get("index") is int) else 0
			var all: PackedStringArray = names.duplicate()
			all.append("output")
			if not bt.has_node(StringName(to2)):
				return R.err(R.NOT_FOUND, "%s: 'to' node '%s' does not exist. Nodes: %s." % [where, to2, ", ".join(all)])
			var target: AnimationNode = bt.get_node(StringName(to2))
			if port < 0 or port >= target.get_input_count():
				return R.err(R.BAD_PARAMS, "%s: '%s' has %d input port(s); 'index' must be 0..%d." % [where, to2, target.get_input_count(), target.get_input_count() - 1])
			var connected: bool = false
			for c: Dictionary in blend_tree_connections(bt):
				if c["to"] == to2 and int(c["input"]) == port:
					connected = true
			if kind == "remove_transition":
				if not connected:
					return R.err(R.NOT_FOUND, "%s: input %d of '%s' is not connected." % [where, port, to2])
				bt.disconnect_node(StringName(to2), port)
				return R.value({"op": kind, "to": to2, "index": port})
			if from == "output" or not bt.has_node(StringName(from)):
				return R.err(R.NOT_FOUND, "%s: 'from' node '%s' does not exist (and output cannot be a source). Nodes: %s." % [where, from, ", ".join(names)])
			if from == to2:
				return R.err(R.BAD_PARAMS, "%s: a node cannot feed itself." % where)
			if connected:
				bt.disconnect_node(StringName(to2), port)
			bt.connect_node(StringName(to2), port, StringName(from))
			return R.value({"op": kind, "from": from, "to": to2, "index": port, "input_name": target.get_input_name(port)})
	return R.err(R.BAD_PARAMS, "%s: '%s' does not apply to a blend tree; use add_state (adds a node), remove_state, rename_state, add_transition (connects from -> to input 'index'), remove_transition or set." % [where, kind])


# --- set -----------------------------------------------------------------------------------

## set: properties on the target graph itself, on a transition (from + to), or on a child
## node (name: a state, blend tree node or blend point).
static func _op_set(target: AnimationNode, op: Dictionary, where: String, ctx: Dictionary) -> Dictionary:
	var props: Variant = op.get("properties", {})
	if not props is Dictionary:
		return R.err(R.BAD_PARAMS, "%s: 'properties' must be an object, e.g. {\"min_space\": -1, \"max_space\": 1}." % where)
	var obj: Object = target
	var label: String = type_name(target)
	if op.get("from") != null and op.get("to") != null and target is AnimationNodeStateMachine:
		var sm: AnimationNodeStateMachine = target
		var from: String = str(op["from"])
		var to: String = str(op["to"])
		var found: int = -1
		for t: int in range(sm.get_transition_count()):
			if String(sm.get_transition_from(t)) == from and String(sm.get_transition_to(t)) == to:
				found = t
		if found < 0:
			return R.err(R.NOT_FOUND, "%s: there is no transition %s -> %s." % [where, from, to])
		var trans: AnimationNodeStateMachineTransition = sm.get_transition(found)
		# Transition fields may be given directly on the op as well as in properties.
		var terr: Dictionary = _transition_props(trans, op, where)
		if not terr.is_empty():
			return terr
		obj = trans
		label = "transition %s -> %s" % [from, to]
	elif op.get("name") != null:
		var nav: Dictionary = _navigate(target, str(op["name"]))
		if R.is_err(nav):
			return nav
		obj = nav["value"]
		label = "'%s' (%s)" % [op["name"], type_name(nav["value"])]
		if op.get("position") != null and (target is AnimationNodeStateMachine or target is AnimationNodeBlendTree):
			var pos: Dictionary = _position(op, Vector2.ZERO, where)
			if R.is_err(pos):
				return pos
			target.call("set_node_position", StringName(str(op["name"])), pos["value"])
	elif (props as Dictionary).is_empty():
		return R.err(R.BAD_PARAMS, "%s: pass 'properties' (e.g. {\"max_space\": [1, 1]} on a blend space, or {\"animation\": \"run\"} with name of a state)." % where)
	var changed: Dictionary = {}
	for key: Variant in props:
		var pname: String = str(key)
		var info: Dictionary = Codec.find_property(obj, pname)
		if info.is_empty() or pname.begins_with("resource_") or pname.contains("/"):
			var e: Dictionary = Codec.unknown_property_error(obj, pname, label)
			e["error"]["message"] = "%s: %s" % [where, e["error"]["message"]]
			return e
		var r: Dictionary = Codec.decode_typed(props[key], info, ctx["root"], obj)
		if R.is_err(r):
			return _prefix(r, where)
		obj.set(pname, r["value"])
		changed[pname] = Codec.encode(obj.get(pname))
	return R.value({"op": "set", "target": label, "changed": changed})


static func _prefix(res: Dictionary, where: String) -> Dictionary:
	if R.is_err(res):
		res["error"]["message"] = "%s: %s" % [where, res["error"]["message"]]
	return res
