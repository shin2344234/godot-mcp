# Methods: screenshots and performance (step 3)

MCP tools `godot_game_screenshot` and `godot_game_perf` (`server/src/ops/gameView.ts`, group
`game`). Game-side work is done by runtime methods in
`addons/godot_mcp/runtime/ops/rt_view.gd` (over the runtime channel,
[runtime-protocol.md](../runtime-protocol.md)); editor viewport screenshots by the bridge method
`editor.screenshot` in `addons/godot_mcp/ops/editor_view_ops.gd` (**(E)**, editor only). Both
tools take an optional `run_id`: the given process run, `"editor"` for the game the editor
plays, or by default the newest process run, else the editor's game.

Godot facts below were checked against the 4.7.2 sources (tag `4.7.2-stable`) and a real
4.7.2 binary (games and a windowed editor under Xvfb with Mesa llvmpipe, Compatibility
renderer).

## godot_game_screenshot

Tool params: `{ run_id?, source?: "game" | "editor_2d" | "editor_3d", node?, region?: {x, y, w, h},
max_size?: 768, format?: "png" | "jpg", quality?: 0.85, save_to?, compare_to?, tolerance?: 16 }`

Returns the picture as an MCP **image content block** (PNG or JPEG) after a small JSON summary:

```json
{ "run_id": "3f2a91c0", "width": 768, "height": 432, "scale": 0.6667,
  "source": { "viewport": "main window", "width": 1152, "height": 648,
              "game_size": [640, 360] },                     // only with a stretch mode
  "bytes": 2563, "frame": 812,
  "region": { "x": 100, "y": 100, "w": 200, "h": 100 },        // when given (clipped) or framed
  "framed": "Player",                                        // with a node to frame
  "saved_to": "user://shots/ref.png", "saved_size": [1152, 648], // with save_to
  "diff": { ... } }                                          // with compare_to
```

What is captured (`source: "game"`, runtime method `game.screenshot`):

- default: the main window (`get_tree().root`, a `Window`, i.e. a `Viewport`);
- `node`: a `Viewport` (`SubViewport`, `Window`), a `SubViewportContainer` (its first
  `SubViewport` child) or a `Camera2D`/`Camera3D` (the whole viewport it renders into) is
  captured whole. **Any other node is framed**: the capture is cropped to its on-screen
  bounding rect plus 8 px of padding (game coordinates) in the viewport it is drawn in, and
  `framed` names it. Paths are relative to the current scene, or `/root/...`. What the rect is:
  - Control: its rect (`get_global_transform_with_canvas()` × size); hidden ones are refused;
  - 2D node: the union of the visible things with a size in it and below it: CanvasItems with
    `get_rect()` (Sprite2D, AnimatedSprite2D...), CollisionShape2D shapes (`Shape2D.get_rect()`),
    Polygon2D / CollisionPolygon2D points and Controls, each through its own canvas transform
    (Camera2D, CanvasLayers applied). So a CharacterBody2D `Player` frames its sprite and shape;
  - 3D node: the AABBs of its VisualInstance3D nodes (meshes, sprites) projected through the
    viewport's current Camera3D;
  - anything else (a plain `Node`, a 2D node with nothing visible below it, a node off screen)
    is a `BAD_PARAMS` error naming what can be framed. Earlier versions silently returned the
    whole window for such nodes (`node: "Player"` looked like a capture of the player).
  At most 500 nodes are looked at below the framed one. `node` (to frame) and `region` can't
  be combined.
- `region`: a crop in pixels of that viewport's image (before scaling); clipped to the image,
  `BAD_PARAMS` with the image size when it misses it entirely.

**Image pixels vs game coordinates.** `region`, `changed_rect`, `width`/`height` and
`source.width/height` are pixels of the captured image. Without a stretch mode these equal the
game's coordinates (what `godot_game_input` `at`, `godot_game_tree` rects and node positions
use). With one they differ: a 640x360 game in a 1280x720 window with stretch mode
`canvas_items` is captured at 1280x720 (the root viewport's texture is window-sized; with mode
`viewport` it is game-sized, 640x360). The result then says `source.game_size: [640, 360]`,
and `godot_game_input` results say `window: [1280, 720]` next to `viewport`. Framing a node
converts for you: a window-sized image uses the root's `get_final_transform()` (the stretch,
including a letterbox offset), anything else the size ratio (verified with 4.7.2 under Xvfb:
a Sprite2D at game rect (195, 198.75, 40x40) under a 1.25x Camera2D framed as image region
(373, 381, 113x113)). `region` stays in image pixels because it is an exact crop of the
returned picture and `changed_rect` can be passed back as `region` unchanged.

How:

- The runtime waits for the next drawn frame (`RenderingServer.frame_post_draw`, at most 0.5 s,
  so low-processor mode or a hidden window can't hang the call), then reads
  `Viewport.get_texture().get_image()`. A `SubViewport` whose `render_target_update_mode` isn't
  `UPDATE_ALWAYS` is set to `UPDATE_ONCE` for that frame and restored afterwards.
- The image is converted to RGBA8; HDR 2D viewports on RenderingDevice renderers get
  `linear_to_srgb()`, as Godot's own debugger screenshot does
  (`scene/debugger/scene_debugger.cpp`, `_msg_rq_screenshot`).
- Scaling: if the longest side exceeds `max_size` (16..4096, default 768) the image is resized
  with Lanczos so it fits; it is never scaled up. `scale` = returned / source.
- Encoding: `Image.save_png_to_buffer()` or `save_jpg_to_buffer(quality)`, base64 in the JSON
  reply, moved into an image block by the server. Payload limit: the encoded image must be at
  most 5 MiB (base64 ≈ 6.7 MiB), because debugger packets (`RemoteDebuggerPeerTCP`, 8 MiB) and
  bridge frames (8 MiB outbound buffer) are capped; above that the error suggests a smaller
  `max_size`, a `region` or `"jpg"`.

**Headless games render nothing.** When `DisplayServer.get_name() == "headless"` the call fails
with `UNSUPPORTED` telling the agent to restart with `godot_run_start headless:false` (needs a
display: on Linux `DISPLAY`/`WAYLAND_DISPLAY`, e.g. Xvfb). `godot_game_perf` still works there.

### save_to / compare_to

- `save_to`: a `user://` or `res://` path ending in `.png`, `.jpg` or `.jpeg`; folders are
  created. The **full-resolution** (cropped, unscaled) image is saved, so the file is useful by
  itself; `saved_size` gives its size (`width`/`height` describe the returned preview, which
  `max_size` may have scaled down). `user://` is the safe choice in a running game; in the editor, a `res://` file is
  registered with the FileSystem dock (`EditorFileSystem.update_file`).
- `compare_to`: a previously saved image (same path rules). It is read as raw bytes
  (`FileAccess` + `Image.load_png_from_buffer` / `load_jpg_from_buffer`), not through the
  importer, so a file the game just wrote works and Godot logs no "loaded resource as image
  file" warning. If its size differs from the returned image, it is resized to it with the same
  Lanczos filter (so a full-size reference and a scaled capture of the same frame compare as
  identical; verified). The comparison runs on the **full-resolution** capture (cropped to
  `region`), not on the scaled preview, so `max_size` changes only what is returned, never the
  diff's precision. Captures over 1920×1080 pixels are reduced to that pixel count for the
  diff (`compared_size` shows the size actually compared).
- A pixel is "changed" when any RGBA channel differs by more than `tolerance` (0..255,
  default 16; JPEG references need a higher value). Result:

```json
"diff": { "reference": "user://shots/ref.png", "changed_percent": 1.34, "changed_pixels": 4437,
          "compared_size": [768, 432], "tolerance": 16,
          "changed_rect": { "x": 600, "y": 300, "w": 100, "h": 100 },
          "reference_size": [1152, 648], "note": "The reference had a different size ..." }
```

`changed_rect` is the bounding box of changed pixels in **source viewport pixels** (scale and
region offset undone, rounded outwards), so it can be passed back as `region` to look closer;
`null` when nothing changed. Cost: a GDScript loop over the RGBA bytes, about 120 ms for
768×432 on the test machine, so roughly 0.3 s for a 1280×720 capture and 0.6 s for 1080p.

### Editor viewports (`source: "editor_2d" | "editor_3d"`)

Bridge method `editor.screenshot` (E), params
`{ "view": "2d" | "3d", "viewport"?: 0, region?, max_size?, format?, quality?, save_to?, compare_to?, tolerance? }`
(the tool always uses 3D viewport 0; `viewport` 0..3 picks a split view over the bridge).

- `EditorInterface.get_editor_viewport_2d()` returns the edited scene's `SubViewport` (no
  camera; the 2D editor's pan/zoom is its `global_canvas_transform`), and
  `get_editor_viewport_3d(idx)` one of the four 3D editor `SubViewport`s
  (`editor/editor_interface.cpp`). The 2D image shows the scene content as panned/zoomed in the
  editor, without the editor's grid and gizmo overlays (those are drawn by other controls).
- A viewport inside a hidden main screen isn't drawn. Module methods run synchronously in the
  editor backend (it does not await them), so the method can't wait for frames: when the
  viewport's container isn't visible it calls `EditorInterface.set_main_screen_editor("2D" | "3D")`
  and answers `{ "retry_after_ms": 300, "switched_main_screen": "3D" }`; the server waits and
  asks again, up to 6 times (about 1.8 s; a slow software renderer can need more than one
  frame after the switch), sending `_retried: true` on the last attempt so the addon then
  fails with `CONFLICT` instead of switching again. The tool result carries
  `switched_main_screen`.
- The screen the user had open is put back right after the capture (and also when the call
  gives up with `CONFLICT`), and the result says `restored_main_screen`. EditorInterface has
  no getter for the current main screen, so the addon reads it from the title bar's screen
  buttons: toggle `Button`s named after the plugin, theme type variation `MainScreenButton`,
  only the selected one pressed (`EditorMainScreen::add_main_plugin` / `select`,
  `editor/editor_main_screen.cpp`, 4.7.2). The retry answer carries `previous_main_screen`,
  which the server sends back as `_restore`.
- A headless editor (`--headless`) renders nothing: `UNSUPPORTED` with a hint to use a windowed
  editor or a windowed game. Without a connected editor: `EDITOR_NOT_CONNECTED`.
- `node` is rejected with editor sources.

## godot_game_perf

Tool params: `{ run_id?, sample_seconds?: 0.1..30, profile_scripts_seconds?: 0.5..30, top?: 15, monitors?: bool }`

### Snapshot

Included by default only when neither `sample_seconds` nor `profile_scripts_seconds` is given
(a sampling/profiling call returns just `"fps"` in its place, so repeated measurements don't
repeat ~40 monitor values); `monitors: true` asks for both, `false` leaves it out.

Runtime method `game.perf`, reading `Performance.get_monitor()` for the 4.7.2 monitor list
(`doc/classes/Performance.xml`, `MONITOR_MAX` = 59) in readable units:

```json
"monitors": {
  "time": { "fps": 60, "process_ms": 0.41, "physics_ms": 0.05, "navigation_ms": 0 },
  "memory": { "static_mib": 38.2, "static_max_mib": 41.0, "message_buffer_max_mib": 0.06 },
  "objects": { "objects": 1450, "resources": 120, "nodes": 14, "orphan_nodes": 0 },
  "render": { "objects_in_frame": 4, "primitives_in_frame": 8, "draw_calls_in_frame": 4,
              "video_mem_mib": 12.5, "texture_mem_mib": 4.1, "buffer_mem_mib": 0.3 },
  "pipeline_compilations": { "canvas": 0, "mesh": 0, "surface": 0, "draw": 0, "specialization": 0 },
  "audio": { "output_latency_ms": 15 },
  "engine": { "frames_drawn": 912, "max_fps": 0, "physics_ticks_per_second": 60, "time_scale": 1,
              "vsync": "enabled", "display": "X11", "rendering_method": "gl_compatibility" },
  "physics_2d": {...}, "physics_3d": {...}, "navigation_2d": {...}, "navigation_3d": {...},
  "custom": { "game/enemies": 12 }
}
```

`TIME_FPS` is updated once a second by Godot; `TIME_PROCESS` / `TIME_PHYSICS_PROCESS` are the
last frame's step times. Physics and navigation groups are left out while all their values
are zero and have never been non-zero in this game; once a group has shown up it stays in every
later snapshot (physics counts such as active objects and collision pairs drop to 0 whenever
everything sleeps, and a group that came and went between calls looked like a bug). Custom monitors (`Performance.add_custom_monitor`) appear under `custom` (non-numbers as
`null`). Static memory monitors are 0 in release builds.

### Sampling (`sample_seconds`)

The runtime awaits `SceneTree.process_frame` every frame for that long (it runs with
`PROCESS_MODE_ALWAYS`, so this also works while the tree is paused) and records the wall-clock
interval between frames (`Time.get_ticks_usec`), `TIME_PROCESS`, `TIME_PHYSICS_PROCESS` and
`RENDER_TOTAL_DRAW_CALLS_IN_FRAME`. Statistics are computed in the game, so the reply stays
small however many frames were recorded (at most 200000):

```json
"sample": { "seconds": 1.001, "frames": 60, "avg_fps": 59.9,
  "frame_ms":   { "min": 15.9, "avg": 16.7, "median": 16.6, "p95": 17.4, "max": 41.2 },
  "process_ms": {...}, "physics_ms": {...}, "draw_calls": {...},
  "delta": { "objects": 0, "nodes": 0, "orphan_nodes": 0, "static_memory_mib": 0.01 },
  "spike_threshold_ms": 33.2, "spike_count": 1,
  "spikes": [{ "t_ms": 512.3, "frame": 1290, "frame_ms": 41.2, "process_ms": 24.0, "physics_ms": 0.1 }] }
```

A **spike** is a frame whose interval is at least twice the median and at least 4 ms above it
(the absolute margin keeps jitter on very fast frames from counting). Up to 10 of the worst are
listed in time order; `t_ms` is milliseconds since sampling started, `frame` is
`Engine.get_process_frames()`. Percentiles are nearest-rank. `delta` shows how counts moved
during the sample (a steadily growing `orphan_nodes` or `objects` hints at a leak).

### Script profiler (`profile_scripts_seconds`, process runs only)

Godot's script function profiler is part of the `"servers"` `EngineProfiler`
(`servers/debugger/servers_debugger.cpp`). The server (the game's debugger in process runs)
sends the native command `profiler:servers [true, [128, false]]` (max functions per frame, no
native calls; the same message the editor's Profiler tab sends,
`editor/debugger/script_editor_debugger.cpp`), waits, then sends `profiler:servers [false]`.
Enabling resets the language counters (`ScriptLanguage::profiling_start`); disabling makes the
game send one `servers:profile_total` with the counters accumulated since then (top functions by
total time), with `servers:function_signature [name, id]` messages naming them and a
`servers:profile_frame` per frame meanwhile (counted for `frames` and `script_ms_per_frame`).
Parsing: `server/src/game/scriptProfiler.ts` (`ServersProfilerFrame::serialize()` layout,
times in seconds). Result:

```json
"scripts": { "seconds": 1.0, "frames": 89, "script_ms_per_frame": 0.235,
  "functions": [
    { "function": "heavy_work", "file": "res://view_test.gd", "line": 9, "body_line": 10, "calls": 89, "self_ms": 13.47, "total_ms": 13.47 },
    { "function": "_process", "file": "res://view_test.gd", "line": 3, "body_line": 4, "calls": 89, "self_ms": 3.76, "total_ms": 17.62 } ] }
```

Sorted by self time, `top` entries (1..50). GDScript signatures are `path::line::name`, where
Godot's `line` is the **first line of the function's body** (verified: a `func` on line 9
reports 10). The server reads the script (inside the project, `.gd` only) and reports the
`func` declaration line instead, like `godot_code_symbols` does, with Godot's body line as
`body_line`; when the declaration can't be found (lambdas, a changed file) Godot's line stays.
Functions with no calls during the window and the addon's own scripts (`res://addons/godot_mcp/`,
i.e. the runtime answering requests) are left out; `script_ms_per_frame` comes from Godot's
per-frame totals and still includes them. Snapshot, sampling and profiling run concurrently, so
the call takes the longer of `sample_seconds` and `profile_scripts_seconds`; on cancellation
the profiler is turned off again.

**Why process runs only (the choice made here):** the profiler counters are only reachable
through the native debugger messages; GDScript has no API to read them, so the runtime can't
measure script functions itself (measuring from GDScript would only see the frame, not the
functions). In an editor run the game talks to the editor's debugger, whose
`ScriptEditorDebugger` consumes the `servers:*` replies and shows them in its own Profiler tab;
our relay plugin only forwards `mcp:*` messages. So in editor runs `profile_scripts_seconds` fails
with `UNSUPPORTED` (suggesting a process run or the editor's Profiler), while the snapshot and
sampling, which are measured inside the game, work in both run kinds.

The once-a-second `performance:profile_frame` message every debug game sends is not used: it
carries the same monitor values the runtime reads directly, and isn't available to the server
for editor runs.

## Limits

- Screenshots need a rendering game or editor (not `--headless`). Under Xvfb use the
  Compatibility renderer (`renderer/rendering_method="gl_compatibility"`): llvmpipe has OpenGL
  but no Vulkan.
- Editor screenshots: one retry after switching the main screen; a hidden 3D split view
  (`viewport` 1..3 with a single-view layout) answers `CONFLICT`.
- `compare_to` diffs whole images at the returned size; it does not align moved content, and
  large `max_size` values make it slower (GDScript loop).
- The script profiler needs a debug build of the game (the editor binary or a debug export
  template), as GDScript only collects profiling data with `DEBUG_ENABLED`.
