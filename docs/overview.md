# How godot-mcp works

godot-mcp has two halves: a **server** (TypeScript, Node.js) that your AI client starts,
and an **addon** (GDScript, `addons/godot_mcp`) that runs inside the Godot editor and,
while the agent tests it, inside your game.

```
MCP client ──stdio──► godot-mcp (TypeScript, MCP SDK v2)
                        ├─ WebSocket on 127.0.0.1 + per-session token ─► Godot editor plugin (addons/godot_mcp)
                        ├─ child process ─► godot --headless (when the editor is closed)
                        ├─ remote debugger on 127.0.0.1 ─► the running game (runtime loaded by override.cfg)
                        └─ GDScript language server ─► the editor's LSP, or a private headless editor
```

## The live editor comes first

When the editor is open with the **Godot MCP** plugin enabled, the plugin serves a WebSocket
on `127.0.0.1` and the server connects to it. Every scene edit then goes through Godot's
undo history, so Ctrl+Z undoes anything the agent did, and you see the change right away.

The plugin writes its port and a fresh random token to `.godot/godot_mcp/session.json` each
time the editor starts, and deletes the file when the editor closes. The server needs that
token to connect. The wire format is in [bridge-protocol.md](bridge-protocol.md).

## Headless fallback

With no editor running, the same scene, node, resource and project operations run in a
one-shot `godot --headless` process. They edit `.tscn` and `.tres` files through Godot's
own APIs, never as hand-edited text, and save the file when they finish.

A few tools need the live editor because they act on the editor itself: `godot_scene_open`,
`godot_scene_save_as`, `godot_scene_close`, `godot_editor_logs`, `godot_editor_ui` and
editor-view screenshots (`godot_game_screenshot` with `source: "editor_2d"` or
`"editor_3d"`). `godot_editor_launch` opens the editor for you.

## The running game

The `game_*` and `debug_*` tools work on a game started with `godot_run_start`. There are
two modes:

- **`process`** (no editor needed): the server starts Godot itself and acts as the game's
  remote debugger on `127.0.0.1`. Breakpoints, stepping and the script profiler need this
  mode.
- **`editor`**: the game is started from the open editor, and the editor plugin relays
  messages between the game and the server.

Either way the server loads a small runtime into the game through a temporary
`res://override.cfg` autoload. The file is removed once the game is up, and `project.godot`
is never changed. The runtime does nothing in exported games or in runs not started by the
server. The full design is in [runtime-protocol.md](runtime-protocol.md).

## Code intelligence and offline docs

The `code_*` tools talk to Godot's GDScript language server. If your editor is open they use
its server; otherwise they start a private headless editor and stop it after 10 idle minutes.
The `docs_*` tools search a class reference index built from your own Godot binary, so the
docs always match your engine version. See [methods/code-docs.md](methods/code-docs.md).

## Safety

- **Local only.** The bridge binds to `127.0.0.1` and needs the per-session token. The
  server makes no network requests of its own.
- **Project sandbox.** File tools can't leave the project folder (symlinks included). No tool
  can read, search or write the export credentials (`.godot/export_credentials.cfg`) or the
  bridge's session file.
- **No code evaluation by default.** `godot_game_eval` runs code in the game only when the
  server is started with `--allow-eval`.
- **Asks before irreversible steps.** Clients that support MCP elicitation show a yes/no
  question before, for example, a file is deleted. Other clients rely on their own
  permission prompt, driven by each tool's destructive hint. `--confirm never` turns the
  question off for unattended runs.

The threat model and how to report a vulnerability are in [SECURITY.md](../SECURITY.md).

## Small context footprint

The tool list never changes during a session, and every tool carries read-only, destructive
and idempotent hints. Full mode lists 91 tools (90 operations plus `godot_tools`), about 15k
tokens of definitions. Compact mode lists 17 (14 core tools plus three routers), about 2.2k
tokens. `--toolsets` hides whole groups and `--read-only` hides every tool that changes
something. Details are in [tools.md](tools.md#modes-and-toolsets).
