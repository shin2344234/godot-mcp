# Setting up godot-mcp in your AI client

This page shows how to connect godot-mcp to each supported client. There are two ways:

- **Automatic**: run `godot-mcp init` in your Godot project. It installs the editor addon and writes the client config for you.
- **Manual**: add a few lines of config yourself. Every client section below shows the exact file and format.

If something doesn't work, see [troubleshooting.md](troubleshooting.md).

**Contents:**
[Before you start](#before-you-start) ·
[Automatic setup](#automatic-setup-init) ·
[Claude Code](#claude-code) ·
[Claude Desktop](#claude-desktop) ·
[Cursor](#cursor) ·
[VS Code](#vs-code-github-copilot) ·
[Codex](#openai-codex-cli-ide-extension-and-app) ·
[Gemini CLI](#gemini-cli) ·
[Windsurf](#windsurf-devin-desktop) ·
[Zed](#zed) ·
[Options](#options) ·
[Windows notes](#windows-notes)

## Before you start

You need:

- **Node.js 22 or newer** (for `npx`). Check with `node --version`. Claude Desktop users who install the `.mcpb` bundle don't need it.
- **Godot 4.7 or newer** (tested with 4.7.2). The addon loads on 4.5 and 4.6, but several tools use 4.7-only engine APIs and fail there.
- **A Godot project folder** (the one with `project.godot`).

The server finds Godot on your `PATH` (as `godot`, `godot4`, `Godot` or a `Godot_v4*` download). If it isn't there, give the full path with `GODOT_PATH`. Typical locations:

| OS | Godot executable |
|---|---|
| Windows | `C:\Godot\Godot_v4.7.2-stable_win64.exe` (the main exe, **not** `_console.exe`, see [Windows notes](#windows-notes)) |
| macOS | `/Applications/Godot.app/Contents/MacOS/Godot` |
| Linux | wherever you unpacked it, e.g. `~/bin/Godot_v4.7.2-stable_linux.x86_64` |

The command every client runs is:

```bash
npx -y @shin2344234/godot-mcp --project /path/to/my-game
```

The `-y` tells `npx` not to ask before downloading the package. The server talks to the client over stdin/stdout, so you never run it by hand except to test it (`npx -y @shin2344234/godot-mcp --version` prints the version, `--help` lists the options).

## Automatic setup (`init`)

From your Godot project folder:

```bash
npx -y @shin2344234/godot-mcp init
```

`init` shows what it will change and asks before writing anything. It:

1. Copies the editor addon into `addons/godot_mcp/` and enables it in `project.godot`.
2. Registers the server (named `godot`) in each client's config, with your project path and, if it found Godot, `GODOT_PATH`.
3. Adds a short, marked block to `AGENTS.md`, and an `@AGENTS.md` import to `CLAUDE.md` (Claude Code only).

Then open the project in Godot and start a new agent session.

Which clients it configures: the ones whose project folders it finds (`.cursor/`, `.vscode/`, `.mcp.json`, ...). If it finds none, it sets up Claude Code. To choose yourself, pass `--agents`:

```bash
npx -y @shin2344234/godot-mcp init --agents claude-code,cursor,vscode,codex,gemini-cli
```

Useful flags:

| Flag | What it does |
|---|---|
| `--agents a,b,c` | Clients to configure (names in the table below) |
| `--project <dir>` | Project folder, if you're not running from it |
| `--dry-run` | Show the plan, write nothing |
| `--yes` | Don't ask (needed when not in a terminal) |
| `--no-addon` | Don't copy or enable the addon |
| `--no-agents-md`, `--no-claude-md` | Leave `AGENTS.md` / `CLAUDE.md` alone |
| `--remove` | Undo: remove the server from the configs and the blocks from `AGENTS.md` / `CLAUDE.md`, and disable the plugin (the addon files stay) |

Running `init` again is safe: it only changes what is out of date. Run it again after updating to a new version to update the addon too.

Where `init` writes each client's config (file locations come from the [add-mcp](https://www.npmjs.com/package/add-mcp) library):

| `--agents` name | Client | File `init` writes |
|---|---|---|
| `claude-code` | Claude Code | `.mcp.json` (project) |
| `claude-desktop` | Claude Desktop | `claude_desktop_config.json` (global, see below) |
| `cursor` | Cursor | `.cursor/mcp.json` (project) |
| `vscode` | VS Code | `.vscode/mcp.json` (project) |
| `codex` | Codex | `.codex/config.toml` (project) |
| `gemini-cli` | Gemini CLI | `.gemini/settings.json` (project) |
| `windsurf` | Windsurf | `~/.codeium/windsurf/mcp_config.json` (global, see the note in [Windsurf](#windsurf-devin-desktop)) |
| `zed` | Zed | `.zed/settings.json` (project) |

`init` also knows `github-copilot-cli`, `opencode`, `goose`, `cline`, `cline-cli`, `kilo-code`, `kiro-cli`, `antigravity` and a few more; run `init --agents nope` to print the full list.

Good to know:

- The configs contain absolute paths for your machine (project folder, Godot). Think twice before committing them for a team; teammates can run `init` themselves.
- When run through `npx`, `init` pins the version it was run with (e.g. `@shin2344234/godot-mcp@0.1.0`). To upgrade, run `npx -y @shin2344234/godot-mcp@latest init`.
- Global configs (Claude Desktop, Windsurf) hold one entry named `godot` for **one** project. For several projects, add entries by hand with different names (`godot-platformer`, `godot-rpg`).

### From a source checkout

If you build the server yourself (see [CONTRIBUTING.md](../CONTRIBUTING.md)):

```bash
cd /path/to/godot-mcp/server && npm install && npm run build
cd /path/to/my-game
node /path/to/godot-mcp/server/dist/index.js init
```

The configs then run `node /path/to/godot-mcp/server/dist/index.js` instead of `npx`. In the manual examples below, replace `"command": "npx"` and `"args": ["-y", "@shin2344234/godot-mcp", ...]` with `"command": "node"` and `"args": ["/path/to/godot-mcp/server/dist/index.js", ...]`.

### The editor addon without `init`

The manual setups below still need the addon in your project for the live editor and for headless scene editing. Any of these works:

- **Ask your agent.** The `godot_addon_install` tool copies the addon that ships with the server into `addons/godot_mcp/` and enables it in `project.godot`. It asks before replacing an existing copy. `godot_status` reports an `addon_hint` when the addon is missing or older than the server's, so agents usually suggest this themselves. This is the easy path for the Claude Desktop bundle and the Claude Code plugin, where you never run `init`.
- Run `npx -y @shin2344234/godot-mcp init --no-agents-md --no-claude-md --agents <your client>` once.
- Copy `addons/godot_mcp/` from this repository into your project and enable **Godot MCP** in **Project > Project Settings > Plugins**.
- Install it from the Godot asset library: see [asset-store.md](asset-store.md).

After installing or updating the addon, reopen the project in Godot so the plugin starts.

## Claude Code

**Plugin:** inside Claude Code, run:

```text
/plugin marketplace add shin2344234/godot-mcp
/plugin install godot-mcp@godot-mcp
```

(or `claude plugin marketplace add shin2344234/godot-mcp` and `claude plugin install godot-mcp@godot-mcp` from a shell). Then, in a Godot project, ask Claude to check `godot_status` and install the addon with `godot_addon_install` if it's missing.

**Automatic:** `npx -y @shin2344234/godot-mcp init --agents claude-code` writes `.mcp.json` in your project. The first time you start `claude` there, it asks you to approve the project's MCP server.

**Command line:** run this in your project folder. `--scope project` stores it in `.mcp.json`; leave it out to keep it private to you (stored in `~/.claude.json`). Everything after `--` is the server command.

```bash
claude mcp add --scope project --env GODOT_PATH=/path/to/godot --transport stdio godot \
  -- npx -y @shin2344234/godot-mcp --project /path/to/my-game
```

(Keep another option, such as `--transport stdio`, between `--env` and the server name. Otherwise Claude Code reads the name as another `KEY=value` pair.)

**Manual:** create `.mcp.json` in the project root:

```json
{
  "mcpServers": {
    "godot": {
      "command": "npx",
      "args": ["-y", "@shin2344234/godot-mcp", "--project", "/path/to/my-game"],
      "env": { "GODOT_PATH": "/path/to/godot" }
    }
  }
}
```

Check it with `/mcp` inside Claude Code. Claude Code loads MCP tools on demand (tool search), so full mode costs little context there.

Long tool calls (exports, test runs) can exceed Claude Code's tool timeout. Add `"timeout": 1800000` (milliseconds) to the server entry if they get cut off.

## Claude Desktop

**Bundle (easiest):** download the `.mcpb` file from the [GitHub Releases](https://github.com/shin2344234/godot-mcp/releases) page and double-click it. You can also drag it into the Claude Desktop window, or use **Settings > Extensions > Advanced settings > Install Extension…**. The install screen asks for the settings the bundle needs, such as your project folder. Claude Desktop ships its own Node.js, so you don't need to install it. Desktop extensions work on macOS and Windows.

You still need the addon in your project for the live editor. Ask Claude to run `godot_addon_install` (see [The editor addon without init](#the-editor-addon-without-init)). To build the bundle yourself from a checkout, run `node scripts/build-mcpb.mjs`; it writes `dist-bundles/godot-mcp-<version>.mcpb`.

**Automatic:** `npx -y @shin2344234/godot-mcp init --agents claude-desktop` adds the server to your global Claude Desktop config for this project.

**Manual:** open **Settings > Developer > Edit Config**. That opens `claude_desktop_config.json`:

- macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
- Windows: `%APPDATA%\Claude\claude_desktop_config.json`

Add:

```json
{
  "mcpServers": {
    "godot": {
      "command": "npx",
      "args": ["-y", "@shin2344234/godot-mcp", "--project", "/Users/me/my-game"],
      "env": { "GODOT_PATH": "/Applications/Godot.app/Contents/MacOS/Godot" }
    }
  }
}
```

On Windows, double the backslashes:

```json
{
  "mcpServers": {
    "godot": {
      "command": "npx",
      "args": ["-y", "@shin2344234/godot-mcp", "--project", "C:\\Users\\me\\my-game"],
      "env": { "GODOT_PATH": "C:\\Godot\\Godot_v4.7.2-stable_win64.exe" }
    }
  }
}
```

Quit Claude Desktop completely and start it again. Claude Desktop config is global, so `--project` is required. Server logs are in `~/Library/Logs/Claude/mcp-server-godot.log` (macOS) or `%APPDATA%\Claude\logs\` (Windows).

## Cursor

**Automatic:** `npx -y @shin2344234/godot-mcp init --agents cursor` writes `.cursor/mcp.json`.

**Manual:** create `.cursor/mcp.json` in the project (or `~/.cursor/mcp.json` for all projects). Cursor replaces `${workspaceFolder}` with the project folder:

```json
{
  "mcpServers": {
    "godot": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@shin2344234/godot-mcp", "--project", "${workspaceFolder}"],
      "env": { "GODOT_PATH": "/path/to/godot" }
    }
  }
}
```

Make sure the server is switched on in Cursor's MCP settings. Cursor asks before running MCP tools by default.

## VS Code (GitHub Copilot)

Use Copilot Chat in **Agent** mode.

**Automatic:** `npx -y @shin2344234/godot-mcp init --agents vscode` writes `.vscode/mcp.json`.

**Manual:** create `.vscode/mcp.json` in the project. Note the top-level key is `servers`, not `mcpServers`:

```json
{
  "servers": {
    "godot": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@shin2344234/godot-mcp", "--project", "${workspaceFolder}"],
      "env": { "GODOT_PATH": "/path/to/godot" }
    }
  }
}
```

For all workspaces, run **MCP: Open User Configuration** from the Command Palette and add the same entry there (with an absolute `--project` path). Or add it from a terminal:

```bash
code --add-mcp "{\"name\":\"godot\",\"command\":\"npx\",\"args\":[\"-y\",\"@shin2344234/godot-mcp\",\"--project\",\"/path/to/my-game\"]}"
```

VS Code asks whether you trust the server the first time it starts. A chat request can use at most 128 tools at once; full mode has 90 (89 plus `godot_tools`), so if you also use other servers, switch to compact mode or fewer toolsets.

## OpenAI Codex (CLI, IDE extension and app)

The Codex CLI, IDE extension and ChatGPT desktop app share one config.

**Automatic:** `npx -y @shin2344234/godot-mcp init --agents codex` writes `.codex/config.toml` in the project. Codex reads project config only for projects you have marked as trusted.

**Command line:**

```bash
codex mcp add godot --env GODOT_PATH=/path/to/godot -- npx -y @shin2344234/godot-mcp --project /path/to/my-game
```

**Manual:** edit `~/.codex/config.toml` (or `.codex/config.toml` in a trusted project):

```toml
[mcp_servers.godot]
command = "npx"
args = ["-y", "@shin2344234/godot-mcp", "--project", "/path/to/my-game"]
# The first npx download can take longer than the 10 s default.
startup_timeout_sec = 60
# Exports and test runs can take minutes (default 60 s).
tool_timeout_sec = 1800

[mcp_servers.godot.env]
GODOT_PATH = "/path/to/godot"
```

`init` doesn't set the two timeouts; add them if the server times out at startup or long calls get cut off.

## Gemini CLI

**Automatic:** `npx -y @shin2344234/godot-mcp init --agents gemini-cli` writes `.gemini/settings.json`.

**Manual:** edit `.gemini/settings.json` in the project (or `~/.gemini/settings.json` for all projects):

```json
{
  "mcpServers": {
    "godot": {
      "command": "npx",
      "args": ["-y", "@shin2344234/godot-mcp", "--project", "/path/to/my-game"],
      "env": { "GODOT_PATH": "/path/to/godot" }
    }
  }
}
```

Gemini CLI also has a `gemini mcp add` command; editing the JSON avoids shell-quoting trouble with the `-y` and `--project` arguments. Gemini's default request timeout is 10 minutes; add `"timeout": 1800000` for long exports.

## Windsurf (Devin Desktop)

Windsurf was renamed **Devin Desktop** in June 2026. Its MCP servers live in one global `mcp_config.json`, so `--project` is required.

The most reliable way to find the file is to open it from the MCPs section of Cascade's menu, which opens the file your version actually reads. The current docs give these paths:

- macOS / Linux: `~/.config/devin/mcp_config.json`
- Windows: `%APPDATA%\devin\mcp_config.json`

Older Windsurf versions used `~/.codeium/windsurf/mcp_config.json`. That older path is the one `init --agents windsurf` writes to. If the server doesn't show up, copy the `godot` entry into the file your editor opens.

```json
{
  "mcpServers": {
    "godot": {
      "command": "npx",
      "args": ["-y", "@shin2344234/godot-mcp", "--project", "/path/to/my-game"],
      "env": { "GODOT_PATH": "/path/to/godot" }
    }
  }
}
```

Cascade can use at most 100 tools in total across all servers. Full mode has 90 (89 plus `godot_tools`), so use compact mode (`--mode compact`, 17 tools) or a smaller `--toolsets` list.

## Zed

**Automatic:** `npx -y @shin2344234/godot-mcp init --agents zed` writes `.zed/settings.json` in the project. Zed starts MCP servers from project settings only after you trust the project folder.

**Manual:** run `zed: open settings file` (or use **Settings > AI > MCP Servers**) and add a `context_servers` entry:

```json
{
  "context_servers": {
    "godot": {
      "command": "npx",
      "args": ["-y", "@shin2344234/godot-mcp", "--project", "/path/to/my-game"],
      "env": { "GODOT_PATH": "/path/to/godot" }
    }
  }
}
```

In **Settings > AI > MCP Servers**, a green dot next to `godot` means it's running.

## Options

Pass options as arguments after the package name, or as environment variables in the `env` block. Arguments win over environment variables. An empty environment variable (for example `"GODOT_PATH": ""`) counts as not set.

| Argument | Environment variable | Default | Meaning |
|---|---|---|---|
| `--project <dir>` | `GODOT_PROJECT_PATH` | current folder | Godot project folder (the one with `project.godot`) |
| `--godot <exe>` | `GODOT_PATH` (or `GODOT_BIN`) | searched on `PATH` | Godot 4 executable |
| `--mode full\|compact` | `GODOT_MCP_MODE` | `full` | `compact` lists 14 core tools plus `godot_tools`, `godot_call_read` and `godot_call_write` for everything else |
| `--toolsets a,b,c` | `GODOT_MCP_TOOLSETS` | all | Only these tool groups (`core` is always on) |
| `--read-only` | `GODOT_MCP_READ_ONLY=1` | off | Hide every tool that changes something |
| `--allow-eval` | `GODOT_MCP_ALLOW_EVAL=1` | off | Let `godot_game_eval` run GDScript inside the running game |
| `--confirm never` | `GODOT_MCP_CONFIRM=never` | `elicit` | Skip the yes/no question before irreversible steps |
| | `GODOT_MCP_HEADLESS_TIMEOUT_MS` | `120000` | Limit for one headless Godot run |
| | `GODOT_MCP_BRIDGE_TIMEOUT_MS` | `30000` | Limit for one editor request |
| | `GODOT_MCP_LSP_PORT` | editor's setting | GDScript language server port |
| | `GODOT_MCP_LSP_TIMEOUT_MS` | `15000` | Limit for one language server request |
| | `GODOT_MCP_LSP_IDLE_MS` | `600000` | Stop the private language server editor after this long unused |
| | `GODOT_MCP_LOG_LEVEL` | `info` | `debug` for troubleshooting (logs go to stderr) |

Tool groups for `--toolsets`: `core`, `files`, `scene`, `node`, `script`, `run`, `editor`, `signal`, `resource`, `visual`, `anim`, `world`, `audio`, `project`, `import`, `export`, `code`, `docs`, `game`, `debug`, `test`. The [README](../README.md#tools) lists the tools in each.

Example: compact mode, read-only, with a fixed Godot:

```json
"args": ["-y", "@shin2344234/godot-mcp", "--project", "/path/to/my-game", "--mode", "compact", "--read-only"],
"env": { "GODOT_PATH": "/path/to/godot" }
```

Example: only scene work and running the game:

```json
"args": ["-y", "@shin2344234/godot-mcp", "--project", "/path/to/my-game", "--toolsets", "files,scene,node,script,run"]
```

In TOML (Codex) the same arguments go in the `args = [...]` list.

**Which mode?** Clients that load tools on demand (Claude Code) handle full mode well. Clients that send every tool definition on every turn, or cap the tool count (Windsurf: 100, VS Code: 128 per request), do better with `compact` or a short `--toolsets` list. Full mode is about 15k tokens of tool definitions, compact about 2.2k.

**`--allow-eval`** lets the agent run any GDScript inside your running game, with the game's access to files and the OS. Turn it on only when you want that. Without it, `godot_game_get` and `godot_game_edit` still read and change the live game.

## Windows notes

- **Use the main Godot exe**, e.g. `Godot_v4.7.2-stable_win64.exe`, not `Godot_v4.7.2-stable_win64_console.exe`. The console one is a small launcher; under load it sometimes exits with no output. The server reads Godot's output through pipes either way, so you lose nothing.
- **Escape backslashes in JSON**: `"C:\\Godot\\Godot_v4.7.2-stable_win64.exe"`. TOML basic strings need the same, or use single quotes: `'C:\Godot\Godot_v4.7.2-stable_win64.exe'`.
- **If `npx` won't start.** Most clients start `npx` directly (Claude Desktop's own Windows example does). If a client on native Windows reports that the server failed to start, "program not found", or "Connection closed", run `npx` through `cmd`:

  ```json
  "command": "cmd",
  "args": ["/c", "npx", "-y", "@shin2344234/godot-mcp", "--project", "C:\\Users\\me\\my-game"]
  ```

  We couldn't confirm from the clients' current docs which of them still need this, so try plain `npx` first.
- **WSL**: if your client runs inside WSL, Godot and the project must be reachable from WSL too. Running everything on the Windows side is simpler.
