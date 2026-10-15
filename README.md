# godot-mcp

An [MCP](https://modelcontextprotocol.io) server for the **Godot 4** engine. Use it with Claude Code, Cursor, Codex, VS Code Copilot, Gemini CLI and other agents to:

- inspect and edit scenes, nodes, signals and resources
- author animations, AnimationTrees, tile maps, navigation, audio buses and visual shaders
- change project settings, input actions, autoloads, import options and export presets, and run exports
- write scripts with GDScript language-server diagnostics, symbols and renames
- look up the Godot class reference offline for the exact version you have installed
- run the game and work on it live: inspect and change nodes, send input, pause and step frames, take screenshots, profile, record and replay input
- debug with breakpoints, stepping, stack and variables, and run tests

It works through a live editor bridge, and through headless Godot when the editor is closed.

> Status: early development (step 3 of 4: the running game and debugging done; next is polish and release). Targets **Godot 4.7** and the **2026-07-28 MCP spec**. Older 2025-era MCP clients are also supported.

## How it works

```
MCP client ──stdio──► godot-mcp (TypeScript, MCP SDK v2)
                        ├─ WebSocket on 127.0.0.1 + per-session token ─► Godot editor plugin (addons/godot_mcp)
                        └─ child process ─► godot --headless (when the editor is closed; game runs)
```

- **Live editor first.** When the editor is open with the plugin enabled:
  - Every scene edit goes through Godot's undo history, so you can Ctrl+Z anything the agent did.
  - Edits show up immediately in the scene you have open.
- **Headless fallback.** With no editor running:
  - The same scene/node operations run in a one-shot `godot --headless` process.
  - They edit the `.tscn` files through Godot's own APIs. The `.tscn` text is never hand-edited.
- **Secure by default.**
  - The bridge binds to `127.0.0.1` only and needs a fresh random token each time the editor starts.
  - File tools can't leave the project folder.
  - Nothing talks to the internet.
- **Small context footprint.**
  - The tool list never changes during a session.
  - Every tool carries read-only and destructive hints.
  - A `compact` mode exposes 14 core tools plus search and call routers for everything else.
  - `--toolsets` hides whole groups you don't use.
  - A size budget test keeps tool definitions small: about 14k tokens for all 74 tools in full mode and 2.4k in compact mode today.
- **Asks before irreversible steps.** Clients that support MCP elicitation show a yes/no question before, for example, a file is deleted. Other clients rely on their own permission prompt, driven by each tool's destructive hint.

See [docs/bridge-protocol.md](docs/bridge-protocol.md) for the editor/headless protocol, and [docs/methods/](docs/methods/) for each tool group's methods and limits.

## Quick start

Requirements: Node 22+ and Godot 4.5+ (4.7 recommended).

```bash
cd server && npm install && npm run build
# From your Godot project folder:
node /path/to/godot-mcp/server/dist/index.js init
```

`init` makes these changes. It shows the plan first and asks before writing anything (`--dry-run` previews only, `--remove` undoes it):

- Copies the editor addon into `addons/godot_mcp` and enables it.
- Registers the server in your agents' project configs. These are detected automatically, or you choose them with `--agents claude-code,cursor,vscode,codex,gemini-cli,...`.
- Adds a short, marked block to `AGENTS.md`, and an `@AGENTS.md` import to `CLAUDE.md`.

Then open the project in Godot and start a new agent session.

## Configuration

| Flag / env var | Default | Meaning |
|---|---|---|
| `--project` / `GODOT_PROJECT_PATH` | current folder | Godot project folder |
| `--godot` / `GODOT_PATH` | searched on PATH | Godot 4 executable |
| `--mode` / `GODOT_MCP_MODE` | `full` | `full`: every operation is a tool. `compact`: core tools plus `godot_tools`, `godot_call_read` and `godot_call_write` |
| `--toolsets` / `GODOT_MCP_TOOLSETS` | all | Comma list of the groups in the tools table below, e.g. `core,files,scene,node,script,run` |
| `--read-only` / `GODOT_MCP_READ_ONLY` | off | Hide every tool that changes something |
| `--allow-eval` / `GODOT_MCP_ALLOW_EVAL` | off | Let `godot_game_eval` run code inside the running game. Off, the tool explains how to turn it on |
| `--confirm` / `GODOT_MCP_CONFIRM` | `elicit` | `never` skips the yes/no question before irreversible steps |
| `GODOT_MCP_HEADLESS_TIMEOUT_MS` | `120000` | Limit for one headless Godot run |
| `GODOT_MCP_BRIDGE_TIMEOUT_MS` | `30000` | Limit for one editor bridge request |
| `GODOT_MCP_LSP_PORT` | editor's setting | GDScript language server port to use |
| `GODOT_MCP_LSP_TIMEOUT_MS` | `15000` | Limit for one language server request |
| `GODOT_MCP_LSP_IDLE_MS` | `600000` | Stop the private language server editor after this long unused |
| `GODOT_MCP_LOG_LEVEL` | `info` | `debug` for troubleshooting (logs go to stderr) |

## Tools

Tool names are `godot_` plus the method with dots replaced, e.g. `godot_node_add`.

| Group | Tools |
|---|---|
| core | `status`, `project_info`, `project_settings` |
| files | `files_list`, `files_read`, `files_search`, `files_write`, `files_edit`, `files_move`, `files_delete` |
| scene | `scene_tree`, `scene_create`, `scene_open`, `scene_save`, `scene_save_as`, `scene_inherit`, `scene_close`, `batch_apply` |
| node | `node_get`, `node_add`, `node_set`, `node_remove`, `node_rename`, `node_reparent`, `node_duplicate`, `node_instance`, `node_find`, `node_move`, `node_groups` |
| signal | `signal_list`, `signal_connect`, `signal_disconnect` |
| script | `script_attach`, `script_validate` |
| resource | `resource_read`, `resource_create`, `resource_set`, `resource_deps` |
| visual | `visual_shader_graph`, `visual_shader_graph_read`, `visual_shader_check`, `visual_layout` |
| anim | `anim_read`, `anim_edit`, `anim_tree_read`, `anim_tree` |
| world | `grid_read`, `grid_edit`, `tileset_edit`, `navigation_bake`, `navigation_path` |
| audio | `audio_buses`, `audio_edit` |
| project | `project_set`, `input_edit`, `autoload_edit`, `project_plugins`, `project_validate` |
| import | `import_get`, `import_set` |
| export | `export_presets`, `export_preset_set`, `export_run` |
| code | `code_diagnostics`, `code_symbols`, `code_lookup`, `code_rename` |
| docs | `docs_search`, `docs_class` |
| run | `run_start`, `run_stop`, `run_output` |
| game | `game_tree`, `game_get`, `game_edit`, `game_eval`, `game_input`, `game_time`, `game_record`, `game_screenshot` (also the editor 2D/3D views), `game_perf` |
| debug | `debug_breakpoints`, `debug_control`, `debug_state` |
| test | `test_run` (GUT or GdUnit4, whichever the project has) |
| editor | `editor_logs`, `editor_launch`, `editor_ui` |
| discovery | `godot_tools` (plus `godot_call_read` and `godot_call_write` in compact mode) |

A few tools need the live editor (`scene_open`, `scene_save_as`, `scene_close`, `editor_logs`); the rest also work with the editor closed. The `code_*` tools start a private headless editor for the GDScript language server when your editor isn't open. Export credentials (`.godot/export_credentials.cfg`) are never read or returned.

The `game_*` and `debug_*` tools work on a game started with `run_start` (mode `process`, no editor needed) and, except for breakpoints and the script profiler, on a game started from the editor. The server loads a small runtime into the game through a temporary `override.cfg` that is removed once the game is up; `project.godot` is never changed. The runtime does nothing in exported or normal runs. See [docs/runtime-protocol.md](docs/runtime-protocol.md).

### Resources and prompts

- Resources: `godot://project/info`, `godot://editor/status`, `godot://editor/logs`, and the templates `godot://scene/{path}` (a scene's node tree) and `godot://script/{path}` (a script's source). Scene and script paths autocomplete.
- Prompts: `scaffold-player`, `triage-errors`, `port-from-godot-3`, `write-shader`.

## Development

```bash
cd server
npm test                                  # unit + protocol tests (no Godot needed)
GODOT_BIN=/path/to/godot npm run test:e2e # end-to-end against real Godot
../scripts/test-gdscript.sh               # GDScript-side tests (headless runner + editor bridge)
```

GitHub Actions is turned off for this repository, so run the tests locally before pushing.

## License

MIT
