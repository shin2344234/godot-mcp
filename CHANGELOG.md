# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.2] - 2026-10-16

### Fixed

- **The addon reported its version as 0.1.0 in 0.1.1.** `PLUGIN_VERSION` in
  `addons/godot_mcp/core/constants.gd` was not bumped with the rest, so the editor bridge's
  welcome message, `godot_status`, the session file and the server's "Connected to Godot
  editor" log showed 0.1.0. Nothing compared it, and `godot-mcp init` reads `plugin.cfg`,
  so this was a wrong label only. The release version check now covers that file too.

## [0.1.1] - 2026-10-16

Fixes for the bugs a code review of 0.1.0 found and reproduced.

### Fixed

- **Scene paths could escape the project.** Godot's `simplify_path()` keeps a leading
  `..`, so `res://../x.tscn` passed the addon's check and `godot_scene_create` wrote files
  next to the project folder. The addon now rejects such paths, and the server refuses any
  `res://` value that climbs above the project before it reaches Godot.
- **`godot_files_search` and recursive `godot_files_list` followed links out of the project.**
  Symlinks and Windows junctions found while walking are now followed only when they stay
  inside the project, never into the secret files, and never in a loop.
- **A Godot binary that can't be started crashed the server.** `godot_run_start` now marks
  the run finished with the reason in its output, and `godot_editor_launch` reports it.
- **Non-ASCII characters in Godot output were sometimes garbled** when a character was split
  between two output chunks (game output, headless calls, exports, tests, the language
  server).
- **Multi-line `godot_files_edit` failed on files with Windows (CRLF) line endings.** The
  edit now matches text copied from `godot_files_read` and keeps the file's line endings.

## [0.1.0] - 2026-10-16

The first public release. It covers the MCP server
(`@shin2344234/godot-mcp` on npm) and the Godot editor addon (`addons/godot_mcp`).
Needs Godot 4.7 or newer (tested with 4.7.2).

### Added

- **MCP server** over stdio for the 2026-07-28 MCP spec, also serving 2025-era clients.
  90 operations in 21 tool groups, with read-only and destructive hints on every tool.
- **Two tool modes**: `full` (every operation is a tool) and `compact` (14 core tools
  plus `godot_tools` search and `godot_call_read` / `godot_call_write` routers).
  `--toolsets` and `--read-only` narrow the list further. A budget test keeps the
  tool definitions at about 15k tokens in full mode and 2.2k in compact mode.
- **Live editor bridge**: the editor addon serves a WebSocket on 127.0.0.1 with a fresh
  token per editor session. Scene edits go through the editor's undo history.
- **Headless fallback**: the same scene and node operations run in a one-shot
  `godot --headless` process when the editor is closed.
- **Scenes, nodes and signals**: read the tree, create, open, save, inherit and close
  scenes; add, set, remove, rename, reparent, duplicate, instance, find and move nodes;
  groups; signal connections; all-or-nothing batches as one undo step.
  Removing, renaming or moving a node inherited from a base scene (or inside an instance
  with Editable Children) is refused, since Godot would restore it on load. `node.set`
  warns when an animation keys the property. The editor keeps a scene's unsaved state
  when switching to a scene whose sub-scene was saved (a Godot bug otherwise drops it).
  `scene.tree` counts an instance's hidden nodes and lists them when started there.
- **Files** inside the project only (`res://` sandbox, symlink-aware): list, read,
  search, write, edit, move and delete, with automatic GDScript checks (parse and type
  errors, the same compile as `godot_script_validate`). `files.list` hides `.uid`/`.import`
  sidecars and, when recursive, `addons/` contents unless `all: true`. `files.move` of a
  `class_name` script refreshes Godot's global class cache (editor scan, or `--import`
  before the next headless call), so the moved script no longer "hides a global class".
- **Resources and visual authoring**: `.tres` resources and dependencies, visual
  shader graphs, shader checks, Control layout.
- **Animation, world and audio**: AnimationPlayer, AnimationTree and SpriteFrames
  (animations cut from sprite sheets), TileMapLayer,
  GridMap and TileSet, navigation baking and paths, audio bus layout.
  `tileset.edit` covers one-way collision, navigation and occlusion layers/polygons,
  per-tile values (custom data by name, modulate, z_index...), alternative tiles and tile
  animation, and warns about keys an op ignores; `grid.edit` paints terrains by name over
  a `rect`; `navigation.bake` takes `agent_radius`.
- **Project, import and export**: project settings, input actions, autoloads, plugins,
  validation, import options, export presets and export runs. Export credentials
  are never read or written by the export tools. `import.get` shows only options that
  differ from the importer's defaults (`full: true` for all; defaults generated by
  `scripts/gen-import-defaults.sh`), `import.set` replies with what changed and whether
  the reimport worked. `project.validate` skips vendored `addons/` unless `addons: true`.
  `input.edit` describes every physical key binding as `"<key> - Physical"` (also
  Up/Escape/F1). `export.preset_set` reports an unknown option before treating a
  `*key*`-like name as a secret, and `export.run`'s `tail` leaves out per-file progress
  lines.
- **Code intelligence**: GDScript diagnostics, symbols, lookups and renames through
  Godot's language server (the editor's, or a private headless one). Symbol outlines
  repair two gaps of Godot's own details from the source: typed signal parameters and
  non-String defaults (`Vector2(0, -180)`, not `"(0.0, -180.0)"`).
- **Offline docs**: search the class reference of the installed Godot version.
- **Running the game**: start and stop runs, read output and errors with script stacks,
  also for games started from the editor. Driver and audio start-up noise is tagged
  `ENV` and kept out of the error counts.
- **Live game tools**: live scene tree, read and edit nodes, input (keys, mouse, touch,
  actions; clicks report the Control and physics object hit), pause and stepping by
  frames or exact physics ticks, input recording and replay, screenshots (of the window,
  a node framed on screen, or the editor's 2D/3D views, which put the editor's main
  screen back afterwards), performance monitors and a script profiler.
  `godot_game_eval` is off unless the server runs with `--allow-eval`.
- **Debugging**: breakpoints, stepping, call stack, variables and expression evaluation
  on games the server starts. `debug.state` opens object variables (`expand`) and can
  wait for a stop; breakpoints on declaration lines and a `step_out` that leaves the
  caller frame are explained.
- **Test runs**: GUT 9.7.x and GdUnit4 6.2.x or newer, with per-test progress and
  failures with file and line (GUT's values labeled "got ..., expected ...").
- **Editor helpers**: editor log, launching the editor, Scene dock selection, opening a
  script at a line, saving everything, editor toasts.
- **Runtime injection** through a temporary `override.cfg` that is removed once the game
  is up; `project.godot` is never changed. The runtime is inactive without a debugger.
- **Resources and prompts**: `godot://project/info`, `godot://editor/status`,
  `godot://editor/logs`, `godot://scene/{path}`, `godot://script/{path}`; prompts
  `scaffold-player`, `triage-errors`, `port-from-godot-3`, `write-shader`.
- **Confirmation** before irreversible steps through MCP elicitation, where the client
  supports it (`--confirm never` turns it off).
- **`godot_addon_install`**: copies the addon bundled with the server into the project and
  enables it (asks before replacing an existing copy). `godot_status` reports an
  `addon_hint` when the addon is missing or out of date, and says that scene tools then
  work headless without the editor. `godot_tools` search without a query returns a
  compact index (name and title per operation) instead of the whole catalog.
- **Claude Code plugin** (`/plugin marketplace add shin2344234/godot-mcp`) and a
  **Claude Desktop extension** (`.mcpb` bundle).
- **`godot-mcp init`**: installs and enables the addon, registers the server in the
  project config of Claude Code, Cursor, VS Code, Codex, Gemini CLI, Zed and more
  (Claude Desktop and Windsurf globally), and adds a short `AGENTS.md` block.
  `--dry-run` previews, `--remove` undoes.
- **Docs**: a short README with install steps; under `docs/`, per-client setup, the full tool list, how it works, troubleshooting, protocol designs and per-area method references.

[unreleased]: https://github.com/shin2344234/godot-mcp/compare/v0.1.2...HEAD
[0.1.2]: https://github.com/shin2344234/godot-mcp/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/shin2344234/godot-mcp/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/shin2344234/godot-mcp/releases/tag/v0.1.0
