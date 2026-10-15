@tool
extends RefCounted
## An ordered list of "do" and "undo" operations describing one scene mutation.
##
## Scene operations (scene_ops.gd) never touch the scene directly. They validate their
## input and *describe* the change as a ChangeSet. The backend then decides how to apply it:
##
## * Editor backend: `commit_to_undo_redo()` registers every operation with
##   EditorUndoRedoManager as a single named action ("MCP: node.add"), so the user can
##   Ctrl+Z it and the scene tab is marked unsaved - exactly like a manual edit.
## * Headless backend: `apply_direct()` runs only the "do" operations, then the caller
##   packs and saves the scene. `release_direct()` frees nodes that were removed.
##
## Operation order matters and is preserved on both sides. Undo operations are executed
## in the order they were added (EditorUndoRedoManager's default, backward_undo_ops=false),
## so callers add undo operations in the order they must run, not in reverse.
##
## Engine classes from the editor (EditorUndoRedoManager) are only referenced dynamically
## so this file also loads in exported games (a future runtime bridge).

var _do_ops: Array[Dictionary] = []
var _undo_ops: Array[Dictionary] = []


func do_method(obj: Object, method: StringName, args: Array = []) -> void:
	_do_ops.append({"kind": "method", "object": obj, "method": method, "args": args})


func undo_method(obj: Object, method: StringName, args: Array = []) -> void:
	_undo_ops.append({"kind": "method", "object": obj, "method": method, "args": args})


func do_property(obj: Object, property: StringName, value: Variant) -> void:
	_do_ops.append({"kind": "property", "object": obj, "property": property, "value": value})


func undo_property(obj: Object, property: StringName, value: Variant) -> void:
	_undo_ops.append({"kind": "property", "object": obj, "property": property, "value": value})


## A node created by this change: the undo history keeps it alive while the action can be
## redone and frees it when the history entry is discarded.
func do_reference(obj: Object) -> void:
	_do_ops.append({"kind": "reference", "object": obj})


## A node removed by this change: kept alive by the history so undo can re-add it.
func undo_reference(obj: Object) -> void:
	_undo_ops.append({"kind": "reference", "object": obj})


func is_empty() -> bool:
	return _do_ops.is_empty()


## Headless: perform the "do" operations immediately.
func apply_direct() -> void:
	for op: Dictionary in _do_ops:
		var obj: Object = op["object"]
		match op["kind"]:
			"method":
				obj.callv(op["method"], op["args"])
			"property":
				obj.set(op["property"], op["value"])


## Headless: free nodes that `apply_direct()` detached from the scene (the undo references),
## since there is no undo history to own them. Call after the result has been computed.
func release_direct() -> void:
	for op: Dictionary in _undo_ops:
		if op["kind"] != "reference":
			continue
		var obj: Object = op["object"]
		if is_instance_valid(obj) and obj is Node and (obj as Node).get_parent() == null:
			obj.free()


## Editor: register everything as one undoable action and execute it.
## `undo_redo` is the EditorUndoRedoManager; `context` (the edited scene root) makes sure
## the action lands in that scene's history rather than the global one.
func commit_to_undo_redo(undo_redo: Object, action_name: String, context: Object) -> void:
	# 0 = UndoRedo.MERGE_DISABLE: every MCP call is its own undo step.
	undo_redo.call("create_action", action_name, 0, context)
	for op: Dictionary in _do_ops:
		match op["kind"]:
			"method":
				undo_redo.callv("add_do_method", [op["object"], op["method"]] + op["args"])
			"property":
				undo_redo.call("add_do_property", op["object"], op["property"], op["value"])
			"reference":
				undo_redo.call("add_do_reference", op["object"])
	for op: Dictionary in _undo_ops:
		match op["kind"]:
			"method":
				undo_redo.callv("add_undo_method", [op["object"], op["method"]] + op["args"])
			"property":
				undo_redo.call("add_undo_property", op["object"], op["property"], op["value"])
			"reference":
				undo_redo.call("add_undo_reference", op["object"])
	undo_redo.call("commit_action")
