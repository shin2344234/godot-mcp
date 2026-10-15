@tool
extends RefCounted
## Writes/deletes `res://.godot/godot_mcp/session.json`, which tells the MCP server how to
## reach this editor: port, auth token, pid and versions (docs/bridge-protocol.md section 1).
##
## The file lives under `.godot/` (git-ignored by Godot's default .gitignore) and is made
## readable by the current user only where the OS supports Unix permissions, because the
## token grants full control over the editor to anyone who can connect to the port.

const Constants := preload("../core/constants.gd")

## [code/docs area] Session file written instead of session.json by a private "LSP-only"
## editor that the MCP server starts just for the GDScript language server (see
## server/src/lsp/manager.ts and plugin.gd). A separate file keeps the server's main
## bridge from routing scene edits into that invisible editor, while still letting the
## server reach it (e.g. to ask for a filesystem rescan after files change on disk).
const LSP_SESSION_FILE: String = "res://.godot/godot_mcp/lsp_session.json"


## Writes the session file. Returns OK or the Godot error code.
## [code/docs area] `file` selects session.json (default) or LSP_SESSION_FILE; `extra` adds
## fields such as "lsp_port" (the editor's GDScript language server port).
static func write(port: int, token: String, file: String = Constants.SESSION_FILE, extra: Dictionary = {}) -> int:
	var dir_abs: String = ProjectSettings.globalize_path(Constants.SESSION_DIR)
	var dir_err: int = DirAccess.make_dir_recursive_absolute(dir_abs)
	if dir_err != OK and dir_err != ERR_ALREADY_EXISTS:
		return dir_err
	var data: Dictionary = {
		"protocol": Constants.PROTOCOL_VERSION,
		"port": port,
		"token": token,
		"pid": OS.get_process_id(),
		"godot_version": Constants.godot_version_string(),
		"plugin_version": Constants.PLUGIN_VERSION,
		"project_path": Constants.project_path(),
		"started_at": Constants.utc_now_iso(),
	}
	data.merge(extra)
	var path_abs: String = ProjectSettings.globalize_path(file)
	# Write to a temp file and rename, so a server polling for the file never reads a
	# half-written JSON document.
	var tmp_abs: String = path_abs + ".tmp"
	var f: FileAccess = FileAccess.open(tmp_abs, FileAccess.WRITE)
	if f == null:
		return FileAccess.get_open_error()
	f.store_string(JSON.stringify(data, "  ") + "\n")
	f.close()
	if OS.get_name() != "Windows":
		# 0600: owner read/write only. Failure is not fatal (e.g. exotic filesystems).
		FileAccess.set_unix_permissions(tmp_abs, FileAccess.UNIX_READ_OWNER | FileAccess.UNIX_WRITE_OWNER)
	var rename_err: int = DirAccess.rename_absolute(tmp_abs, path_abs)
	if rename_err != OK:
		DirAccess.remove_absolute(tmp_abs)
		return rename_err
	return OK


## Deletes the session file if it exists (and still belongs to this process).
static func remove(file: String = Constants.SESSION_FILE) -> void:
	var path_abs: String = ProjectSettings.globalize_path(file)
	if not FileAccess.file_exists(path_abs):
		return
	# Another editor instance on the same project may have overwritten the file since we
	# wrote it; only delete it if it is ours.
	var parsed: Variant = JSON.parse_string(FileAccess.get_file_as_string(path_abs))
	if parsed is Dictionary and int((parsed as Dictionary).get("pid", -1)) != OS.get_process_id():
		return
	DirAccess.remove_absolute(path_abs)
