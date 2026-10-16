# Methods: core, files and editor

The tools an agent uses to orient itself, read and write project files, and open the
editor. Unlike most areas, the `core` and `files` tools run in the TypeScript server itself
(`server/src/ops/core.ts`, `server/src/ops/files.ts`) and need no Godot process, except
for the GDScript check after a write. `godot_editor_logs` and `godot_editor_launch` live in
`server/src/ops/run.ts`.

**Contents:**
[godot_status](#godot_status-read) ·
[godot_addon_install](#godot_addon_install-write-destructive) ·
[godot_project_info](#godot_project_info-read) ·
[godot_project_settings](#godot_project_settings-read) ·
[File paths](#file-paths-and-the-project-sandbox) ·
[godot_files_list](#godot_files_list-read) ·
[godot_files_read](#godot_files_read-read) ·
[godot_files_search](#godot_files_search-read) ·
[godot_files_write](#godot_files_write-write-destructive) ·
[godot_files_edit](#godot_files_edit-write) ·
[godot_files_move](#godot_files_move-write) ·
[godot_files_delete](#godot_files_delete-write-destructive) ·
[godot_editor_logs](#godot_editor_logs-read) ·
[godot_editor_launch](#godot_editor_launch-write)

## godot_status (read)

No parameters. The tool to call first in a session. Returns:

| Field | Meaning |
|---|---|
| `server_version` | Version of the running server |
| `project_path`, `project_found`, `project_name` | The project folder the server was started with, whether it holds a `project.godot`, and the project's name |
| `addon_installed` | Whether `addons/godot_mcp` is in the project |
| `godot` | `{ path, version }` of the Godot executable found, or `null` |
| `editor_connected`, `editor` | Whether the live editor bridge is connected, and its status (open scenes, unsaved changes, playing state) |
| `runs` | Games started by this server: `run_id`, scene, whether it is still running, exit code, error and warning counts |
| `scene_backend` | Where scene edits go right now: `editor (undoable, live)`, `headless (edits .tscn files on disk)` or `unavailable` |
| `addon_hint` | Only when the addon is missing or older than the server's copy: what to do about it |
| `godot_hint` | Only when the Godot found is older than 4.7, the minimum supported version |

## godot_addon_install (write, destructive)

No parameters. Copies the addon bundled with the server into `res://addons/godot_mcp` and
enables it in `project.godot`. This is how people who installed the server as a Claude
Desktop bundle or a Claude Code plugin, and so never ran `init`, get the addon.

- When the project already has the same version, nothing is copied.
- When it has a different version, clients that support elicitation ask first, since local
  edits to those files are lost.
- Result: `installed_version`, `previous_version`, `copied`, `plugin_enabled_now`, and a
  `note`. An open editor must be restarted, or the plugin turned off and on in
  **Project > Project Settings > Plugins**, to load a new addon. Headless tools use it
  right away.

## godot_project_info (read)

No parameters. Facts parsed from `project.godot`: name, the Godot version the project was
made with, main scene, autoloads, input action names, renderer, enabled plugins, whether the
project uses C#, and which test framework (GUT or GdUnit4) is installed.

## godot_project_settings (read)

| Parameter | Default | Meaning |
|---|---|---|
| `prefix` | all | Only keys starting with this, e.g. `"display/window"` or `"input/"` |
| `limit` | 200 | At most this many keys (1 to 1000) |

Returns `count`, `truncated` and `settings` (key to JSON value). Only values that differ from
Godot's defaults are stored in `project.godot`, so a missing key means the default. To change
settings use `godot_project_set` ([project-export.md](project-export.md)).

## File paths and the project sandbox

All file tools take project paths: `res://scenes/main.tscn` or a path relative to the
project folder. They refuse absolute paths, `..` escapes, and symlinks that lead outside the
project. They never write inside Godot's `.godot/` cache, and no file tool can read, search
or write the export credentials (`.godot/export_credentials.cfg`) or the editor bridge's
session file.

When the editor is connected, every write, move and delete asks it to rescan the changed
files and reload open script tabs (`editor_refreshed: true` in the result). Without that the
editor could keep showing stale content, and overwrite the change on its next save.

Godot keeps sidecar files next to resources: `foo.gd.uid` (stable resource IDs) and
`foo.png.import` (import settings). Moves and deletes carry them along.

## godot_files_list (read)

| Parameter | Default | Meaning |
|---|---|---|
| `path` | `res://` | Folder to list |
| `recursive` | `false` | Walk subfolders |
| `pattern` | none | File-name filter with `*` and `?`, case-insensitive, e.g. `"*.tscn"` |
| `all` | `false` | Also list `.uid`/`.import` sidecars and, when recursive, the contents of `res://addons/` |
| `max` | 500 | At most this many entries (1 to 5000) |

`.godot/`, `.git/` and similar tool folders are always skipped. When something was hidden,
the result says how many entries and how to show them. Listing `res://addons` itself shows
everything in it, and a `pattern` naming a sidecar extension (`"*.uid"`) lists those files.

## godot_files_read (read)

| Parameter | Default | Meaning |
|---|---|---|
| `path` | required | Text file to read |
| `offset` | 1 | First line (1-based) |
| `limit` | 1000 | At most this many lines (1 to 5000) |

Returns the lines numbered, plus `total_lines`, `from`, `to` and `truncated`. Binary files
(images, audio, compiled files) and files over about 2.5 MB are refused.

## godot_files_search (read)

| Parameter | Default | Meaning |
|---|---|---|
| `query` | required | Text to find |
| `regex` | `false` | Treat `query` as a JavaScript regular expression |
| `case_sensitive` | `false` | |
| `path` | `res://` | Folder to search |
| `pattern` | none | Only files whose name matches, e.g. `"*.gd"` |
| `max_results` | 100 | At most this many matching lines (1 to 1000) |

Searches text files only (scripts, scenes, resources, shaders, configs, JSON, Markdown and
similar) and skips files over 1 MB. Each match has `path`, `line` and the trimmed line text.

## godot_files_write (write, destructive)

| Parameter | Default | Meaning |
|---|---|---|
| `path` | required | File to create or replace. Missing folders are created |
| `content` | required | The whole file |
| `overwrite` | `true` | `false` fails instead of replacing an existing file |

After writing a `.gd` file the server compiles it, exactly as `godot_script_validate` does,
and returns the result as `validation`: parse errors and type errors such as
`var x: int = "hello"`. As in Godot, a syntax error stops the parser, so type errors
elsewhere in the file show up once it is fixed. Prefer `godot_files_edit` for small changes.

## godot_files_edit (write)

| Parameter | Default | Meaning |
|---|---|---|
| `path` | required | File to change |
| `old_text` | required | Exact text to replace, including indentation (tabs and spaces matter in GDScript) |
| `new_text` | required | Replacement |
| `replace_all` | `false` | Replace every occurrence instead of requiring exactly one |

Fails when `old_text` is not found, or found more than once without `replace_all`. GDScript
files are checked afterwards, as for `godot_files_write`.

## godot_files_move (write)

Parameters `from` and `to`. Moves or renames a file or folder with its sidecars. The target
must not exist. References by `uid://` keep working; plain `res://` paths in other files are
**not** rewritten, so search for them with `godot_files_search`. Moving a script with a
`class_name` refreshes Godot's global class cache (an editor rescan, or a cache refresh before
the next headless call), so the moved script doesn't report that it "hides a global class".

## godot_files_delete (write, destructive)

Parameters `path` and `recursive` (default `false`, required to delete a folder). Deletes the
file and its sidecars. This cannot be undone, so clients that support elicitation ask first.
The project root and `project.godot` can't be deleted.

## godot_editor_logs (read)

Needs the live editor. Reads what the editor process printed: messages, warnings and errors
from plugins and tool scripts, and import errors. A running game's prints are not here; read
them with `godot_run_output` ([debug.md](debug.md)).

| Parameter | Default | Meaning |
|---|---|---|
| `since` | 0 | Return entries after this sequence number (the `next` value of the last call) |
| `limit` | 200 | At most this many entries (1 to 2000) |
| `level` | `all` | `all`, `warning` (warnings and errors) or `error` |

Repeated entries are merged into the first one with a `count`. Errors and warnings that
differ only in numbers (Godot puts serial numbers and ids into many messages) count as
repeats; plain prints merge only when identical.

## godot_editor_launch (write)

Opens this project in the Godot editor and waits until the addon's bridge connects.

| Parameter | Default | Meaning |
|---|---|---|
| `wait_seconds` | 60 | How long to wait for the bridge (0 to 300) |
| `headless` | `false` | Run the editor without a window, for automation and CI |

If an editor is already connected it returns `already_running: true`. The addon must be
installed and enabled in the project (see `godot_addon_install`).
