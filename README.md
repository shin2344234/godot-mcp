# godot-mcp

An [MCP](https://modelcontextprotocol.io) server for the **Godot 4** engine. It lets AI agents such as Claude Code, Claude Desktop, Cursor, VS Code Copilot, Codex, Gemini CLI, Windsurf and Zed work on your Godot project:

- inspect and edit scenes, nodes, signals and resources
- author animations, AnimationTrees, SpriteFrames, tile maps, navigation, audio buses and visual shaders
- change project settings, input actions, autoloads, import options and export presets, and run exports
- write scripts with GDScript language-server diagnostics, symbols and renames
- look up the Godot class reference offline for the exact version you have installed
- run the game and work on it live: inspect and change nodes, send input, pause and step frames, take screenshots, profile, record and replay input
- debug with breakpoints, stepping, stack and variables, and run GUT or GdUnit4 tests

It works through a live editor bridge, so every scene edit can be undone with Ctrl+Z, and through headless Godot when the editor is closed.

## Requirements

- **Godot 4.7 or newer** (tested with 4.7.2)
- **Node.js 22 or newer**, unless you use the Claude Desktop bundle, which brings its own

## Install

In your Godot project folder (the one with `project.godot`), run:

```bash
npx -y @shin2344234/godot-mcp init
```

`init` shows its plan and asks before writing anything (`--dry-run` previews, `--remove` undoes). It copies the editor addon into `addons/godot_mcp` and enables it, registers the server with the agents it finds on your machine (or the ones you pick with `--agents claude-code,cursor,vscode,codex,gemini-cli,...`), and adds a short note to `AGENTS.md`.

Then open the project in Godot, start a new agent session and ask it to call `godot_status` to check the connection.

### Other ways to install

- **Claude Code plugin:** run `/plugin marketplace add shin2344234/godot-mcp`, then `/plugin install godot-mcp@godot-mcp`.
- **Claude Desktop:** download the `.mcpb` file from [Releases](https://github.com/shin2344234/godot-mcp/releases) and double-click it.
- **Any other MCP client:** add the server to its config by hand. [docs/setup.md](docs/setup.md) gives the exact file and format for each client.
- **From source:**

  ```bash
  git clone https://github.com/shin2344234/godot-mcp
  cd godot-mcp/server && npm install && npm run build
  cd /path/to/my-game
  node /path/to/godot-mcp/server/dist/index.js init
  ```

If you installed without `init`, ask the agent to run `godot_addon_install` once per project to add the editor addon.

## Documentation

- [Setup for each client](docs/setup.md): Claude Code, Claude Desktop, Cursor, VS Code, Codex, Gemini CLI, Windsurf and Zed, all options, and Windows notes
- [Tools](docs/tools.md): every tool by group, tool modes and toolsets, resources and prompts
- [How it works](docs/overview.md): editor bridge, headless fallback, the in-game runtime, safety and context size
- [Troubleshooting](docs/troubleshooting.md): error messages and fixes
- [All documentation](docs/README.md), including the per-area method references and protocol designs
- [Changelog](CHANGELOG.md) · [Contributing](CONTRIBUTING.md) · [Security](SECURITY.md)

## License

[MIT](LICENSE)
