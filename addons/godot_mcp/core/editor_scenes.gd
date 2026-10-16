@tool
extends RefCounted
## Open/unsaved scene tabs of the editor, with paths that stay correct after "save as".
##
## Why this exists (checked against the Godot 4.7.2 source):
##   EditorInterface.get_open_scenes() and get_unsaved_scenes() report each tab's
##   EditorData::EditedScene.path. EditorInterface.save_scene_as() saves through
##   EditorNode::_save_scene(), which updates the scene ROOT's scene_file_path but never
##   that cached `path` (only the editor's own Save As dialog calls set_scene_path()). So
##   after our scene.save_as, both lists keep naming the OLD file for the renamed tab:
##   godot_status showed edited_scene "res://levels/main_alt.tscn" next to open_scenes
##   ["res://scenes/main.tscn"], and scene.close looked the new path up in the unsaved list,
##   missed it, and reported discarded_changes: false while it did drop changes.
##
## The cached path is not settable from GDScript, so we translate instead:
## get_open_scene_roots() returns the same tabs in the same order (skipping tabs without a
## root, i.e. ones that failed to load), and each root knows its real path. When the two
## lists line up we map tab i's cached path to its root's scene_file_path.
##
## Everything goes through Object.call() on the interface passed in, so this script also
## compiles in the headless runner, where the EditorInterface identifier doesn't exist.


## Cached path -> real path pairs, one per tab, in tab order: [[cached, real], ...].
## Falls back to [[cached, cached], ...] when the root list doesn't line up with the tabs.
static func _tab_paths(ei: Object) -> Array:
	var cached: PackedStringArray = ei.call(&"get_open_scenes")
	var out: Array = []
	var roots: Array = []
	if ei.has_method(&"get_open_scene_roots"):
		roots = Array(ei.call(&"get_open_scene_roots"))
	var aligned: bool = roots.size() == cached.size()
	for i: int in cached.size():
		var real: String = cached[i]
		if aligned and roots[i] is Node:
			var root_path: String = (roots[i] as Node).scene_file_path
			# A never-saved scene has no path on either side; keep the cached one then.
			if not root_path.is_empty():
				real = root_path
		out.append([cached[i], real])
	return out


## Paths of the open scene tabs, in tab order (real paths, see the header).
static func open_scenes(ei: Object) -> PackedStringArray:
	var out := PackedStringArray()
	for pair: Array in _tab_paths(ei):
		out.append(pair[1])
	return out


## Real paths of the tabs with unsaved changes. get_unsaved_scenes() only exists since
## Godot 4.7, hence the has_method check (the plugin still loads on 4.5/4.6).
static func unsaved_scenes(ei: Object) -> PackedStringArray:
	var out := PackedStringArray()
	if not ei.has_method(&"get_unsaved_scenes"):
		return out
	var unsaved: PackedStringArray = ei.call(&"get_unsaved_scenes")
	var pairs: Array = _tab_paths(ei)
	for u: String in unsaved:
		var mapped: bool = false
		for pair: Array in pairs:
			# Several tabs can share one cached path (save-as, then reopen the original):
			# report every candidate rather than miss an unsaved scene.
			if pair[0] == u and not out.has(pair[1]):
				out.append(pair[1])
				mapped = true
		if not mapped and not out.has(u):
			out.append(u)
	return out


## True when the scene tab currently being edited has unsaved changes. Looks the tab up by
## its root (not by path), so it is right even when the cached path is stale.
static func current_is_unsaved(ei: Object) -> bool:
	var current: Node = ei.call(&"get_edited_scene_root")
	if current == null or not ei.has_method(&"get_unsaved_scenes"):
		return false
	var cached: PackedStringArray = ei.call(&"get_open_scenes")
	var unsaved: PackedStringArray = ei.call(&"get_unsaved_scenes")
	var roots: Array = []
	if ei.has_method(&"get_open_scene_roots"):
		roots = Array(ei.call(&"get_open_scene_roots"))
	if roots.size() == cached.size():
		var idx: int = roots.find(current)
		if idx >= 0:
			return cached[idx] in unsaved
	# Lists don't line up: fall back to the root's own path.
	return current.scene_file_path in unsaved



## Works around a Godot 4.7 editor bug that silently drops a scene's "unsaved" state.
##
## When a tab becomes current, EditorNode::_set_current_scene_nocheck() calls
## EditorData::check_and_update_scene(): if a scene instanced in that tab changed on disk
## (e.g. we just saved player.tscn, which main.tscn instances), the tab is re-packed and
## re-instantiated from memory with a NEW root node, keeping the user's edits, and then
## EditorUndoRedoManager::clear_history(id, false) runs, which marks the history as saved.
## So the tab loses its asterisk, the "save changes?" prompt on close, and its entry in
## get_unsaved_scenes(), while its edits are still not on disk (read in the 4.7.2 source,
## editor/editor_node.cpp and editor/editor_data.cpp, and reproduced: edit main.tscn, edit
## and save player.tscn, switch to main -> main reported clean). The dogfood test saw
## godot_status report unsaved_scenes: [] with a dirty level open.
##
## Call this after any switch of the current tab that we cause (opening a scene, closing
## one), passing unsaved_scenes() from before the switch. The root is replaced by the
## reload, so tabs are matched by path, not by node. If the tab that is current now was
## unsaved before and is not any more, it is marked unsaved again (mark_scene_as_unsaved()
## acts on the current tab, which is the only one the reload touches).
static func restore_unsaved(ei: Object, dirty_before: PackedStringArray) -> void:
	if dirty_before.is_empty() or not ei.has_method(&"mark_scene_as_unsaved"):
		return
	var current: Node = ei.call(&"get_edited_scene_root")
	if current == null or current.scene_file_path.is_empty():
		return
	if current.scene_file_path in dirty_before and not current_is_unsaved(ei):
		ei.call(&"mark_scene_as_unsaved")
