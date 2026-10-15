# Methods: project configuration and export (step 2)

Groups `project` and `export`. Addon side: `addons/godot_mcp/ops/project_ops.gd`
(with `core/project_input.gd` and `core/project_validate.gd`) and
`addons/godot_mcp/ops/export_ops.gd`. Server side: `server/src/ops/projectEdit.ts`
and `server/src/ops/exports.ts`. Conventions (value codec, error codes) are those of
`docs/bridge-protocol.md` sections 3 and 5. All methods are **(E/H)** except
`export.run`, which is not a bridge method (the server runs Godot's CLI exporter).

The read-only tools `godot_project_info` / `godot_project_settings` (core group) read
project.godot directly in TypeScript; the methods below are the write side.

## How settings are written

Every project method persists through `ProjectSettings.set_setting()` +
`ProjectSettings.save()`, never by editing project.godot text:

* **Editor:** one `EditorUndoRedoManager` action named `"MCP: <method>"` in the
  *global* history (context object `ProjectSettings`, `mark_unsaved = false`), with
  `ProjectSettings.save()` as a do *and* undo method, so Ctrl+Z reverts the setting and
  the file. While the editor is open it owns project.godot (it keeps all settings in
  memory and would overwrite disk edits), which is why the server routes these methods
  to it whenever it is connected. Verified on 4.7.2: undo of project.set, input.edit and
  autoload.edit restores memory and file.
* **Headless:** the runner is started with `--path <project>`, so `ProjectSettings` holds
  the project's settings. `save()` from a `--script` run writes only non-default values
  and keeps section/key order; like the editor it replaces the comment block at the top
  of the file with Godot's standard header (verified by diffing a temp copy).

## project.set (E/H)

params: `{ "settings": { "<section/name>": value | null, ... }, "create"?: false }`

* Values are decoded against the setting's property info (`ProjectSettings.get_property_list()`)
  with the codec: `"1280"` → int, `"#202020"` → Color, enum ints accept names.
  Range hints (`1,7680,1,or_greater`), string enum hints
  (`rendering/renderer/rendering_method`) and file hints (must exist) are checked.
* `null` resets: built-in settings go back to `property_get_revert()` (and disappear from
  the file); custom settings are erased.
* Unknown names → `NOT_FOUND` with up to 5 similar names, unless `create: true`.
* `input/*`, `autoload/*` and `editor_plugins/*` → `BAD_PARAMS` pointing at
  input.edit / autoload.edit / project.plugins.
* `godot_mcp/bridge/port` must be an int in 1024-65535 (a warning says it applies when
  the plugin restarts).

result: `{ "changed": { key: { "old", "new" } }, "saved": true, "restart_required"?: [keys], "warnings"?: [...] }`

## input.edit (E/H)

params: `{ "ops": [ { "op", "action", "event"?, "index"?, "deadzone"? }, ... ] }`, applied in
order, committed as one undo action. Ops: `add_action` (deadzone default 0.2 =
`InputMap.DEFAULT_DEADZONE`; optional first `event`), `remove_action`, `add_event`,
`remove_event` (`index` or the same `event` spec, matched with `InputEvent.is_match(exact)`),
`clear_events`, `set_deadzone` (0-1).

Event specs (all events are saved with `device = -1`, all devices, like the editor's
dialog; a bare `InputEventKey` would get 4.7's keyboard device id):

| spec | notes |
|---|---|
| `"Space"`, `"Ctrl+S"` | shorthand for a physical key |
| `{"type": "key", "key": "A", "physical"?: true, "ctrl"?, "shift"?, "alt"?, "meta"?}` | names via `OS.find_keycode_from_string` (case-insensitive) plus aliases (esc, return, del, ...); `physical: false` stores the keycode |
| `{"type": "mouse_button", "button": "left" \| 1}` | left, right, middle, wheel_up/down/left/right, xbutton1/2 |
| `{"type": "joy_button", "button": "a" \| 0, "device"?}` | JoyButton names + aliases (cross, triangle, lb, start...) |
| `{"type": "joy_axis", "axis": "left_x" \| 0, "value": -1 \| 1}` | left_x/y, right_x/y, trigger_left/right (lt, rt) |

Built-in `ui_*` actions can be edited (the full action is then written to project.godot,
with a warning); `remove_action` on one restores the engine default instead of deleting.
Action names follow the editor's rule (no `/ : = \ "`).

result: `{ "actions": { name: { "deadzone", "events": ["key: Space - Physical", ...] } | null }, "saved": true, "warnings"?: [...] }`

## autoload.edit (E/H)

params: `{ "op": "add" | "remove" | "move", "name", "path"?, "singleton"?: true, "index"? }`

* Name rules = `EditorAutoloadSettings::_autoload_name_is_valid` (identifier, not an
  engine class, global script class, built-in type, engine singleton or keyword).
* `path`: an existing .gd/.cs/.tscn/.scn; a .gd with compile errors is added with a warning.
  A .gd whose native base is not a Node (resolved through `extends` chains, class_name
  bases included) is refused: Godot fails to instantiate such an autoload at startup.
* Stored like 4.7's Autoload tab: `"*uid://..."` (`*` = singleton) via
  `ResourceUID.path_to_uid` (falls back to the res:// path when the file has no UID).
* Editor: `add` with defaults uses `EditorPlugin.add_autoload_singleton` and `remove` uses
  `remove_autoload_singleton` (the Autoload tab's own undoable path); `add` with `index`
  or `singleton: false` and `move` use a ProjectSettings undo action with `set_order`.
  Order: the existing autoload order numbers are reassigned in the new sequence, as the
  tab's drag and drop does.

result: `{ "autoloads": [ { "name", "path", "singleton" } ] (load order), "saved": true, "warnings"? }`

## project.plugins (E/H)

params: `{ "enable"?: [...], "disable"?: [...], "force"?: false }`; entries are a folder
name under addons/ (`"gut"`), `addons/x`, `res://addons/x[/plugin.cfg]` or the plugin's
display name. Plugins are found like the Plugins tab (recursive scan of res://addons until
a folder has plugin.cfg).

* Editor: `EditorInterface.set_plugin_enabled(path, bool)`, then `ProjectSettings.save()`.
  A plugin that fails to load is reported in `warnings`.
* Headless: edits `editor_plugins/enabled` (sorted, erased when empty, like
  `EditorNode::_update_addon_config`); the editor picks it up when it next opens the project.
* Disabling `godot_mcp` needs `force: true` (in the editor it is deferred so the response
  is sent before the bridge closes).

result: `{ "plugins": [ { "path", "name", "version", "enabled", "missing"? } ], "changed": [ { "path", "enabled" } ], "warnings"? }`

## project.validate (E/H, read-only)

params: `{ "scope"?: "all" | "project" | "scenes" | "resources" | "scripts" | "uids", "path_prefix"?: "res://", "deep"?: false, "limit"?: 200, "offset"?: 0 }`

Checks (files under `path_prefix`, skipping hidden folders and folders with `.gdignore`):

| kind | severity | source |
|---|---|---|
| `main_scene` | error (missing) / warning (unset) | `application/run/main_scene` |
| `autoload` | error | autoload path or UID does not resolve |
| `plugin` | error | enabled plugin.cfg or its script missing |
| `icon` | warning | `application/config/icon` missing |
| `missing_dependency` | error | `ResourceLoader.get_dependencies()` path missing and UID unknown |
| `moved_dependency` | warning | path missing but the UID resolves elsewhere |
| `stale_uid` | warning | UID unknown, path exists (Godot falls back to the path) |
| `load_failed` / `load_errors` | error | `deep: true` only: load with `CACHE_MODE_IGNORE`, engine errors captured with a Logger |
| `script_error` | error | `core/script_validate.gd` compile (max 3 per script) |
| `missing_uid` / `orphan_uid` | warning | .gd/.cs/.gdshader(inc) without `.uid`, `.uid` without its file |
| `duplicate_uid` | error | same UID in several `.uid` files, scene/resource headers or `.import` files |

`get_dependencies` reads only the ext_resource list, so no asset is loaded unless `deep`.
Entries look like `"uid://...::Type::res://path"` when the reference has a UID.

result: `{ "issues": [ { "severity", "kind", "path", "message", "fix_hint" } ], "counts": { "total", "error", "warning", "by_kind" }, "checked": { "files", "scenes", "resources", "scripts" }, "truncated", "next_offset"? }`

## export.presets (E/H, read-only)

params: `{ "preset"?: name | index }`. Without `preset`: a summary per preset (`index`,
`name`, `platform`, `runnable`, `export_path`, filters, a few key options, `option_count`).
With it: every field and option.

* 4.7 layout: `[preset.N]`, `[preset.N.options]`, and `[runnable_presets]`
  (`Platform="Preset name"`; the legacy `runnable=true` key is still read).
* Secrets: Godot keeps credential options and the script encryption key in
  `.godot/export_credentials.cfg`; this module **never reads or writes that file**.
  Secret-looking keys found in export_presets.cfg (names containing key, password,
  secret, token, keystore, identity, certificate, apple_id, ssh, ...) are returned as
  `"<redacted>"` (booleans/numbers and empty strings are kept) and listed in `redacted`.
* The server adds `templates: { version, dir, installed, files? }` and per preset
  `templates_missing: [...]` (expected file names, e.g. `linux_release.x86_64`,
  `windows_release_x86_64.exe`, `web_nothreads_release.zip`; skipped when
  `custom_template/<mode>` is set). Template dir = `<editor data dir>/export_templates/<version>`
  where the data dir is `~/.local/share/godot` (Linux, honours `XDG_DATA_HOME`),
  `~/Library/Application Support/Godot` (macOS), `%APPDATA%\Godot` (Windows) or
  `editor_data/` beside a self-contained binary, and version is e.g. `4.7.2.stable`
  (`.mono` suffix for .NET builds).

## export.preset_set (E/H)

params: `{ "preset"?: name | index, "set"?: { key: value }, "create"?: { "name", "platform" }, "allow_new_keys"?: false, "allow_secrets"?: false }`

* Keys of `[preset.N]` (`name`, `export_path`, `export_filter`, `include_filter`,
  `runnable`, `custom_features`, `patches`, ...) are fields; anything else (or an
  `options/` prefix) is a platform option. Values are decoded to the type of the current
  value. Unknown options → `NOT_FOUND` with did-you-mean unless `allow_new_keys`
  (Godot writes every option of a platform, so unknown usually means a typo).
* `runnable: true` updates `[runnable_presets]` (one runnable preset per platform);
  renaming keeps it in sync. `platform` cannot change.
* Credential options (keystore/*, codesign/*, notarization/*, provisioning profiles) and
  `script_encryption_key` are refused: they belong in `.godot/export_credentials.cfg`
  (set them in Project > Export or via Godot's env vars such as
  `GODOT_ANDROID_KEYSTORE_RELEASE_PASSWORD`). Other secret-looking keys need
  `allow_secrets: true`; their values are never echoed.
* `create` appends `[preset.N]` with the defaults `EditorExport::_save` writes for a new
  preset, and an options section with **every option of the platform and its default**,
  as the editor writes it, so documented keys (`binary_format/embed_pck`, ...) can be set
  in the same call. No script API lists a platform's options outside the editor, so they
  come from `core/export_defaults.cfg`, generated from a headless editor by
  `scripts/gen-export-defaults.sh` (rerun it when the targeted Godot version changes).
  Secret options are not in it (Godot keeps them in `export_credentials.cfg`).
  Platforms: Linux, Windows Desktop, macOS, Android, iOS, visionOS, Web (aliases accepted).
* The file is written with `ConfigFile` (the editor's own format). In the editor, no
  script API exposes EditorExport's in-memory presets, so the editor is made to reload
  the file: registering and removing an empty `EditorExportPlatformExtension` sets
  EditorExport's reload flag, and next frame it re-runs `load_config()`. Verified on
  4.7.2: a plain disk edit stays invisible to the editor, after export.preset_set the
  editor's `EditorExportPreset` has the new value. Result field `editor_reloaded`.

result: `{ "preset": <summary>, "changed": { key: value (redacted) }, "created", "saved": true, "editor_reloaded"?, "note"? }`

## export.run (server-side, not a bridge method)

params: `{ "preset": name, "mode"?: "release" | "debug" | "pack" | "patch", "output"?, "patches"?: [...], "allow_outside_project"?: false, "timeout_s"?: 1800 }`

Runs `godot --headless --path <project> --export-<mode> "<preset>" <absolute output> [--patches a,b]`
as a child process (works with or without the editor open):

* Preset details come from `export.presets` (editor or headless).
* `output` defaults to the preset's `export_path` (pack/patch: same name with `.pck`).
  Relative/res:// paths stay inside the project (not `.godot/`); absolute paths outside
  the project need `allow_outside_project`. Pack/patch outputs must end in .pck or .zip.
  The output folder is created (Godot requires it to exist).
* release/debug fail fast when the template the preset needs is missing (message names
  the file, the folder and Editor > Manage Export Templates). Pack/patch exports never
  need templates (verified: `--export-pack` with no templates installed exits 0).
* Output lines are streamed: `[ 42% ] savepack | ...` becomes `ctx.progress(42, 100, ...)`.
  Cancellation (`ctx.signal`) and the timeout stop the process (SIGTERM, then SIGKILL).
* The export starts a second editor instance whose godot_mcp plugin would overwrite and
  then delete `.godot/godot_mcp/session.json`; the server restores the live editor's
  session file afterwards.

result: `{ "preset", "platform", "mode", "output", "exit_code", "duration_s", "files": [ { "path", "size" } ], "errors": [...], "warning_count", "tail": [last 25 lines] }`;
a non-zero exit (or no output file) is a `GODOT_ERROR` whose message lists the error lines.
