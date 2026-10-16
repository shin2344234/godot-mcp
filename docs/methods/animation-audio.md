# Methods: animation and audio (step 2)

Bridge-protocol methods of the `anim` and `audio` groups, in the style of
[bridge-protocol.md](../bridge-protocol.md) section 5. Values follow section 3
(value codec) and node paths section 4. **(E/H)** = editor and headless.

GDScript: `addons/godot_mcp/ops/anim_ops.gd` (AnimationPlayer, registration),
`addons/godot_mcp/core/anim_tree_ops.gd` (AnimationTree),
`addons/godot_mcp/core/sprite_frames_ops.gd` (SpriteFrames), `addons/godot_mcp/ops/audio_ops.gd`.
TypeScript: `server/src/ops/animation.ts`, `server/src/ops/audio.ts`.

| Method | Kind | MCP tool |
|---|---|---|
| `anim.read` | scene_read | `godot_anim_read` |
| `anim.read_library` | project | `godot_anim_read` with `library` |
| `anim.edit` | scene_mutation | `godot_anim_edit` |
| `anim.tree_read` | scene_read | `godot_anim_tree_read` |
| `anim.tree` | scene_mutation | `godot_anim_tree` |
| `anim.frames_read` | scene_read | `godot_anim_frames` without `ops` |
| `anim.frames` | scene_mutation | `godot_anim_frames` with `ops` |
| `anim.frames_file` | project | `godot_anim_frames` with `path` (a .tres) |
| `audio.buses` | project | `godot_audio_buses` |
| `audio.edit` | project | `godot_audio_edit` |

Common rules:

* `player` / `tree` are node paths. When omitted, the scene's only AnimationPlayer /
  AnimationTree is used; with several, the error lists them.
* Animation names are `"name"` for the default library `""` and `"library/name"`
  otherwise. Godot rejects `/ : , [` in animation and library names.
* Edit methods take `ops`, an array applied in order. Everything is validated before
  anything changes: one bad op fails the whole call and nothing is applied. In the
  editor the call is ONE undo step (`"MCP: anim.edit"` etc.).
* Times, lengths and steps in results are rounded to 0.1 ms (Godot stores them as
  32-bit floats).

### anim.read (E/H)

params: `{ "scene"?, "player"?, "animation"?: "walk", "max_keys"?: 50 }`

```json
{ "player": "AnimationPlayer", "root_node": "..", "autoplay": "idle",
  "libraries": [ { "name": "", "resource": null,
    "animations": [ { "name": "idle", "length": 1, "loop": "linear", "step": 0.0333, "track_count": 1 } ] } ],
  "animation": { "name": "idle", "length": 1, "loop": "linear", "step": 0.0333, "track_count": 1,
    "tracks": [ { "index": 0, "type": "value", "path": "Sprite2D:modulate", "interpolation": "linear",
      "update_mode": "continuous", "key_count": 2, "keys_truncated": true,
      "keys": [ { "time": 0, "value": "Color(1, 1, 1, 1)", "transition": 1 } ] } ] } }
```

* `animation` is only present when requested. `resource` is the .tres path of an external
  library, otherwise null.
* Track `type`: `value`, `position_3d`, `rotation_3d`, `scale_3d`, `blend_shape`, `method`,
  `bezier`, `audio`, `animation`. `interpolation` is reported for value/3D/blend-shape
  tracks, `update_mode` for value tracks, and `"enabled": false` only for disabled tracks.
* Key `value` encoding per track type: method `{method, args}`; bezier `{value, in_handle, out_handle}`;
  audio `{stream, start_offset, end_offset}`; animation the animation name; else the codec.

### anim.read_library (E/H)

params: `{ "library": "res://anim/moves.tres", "animation"? , "max_keys"? }`. Result:
`{ "library": path, "animations": [...], "animation"?: {...} }`, same shapes as anim.read.
An `Animation` .tres is accepted too (result has only `animation`). In the editor the
in-memory copy is read (unsaved edits included).

### anim.edit (E/H)

params: `{ "scene"?, "player"?, "animation"?: default for ops, "allow_missing"?: false, "ops": [...] }`

| op | fields | notes |
|---|---|---|
| `create` | animation, library?, length?, loop?, step? | creates the library (e.g. `""` or `"moves"`) when missing |
| `remove` | animation | clears `autoplay` if it named it |
| `rename` | animation, to | same library; `autoplay` follows; warns when the scene has AnimationTrees (they refer to names) |
| `set` | animation, length? (>= 0.001), loop? (`none`/`linear`/`pingpong`), step? | |
| `add_track` | animation, type (default `value`), path, interpolation?, update_mode? | path relative to the player's `root_node`; result has the new `track` index |
| `remove_track` | animation, track | later indices shift down |
| `insert_key` | animation, track, time, value, transition? (default 1) | a key at the same time is replaced (`"replaced": true`) |
| `remove_key` | animation, track, time or key | |

`track` is an index or a path (add `type` when one path has several tracks).

Track path validation (skipped with `allow_missing: true`): the node must exist relative to
`root_node` (did-you-mean on failure); value/bezier tracks need `Node:property` with an
existing property (bezier: a number); blend_shape needs a MeshInstance3D and a known shape;
position/rotation/scale_3d need a Node3D and no property; audio needs a node with
`stream`; animation needs an AnimationPlayer. Value tracks on bool/int/String/Object
properties default to `update_mode: discrete`, as in the editor.

Key values are decoded against the target property's type when the path resolves (any
section 3 form: `[1, 2]`, `"#ff0000"`, ...), else only literal forms are converted.
position/scale_3d: Vector3. rotation_3d: `[x, y, z]` Euler **degrees** or a quaternion
(`[x, y, z, w]`, `"Quaternion(...)"`). blend_shape: number. bezier: number or
`{value, in_handle?, out_handle?}`. method: `{"method": "name", "args": [...]}` (missing
method = warning only: non-tool scripts are placeholders in the editor). audio:
`"res://x.wav"` or `{stream, start_offset?, end_offset?}`. animation: an animation name
or `"[stop]"` (unknown name = warning).

Result: `{ "player", "results": [per-op result], "animations": [summary of every animation
after the edit], "warnings"?, "saved_resources"? }` plus `scene`/`saved` from the backend.

Undo design: the whole call is simulated during planning. Existing animations are edited
through a working copy and the ChangeSet does `anim.copy_from_resource(copy)` (undo:
`copy_from_resource(snapshot)`), so the live Animation keeps its identity (the editor's
track editor holds it) and undo is exact. Library changes are AnimationLibrary
`add_animation` / `remove_animation` / `rename_animation` calls with their inverses; new
libraries are added with `add_animation_library`. Headless the scene is packed, so the
embedded sub-resources land in the .tscn. Libraries/animations stored in their own .tres
are external: `finish` saves them (headless and editor) and lists them in `saved_resources`.

### anim.tree_read (E/H)

params: `{ "scene"?, "tree"?, "parameters"?: true }`

```json
{ "tree": "AnimationTree", "anim_player": "../AnimationPlayer", "active": true,
  "animations": ["idle", "walk"],
  "root": { "type": "state_machine", "start": ["Idle"],
    "states": [ { "name": "Idle", "position": [200, 100], "type": "animation", "animation": "idle" },
                { "name": "Move", "position": [560, 100], "type": "blend_space_1d", "node": { ... } } ],
    "transitions": [ { "from": "Start", "to": "Idle", "switch_mode": "immediate", "advance_mode": "auto",
                       "xfade_time": 0, "advance_condition"?: "moving", "advance_expression"?: "...", "priority"?: 3 } ] },
  "parameters": { "parameters/conditions/moving": false } }
```

Node types: `state_machine`, `blend_space_1d`, `blend_space_2d`, `blend_tree`, `animation`,
or the class name for other AnimationNodes. Blend spaces report `min_space`, `max_space`,
`snap`, labels, `blend_mode` (`interpolated`/`discrete`/`carry`) and
`points: [{index, name, position, type, animation | node}]` (2D adds `auto_triangles`,
`triangle_count`). Blend trees report `nodes` and `connections: [{from, to, input}]`.
Nested graphs are expanded 4 levels deep. Start/End are not listed as states.
`parameters` leaves out runtime-only times (current_*); runtime objects are listed by type, e.g. `"parameters/playback": {"object": "AnimationNodeStateMachinePlayback", "use": "$Tree.get(\"parameters/playback\").travel(\"<state>\")"}`.

### anim.tree (E/H)

params: `{ "scene"?, "tree"?, "nested"?: "Locomotion/Run", "allow_missing"?: false, "ops": [...] }`

`nested` walks states, blend tree nodes and blend points by name; the ops then apply to
that graph.

| op | applies to | fields |
|---|---|---|
| `set_root` | tree (not with `nested`) | type: state_machine, blend_space_1d, blend_space_2d, blend_tree |
| `add_state` | state machine, blend tree | name, animation, or type (nested graph or any AnimationNode class), position? |
| `remove_state` / `rename_state` | state machine, blend tree | name (, to) |
| `add_transition` | state machine | from, to, switch_mode?, advance_mode?, advance_condition?, advance_expression?, xfade_time? |
| `add_transition` | blend tree | connects `from` to input port `index` (default 0) of `to` (`"output"` = final output) |
| `remove_transition` | state machine: from, to; blend tree: to, index | |
| `set_start` | state machine | name: replaces the Start -> * transitions with Start -> name (advance auto) |
| `set_end` | state machine | name: adds name -> End (switch at_end, advance auto) |
| `add_blend_point` | blend space | animation or type, position (number / [x, y]), name? (default: the animation name, made unique) |
| `remove_blend_point` | blend space | name or index |
| `set` | any | properties on the graph itself (e.g. min_space, blend_mode, sync_mode, allow_transition_to_self); with from+to on a transition (transition fields also accepted directly); with name on a child node (also moves it with position) |

* Animation names are checked against the tree's own libraries and its `anim_player`'s
  (did-you-mean; `allow_missing` downgrades it to a warning).
* Transitions from Start or into End default to `advance_mode: auto`. `advance_expression`
  is parsed with Expression to catch typos.
* Removing a state also removes its transitions (`transitions_removed` in the result).

Result: `{ "tree", "results": [...], "graph": <the edited graph, 2 levels>, "warnings"? }`.

Undo design: the call deep-duplicates `tree_root` (`duplicate(true)` copies every embedded
node, transition and curve), applies the ops to the copy, and the ChangeSet swaps
`tree_root` (undo restores the original object). Side effect: tree parameters
(conditions, blend positions) reset to defaults, as after any root change in the inspector.

### anim.frames / anim.frames_read / anim.frames_file (E/H)

SpriteFrames: the flip-book animations of AnimatedSprite2D / AnimatedSprite3D. One MCP tool,
`godot_anim_frames`; the server picks the method: `path` (a SpriteFrames `.tres`) →
`anim.frames_file`; otherwise `node` in a scene → `anim.frames_read` (no `ops`) or
`anim.frames` (with `ops`).

params: `{ "scene"?, "node"?: "Hero", "path"?: "res://hero_frames.tres", "ops"?: [...] }`
(`node` and `path` exclude each other; `node` is optional when the scene has one animated sprite).

| op | fields | notes |
|---|---|---|
| `add` | animation, speed?, loop?, + the frame fields of `add_frames` | `CONFLICT` if it exists |
| `remove` | animation | the node's `autoplay` is cleared if it named it |
| `rename` | animation, to | the node's `animation` and `autoplay` follow |
| `set` | animation, speed? (FPS, >= 0), loop? (bool) | |
| `add_frames` | animation, texture, duration?, hframes?/vframes? or frame_size?, cells? or start?/count? | appends frames |
| `clear` | animation | removes all frames |

Frames: `texture` is a res:// texture or a list of them. Without a grid each texture is one
whole frame. With `hframes`/`vframes` (columns/rows) or `frame_size: [w, h]` the (single)
texture is a sprite sheet: each picked cell becomes an embedded `AtlasTexture` (atlas = the
sheet, region = the cell). `cells` lists row-major indices or `[column, row]` pairs;
`start` + `count` pick a range (default: every cell from `start`). `duration` is the
relative frame length (1 = one tick at `speed` FPS). A sheet that is not a whole number of
cells gives a warning (leftover pixels unused).

Result (all three): the summary
`{ "node", "resource": ".tres path or null", "animation", "autoplay", "animations": [...] }`
(`anim.frames_file`: `{ "path", "animations" }`), plus `results` (per op) for edits:

```json
{ "name": "walk", "speed": 12, "loop": true, "frame_count": 4,
  "atlas": "res://hero.png", "regions": [[0, 0, 16, 16], [16, 0, 16, 16], [32, 0, 16, 16], [48, 0, 16, 16]],
  "durations"?: [1, 1, 1, 2] }
```

Frames that are not all cells of one sheet are listed as `frames: ["res://a.png" |
{"atlas", "region"} | {"class", "embedded": true}]`; `durations` only appears when a frame is
not 1; at most 64 frames per animation are listed (`frames_truncated`).

* A node without SpriteFrames gets a new one (`created_frames: true`). Godot creates it with
  an empty `"default"` animation; when the ops add other animations and never touch
  `"default"`, it is dropped and the node's `animation` set to the first added one (`note`).
* The node's `animation` always names an existing animation afterwards (Godot prints errors
  on every draw otherwise): when it was removed, the first remaining one is used.
* Ops run in order, all-or-nothing, on a working copy; errors are prefixed `ops[i] (op):`.

Undo design: the working copy is a fresh SpriteFrames whose `animations` array is a copy of
the live one; the ops use the real SpriteFrames API on it. The ChangeSet swaps the live
`animations` property (undo: the array read before) and calls `emit_changed()` (setting
`animations` does not emit it, verified on 4.7.2; the SpriteFrames panel listens to it), then
`animation`/`autoplay`. A new SpriteFrames is assigned as `sprite_frames` (undo: null). The
order keeps every `animation` assignment valid (AnimatedSprite2D.set_animation prints an
error for a missing name). Do → undo → redo was checked to restore the exact state.
Headless the scene is packed (embedded SpriteFrames and AtlasTextures land in the .tscn). A
SpriteFrames saved as its own `.tres` is saved in `finish` (`saved_resources`; in the editor
undo saves it again). `anim.frames_file` edits a `.tres` directly: in the editor one undo step
`"MCP: anim.frames"` that also saves, like resource.set (`undoable: true`).

### audio.buses (E/H)

params: `{}` → result:

```json
{ "layout": "res://default_bus_layout.tres", "layout_exists": true, "source": "audio_server" | "file",
  "buses": [ { "index": 0, "name": "Master", "volume_db": 0, "mute": false, "solo": false,
               "bypass_effects": false, "send": null,
               "effects": [ { "index": 0, "class": "AudioEffectReverb", "enabled": true, "properties": { "room_size": 0.6 } } ] } ],
  "note"?: "No bus layout file yet ..." }
```

`layout` comes from the project setting `audio/buses/default_bus_layout` (uid:// values
resolved). In the editor the live AudioServer state is read (what the Audio panel shows);
headless the file is loaded (Master only when it does not exist).

### audio.edit (E/H)

params: `{ "ops": [...] }`; `bus` is a name or index.

| op | fields |
|---|---|
| `add_bus` | name, index? (1..count; default append), send? (default Master), volume_db?, mute?, solo?, bypass_effects? |
| `remove_bus` | bus (not Master); buses that sent to it are re-pointed to Master (warning) |
| `rename_bus` | bus (not Master), name; sends naming the old name are updated |
| `move_bus` | bus (not Master), index: the final position (>= 1) |
| `set` | bus, volume_db?, mute?, solo?, bypass_effects?, send? |
| `add_effect` | bus, type (an AudioEffect class, did-you-mean), properties?, index?, enabled? |
| `remove_effect` | bus, effect (index) |
| `set_effect` | bus, effect, properties?, enabled? |

Result: `{ "layout", "saved": true, "results": [...], "buses": [...as audio.buses], "warnings"? }`.

Implementation: both backends apply the ops through AudioServer (it works headless on the
Dummy driver) and save `AudioServer.generate_bus_layout()` with `core/res_save.gd`.
Headless the file is loaded into AudioServer first. In the editor the ops are applied to
validate them and compute the new layout, the old layout is put back, and one
EditorUndoRedoManager action (global history) applies the new one: `set_bus_layout`, emit
`bus_layout_changed` (the Audio panel rebuilds; `set_bus_layout` itself emits nothing),
save the file, `EditorFileSystem.update_file`. Undo applies the old layout the same way,
so the panel, AudioServer and the file all go back. `set_effect` replaces the effect with
an edited duplicate because effect objects are shared with the undo snapshot.
