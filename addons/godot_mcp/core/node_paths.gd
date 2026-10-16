@tool
extends RefCounted
## Node path handling, per docs/bridge-protocol.md section 4.
##
## All paths in params and results are relative to the *scene root*: "" or "." is the root,
## "Player/Sprite2D" a descendant. We also tolerate a leading "/root/" and the root's own
## name as the first segment (both are common when an LLM copies a path from a runtime
## print or from the editor's "Copy Node Path"), stripping them before lookup.

const R := preload("mcp_result.gd")


## Canonical path of `node` relative to `root` ("." for the root itself).
static func rel_path(root: Node, node: Node) -> String:
	if node == null:
		return ""
	if node == root:
		return "."
	if root != null and root.is_ancestor_of(node):
		return String(root.get_path_to(node))
	# Outside the scene (should not happen for scene nodes): best effort.
	if node.is_inside_tree():
		return String(node.get_path())
	return String(node.name)


## Strips tolerated prefixes and returns the lookup path relative to the root.
static func normalize(root: Node, path: String) -> String:
	var p: String = path.strip_edges()
	if p.begins_with("/root/"):
		p = p.substr(6)
	elif p == "/root":
		p = ""
	elif p.begins_with("/"):
		p = p.substr(1)
	while p.begins_with("./"):
		p = p.substr(2)
	while p.length() > 1 and p.ends_with("/"):
		p = p.left(p.length() - 1)
	if p.is_empty() or p == ".":
		return "."
	# Tolerate the root's own name as the first segment ("Main/Player" -> "Player"), unless
	# the root really has a child with that name (then the path is already relative).
	var first: String = p.get_slice("/", 0)
	if first == String(root.name) and root.get_node_or_null(NodePath(first)) == null:
		p = p.substr(first.length() + 1)
		if p.is_empty():
			return "."
	return p


## Resolves `path` under `root`. Returns {"value": Node} or a NOT_FOUND error that lists
## the children of the deepest existing ancestor, so the caller can correct the path.
static func resolve(root: Node, path: String, param_name: String = "path") -> Dictionary:
	var p: String = normalize(root, path)
	if p == ".":
		return R.value(root)
	var node: Node = root.get_node_or_null(NodePath(p))
	if node != null and (node == root or root.is_ancestor_of(node)):
		return R.value(node)
	if node != null:
		return R.err(R.NOT_FOUND, "Path '%s' (parameter '%s') points outside the scene rooted at '%s'. Paths must be relative to the scene root." % [path, param_name, root.name])
	# Walk down segment by segment to find where the path stops matching.
	var segments: PackedStringArray = p.split("/", false)
	var current: Node = root
	var matched: PackedStringArray = []
	for seg: String in segments:
		var next: Node = current.get_node_or_null(NodePath(seg))
		if next == null:
			break
		current = next
		matched.append(seg)
	var children: Array[String] = []
	for c: Node in current.get_children():
		children.append(String(c.name))
	var where: String = "the scene root '%s'" % root.name if current == root else "'%s'" % "/".join(matched)
	var msg: String = "Node '%s' (parameter '%s') not found under scene root '%s'. " % [path, param_name, root.name]
	if children.is_empty():
		msg += "The deepest existing node on that path, %s, has no children. " % where
	else:
		msg += "Children of %s: %s. " % [where, ", ".join(children)]
	msg += "Paths are relative to the scene root (\".\" is the root); use scene.tree to list nodes."
	return R.err(R.NOT_FOUND, msg, {"existing_parent": rel_path(root, current), "children": children})


## True if `node` is part of the scene being edited in the sense that its changes are saved:
## the root, nodes owned by the root, or nodes inside an instanced sub-scene whose
## "Editable Children" flag is on. Internal nodes of a normal instance are not editable:
## Godot would silently drop changes to them when the scene is packed.
static func is_editable(root: Node, node: Node) -> bool:
	if node == root:
		return true
	var owner_node: Node = node.owner
	if owner_node == null:
		return false
	if owner_node == root:
		return true
	return root.is_editable_instance(owner_node) and is_editable(root, owner_node)


## Returns an error if `node` cannot be modified (see is_editable), otherwise {}.
static func check_editable(root: Node, node: Node, what: String) -> Dictionary:
	if is_editable(root, node):
		return {}
	# Find the instance this node belongs to, to give a precise fix.
	var inst: Node = node.owner
	while inst != null and inst.owner != null and inst.owner != root and not root.is_editable_instance(inst.owner):
		inst = inst.owner
	if inst == null:
		return R.err(R.BAD_PARAMS, "Cannot %s '%s': the node is not owned by the scene, so changes would not be saved." % [what, rel_path(root, node)])
	var inner: String = String(inst.get_path_to(node))
	return R.err(R.BAD_PARAMS, ("Cannot %s '%s': it is an internal node of the instanced scene '%s' (instance '%s'). " +
		"Changes there would not be saved in this scene. Edit the sub-scene directly instead " +
		"(scene: \"%s\", path: \"%s\"), or modify the instance node '%s' itself.") %
		[what, rel_path(root, node), inst.scene_file_path, rel_path(root, inst), inst.scene_file_path, inner, rel_path(root, inst)],
		{"instance": rel_path(root, inst), "instance_scene": inst.scene_file_path, "path_in_instance": inner})


## Returns an error if `node` cannot be removed, renamed, reparented or reordered in the
## scene rooted at `root`, otherwise {}. Call it after check_editable().
##
## Property changes on such nodes are saved fine (as overrides), but Godot's scene format
## has no way to store the *absence*, new name or new position of a node that comes from
## somewhere else. PackedScene.pack() silently re-adds it from the base on the next load
## (verified on 4.7.2: a removed inherited node is back after save + reload, and a renamed
## one comes back under its old name next to the "renamed" copy). The editor's Scene dock
## refuses these operations for the same reason ("Can't operate on nodes the current scene
## inherits from!"), so we refuse them too instead of reporting a success that is lost on
## save. Two kinds of nodes are affected:
##   * nodes inherited from the base scene of an inherited scene (scene.inherit);
##   * nodes inside an instanced sub-scene whose "Editable Children" flag is on (their
##     owner is the instance, not the root).
static func check_structural(root: Node, node: Node, what: String) -> Dictionary:
	if node == root:
		return {}
	if node.owner != null and node.owner != root:
		var inst: Node = node.owner
		return R.err(R.BAD_PARAMS, ("Cannot %s '%s': it belongs to the instanced scene '%s' (instance '%s', shown here " +
			"because Editable Children is on). Godot only saves property changes on such nodes, so this would " +
			"be lost on save. Edit '%s' itself, or hide the node (visible: false).") %
			[what, rel_path(root, node), inst.scene_file_path, rel_path(root, inst), inst.scene_file_path],
			{"instance": rel_path(root, inst), "instance_scene": inst.scene_file_path})
	var base: String = inherited_from(root, node)
	if not base.is_empty():
		return R.err(R.BAD_PARAMS, ("Cannot %s '%s': it is inherited from the base scene '%s'. An inherited scene can " +
			"only override properties of base nodes; Godot would restore the node as it is in the base on the next " +
			"load. Edit the base scene instead, or hide the node here (node.set {\"visible\": false}).") %
			[what, rel_path(root, node), base], {"base_scene": base})
	return {}


## The res:// path of the base scene `node` is inherited from, or "" when `node` was added
## in this scene (or the scene is not an inherited scene).
##
## Godot keeps the inherited state on the root (Node::get_scene_inherited_state), but that is
## not exposed to scripts. So we look at the saved scene instead: in an inherited .tscn the
## root node entry is an instance of the base (SceneState.get_node_instance(0) returns the
## base PackedScene), and the base's SceneState lists its node paths. Bases can be inherited
## themselves, so we walk the chain. Unsaved scenes have no file and cannot be inherited
## (scene.inherit always writes the new file first), so they correctly return "".
static func inherited_from(root: Node, node: Node) -> String:
	var own_path: String = root.scene_file_path
	if own_path.is_empty() or not ResourceLoader.exists(own_path):
		return ""
	var packed: PackedScene = ResourceLoader.load(own_path) as PackedScene
	if packed == null:
		return ""
	var rel: String = rel_path(root, node)
	var base: PackedScene = packed.get_state().get_node_instance(0)
	var guard: int = 0
	# The walk is bounded in case of a (broken) cyclic inheritance chain.
	while base != null and guard < 16:
		var st: SceneState = base.get_state()
		for i: int in range(st.get_node_count()):
			# SceneState paths are "." for the root and "./A/B" below it (checked on 4.7.2).
			var sp: String = String(st.get_node_path(i))
			if sp.begins_with("./"):
				sp = sp.substr(2)
			if sp == rel:
				return base.resource_path
		base = st.get_node_instance(0) if st.get_node_count() > 0 else null
		guard += 1
	return ""


## Child names that are visible/listed for `node` (see is_editable), in tree order.
static func listed_children(root: Node, node: Node) -> Array[Node]:
	var out: Array[Node] = []
	for c: Node in node.get_children():
		if is_editable(root, c):
			out.append(c)
	return out


## Returns a name not used by any child of `parent` (ignoring `ignore`), following the
## editor's convention: "Enemy" -> "Enemy2" -> "Enemy3"; "Enemy2" -> "Enemy3".
static func unique_child_name(parent: Node, desired: String, ignore: Node = null) -> String:
	if not has_child_named(parent, desired, ignore):
		return desired
	var base: String = desired
	var digits: String = ""
	while not base.is_empty() and base[base.length() - 1] >= "0" and base[base.length() - 1] <= "9":
		digits = base[base.length() - 1] + digits
		base = base.left(base.length() - 1)
	var n: int = 2
	if not digits.is_empty() and not base.is_empty():
		n = digits.to_int() + 1
	else:
		base = desired
	while has_child_named(parent, base + str(n), ignore):
		n += 1
	return base + str(n)


static func has_child_named(parent: Node, child_name: String, ignore: Node = null) -> bool:
	for c: Node in parent.get_children(true):
		if c != ignore and String(c.name) == child_name:
			return true
	return false
