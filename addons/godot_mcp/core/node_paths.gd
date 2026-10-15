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
