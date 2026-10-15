@tool
extends EditorPlugin
## Generator plugin for scripts/gen-export-defaults.sh (not part of the addon).
##
## Makes the editor write every export option of every platform, with its default value,
## into export_presets.cfg:
## 1. An EditorExportPlugin is registered. EditorExport::add_export_plugin sets
##    should_update_presets, so on the next frame update_export_presets() calls our
##    _get_export_options(platform) once per export platform: that is how a script gets
##    hold of the (non-instantiable) EditorExportPlatform objects.
## 2. update_export_presets() also fills every loaded preset's missing options with the
##    platform defaults (in memory only).
## 3. EditorExportPreset::_set() calls EditorExport::save_presets(), which writes ALL
##    values of all presets 0.8 s later (secret ones to .godot/export_credentials.cfg).
##    So setting one option on each preset makes the editor save the full lists.
## Source: editor/export/editor_export.cpp and editor_export_preset.cpp, Godot 4.7.2.

class Capture extends EditorExportPlugin:
	var platforms: Array = []

	func _get_name() -> String:
		return "godot_mcp_export_defaults_dump"

	func _get_export_options(platform: EditorExportPlatform) -> Array[Dictionary]:
		if not platforms.has(platform):
			platforms.append(platform)
		return []


var _capture: Capture
var _frames: int = 0
var _saved_at: int = -1


func _enter_tree() -> void:
	_capture = Capture.new()
	add_export_plugin(_capture)


func _process(_delta: float) -> void:
	_frames += 1
	if _saved_at < 0 and _frames > 30 and not _capture.platforms.is_empty():
		for platform: EditorExportPlatform in _capture.platforms:
			for preset: EditorExportPreset in platform.get_current_presets():
				preset.set("custom_template/debug", "")
		_saved_at = Time.get_ticks_msec()
		print("export-defaults: platforms=", _capture.platforms.size())
	if _saved_at >= 0 and Time.get_ticks_msec() - _saved_at > 3000:
		remove_export_plugin(_capture)
		get_tree().quit()
