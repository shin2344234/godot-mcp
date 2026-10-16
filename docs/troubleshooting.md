# Troubleshooting

Start with `godot_status`. Ask your agent to call it, or look at its answer in the tool log. It tells you:

- `project_found`: the server sees a `project.godot` at `project_path`;
- `addon_installed`: `addons/godot_mcp/` is in the project, and `addon_hint` when it's missing or older than the server's (fix: `godot_addon_install`);
- `godot`: which Godot executable it found (or `null`);
- `editor_connected`: whether the live editor bridge is up;
- `scene_backend`: where scene edits will go right now (`editor`, `headless`, or `unavailable`);
- `runs`: games started with `godot_run_start`.

The sections below quote the server's error messages, so you can search this page for the text you see.

**Contents:**
[Server doesn't start](#the-server-doesnt-start-or-doesnt-show-up) ·
[Editor not connected](#the-godot-editor-is-not-connected) ·
[Godot not found](#godot-4-executable-not-found) ·
[Addon missing](#the-godot_mcp-addon-is-not-installed) ·
[No game / runtime didn't load](#no-game-is-running--the-runtime-did-not-load) ·
[Debugger on editor runs](#breakpoints-and-the-script-profiler-on-editor-runs) ·
[Screenshots on headless runs](#screenshots-of-a-headless-game) ·
[Eval disabled](#code-evaluation-in-the-game-is-off) ·
[Code tools slow](#code-tools-are-slow-the-first-time) ·
[Timeouts](#timeouts) ·
[Too many tools](#too-many-tools-or-too-much-context) ·
[Leftover override.cfg](#a-leftover-overridecfg) ·
[Logs](#logs)

## The server doesn't start or doesn't show up

1. Check Node: `node --version` must be 22 or newer.
2. Run the server by hand: `npx -y @shin2344234/godot-mcp --version`. It should print a version number.
3. Restart the client, or start a new session. Most clients read their MCP config only at startup.
4. Check the client's own MCP status view: `/mcp` in Claude Code, the MCP server list in Cursor, VS Code, Zed or Windsurf.
5. Claude Code asks you to approve servers from a project's `.mcp.json` the first time. If you declined, run `claude mcp reset-project-choices`.
6. Codex reads `.codex/config.toml` only in trusted projects. Zed starts servers from `.zed/settings.json` only after you trust the folder.
7. On Windows, see [the `npx` note](setup.md#windows-notes) in the setup guide.

The setup guide has the exact config for each client: [setup.md](setup.md).

## "The Godot editor is not connected"

Full message:

> The Godot editor is not connected. Open this project in the Godot editor with the "Godot MCP" plugin enabled (Project > Project Settings > Plugins), or call godot_editor_launch to start it.

Most tools still work without the editor: scene and node edits run in headless Godot. Only a few need the live editor: `godot_scene_open`, `godot_scene_save_as`, `godot_scene_close` and `godot_editor_logs`.

To connect the editor:

1. **Open the right project.** The server's `project_path` (in `godot_status`) must be the folder you have open in Godot.
2. **Install and enable the plugin.** In Godot: **Project > Project Settings > Plugins**, tick **Godot MCP**. `init` and `godot_addon_install` do this for you, but Godot only picks it up when the project is (re)opened.
3. **Check the session file.** When the plugin starts, it writes `.godot/godot_mcp/session.json` with the port and a fresh token. No file means the plugin isn't running. Look in Godot's Output panel for errors from the addon.
4. **Port.** The bridge listens on `127.0.0.1` port 6520. If that's busy, it tries the next 10 ports and records the one it got in `session.json`. You can change the start port with the project setting `godot_mcp/bridge/port`.
5. **Stale session file.** If the editor crashed, `session.json` can be left behind. The server ignores it when the process it names is gone. If the server log says `Editor bridge rejected our token (stale session.json?)`, turn the plugin off and on again (or restart the editor) to get a new token.
6. **Old addon.** If the log says `Editor plugin speaks bridge protocol N, server expects M`, the addon and server are from different versions. Update the addon with `godot_addon_install` (or run `init` again), then reopen the project.

"The Godot editor connection closed before it answered. Was the editor closed or the plugin disabled?" means the editor went away in the middle of a call. Reopen it and try again.

## "Godot 4 executable not found"

Full message:

> Godot 4 executable not found. Set GODOT_PATH to the full path of your Godot 4.x binary (e.g. C:\Godot\Godot_v4.7.2-stable_win64.exe) in the MCP server config, or put it on PATH as "godot".

The server looks for `godot`, `godot4`, `Godot` or `godot-4` on `PATH`, then any `Godot_v4*` file in a `PATH` folder. It checks each one by running `--version`. Your client may start the server with a different `PATH` than your terminal, so setting `GODOT_PATH` in the server's `env` is the safest fix (an empty `GODOT_PATH` counts as not set):

- Windows: `C:\\Godot\\Godot_v4.7.2-stable_win64.exe` (JSON needs double backslashes). Use the main exe, not `_console.exe`.
- macOS: `/Applications/Godot.app/Contents/MacOS/Godot` (the binary inside the app bundle, not `Godot.app`).
- Linux: the full path of the unpacked binary. Make sure it is executable (`chmod +x`).

Godot 3 binaries are skipped. `godot_status` shows which binary it picked.

## "The godot_mcp addon is not installed"

> The godot_mcp addon is not installed in this project (expected addons/godot_mcp/). ...

Headless scene editing and `godot_editor_launch` need the addon inside the project. Ask your agent to run `godot_addon_install` (it copies the addon bundled with the server and enables it), run `npx -y @shin2344234/godot-mcp init` in the project folder, or copy `addons/godot_mcp/` from this repository. Then reopen the project in Godot.

## "No game is running" / the runtime did not load

> No game is running. Start one with godot_run_start (mode "process" works without the editor; headless: false shows a window), then retry.

The `godot_game_*` and `godot_debug_*` tools need a running game. Start one with `godot_run_start`, or press Play in the editor (with the plugin enabled).

> The game is running but the Godot MCP runtime did not load in it. Make sure addons/godot_mcp is up to date (it contains runtime/mcp_runtime.gd), then restart the game.

How it works: just before the game starts, a temporary `override.cfg` adds a small runtime autoload. It's removed again as soon as the game is up. If the runtime didn't arrive:

- **Old addon.** `addons/godot_mcp/runtime/mcp_runtime.gd` must exist. Update the addon with `godot_addon_install` or by running `init` again.
- **Editor runs** need the plugin enabled; the plugin writes `override.cfg` when you press Play.
- **Something blocks writing `override.cfg`** in the project root (read-only folder, a sync tool locking it). Run with `GODOT_MCP_LOG_LEVEL=debug` and look for `Could not restore` or file errors.
- **The game crashed during startup.** Then the message is "The game exited before its runtime started. See godot_run_output for errors." Read the errors with `godot_run_output`.

> Run "3f9c2a1b" has exited (code 1). Read what happened with godot_run_output, or start it again.

The game stopped. `godot_run_output` shows why.

## Breakpoints and the script profiler on editor runs

> Breakpoint debugging works on games this server launches: the editor's own debugger receives the breakpoints of games started from the editor. Start the game with godot_run_start {mode: "process", breakpoints: ["res://file.gd:LINE"]} instead.

When you press Play in the editor, Godot's own debugger owns the breakpoints, the call stack and the profiler. Plugins can't get them. So `godot_debug_*` and `godot_game_perf`'s `profile_scripts_seconds` work only on games the server starts itself: `godot_run_start` with `mode: "process"`. Everything else (`godot_game_tree`, `godot_game_input`, screenshots, monitors) works on editor runs too.

> No game started with godot_run_start (mode "process") is running. ...

Same fix: start the game in process mode.

## Screenshots of a headless game

> The game runs headless (DisplayServer 'headless'), so it renders nothing to capture. Stop it (godot_run_stop) and start it with godot_run_start headless:false; that needs a display (on Linux a DISPLAY or WAYLAND_DISPLAY, e.g. under Xvfb).

A headless game draws nothing, so there is nothing to capture. Start it with `headless: false`. On Windows and macOS that's the default. On Linux without a desktop session, `headless` defaults to true; run the client under a virtual display, for example `xvfb-run -a -s "-screen 0 1280x720x24" <your client>`.

The same applies to `write_movie` ("write_movie needs a window (headless: false and a display); headless runs render nothing.").

## "Code evaluation in the game is off"

> Code evaluation in the game is off. The user can enable it by starting the MCP server with --allow-eval (or env GODOT_MCP_ALLOW_EVAL=1) in the MCP client config, then restarting the server. ...

This is on purpose. `godot_game_eval` runs any GDScript in your game, which can touch files and the OS. To allow it, add `"--allow-eval"` to the server's `args` (or `"GODOT_MCP_ALLOW_EVAL": "1"` to `env`) and restart the client. Without it, `godot_game_get` reads live values and `godot_game_edit` sets properties and calls methods.

## Code tools are slow the first time

The `godot_code_*` tools use Godot's GDScript language server.

- **Editor open:** they use your editor's language server. Nothing to start.
- **Editor closed:** the server starts a private headless Godot editor just for the language server. That takes a few seconds, and up to a few minutes the first time on a project that was never opened (Godot imports everything first). It stops again after 10 minutes without use (`GODOT_MCP_LSP_IDLE_MS`).

Messages you may see:

- "The Godot editor is connected, but its GDScript language server is not reachable on 127.0.0.1:PORT ..." Check **Editor Settings > Network > Language Server > Remote Port**. If you changed it, set `GODOT_MCP_LSP_PORT` to match. Restarting the editor usually fixes a port clash.
- "The GDScript language server on 127.0.0.1:PORT belongs to another Godot editor (project ...)". Two editors are open and only the first one got the port. Close the other one, or give this editor a different port and set `GODOT_MCP_LSP_PORT`.
- "The headless Godot editor did not start its GDScript language server ..." The last lines of Godot's output follow the message. Often it's a project that fails to import.

The first headless scene edit on a never-opened project also runs a one-time import (`godot --headless --import`), so it can take longer. The same import runs again before a headless call when a `class_name` script changed since Godot last saved its global class cache (`.godot/global_script_class_cache.cfg`), so new script classes are known to headless operations.

## Timeouts

| Message starts with | Raise |
|---|---|
| "Headless Godot did not finish ..." | `GODOT_MCP_HEADLESS_TIMEOUT_MS` (default 120000) |
| "The Godot editor did not answer ..." | `GODOT_MCP_BRIDGE_TIMEOUT_MS` (default 30000). The editor may be busy importing or have a dialog open |
| "The GDScript language server did not answer ..." | `GODOT_MCP_LSP_TIMEOUT_MS` (default 15000) |
| "The game did not answer ..." | The game may be stopped at a breakpoint (`godot_debug_state`) or frozen |
| "Export did not finish within ..." / "Tests did not finish within ..." | The tool's `timeout_s` argument |

Your **client** has its own limits too, and may cut a long call off first:

- Codex: `startup_timeout_sec` (default 10) and `tool_timeout_sec` (default 60) in `config.toml`.
- Claude Code: `"timeout"` (milliseconds) on the server entry in `.mcp.json`; `MCP_TIMEOUT` for startup.
- Gemini CLI: `"timeout"` (milliseconds, default 10 minutes).

See [setup.md](setup.md) for where to put them.

## Too many tools or too much context

Full mode lists 90 tools plus `godot_tools`, about 15k tokens of definitions. If that's too much for your client or model:

- `--mode compact`: 14 core tools plus three router tools (`godot_tools` to search, `godot_call_read` / `godot_call_write` to run anything else). About 2.2k tokens.
- `--toolsets files,scene,node,script,run`: only the groups you use (`core` is always on).
- `--read-only`: hide everything that changes the project.

Some clients cap the count: Windsurf (Devin Desktop) allows 100 tools across all servers, VS Code 128 per chat request. Claude Code loads MCP tools on demand, so full mode is fine there. See [setup.md#options](setup.md#options).

## A leftover `override.cfg`

To load its runtime into a game, the server (or the editor plugin) writes a temporary `res://override.cfg` that starts with this line:

```
; godot_mcp: temporary runtime autoload (removed automatically)
```

It's removed as soon as the game is up. If Godot or the server crashed at the wrong moment, the file can stay behind. It's cleaned up automatically the next time the editor plugin starts or the server starts a game. A leftover file is harmless: the runtime does nothing unless a debugger is attached, so it can't affect normal or exported runs.

To clean up by hand:

1. If `.godot/godot_mcp/override.cfg.user-backup` exists, that's **your** original `override.cfg`. Move it back to `override.cfg` in the project root.
2. Otherwise, delete `override.cfg` if it contains the line above.

`project.godot` is never changed by this.

## Logs

The server writes its log to **stderr** (stdout carries the MCP messages). Turn on detail with:

```json
"env": { "GODOT_MCP_LOG_LEVEL": "debug" }
```

Where to read it depends on the client:

- Claude Desktop: `~/Library/Logs/Claude/mcp-server-godot.log` (macOS), `%APPDATA%\Claude\logs\` (Windows).
- Other clients: their MCP output or log panel, or run the same command in a terminal to see stderr directly.

When you report a bug, please include the `godot_status` output, the debug log, your client and its version, your OS, and your Godot version.
