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


## Run the "undo" operations directly, in their recorded order. Used to roll back a
## change that was applied with apply_direct() (batch planning, failed batches).
func apply_undo_direct() -> void:
	for op: Dictionary in _undo_ops:
		var obj: Object = op["object"]
		if not is_instance_valid(obj):
			continue
		match op["kind"]:
			"method":
				obj.callv(op["method"], op["args"])
			"property":
				obj.set(op["property"], op["value"])


## After apply_direct() + apply_undo_direct(), nodes this change created are detached
## orphans with no undo history to own them: free them.
func free_created_direct() -> void:
	for op: Dictionary in _do_ops:
		if op["kind"] != "reference":
			continue
		var obj: Object = op["object"]
		if is_instance_valid(obj) and obj is Node and (obj as Node).get_parent() == null:
			obj.free()


## Fill this (empty) ChangeSet so it is equivalent to applying `sets` in order: all "do"
## operations in order, and the "undo" operations of the last set first (each set's own
## undo order kept), so undoing reverses dependent changes correctly. Used by batches.
func absorb_in_order(sets: Array) -> void:
	for cs: Variant in sets:
		_do_ops.append_array(cs._do_ops)
	for i: int in range(sets.size() - 1, -1, -1):
		_undo_ops.append_array(sets[i]._undo_ops)


## Editor: register everything as one undoable action and execute it.
## `undo_redo` is the EditorUndoRedoManager; `context` (the edited scene root) makes sure
## the action lands in that scene's history rather than the global one.
## Every MCP call is its own undo step (UndoRedo.MERGE_DISABLE). Batches don't use
## MERGE_ALL: in 4.7.2 it only merges same-name actions created within 800 ms and replays
## merged undo steps first-to-last, which breaks dependent ops (add, then reparent) and
## could fuse two quick batches. scene_batch.gd builds one combined ChangeSet instead.
func commit_to_undo_redo(undo_redo: Object, action_name: String, context: Object) -> void:
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
