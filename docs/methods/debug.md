# Methods: breakpoint debugging (step 3)

MCP tools `godot_debug_breakpoints`, `godot_debug_control` and `godot_debug_state`
(`server/src/ops/debug.ts`, state in `server/src/game/debugState.ts`), plus the errors view
of `godot_run_output` (`server/src/ops/run.ts`).

They work on **process runs** (`godot_run_start` with `mode: "process"`), where the server
itself is the game's remote debugger ([runtime-protocol.md](../runtime-protocol.md)
section 2). There is no DAP and no editor involved: the server speaks Godot's own debugger
messages, the same ones the editor's Debugger panel uses. Games started from the editor
send `debug_enter` / `stack_dump` to the editor's debugger, which plugins can't see, so
the tools answer `UNSUPPORTED` for them (and for `run_id: "editor"`) with a hint to start
the game with `godot_run_start {mode: "process", breakpoints: [...]}`.

All three take an optional `run_id`; the default is the newest process run that is still
running. No such run → `GAME_NOT_RUNNING`; a run that exited → `GAME_NOT_RUNNING` with its
exit code and a pointer to `godot_run_output`.

## Typical session

```
godot_run_start {mode: "process", scene: "res://level.tscn", breakpoints: ["res://player.gd:42"]}
godot_debug_state {}                         -> stopped, reason "breakpoint", stack, locals, members
godot_debug_control {action: "step_over"}    -> new location (with its source line) and locals
godot_debug_control {action: "evaluate", expression: "velocity.length()"}
godot_debug_breakpoints {action: "add", breakpoints: ["res://enemy.gd:17"]}
godot_debug_control {action: "continue", wait: 5}   -> the next stop, or "running"
```

While the game is stopped its main loop doesn't run, so runtime tools (`godot_game_*`,
which go through `mcp:request`) may not answer until it continues.

## godot_debug_breakpoints (not read-only, idempotent)

params: `{ "action"?: "list" | "add" | "remove" | "clear", "breakpoints"?: ["res://player.gd:42", {"file": "player.gd", "line": 42}], "run_id"? }`

- The server keeps the run's breakpoint list. It starts with the `breakpoints` given to
  `godot_run_start` (read back from the game's `--breakpoints` argument).
- `add` validates every entry first (nothing is applied if one is wrong): the path is
  resolved inside the project (`res://`, relative and `./` forms; absolute paths and `..`
  escapes are refused), must be an existing `.gd` file, and the line must be 1..line count.
  Godot matches breakpoints by the script's exact path, so they're sent as canonical
  `res://` paths.
- Lines that can never stop are added with a **warning** naming the next code line.
  Verified with 4.7.2: GDScript stops only where the compiler emitted a line opcode
  (statements). Blank lines, comments and `func` declaration lines never trigger; Godot
  doesn't move them. A member `var x := 1` line does stop, while the object is constructed
  (function `@implicit_new`).
- `remove` of a breakpoint that wasn't set is sent anyway and warned about; `clear` removes
  every breakpoint in the list.
- Works while the game runs and while it is stopped.

Result: `{ "run_id", "breakpoints": ["res://dbg.gd:9", ...], "added"? | "removed"?: [...], "warnings"?: [...], "stopped": bool }`.

## godot_debug_control (not read-only)

params: `{ "action": "continue" | "pause" | "step_into" | "step_over" | "step_out" | "evaluate", "expression"?, "frame"?: 0, "wait"?: seconds, "run_id"? }`

- `step_into` / `step_over` / `step_out` (Godot's `step` / `next` / `out`) need a stopped
  game; they wait up to `wait` seconds (default 10) for it to stop again and return where it
  is, from a fresh stack dump:
  `{ "stopped": true, "reason": "step", "at": { "file", "line", "function", "code" }, "depth": 2, "locals": {...} }`
  (`code` is that source line, trimmed). Stepping past the end of a function stops at the
  next GDScript line that runs anywhere (often the next frame's callback).
- `continue` resumes. With `wait` > 0 (default 0) it waits for the next stop and returns it
  like a step; otherwise `{ "stopped": false, "running": true }`.
- `pause` sends `core:break`. The game breaks at its next debugger poll, between frames
  (or every 2048 GDScript lines in a busy loop), which is **outside GDScript: there is no
  call stack** (`reason: "pause"`, no `at`). `step_into` from there stops at the next
  GDScript line that runs; after a pause every step action is sent as `step`, since
  `next`/`out` are relative to a frame. `pause` on a stopped game is a no-op.
- After a **script error** stop, Godot only allows `continue` (the failing function is
  aborted; the editor disables its step buttons too): steps answer `CONFLICT`.
- `evaluate` runs `expression` with Godot's `Expression` class in stack frame `frame`
  (0 = innermost): the frame's locals, the globals (autoloads), engine singletons and
  global classes are inputs and the frame's `self` is the base object, so members and
  methods work (`position.x + 1`, `get_child_count()`, `GameState.score`). It is one
  expression, not GDScript statements (no `=` assignments), but method calls **can change
  the game**; that is why it is here and not in the read-only `godot_debug_state`.
  Result `{ "expression", "frame", "value" }`. A parse or execution failure →
  `GODOT_ERROR` with Godot's message (Godot returns null and reports the reason as an
  `error` message right after; the server waits briefly for it). That error carries the
  stopped frame's backtrace and is also printed on the game's stderr, but it is not a game
  error: it is kept out of `godot_run_output {errors: true}` and of the error counts, and its
  output lines are shown with an `EVAL` tag instead of `ERROR`.
  Refused before reaching the game: no stack (after a pause), a frame index out of range,
  or a frame without an instance (static functions) — Godot's evaluate handler leaves its
  debug loop in those cases, which would silently resume the game.
- If the game exits while a call waits: `{ "stopped": false, "running": false, "exited": true, "exit_code" }`.
  A step whose target never runs within `wait`: `{ "stopped": false, "running": true, "note" }`
  (it stops when it gets there; check `godot_debug_state`).

## godot_debug_state (read-only)

params: `{ "frame"?: 0, "variables"?: true, "globals"?: false, "run_id"? }`

Running: `{ "run_id", "stopped": false, "running": true, "breakpoints": [...], "errors": 3 }`
(`errors` = script errors so far; read them with `godot_run_output {errors: true}`).

Stopped:

```json
{ "run_id": "fe64fd57", "stopped": true, "reason": "breakpoint", "can_step": true,
  "stack": [{ "file": "res://dbg.gd", "line": 8, "function": "_on_tick", "code": "counter += 1" }],
  "frame": 0, "locals": { "doubled": null },
  "members": { "self": { "object_id": "30551311833", "class": "Node" }, "counter": 0, "label_text": "hello" } }
```

- `reason`: `breakpoint`, `step` (a step finished), `pause`, `error` (with `error`: the
  script error text from `debug_enter`) or `breakpoint_statement` (the `breakpoint`
  keyword). `can_step` is false after errors.
- `stack` is innermost first; `frame` indexes it. `code` is shown for the selected frame.
- Variables follow the server's JSON conventions (`docs/bridge-protocol.md` section 3):
  vectors etc. as `"Vector2(1, 2)"`, objects as `{ "object_id", "class" }` (the class is
  the script's `class_name` or the native class). Caps: 50 variables per scope, strings
  300 characters, arrays/dictionaries 20 items and 3 levels deep, each with a
  `"… +N more"` marker. Godot itself sends null for values over 1 MiB, shown as
  `"<too large to send>"`. `members` starts with `self` when the frame has an instance.
  `globals` (autoloads and global script variables) only with `globals: true`.
- Reading the stack and variables has no side effects in Godot, hence read-only.

## godot_run_output errors view

`godot_run_output {errors: true, since?, limit?, level?}` returns the structured errors the
game reported through the debugger (`run.errors`: `DebuggerMarshalls::OutputError`, each
with its script backtrace) instead of output lines. This works whether or not
`break_on_errors` was set: process runs ignore error breaks by default, so errors never
freeze the game but are all recorded here.

```json
{ "run_id": "5c043cac", "running": true, "exit_code": null, "error_count": 3, "warning_count": 0,
  "next": 3, "more": false,
  "errors": [{ "seq": 0, "message": "Invalid access to property or key 'missing' on a base object of type 'Dictionary'.",
               "at": "res://err.gd:14 in explode()", "callers": ["res://err.gd:9 in _process()"], "count": 3 }] }
```

`since` / `next` page by error seq; `level: "error"` drops warnings (`warning: true`
entries). The `errors` / `warnings` counts of the lines view (`godot_run_start`,
`godot_run_output` without `errors`) count each printed error once (its `ERROR:` line, not
the indented `at:` / backtrace lines under it), so they match `error_count` /
`warning_count` here for errors that went through the debugger. Identical entries in a page are merged with a `count`, so an error raised every
frame takes one entry. `detail` carries Godot's extra description when there is one;
`source` (the C++ location) is given only when no script was on the stack.

## godot_run_output for games started from the editor

A game started with `godot_run_start {mode: "editor"}` (or from the editor's Play button)
sends its output to the editor's Output panel over the editor's debugger connection, and
the editor gives plugins no way to read it (its `output` and `error` messages are handled
before `EditorDebuggerPlugin` captures, `ScriptEditorDebugger::_parse_message`). So the
game's runtime keeps its own copy: `runtime/ops/rt_output.gd` installs a `Logger`
(`OS.add_logger`, Godot 4.5+) that keeps the newest 2000 entries, and `godot_run_output`
reads it with the runtime method `rt.output` when `run_id` is `"editor"`, or by default
when no process run of this server is running. Both views have the same shape as for
process runs (`run_id: "editor"`, no `exit_code`):

- lines: `"<seq> text"`, `"<seq> ERROR text (at res://x.gd:3 in f())"`,
  `"<seq> WARNING ..."`; `printerr()` lines are tagged `[stderr]` but not counted as errors.
- errors (`errors: true`): `{seq, message, at, callers}` (or `source` when no script was on
  the stack), merged with `count` like above.

Output printed before the runtime autoload entered the tree (by autoloads that load
earlier) is not captured.

## Wire protocol (verified against Godot 4.7.2)

Source: `core/debugger/remote_debugger.cpp`, `core/debugger/debugger_marshalls.cpp`,
`editor/debugger/script_editor_debugger.cpp`, `modules/gdscript/gdscript_editor.cpp` and
`gdscript_vm.cpp` at tag `4.7.2-stable`, then checked against a real 4.7.2 game.
Messages are `[name, thread_id, data]` (runtime-protocol.md section 2).

| Direction | Message | Data |
|---|---|---|
| → game, any time | `core:breakpoint` | `[source, line, set]` — source first (`insert_breakpoint(data[1], data[0])`; the editor sends `[path, line, enabled]`) |
| → game, running | `core:break` | `[]` — never while stopped (it would nest a second debug loop) |
| game → | `debug_enter` | `[can_continue, error, has_stack, thread_id]`; `error` = `"Breakpoint"` (breakpoints and finished steps), `"Breakpoint Statement"`, `""` (pause, `has_stack` false) or the error text (`can_continue` false). Sent before the matching `error` message |
| game → | `debug_exit` | `[]` when the debug loop is left (continue or a step) |
| → stopped thread | `step` / `next` / `out` / `continue` | `[]` |
| → stopped thread | `get_stack_dump` | `[]` → `stack_dump [3*n, file, line, function, ...]`, innermost first (note file/**line**/function; `error` messages use file/function/line) |
| → stopped thread | `get_stack_frame_vars` | `[frame]` (exactly one element) → `stack_frame_vars [count]`, then `count` × `stack_frame_var [name, scope, variant_type, value, type_hint]` (`ScriptStackVariable`; scope 0 local, 1 member, 2 global; locals, then members starting with `self`, then globals) |
| → stopped thread | `evaluate` | `[expression, frame]` → `evaluation_return [expression, 3, variant_type, value, type_hint]` |

Other behaviour the tools rely on:

- A bare command sent while the game runs is silently ignored (`poll_events` hands it to
  the `core` capture, which doesn't know it). The debug state is created on the first
  debug tool call, so it may have missed a `debug_enter`; it then sends one
  `get_stack_dump` and treats a reply as "stopped" (reason inferred from the breakpoint
  list and the last recorded error, else `pause` for an empty stack).
- `core:` commands still work while stopped: the debug loop passes prefixed commands to
  their capture.
- Values are encoded with objects as ids; values whose encoding exceeds 1 MiB are sent as
  null; freed objects as null.
- A failed `Expression` (parse or execution) returns null and pushes an engine error whose
  description holds the reason; it is flushed on the debug loop's next iteration (~10 ms
  after `evaluation_return`).

## Limits

- Process runs only (see above). One stopped thread is tracked at a time (the latest
  `debug_enter`); commands while stopped go to that thread.
- When the debug state is created after the game already stopped (first debug call), the
  stop reason is inferred, and `can_step` is assumed true unless it matches a recorded error.
- A breakpoint hit before the runtime autoload says hello (e.g. in a `_ready` that runs on
  the first frame) makes `godot_run_start` wait its full 10 s for the hello before it
  returns (`runtime: false`); the debug tools work regardless.
- The GDScript `breakpoint` keyword counts as an *error* break in 4.7.2
  (`is_error_breakpoint = error != "Breakpoint"` in `GDScriptLanguage::debug_break`), so
  it only stops process runs started with `break_on_errors: true`.
- Only GDScript breakpoints (C# uses its own debugger).
