# Godot MCP editor addon

This folder is the Godot editor half of [godot-mcp](https://github.com/shin2344234/godot-mcp),
an [MCP](https://modelcontextprotocol.io) server for Godot 4. With it, agents such as Claude Code,
Cursor, Codex, VS Code Copilot or Gemini CLI can inspect and edit your project through the open
editor. Every scene edit they make goes through the editor's undo history, so you can undo it
with Ctrl+Z.

**The addon does nothing useful on its own.** It is the bridge that the godot-mcp server (a
separate Node.js program) connects to. The server is what your AI agent talks to.

Requirements: Godot 4.7 or later, and Node.js 22 or later for the server.

## Setup

1. Install the addon from the editor's Asset Store tab, or copy this folder to
   `res://addons/godot_mcp/`.
2. From your Godot project folder (the one with `project.godot`), run:

   ```bash
   npx -y @shin2344234/godot-mcp init
   ```

   `init` shows its plan and asks before it writes anything. It enables this plugin, registers
   the server in your agents' project configs and adds a short note to `AGENTS.md`. If this
   addon is already installed at the same version it is left as it is. Use `--dry-run` to
   preview the changes, `--no-addon` to skip the addon step and `--remove` to undo.
3. Open the project in Godot (or restart the editor), then start a new agent session.

To enable the plugin by hand instead: **Project > Project Settings > Plugins**, tick **Godot MCP**.
The Output panel then shows `Godot MCP: bridge listening on 127.0.0.1:<port>`.

## What it does in your project

- **Editor bridge.** While the plugin is enabled, it runs a WebSocket server in the editor.
  The default port is 6520 (the `godot_mcp/bridge/port` project setting). If that port is
  busy it tries the next 10 ports.
- **Session file.** It writes `.godot/godot_mcp/session.json` with the port and a fresh random
  token. The file is deleted again when the editor closes or the plugin is disabled.
- **Runtime for the running game.** When the server runs your game, it adds
  `runtime/mcp_runtime.gd` as an autoload through a temporary `override.cfg`, which is removed
  as soon as the game has started. `project.godot` is never changed for this.
- **Headless runner.** When the editor is closed, the server runs `headless/runner.gd` in a
  one-shot `godot --headless` process to make the same edits.

## Security

- The bridge binds to **127.0.0.1 only**. Other machines on your network can't reach it.
- Every connection must send the **per-session token** from `.godot/godot_mcp/session.json`.
  A new token is made each time the editor starts. The file is under `.godot/`, which Godot's
  default `.gitignore` excludes, and on macOS and Linux it is readable by your user only.
- The runtime autoload does nothing unless a **debugger is attached**
  (`EngineDebugger.is_active()`). It can't do anything in an exported game.
- **Running code in the game is off by default.** The server only sends `game.eval` requests
  when you start it with `--allow-eval`.
- The addon never connects to the internet.

Anyone who can read `session.json` (any program running as your user) can control the editor
while it is open. Don't run the editor with this plugin enabled on a shared machine account
you don't trust.

## More

- Documentation, tool list and troubleshooting: <https://github.com/shin2344234/godot-mcp>
- Server package: <https://www.npmjs.com/package/@shin2344234/godot-mcp>
- License: MIT, see `LICENSE` in this folder.
