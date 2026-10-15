@tool
extends RefCounted
## Temporary runtime autoload through res://override.cfg, for games started from the editor.
##
## Mirror of server/src/game/override.ts (same marker line and backup path, so the editor
## plugin and the MCP server can each clean up after the other). Godot reads override.cfg
## at startup, after project.godot, and its [autoload] entries are instantiated like the
## project's own (verified with 4.7.2). The plugin writes the file in EditorPlugin._build()
## (called right before the editor runs the project) and restores the original as soon as
## the debugger session starts, i.e. after the game has read it.

const MARKER: String = "; godot_mcp: temporary runtime autoload (removed automatically)"
const AUTOLOAD_NAME: String = "GodotMcpRuntime"
const RUNTIME_SCRIPT: String = "res://addons/godot_mcp/runtime/mcp_runtime.gd"
const OVERRIDE_PATH: String = "res://override.cfg"
const BACKUP_PATH: String = "res://.godot/godot_mcp/override.cfg.user-backup"


## Writes override.cfg with the runtime autoload, keeping (and backing up) the user's own
## override.cfg content. Returns OK or the file error.
static func inject() -> int:
	restore_if_stale()
	if not FileAccess.file_exists(RUNTIME_SCRIPT):
		return ERR_FILE_NOT_FOUND
	var original: String = ""
	if FileAccess.file_exists(OVERRIDE_PATH):
		original = FileAccess.get_file_as_string(OVERRIDE_PATH)
		DirAccess.make_dir_recursive_absolute(BACKUP_PATH.get_base_dir())
		var b := FileAccess.open(BACKUP_PATH, FileAccess.WRITE)
		if b == null:
			return FileAccess.get_open_error()
		b.store_string(original)
		b.close()
	var ours: String = "%s\n[autoload]\n\n%s=\"%s\"\n" % [MARKER, AUTOLOAD_NAME, RUNTIME_SCRIPT]
	var f := FileAccess.open(OVERRIDE_PATH, FileAccess.WRITE)
	if f == null:
		return FileAccess.get_open_error()
	# A second [autoload] header is fine: the config parser continues the section.
	f.store_string((original.strip_edges(false, true) + "\n\n" + ours) if original != "" else ours)
	f.close()
	return OK


## Puts the user's override.cfg back, or deletes ours. Safe to call any time.
static func restore() -> void:
	if FileAccess.file_exists(BACKUP_PATH):
		DirAccess.rename_absolute(ProjectSettings.globalize_path(BACKUP_PATH), ProjectSettings.globalize_path(OVERRIDE_PATH))
	elif FileAccess.file_exists(OVERRIDE_PATH) and FileAccess.get_file_as_string(OVERRIDE_PATH).contains(MARKER):
		DirAccess.remove_absolute(ProjectSettings.globalize_path(OVERRIDE_PATH))


## Restores a file left behind by a crash (ours carries the marker).
static func restore_if_stale() -> void:
	if FileAccess.file_exists(OVERRIDE_PATH) and FileAccess.get_file_as_string(OVERRIDE_PATH).contains(MARKER):
		restore()
