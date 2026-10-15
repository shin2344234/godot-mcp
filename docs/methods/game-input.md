# Methods: input, timing and input recording (step 3)

Tools that drive the **running game**: send input, pause/step/slow it down, wait for things
to happen, and record/replay input. They work on games started with `godot_run_start`
(process runs, headless or windowed) and on games started from the editor (through the
plugin's relay); see [runtime-protocol.md](../runtime-protocol.md) for the channel.

MCP tools (`server/src/ops/gameInput.ts`): `godot_game_input`, `godot_game_time`,
`godot_game_record`. Runtime methods (`addons/godot_mcp/runtime/ops/rt_input.gd`):
`input.run`, `time.state`, `time.step_wait`, `time.wait_for`, `record.start`,
`record.stop`, `record.replay`. Every tool takes an optional `run_id` (default: the newest
process run, else the editor's game) and returns it. Everything here was verified against
the Godot 4.7.2 source (tag `4.7.2-stable`) and a 4.7.2 binary.

## Coordinates

Positions are **viewport pixels**: the coordinates nodes see in `event.position` and
`get_viewport().get_mouse_position()` (for a Control without a camera, the same as
`get_global_rect()`). Write them as `[x, y]`, or give a **node path** instead:

| Node | Position used |
|---|---|
| Control | center of its rect (`get_global_transform_with_canvas() * size / 2`); hidden Controls are refused |
| Node2D | its origin on screen (`get_global_transform_with_canvas().origin`, so Camera2D is applied) |
| Node3D | `Camera3D.unproject_position(global_position)` with the viewport's current camera; behind the camera is refused |

The runtime converts to window pixels with `root.get_final_transform()` (stretch mode and
content scale) before sending, because `Input.parse_input_event` expects window
coordinates and `Viewport._make_input_local` applies the inverse. Results include
`viewport: [w, h]`; a node outside it, or inside a SubViewport, gets a `note`.

**Mouse position in a window.** In a windowed game `Viewport.get_mouse_position()` is not
taken from events: Godot computes it from the real OS pointer
(`DisplayServer.mouse_get_position()`, `scene/main/viewport.cpp`). So before every injected
mouse event the runtime also warps the OS pointer to the event position
(`Input.warp_mouse`, window pixels); a game that aims with `get_mouse_position()` then sees
the click position. It is skipped headless (no `FEATURE_MOUSE`; there the viewport already
uses the last event position) and in `MOUSE_MODE_CAPTURED`. Side effects: the user's real
pointer moves over a windowed game, and the OS reports the warp back, so the game may see
one extra `InputEventMouseMotion` at the same position (a recording captures it too). When
`get_mouse_position()` still disagrees after a `move`/`click` (the OS refused the warp, e.g.
an unfocused window on Windows), the step carries `mouse_position` and a `warning`.

**Headless runs** start with a 64x64 root window (`DisplayServerHeadless` reports no window
size), so anchored UI is squashed and nothing past 64 px can be clicked. The first input
call (or replay) sets the root viewport to the project's window size
(`display/window/size/viewport_width/height`, default 1152x648) and says so in `warnings`.

## godot_game_input → `input.run`

params: `{ "steps": [step, ...] }` (1..200 steps, run in order). All steps are validated
before the first one runs. Step fields:

| type | fields | what it does |
|---|---|---|
| `key` | `key` ("Space", "A", "Left", "Escape", "F1", "Ctrl+S"), `phase`, `ms` | key with keycode, physical keycode and key label set (project input maps usually bind physical keys); printable keys carry `unicode`; `Ctrl+S` presses Ctrl, then S, releases in reverse |
| `action` | `action`, `phase`, `value` (strength 0..1), `ms` | `InputEventAction`: updates `Input.is_action_*` and reaches `_input`/`_unhandled_input` |
| `move` | `at` | mouse motion; reports `hovered` |
| `click` | `at`, `button` (left/right/middle/x1/x2), `double`, `phase`, `ms` | hover, then press/release; reports `hit` (the Control under the cursor, `Viewport.gui_get_hovered_control()`), `handled` (`Viewport.is_input_handled()` after the press) and, for node targets, `hit_target` (false when something else, e.g. an overlay, got it) |
| `drag` | `at`, `to`, `button`, `ms` (default 300), `steps` (default 10) | press, `steps` motions with the button held, release; reports `hit` and `released_on` |
| `scroll` | `at`?, `button` (up/down/left/right, default down), `value` (clicks, default 1) | wheel press+release per click |
| `text` | `text` | types into the focused Control: one key event per character with `unicode` (ASCII letters/digits/space also get a keycode); `\n` = Enter, `\t` = Tab. Reports `focus` and the control's `text`; warns when nothing has focus (click the field first) |
| `joy_button` | `button` (a, b, x, y, back, guide, start, left_stick, right_stick, left_shoulder, right_shoulder, dpad_up/down/left/right, or 0-127), `device`, `phase`, `ms` | `InputEventJoypadButton` |
| `joy_axis` | `axis` (left_x, left_y, right_x, right_y, trigger_left, trigger_right, or a number), `value` (-1..1), `device`, `ms` | sets the axis; with `ms`, holds it that long and returns it to 0 |
| `touch` | `at`, `to`?, `device` (finger index), `phase`, `ms`, `steps` | screen touch tap, or a drag with `to`. By default Godot also emulates a mouse click from it (`input_devices/pointing/emulate_mouse_from_touch`) |
| `wait` | `ms` and/or `frames` | real-time wait (max 120 s) / process frames |

**Paused game.** While the game is suspended (`godot_game_time pause`), Godot disables the
root viewport's input and no node processes, so events are **dropped, not queued**: stepping
frames afterwards does not apply them. The result then has `"discarded": true` and a warning
saying so (also for `record.replay`). Resume first, then send the input.

**Breakpoints.** When a step makes the game stop in the debugger (a breakpoint in an input
handler, a script error with `break_on_errors`, a debugger pause), the call returns at once
with `{ "completed": false, "stopped": { "reason", "at": { "file", "line", "function" }, "error"? }, "note" }`
instead of waiting for its timeout; the remaining steps run after the game resumes
(`godot_debug_control continue`). This holds for every runtime call (`server/src/game/runtime.ts`,
`GameStoppedError`); games started from the editor report `reason: "debugger"` (the editor's
debugger holds the details). Calls made while the game is already stopped wait at most 3 s:
synchronous ones (`godot_game_tree`, `godot_game_get`) still answer from Godot's debug loop,
ones that need frames can't until it resumes.

`phase`: `tap` (default: press, hold, release), `press` or `release` (keep a key or button
held across steps, e.g. `press move_right`, `wait 500`, `release move_right`). `ms` on a tap
is the hold time. Waits and holds are **real time** (a `SceneTreeTimer` with
`ignore_time_scale`), so they don't stretch under `speed` or freeze while paused.

Result: `{ "steps": [{ "type", ...per-type fields }], "elapsed_ms", "frames", "viewport", "warnings"? }`.
An error names the failing step (`steps[2] (click): No node at 'Nope' ...`) and lists the
completed steps in `data.completed`. An unknown action lists the project's actions.

### How events reach the game (4.7.2)

`Input.parse_input_event(ev)` updates the Input singleton (action states, pressed keys,
mouse position, touch↔mouse emulation) and buffers the event (`use_accumulated_input` is on
by default); the runtime then calls `Input.flush_buffered_events()`, so the event is
delivered before the step continues and `hit`/`handled` describe *this* event. Delivery goes
`DisplayServer` event dispatch → main `Window._window_input` → `window_input` signal →
`Viewport.push_input`: `_input`, GUI (`_gui_input`, button signals), `_shortcut_input`,
`_unhandled_key_input`, `_unhandled_input`, then physics picking. The headless
DisplayServer wires the same dispatch (`display_server_headless.cpp`), so all of this works
in `--headless` runs. `Viewport.push_input` alone would skip the Input singleton (no
`is_action_pressed`, no emulation), so it is not used.

Timing: events are only sent right after `await get_tree().process_frame`. That signal is
emitted at the start of `SceneTree.process()`, before nodes' `_process()`, so
`Input.is_action_just_pressed()` is true in that frame's `_process()` and in the next physics
tick, like a real key press. Requests themselves are handled in the debugger poll at the
*end* of a frame, right before `Engine.get_process_frames()` increments, so sending there
would make games miss "just pressed". A tap holds the input until at least one physics tick
and one process frame have run, so both `_process` and `_physics_process` polling see it.
Mouse events also carry the modifier keys currently held (a `press Shift` step + `click` is
a shift-click).

## godot_game_time

`action`:

| action | how | result |
|---|---|---|
| `state` | runtime `time.state` | `suspended`, `tree_paused`, `speed`, `game_time_scale`, `effective_time_scale`, `frames`, `physics_frames` |
| `pause` / `resume` | Godot's `scene:suspend_changed [bool]` | state |
| `step` | `scene:next_frame` + runtime `time.step_wait`, `frames` times (default 1, max 300) | `stepped`, `paused_first`?, state |
| `speed` | `scene:speed_changed [scale]` (0.01..100) | state |
| `wait_for` | runtime `time.wait_for` | `elapsed_ms`, `frames`, plus `args` / `value` / `node` |

**pause = suspend, not `SceneTree.paused`.** `scene:suspend_changed` calls
`SceneTree.set_suspend()`, the editor's Pause button: no node processes (whatever its
`process_mode`, so pause menus and `PROCESS_MODE_ALWAYS` nodes stop too), physics stops,
`Engine.time_scale` is frozen (reads 0) and input is disabled. `SceneTree.paused` is game
state: the game's own pause menu sets and reads it, so changing it would fight the game and
resuming could unpause a game the player had paused. Suspension leaves it alone (reported
as `tree_paused`) and is the only one Godot can step frame by frame. Notes: the game cannot
change `SceneTree.paused` while suspended (Godot logs "Pause state cannot be modified while
suspended"); input sent while suspended is accepted but nodes don't process it (the tool
adds a warning); the runtime keeps answering (it uses the debugger message capture and
`process_frame`, which keep running), so `wait_for frames` and reads work while paused.
`suspended` comes from the runtime node's `can_process()` (it is `PROCESS_MODE_ALWAYS`, so
only suspension stops it); `SceneTree.is_suspended()` is not exposed to GDScript.

Process runs: before suspending/resuming, the server sends
`scene:runtime_node_select_set_type [0]` (NONE). SceneDebugger recomputes the input state on
every suspend change as "disabled if suspended **or** node select type != NONE", and that
type defaults to 2D; only the editor's Game view sets it. Without this, the first resume in
a game we launched left the root viewport's input disabled for good (verified: clicks
stopped reaching Controls). Editor runs keep the mode chosen in the Game view (its Pause
button also stays unaware of an MCP pause).

**step**: if the game is running it is paused first (`paused_first: true`). Godot's
`scene:next_frame` un-suspends and re-suspends on `RenderingServer.frame_post_draw`. A
headless game never draws (`DisplayServerHeadless.can_any_window_draw()` is false, so
`Main::iteration` skips `RenderingServer.draw`) and would never be suspended again, so in
headless runs `time.step_wait` adds an internal helper node that runs last in the next
frame's `_process` (highest `process_priority`) and calls `RenderingServer.force_draw()`,
which emits `frame_post_draw`. Verified: N steps advance `_process` exactly N times, headless
and windowed (Xvfb).

**speed** sets Godot's *user* time scale (`Engine.set_user_time_scale`, the editor's speed
menu), which multiplies the game's own `Engine.time_scale` and also scales physics ticks per
second. GDScript can't read the user scale, so `speed` is the last value set through MCP for
this game (1 by default) and `effective_time_scale = game_time_scale × speed` (0 while
suspended).

**wait_for** (one of, checked once per process frame; `timeout_ms` default 10000, real time):

- `node`: until a node exists at that path (returns its `node` path and `type`);
- `signal` (+ `node` = emitter, default the scene root): until it is emitted; returns `args`
  encoded like other runtime values. An unknown signal lists the node's signals;
- `condition` (+ `node` = base, default the scene root): a Godot `Expression` evaluated on
  the base node until truthy; returns `value`. Executed with `const_calls_only = true`:
  properties and const methods (`get_node('Player').position.x > 300`, `is_visible()`)
  work, calls that change state (`queue_free()`) fail; engine singletons are not reachable
  from an Expression. A parse error or a failure on the first evaluation is reported at once;
  later failures (e.g. the node despawned) keep waiting and are shown on timeout. Tip: a
  one-element array is always truthy, so `condition: "[get_node('Player').health]"` reads a
  value immediately;
- `frames`: N process frames;
- `seconds`: N seconds of **game time** (a `SceneTreeTimer` that counts while
  `SceneTree.paused`, scales with the time scale and stops while suspended).

The wait is a coroutine in the runtime: other requests (input, reads) are served while it
waits, so an agent can start a wait and then trigger the event. Timeouts return `TIMEOUT`
saying what didn't happen (and that the game is paused, if it is). The server's reply
timeout is `timeout_ms` + 5 s.

## godot_game_record

| action | params | result |
|---|---|---|
| `start` | — | `{recording: true, viewport}`; `CONFLICT` if already recording |
| `stop` | `path`? (`user://` or `res://`) | `{event_count, duration_ms, recording}`; with `path`, the file is written and `{path, absolute_path}` returned instead of the inline recording |
| `replay` | `recording` (object from stop) or `path`; `speed`? (default 1) | `{replayed, elapsed_ms, frames, skipped?, warnings?}` when the replay has finished |

Recording connects to the root `Window.window_input` signal, which is emitted for every
event the main window receives from the DisplayServer, before the viewport handles it: real
devices and injected events (`godot_game_input`, replays) alike, in window pixels. Events
Godot synthesizes from others (touch↔mouse emulation, `device == DEVICE_ID_EMULATION`) are
skipped because replaying the original synthesizes them again. Up to 20000 events are kept.

Format (compact JSON, version 1):

```json
{"version": 1, "duration_ms": 1830, "viewport": [1152, 648], "window": [1152, 648],
 "events": [
   {"t": 41, "e": "key", "key": "Space", "p": true, "u": 32},
   {"t": 158, "e": "mm", "x": 160, "y": 120, "rx": 4, "ry": 0},
   {"t": 165, "e": "mb", "b": 1, "p": true, "x": 160, "y": 120},
   {"t": 900, "e": "act", "a": "jump", "p": true}
 ]}
```

`t` = ms since start (real time); `e` = kind: `key` (`key` = keycode with modifiers like
"Ctrl+S", `phys` when the physical key differs, `u` unicode, `echo`), `mb` (mouse button `b`,
`dbl`, wheel `f`actor), `mm` (motion, `m` = button mask), `act` (action `a`, strength `s`),
`jb`/`jm` (joypad button/axis, device `d`), `st`/`sd` (touch/drag, finger `i`), `mag`/`pan`
(gestures); `p` = pressed, `x`/`y` window pixels, `mods` = held modifiers. Replay waits
until each event's `t / speed` (real time, checked every frame), then sends it with
`Input.parse_input_event` + `flush_buffered_events`. Positions are not rescaled when the
window size differs from the recording (a warning says so).

## Recording video: godot_run_start `write_movie`

Movie capture is Godot's Movie Maker, already exposed as `godot_run_start` `write_movie`
(process mode): `{ "mode": "process", "headless": false, "write_movie": "user://capture.avi",
"quit_after_frames": 600 }` (`.avi` = MJPEG + WAV audio, `.png` = numbered image sequence;
a relative or absolute path works too). Movie Maker renders at a fixed 60 FPS
(`editor/movie_writer/fps`) regardless of real speed.

- It needs a window (headless renders nothing). On a server without a display, run the MCP
  server (or the test) under Xvfb: `xvfb-run -a -s "-screen 0 1280x720x24" ...`. Verified in
  this container with Mesa llvmpipe: a `gl_compatibility` project records directly; a
  Forward+ project logs Vulkan errors and Godot falls back to OpenGL 3 by itself
  (`rendering/rendering_device/fallback_to_opengl3`, on by default), so no extra flag is
  needed. Pass `--rendering-driver opengl3` only if a project disabled that fallback.
- **Let the game quit by itself** (`quit_after_frames`, or the game calling
  `get_tree().quit()`): Godot writes the AVI header/index when it shuts down ("Done
  recording movie at path ..." in `godot_run_output`). `godot_run_stop` kills the process, and
  the file is then left unfinalized (verified: no "Done recording", unplayable AVI).
- Combine with input: start the run with `write_movie` + `quit_after_frames`, drive it with
  `godot_game_input` / `godot_game_record` replay while it records, then read the file.
