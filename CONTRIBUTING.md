# Contributing to godot-mcp

Thanks for helping! This page covers the dev setup, the repository layout, running the tests, and how to add a tool.

## Dev setup

You need:

- Node.js 22 or newer
- Godot 4.7 (the editor binary) for the end-to-end and GDScript tests
- bash, for `scripts/*.sh` (Git Bash or WSL on Windows)
- On Linux, `xvfb-run` (package `xvfb`) for the tests that open a window

```bash
git clone https://github.com/shin2344234/godot-mcp
cd godot-mcp/server
npm install
npm run build        # compiles to server/dist
```

Run the server from source without building:

```bash
cd server
npx tsx src/index.ts --project ../examples/sample_project
```

To try your build in a real client, run `init` from a test project. It writes the path of the script you ran into the client config:

```bash
cd /path/to/test-project
node /path/to/godot-mcp/server/dist/index.js init
```

## Layout

| Path | What's there |
|---|---|
| `server/src/index.ts` | Entry point: `serve` (default) and `init` |
| `server/src/config.ts` | All flags and environment variables |
| `server/src/mcp/` | MCP wiring: tool registration, instructions, resources, prompts, elicitation |
| `server/src/ops/` | One file per tool area; every tool is an operation defined with `defineOp` |
| `server/src/ops/catalog.ts` | The ordered list of all operations |
| `server/src/bridge/` | WebSocket client for the editor plugin |
| `server/src/godot/` | Finding Godot, headless runs, game processes |
| `server/src/game/` | Godot's remote-debugger protocol, the runtime channel, `override.cfg` injection |
| `server/src/lsp/` | GDScript language server client |
| `server/src/docs/` | Offline class reference search |
| `server/src/testing/` | GUT / GdUnit4 runners |
| `server/src/init/` | `godot-mcp init` |
| `server/test/unit/` | Fast tests, no Godot needed |
| `server/test/e2e/` | End-to-end tests against real Godot (skipped without it) |
| `addons/godot_mcp/` | The Godot addon: editor plugin, bridge, headless runner, runtime |
| `addons/godot_mcp/ops/` | Editor/headless methods per area (`*_ops.gd`) |
| `addons/godot_mcp/runtime/` | The in-game runtime autoload and its methods (`ops/rt_*.gd`) |
| `examples/sample_project/` | Godot project used by the tests |
| `scripts/` | GDScript test suite and helpers |
| `docs/` | Protocols, per-area method references, user guides |

Read [docs/bridge-protocol.md](docs/bridge-protocol.md) and [docs/runtime-protocol.md](docs/runtime-protocol.md) before changing anything that crosses the TypeScript/GDScript line.

## Running the tests

GitHub Actions is turned off for this repository on purpose. **Run the tests locally before you open a pull request**, and say in the PR which ones you ran.

**Unit and protocol tests** (no Godot needed, a few seconds):

```bash
cd server
npx tsc --noEmit
npx vitest run test/unit
```

**Everything, against real Godot.** Tests that need Godot skip themselves when `GODOT_BIN` isn't set:

```bash
cd server
GODOT_BIN=/path/to/godot npx vitest run
```

On Linux, the tests that open a game window need a display. Run them under Xvfb:

```bash
GODOT_BIN=/path/to/godot xvfb-run -a -s "-screen 0 1280x720x24" npx vitest run
```

**GDScript tests**: lint every addon script with warnings as errors, smoke-test every headless method, and drive a headless editor over the bridge:

```bash
GODOT=/path/to/godot scripts/test-gdscript.sh
```

### The token budget test

`server/test/unit/budget.test.ts` keeps the tool definitions small, because clients send them to the model on every turn. It estimates tokens as characters / 4 over each tool's name, title, description and input schema. Current numbers: about 15.3k tokens for the 90 operations in full mode (limit 17k) and 2.2k for the 14 core tools in compact mode (limit 5k). It also requires every description to start with "Godot " (clients with tool search match on it) and the server instructions to stay under 2 KB.

If your change trips it, shorten descriptions and schema text first. Raise a limit only with a good reason, and explain it in the test.

`server/test/unit/prompts.test.ts` checks that every `godot_*` name mentioned in the prompts and server instructions is a real tool.

## Adding a tool

1. **Server side.** Add an operation to `server/src/ops/<area>.ts` with `defineOp` (name like `area.verb`, group, title, a description starting with "Godot ", a zod input schema, `readOnly` / `destructive` hints). Add it to `ALL_OPERATIONS` in `server/src/ops/catalog.ts`. The tool name is `godot_` plus the name with dots replaced (`node.add` becomes `godot_node_add`).
2. **Godot side**, if it needs Godot:
   - Editor/headless work: a method in `addons/godot_mcp/ops/<area>_ops.gd`, registered in that module's `methods()` (see the descriptor kinds in `addons/godot_mcp/core/methods.gd`). Mark editor-only methods with `"editor_only": true`.
   - Running-game work: a method in `addons/godot_mcp/runtime/ops/rt_<area>.gd`.
   - Errors must say what went wrong **and** how to fix it. The model reads them.
3. **Docs.** Document the method in the matching `docs/methods/<area>.md`, and add the tool to the tools table in `README.md`.
4. **Tests.** A unit test for pure logic, an e2e test in `server/test/e2e/` for the real thing. Run the budget test.
5. **New `.gd` files need their `.uid` files committed** (see below).

New tool groups go in `ALL_GROUPS` in `server/src/ops/types.ts`.

### `.uid` files for new GDScript files

Since Godot 4.4, every script has a `.gd.uid` file next to it, and Godot's advice is to commit them. Without them, a fresh copy of the addon gets new UIDs on every machine. Generate them with Godot rather than by hand:

```bash
scripts/sync-addon.sh                                    # copies the addon into examples/sample_project
godot --headless --path examples/sample_project --import # Godot writes .uid files for new scripts
# copy the .uid files the source addon doesn't have yet:
cd addons/godot_mcp
for gd in $(find . -name '*.gd'); do
  [ -f "$gd.uid" ] || cp "../../examples/sample_project/addons/godot_mcp/$gd.uid" "$gd.uid"
done
```

Or copy `addons/godot_mcp` into any throwaway project, import it once, and copy the new `.gd.uid` files back. Commit them with the scripts. Never change an existing `.uid`.

## Commits and pull requests

- Branch from `main`. One topic per pull request.
- Commit subjects are short and imperative: "Fix runtime-editor e2e test failing outside the cloud container". The body says **why**, and what you found.
- Keep generated files (`server/dist/`, `.godot/`) out of commits. The addon copy in `examples/sample_project/addons/` is git-ignored; the source of truth is `addons/godot_mcp/`.
- Update `CHANGELOG.md` under `[Unreleased]` for user-visible changes.
- In the PR description, list the test commands you ran and on which OS and Godot version.

Releasing is described in [docs/releasing.md](docs/releasing.md).

## Reporting security issues

Please don't open a public issue. See [SECURITY.md](SECURITY.md).
