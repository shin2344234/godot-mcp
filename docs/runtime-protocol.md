# Runtime protocol (server ⇄ running game)

Step 3 adds tools that work on the **running game**: live scene tree, live edits,
input, timing, screenshots, performance, breakpoint debugging and tests. This file
describes the channel they share. Everything here was checked against Godot 4.7.2
(source tag `4.7.2-stable` and a real 4.7.2 binary).

## 1. Two ways a game runs, one protocol inside it

```
                      ┌──────────── process run (godot_run_start mode "process") ─────────────┐
MCP server ── TCP 127.0.0.1 (--remote-debug) ──► game: EngineDebugger ──► runtime autoload
                      └───────────────────────────────────────────────────────────────────────┘
                      ┌──────────── editor run (F5, or godot_run_start mode "editor") ─────────┐
MCP server ── bridge WebSocket ──► editor plugin: EditorDebuggerPlugin ──► editor's debugger
                                         connection ──► game: EngineDebugger ──► runtime autoload
                      └───────────────────────────────────────────────────────────────────────┘
```

In both cases the game talks to *a debugger* through Godot's built-in remote debugger
(`EngineDebugger`). For process runs the MCP server **is** the debugger; for editor runs
the editor is, and the plugin relays our messages. The runtime autoload inside the game
(`addons/godot_mcp/runtime/mcp_runtime.gd`) only ever sees `EngineDebugger` messages, so
runtime code is written once.

## 2. Godot's remote debugger wire format (process runs)

`server/src/game/variant.ts` and `debugSession.ts`.

- The server listens on `127.0.0.1:<random port>` and launches the game with
  `--remote-debug tcp://127.0.0.1:<port>`. It accepts exactly one connection and then
  stops listening.
- Framing: `uint32` little-endian byte length, then one Variant in Godot's binary
  serialization (`core/io/marshalls.cpp`). Decoded values follow the addon's JSON
  conventions (`docs/bridge-protocol.md` section 3): vectors as `"Vector2(1, 2)"`,
  objects sent as ids as `{"object_id": "123"}`.
- Game → debugger: `[message: String, thread_id: int, data: Array]`. Messages seen from a
  4.7.2 game at startup: `set_pid`, `output` (`[strings[], types[]]`), `window:title`,
  `performance:profile_frame` (about once a second; monitor values), `error`
  (`DebuggerMarshalls::OutputError`: time, source file/function/line, error, description,
  warning flag, then the script call stack as file/function/line triples).
- Debugger → game: `[command: String, thread_id: int, data: Array]` (exactly three
  elements, or the game logs `Condition "cmd.size() != 3"` and drops it). `thread_id` must
  be a thread the game listens on: the main thread's id, i.e. the one the game puts in its
  own messages (1 in practice).
- Commands are routed by prefix to captures: `core:` (`breakpoint [source, line, set]`,
  `set_skip_breakpoints [bool]`, `set_ignore_error_breaks [bool]`, `break []`,
  `reload_scripts`), `profiler:<name> [enable, options?]`, `scene:` (Godot's
  SceneDebugger, present in every debug build: `suspend_changed [bool]`, `next_frame []`,
  `speed_changed [float]`, `request_scene_tree`, `rq_screenshot [id]`...), and `mcp:` (ours).
- While the game is stopped at a breakpoint it runs a nested loop that also accepts the
  bare commands `step`, `next`, `out`, `continue`, `get_stack_dump`,
  `get_stack_frame_vars [frame]` and `evaluate [expression, frame]`, and answers with
  `debug_enter [can_continue, error, has_stack, thread_id]`, `stack_dump`,
  `stack_frame_vars`, `evaluation_return`... (`core/debugger/remote_debugger.cpp`; every
  layout is in [methods/debug.md](methods/debug.md)).
- `--breakpoints res://a.gd:12,res://b.gd:30` sets breakpoints before the first frame.
- With a debugger attached, a script error normally **stops the game** in that loop. Process
  runs send `core:set_ignore_error_breaks [true]` right after connecting (unless
  `break_on_errors` was requested), so an unattended game never freezes; the error is
  still reported (with its stack) as an `error` message and kept in `run.errors`.

## 3. Getting the runtime into the game

Godot reads `res://override.cfg` at startup, after `project.godot`, and an `[autoload]`
entry there is instantiated like one in the project (verified with 4.7.2). Autoloads are
only read at startup, so the file only needs to exist while the game boots:

- process runs: the server writes it right before spawning and restores it as soon as the
  runtime says hello (or the game exits, or 20 s pass) — `server/src/game/override.ts`;
- editor runs: the plugin writes it in `EditorPlugin._build()` (called right before the
  editor runs the project) and restores it when the debugger session starts —
  `addons/godot_mcp/core/runtime_override.gd`.

The user's own `override.cfg` is kept (our section is appended, the original is backed up
to `.godot/godot_mcp/override.cfg.user-backup` and put back). A marker comment identifies
our version so either side can clean up a file left by a crash. `project.godot` is never
changed. The runtime does nothing unless `EngineDebugger.is_active()`, so even a stale file
can't affect a normal or exported run.

## 4. The runtime's own messages (`mcp:` prefix)

Payloads are one JSON **string** inside the Variant array, so the editor relay can pass
them through untouched:

| Direction | Message | Data |
|---|---|---|
| server → game | `mcp:request` | `[json]`, json = `{"id": 7, "method": "game.tree", "params": {...}}` |
| game → server | `mcp:reply` | `[json]`, json = `{"id": 7, "result": {...}}` or `{"id": 7, "error": {"code", "message", "data"?}}` |
| game → server | `mcp:hello` | `[json]`, json = `{"protocol": 1, "godot_version", "pid", "current_scene", "display", "methods": [...]}` (once, when ready) |
| game → server | `mcp:event` | `[json]`, json = `{"event": "name", ...}` (unsolicited) |

Runtime methods live in `addons/godot_mcp/runtime/ops/rt_*.gd`, each with
`static func methods() -> Dictionary` mapping a method name to `{"fn": Callable(rt, params)}`.
`fn` returns the usual `{"result": {...}}` / `{"error": {...}}` (`core/mcp_result.gd`) and
may be a coroutine (`await rt.get_tree().process_frame`, signals...); other requests keep
being served while one waits. Helpers on `rt` (the autoload node): `scene_root()`,
`find_node(path)` (relative to the current scene, or absolute `/root/...`, errors list
how to find nodes), `path_of(node)`, `encode(value)`, `send_event(name, data)`.

The runtime node runs with `PROCESS_MODE_ALWAYS`, so it keeps answering while the
SceneTree is paused.

## 5. Editor relay

`addons/godot_mcp/editor/game_relay.gd` (an `EditorDebuggerPlugin`) captures the `mcp`
prefix only, so the editor's own debugger keeps working. Game → server: every `mcp:*`
message becomes a bridge event frame
`{"type": "event", "event": "game.message", "data": {"session", "message", "data"}}`;
`game.started` / `game.stopped` events track sessions. Server → game: bridge method
`game.send {session?, command, data}` (→ `EditorDebuggerSession.send_message`), and
`game.status` lists running sessions with the last hello (for a server that connected
after the game started). Editor runs can't give us `debug_enter`/`stack_dump` (those go
to the editor's own debugger, not plugins), so breakpoint debugging tools work on process
runs.

## 6. Server side

- `GameRun` (`server/src/godot/runs.ts`) owns a `DebugSession` and a `RuntimeChannel`
  (`run.channel`); `run.errors` holds structured errors with stacks.
- `resolveGame(ctx, run_id?)` / `runtimeCall(ctx, run_id, method, params)`
  (`server/src/game/hub.ts`) pick the target: the given run, else the newest live process
  run, else the editor's game. With nothing running, tools fail with `GAME_NOT_RUNNING`
  and a hint to call `godot_run_start`.
- `channel.request(method, params, {timeoutMs, signal})` for runtime methods;
  `channel.native(command, data)` for Godot's own debugger commands (`scene:next_frame`...);
  `channel.on('native', msg)` for Godot's own messages; `channel.on('event', payload)`.
- Runtime tools are always listed (the spec forbids changing the tool list mid-session);
  without a game they return an `isError` result saying how to start one.

## 7. Security

- The debugger listener binds to 127.0.0.1, accepts one connection (the game we launched)
  and closes; the bridge keeps its token check.
- Code evaluation in the game (`godot_game_eval`) is off unless the user starts the server
  with `--allow-eval` / `GODOT_MCP_ALLOW_EVAL=1`.
- Screenshots are scaled down by default; nothing leaves the machine.
