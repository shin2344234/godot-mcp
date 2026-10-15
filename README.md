# godot-mcp

An [MCP](https://modelcontextprotocol.io) server for the **Godot 4** engine. Use it with Claude Code, Cursor, Codex, VS Code Copilot, Gemini CLI and other agents to:

- inspect and edit scenes and nodes
- write and check scripts
- run the game and read its errors

It works through a live editor bridge, and through headless Godot when the editor is closed.

> Status: early development (step 1 of 4: foundation). Targets **Godot 4.7** and the **2026-07-28 MCP spec**. Older 2025-era MCP clients are also supported.

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
  - A `compact` mode exposes about 14 core tools plus search and call routers for everything else.
  - A size budget test keeps tool definitions small: about 4k tokens in full mode and 2k in compact mode today.

See [docs/bridge-protocol.md](docs/bridge-protocol.md) for the editor/headless protocol.

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
| `--toolsets` / `GODOT_MCP_TOOLSETS` | all | Comma list from `core,files,scene,node,script,run,editor` |
| `--read-only` / `GODOT_MCP_READ_ONLY` | off | Hide every tool that changes something |
| `GODOT_MCP_LOG_LEVEL` | `info` | `debug` for troubleshooting (logs go to stderr) |

## Tools (step 1)

| Group | Tools |
|---|---|
| core | `godot_status`, `godot_project_info`, `godot_project_settings` |
| files | `godot_files_list`, `godot_files_read`, `godot_files_search`, `godot_files_write`, `godot_files_edit`, `godot_files_move`, `godot_files_delete` |
| scene | `godot_scene_tree`, `godot_scene_create`, `godot_scene_open`, `godot_scene_save`, `godot_scene_save_as` |
| node | `godot_node_get`, `godot_node_add`, `godot_node_set`, `godot_node_remove`, `godot_node_rename`, `godot_node_reparent`, `godot_node_duplicate` |
| script | `godot_script_attach`, `godot_script_validate` |
| run | `godot_run_start`, `godot_run_stop`, `godot_run_output` |
| editor | `godot_editor_logs`, `godot_editor_launch` |
| discovery | `godot_tools` (plus `godot_call_read` and `godot_call_write` in compact mode) |

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
