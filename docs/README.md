# godot-mcp documentation

## Using godot-mcp

- [Setup](setup.md): installing with `init`, and the exact config for Claude Code, Claude
  Desktop, Cursor, VS Code, Codex, Gemini CLI, Windsurf and Zed; every option; Windows notes
- [Tools](tools.md): all 91 tools by group, full and compact modes, toolsets, resources and
  prompts
- [How it works](overview.md): the editor bridge, the headless fallback, the in-game runtime,
  safety and context size
- [Troubleshooting](troubleshooting.md): error messages and their fixes
- [Security](../SECURITY.md): the threat model and how to report a vulnerability

## Tool reference

Every parameter, result and limit, by area:

| Page | Tool groups |
|---|---|
| [Core, files and editor](methods/core-files-editor.md) | `core`, `files`, `editor` (logs and launch) |
| [Bridge protocol, section 5](bridge-protocol.md#5-core-scene-node-script-and-run-methods) | `scene`, `node`, `script` and `run` basics |
| [Scenes, signals and batches](methods/scene-signals.md) | `scene` extras (inherit, close, batch), `node` extras (instance, find, move, groups), `signal` |
| [Resources, visual authoring and import](methods/resources-visual-import.md) | `resource`, `visual`, `import` |
| [Animation and audio](methods/animation-audio.md) | `anim` (AnimationPlayer, AnimationTree, SpriteFrames), `audio` |
| [Tile maps, grid maps and navigation](methods/world.md) | `world` |
| [Project configuration and export](methods/project-export.md) | `project`, `export` |
| [Code intelligence and offline docs](methods/code-docs.md) | `code`, `docs` |
| [Live game](methods/live-game.md) | `game_tree`, `game_get`, `game_edit`, `game_eval` |
| [Input, timing and recording](methods/game-input.md) | `game_input`, `game_time`, `game_record`, movie capture |
| [Screenshots and performance](methods/game-view.md) | `game_screenshot`, `game_perf` |
| [Breakpoint debugging](methods/debug.md) | `debug`, and `run_output` error views |
| [Tests and editor UI](methods/tests-editor-ui.md) | `test`, `editor_ui` |

## Design

- [Bridge protocol](bridge-protocol.md): how the server talks to the editor plugin and the
  headless runner, and how Godot values are encoded as JSON
- [Runtime protocol](runtime-protocol.md): how the server talks to a running game

## Maintaining the project

- [Contributing](../CONTRIBUTING.md): dev setup, layout, tests, adding a tool
- [Releasing](releasing.md): publishing to npm, the MCP Registry and GitHub Releases
- [Godot Asset Store](asset-store.md): building and submitting the addon listing
- [Changelog](../CHANGELOG.md)
