# Security

godot-mcp lets an AI agent read and change a Godot project and run the game. This page says what it protects against, what it doesn't, and how to report a problem.

## Reporting a vulnerability

Please **don't open a public issue** for security problems. Report them privately through GitHub:

1. Go to the [repository page](https://github.com/shin2344234/godot-mcp).
2. Open the **Security** tab (GitHub may label it **Security and quality**) and click **Report a vulnerability**.
3. Describe the problem, how to reproduce it, and what an attacker could do with it.

We'll answer in the advisory thread, agree on a fix and a disclosure date with you, and credit you if you want. This is a small volunteer project, so please allow a few days for a first answer.

Supported versions: the latest release, and `main`.

## Threat model

The agent is treated as a **trusted local user acting on your behalf**, working in one project. godot-mcp limits where it can reach and keeps other programs on your machine and network out. It does not try to stop a determined agent that you've told to do harm: anything that runs game code runs with your user's permissions. Your MCP client's permission prompts are the main control over what the agent does.

### What is protected

- **Loopback only.** The editor bridge (WebSocket) binds to `127.0.0.1`, never to all interfaces. The debugger port the server opens for games it launches also binds to `127.0.0.1`, accepts exactly one connection (the game it started), and then closes.
- **Per-session token.** The editor plugin creates a random 256-bit token each time it starts and writes it to `.godot/godot_mcp/session.json` (mode 0600 where the OS supports it). A client must send it first; wrong tokens are disconnected. The file is deleted when the editor or plugin stops.
- **Project sandbox.** File tools take `res://` paths and refuse absolute paths, `..` escapes and symlinks that lead outside the project folder. They don't write inside Godot's `.godot/` cache.
- **Export credentials.** Godot keeps export passwords and keys in `.godot/export_credentials.cfg`. No tool can read, search or write that file (the file tools refuse the path, whatever its spelling), and the export tools refuse to set credential options. The same goes for the bridge token files in `.godot/godot_mcp/`.
- **No network.** The server and the addon don't contact the internet. Nothing is downloaded at runtime (test frameworks and export templates must already be installed). The class reference comes from your installed Godot. The only download is `npx` fetching the package itself, from npm.
- **Code evaluation is opt-in.** `godot_game_eval` runs only when the server is started with `--allow-eval` (or `GODOT_MCP_ALLOW_EVAL=1`).
- **The runtime is inert outside debugging.** The in-game runtime is added through a temporary `override.cfg` only while the server or editor starts a game, and it does nothing unless a debugger is attached (`EngineDebugger.is_active()`). It can't affect normal or exported runs, and `project.godot` is never changed for it.
- **Confirmation before irreversible steps.** Tools carry read-only and destructive hints so clients can ask you first, and clients that support MCP elicitation get a yes/no question before, for example, a file is deleted.
- **`--read-only`** hides every tool that changes something.

### What is not protected

- **Running the game runs project code.** `godot_run_start`, test runs, exports and headless scene edits run Godot on your project, including its scripts, tool scripts and addons, with your user's permissions. Only use godot-mcp on projects you trust.
- **With `--allow-eval`**, the agent can run any GDScript in the game, which can read and write files and start processes.
- **Other local programs running as your user** can read `session.json` and connect to the bridge, the same way they could edit your project files. godot-mcp doesn't defend against malware already running as you.
- **The project's own files are readable by the agent.** Don't keep secrets inside the project folder that you wouldn't want an AI model to see.

## Hardening tips

- Use `--read-only` when you only want answers, not changes.
- Use `--toolsets` to leave out groups you don't need (for example `export` or `game`).
- Keep `--allow-eval` off unless you need it for a session.
- Keep your MCP client's per-tool approval on for tools marked destructive.
