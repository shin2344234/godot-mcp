# godot-mcp

An [MCP](https://modelcontextprotocol.io) server for the **Godot 4** engine. Use it with Claude Code, Claude Desktop, Cursor, VS Code Copilot, Codex, Gemini CLI, Windsurf, Zed and other agents to:

- inspect and edit scenes, nodes, signals and resources
- author animations, AnimationTrees, tile maps, navigation, audio buses and visual shaders
- change project settings, input actions, autoloads, import options and export presets, and run exports
- write scripts with GDScript language-server diagnostics, symbols and renames
- look up the Godot class reference offline for the exact version you have installed
- run the game and work on it live: inspect and change nodes, send input, pause and step frames, take screenshots, profile, record and replay input
- debug with breakpoints, stepping, stack and variables, and run tests

It works through a live editor bridge, and through headless Godot when the editor is closed.

> **Status:** preparing the first release, 0.1.0 (step 4 of 4: release prep). Not on npm yet.
> Targets **Godot 4.7** (tested with 4.7.2) and needs **Godot 4.5 or newer**. Speaks the **2026-07-28 MCP spec** and also serves older 2025-era clients.

## Quick start

You need Node.js 22+ and Godot 4.5+ (4.7 recommended). In your Godot project folder, run:

```bash
npx -y @shin2344234/godot-mcp init
```

`init` shows its plan and asks before writing anything (`--dry-run` previews, `--remove` undoes). It:

- copies the editor addon into `addons/godot_mcp` and enables it;
- registers the server in your agents' configs. It detects them, or you pick with `--agents claude-code,cursor,vscode,codex,gemini-cli,...`;
- adds a short, marked block to `AGENTS.md`, and an `@AGENTS.md` import to `CLAUDE.md`.

Then open the project in Godot and start a new agent session. Ask it to call `godot_status` to check the connection.

Other ways in:

- **Claude Code plugin:** `/plugin marketplace add shin2344234/godot-mcp`, then `/plugin install godot-mcp@godot-mcp`.
- **Claude Desktop:** download the `.mcpb` file from [Releases](https://github.com/shin2344234/godot-mcp/releases) and double-click it.
- **Manual config** for any client: [docs/setup.md](docs/setup.md) has the exact file and format for each one.

Without `init`, ask the agent to run `godot_addon_install` once per project to add the editor addon.

**From source:**

```bash
git clone https://github.com/shin2344234/godot-mcp
cd godot-mcp/server && npm install && npm run build
cd /path/to/my-game
node /path/to/godot-mcp/server/dist/index.js init
```

Something not working? See [docs/troubleshooting.md](docs/troubleshooting.md).

## How it works

```
MCP client ──stdio──► godot-mcp (TypeScript, MCP SDK v2)
                        ├─ WebSocket on 127.0.0.1 + per-session token ─► Godot editor plugin (addons/godot_mcp)
                        └─ child process ─► godot --headless (when the editor is closed; game runs)
```

- **Live editor first.** When the editor is open with the plugin enabled, every scene edit goes through Godot's undo history (Ctrl+Z undoes anything the agent did) and shows up right away.
- **Headless fallback.** With no editor running, the same scene and node operations run in a one-shot `godot --headless` process. They edit `.tscn` files through Godot's own APIs, never as hand-edited text.
- **Secure by default.** The bridge binds to `127.0.0.1` only and needs a fresh random token each time the editor starts. File tools can't leave the project folder. Nothing talks to the internet. See [SECURITY.md](SECURITY.md).
- **Small context footprint.** The tool list never changes during a session, and every tool carries read-only and destructive hints. Full mode has 89 tools (about 15k tokens of definitions). `compact` mode has 14 core tools plus search and call routers for the rest (about 2.2k tokens). `--toolsets` hides whole groups.
- **Asks before irreversible steps.** Clients that support MCP elicitation show a yes/no question before, for example, a file is deleted. Other clients rely on their own permission prompt, driven by each tool's destructive hint.

## Configuration

Common options (full list in [docs/setup.md](docs/setup.md#options)):

| Flag / env var | Default | Meaning |
|---|---|---|
| `--project` / `GODOT_PROJECT_PATH` | current folder | Godot project folder |
| `--godot` / `GODOT_PATH` | searched on PATH | Godot 4 executable. On Windows use the main `Godot_v4.x-stable_win64.exe`, not `_console.exe` |
| `--mode` / `GODOT_MCP_MODE` | `full` | `compact`: core tools plus `godot_tools`, `godot_call_read`, `godot_call_write` |
| `--toolsets` / `GODOT_MCP_TOOLSETS` | all | Comma list of groups from the table below |
| `--read-only` / `GODOT_MCP_READ_ONLY` | off | Hide every tool that changes something |
| `--allow-eval` / `GODOT_MCP_ALLOW_EVAL` | off | Let `godot_game_eval` run code inside the running game |
| `GODOT_MCP_LOG_LEVEL` | `info` | `debug` for troubleshooting (logs go to stderr) |

## Tools

Tool names are `godot_` plus the method with dots replaced, e.g. `godot_node_add`.

| Group | Tools |
|---|---|
| core | `status`, `project_info`, `project_settings`, `addon_install` |
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

A few tools need the live editor (`scene_open`, `scene_save_as`, `scene_close`, `editor_logs`); the rest also work with the editor closed. The `code_*` tools start a private headless editor for the GDScript language server when your editor isn't open. The export tools never read or write export credentials (`.godot/export_credentials.cfg`).

The `game_*` and `debug_*` tools work on a game started with `run_start` (mode `process`, no editor needed) and, except for breakpoints and the script profiler, on a game started from the editor. The server loads a small runtime into the game through a temporary `override.cfg` that is removed once the game is up; `project.godot` is never changed. The runtime does nothing in exported or normal runs. See [docs/runtime-protocol.md](docs/runtime-protocol.md).

### Resources and prompts

- Resources: `godot://project/info`, `godot://editor/status`, `godot://editor/logs`, and the templates `godot://scene/{path}` (a scene's node tree) and `godot://script/{path}` (a script's source). Scene and script paths autocomplete.
- Prompts: `scaffold-player`, `triage-errors`, `port-from-godot-3`, `write-shader`.

## Documentation

- [Setup for each client](docs/setup.md): Claude Code, Claude Desktop, Cursor, VS Code, Codex, Gemini CLI, Windsurf, Zed; options; Windows notes
- [Troubleshooting](docs/troubleshooting.md): error messages and fixes
- [Method references](docs/methods/): each tool group's methods and limits
- [Bridge protocol](docs/bridge-protocol.md) and [runtime protocol](docs/runtime-protocol.md): how the server talks to the editor and the game
- [Installing the addon from the Godot asset library](docs/asset-store.md)
- [Changelog](CHANGELOG.md) · [Contributing](CONTRIBUTING.md) · [Security](SECURITY.md) · [Releasing](docs/releasing.md)

## Development

```bash
cd server
npx vitest run test/unit                     # unit + protocol tests (no Godot needed)
GODOT_BIN=/path/to/godot npx vitest run      # everything, against real Godot
GODOT=/path/to/godot ../scripts/test-gdscript.sh   # GDScript-side tests
```

GitHub Actions is turned off for this repository, so run the tests locally before pushing. Details in [CONTRIBUTING.md](CONTRIBUTING.md).

## License

MIT
