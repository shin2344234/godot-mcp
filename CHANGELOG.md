# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

The first public release, planned as **0.1.0**. It covers the MCP server
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
- **Files** inside the project only (`res://` sandbox, symlink-aware): list, read,
  search, write, edit, move and delete, with automatic GDScript syntax checks.
- **Resources and visual authoring**: `.tres` resources and dependencies, visual
  shader graphs, shader checks, Control layout.
- **Animation, world and audio**: AnimationPlayer, AnimationTree and SpriteFrames
  (animations cut from sprite sheets), TileMapLayer,
  GridMap and TileSet, navigation baking and paths, audio bus layout.
- **Project, import and export**: project settings, input actions, autoloads, plugins,
  validation, import options, export presets and export runs. Export credentials
  are never read or written by the export tools.
- **Code intelligence**: GDScript diagnostics, symbols, lookups and renames through
  Godot's language server (the editor's, or a private headless one).
- **Offline docs**: search the class reference of the installed Godot version.
- **Running the game**: start and stop runs, read output and errors with script stacks.
- **Live game tools**: live scene tree, read and edit nodes, input (keys, mouse, touch,
  actions), pause and frame stepping, input recording and replay, screenshots (also of
  the editor's 2D/3D views), performance monitors and a script profiler.
  `godot_game_eval` is off unless the server runs with `--allow-eval`.
- **Debugging**: breakpoints, stepping, call stack, variables and expression evaluation
  on games the server starts.
- **Test runs**: GUT 9.7.x and GdUnit4 6.2.x or newer, with per-test progress and
  failures with file and line.
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
  `addon_hint` when the addon is missing or out of date.
- **Claude Code plugin** (`/plugin marketplace add shin2344234/godot-mcp`) and a
  **Claude Desktop extension** (`.mcpb` bundle).
- **`godot-mcp init`**: installs and enables the addon, registers the server in the
  project config of Claude Code, Cursor, VS Code, Codex, Gemini CLI, Zed and more
  (Claude Desktop and Windsurf globally), and adds a short `AGENTS.md` block.
  `--dry-run` previews, `--remove` undoes.
- **Docs**: per-client setup, troubleshooting, protocol and per-area method references.

[unreleased]: https://github.com/shin2344234/godot-mcp/commits/main
