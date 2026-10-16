# Methods: live game inspection, live changes and eval

Runtime methods in `addons/godot_mcp/runtime/ops/rt_live.gd`, called over the runtime
channel described in [runtime-protocol.md](../runtime-protocol.md) (`mcp:request` →
`mcp:reply`). They work the same in a process run (started with `godot_run_start`, the MCP
server is the game's debugger) and in a game started from the editor (relayed by the
plugin). Values follow the JSON conventions of
[bridge-protocol.md section 3](../bridge-protocol.md) and reuse the addon codec
(`core/variant_codec.gd`): vectors and colors encode as `"Vector2(1, 2)"`, nodes as
`{"node": "Path", "class": "..."}`, resources as `{"resource": "res://...", "class"}`;
decoding is type-directed, so `[10, 20]`, `{"x": 10, "y": 20}` and `"Vector2(10, 20)"` all
work for a Vector2.

MCP tools: `godot_game_tree`, `godot_game_get`, `godot_game_edit`, `godot_game_eval`
(`server/src/ops/liveGame.ts`, group `game`). Each takes an optional `run_id` (a process
run id, or `"editor"`); without it the newest running process run is used, else the
editor's game (`resolveGame` in `server/src/game/hub.ts`). The server adds `run_id` to
every result.

**Node paths** are relative to the current scene (`"."` is the scene root, `"Box/Start"`)
or absolute (`"/root/GameState"` for an autoload); a bare autoload name also resolves.
Results use the same form (`rt.path_of`). Unknown paths → `NOT_FOUND` pointing to
`godot_game_tree`.

**Never a runtime error.** Every lookup is validated first and problems come back as
`{"error"}`: in a game started from the editor, a GDScript runtime error stops the game in
the editor's debugger (the editor does not ignore error breaks). Code that *the game*
runs because of a request (a method called with `call`, an `eval` snippet) can still hit
a script error: process runs ignore error breaks (the error is recorded, the method
returns its default value and the game goes on); editor runs stop at it in the editor's
debugger like any other script error, and the request times out.

### game.tree (read-only)

params: `{ "root"?: ".", "depth"?: -1, "max_nodes"?: 150, "name"?, "class"?, "group"?, "text"? }`

A flat, pre-order list of live nodes under `root` (default: the current scene; `"/root"`
shows everything, including autoloads). The paths show the hierarchy; a flat list is
shorter than nested JSON and every entry is directly usable as a `path` elsewhere. The
runtime autoload (`GodotMcpRuntime`) is never listed. `depth` limits how far below
`root` the walk goes (0 = only `root`). `max_nodes` 1..2000.

Filters (all given filters must match; matching nodes only are listed, the whole subtree
is searched): `name` case-insensitive substring of the node name; `class` `is_class()`
(subclasses match, e.g. `"BaseButton"` finds Buttons and CheckBoxes) or a script
`class_name` (scripts extending it match too; unknown names → `BAD_PARAMS` with
suggestions); `group` `is_in_group()`; `text` case-insensitive substring of the node's
visible text — the way to find the button to click.

Entry: `{ "path", "class", "name"? (scene root and /root only; otherwise the path ends with
it), "children"? (child count, omitted when 0), "script"? (res:// path or "<built-in>"),
"hidden"?: true (CanvasItem/Node3D not visible in tree), "rect"? (Control:
`"Rect2(x, y, w, h)"` from `get_global_rect()`, canvas coordinates), "pos"? (Node2D/Node3D
`global_position` as `"Vector2(...)"` / `"Vector3(...)"`), "text"? }`. Numbers are rounded to
0.1. Visible text: Label, Button (and subclasses: CheckBox, OptionButton, MenuButton...),
LinkButton, Label3D `text`; RichTextLabel `get_parsed_text()` (BBCode stripped);
LineEdit/TextEdit `text`, or `placeholder_text` when empty. Cut to 60 characters in the
listing (filters see the full text).

Result: `{ "root": ".", "nodes": [...], "count": 7, "truncated": false, "total"?: 412, "hint"? }`
(`total` and `hint` when more nodes matched than `max_nodes`).

### game.get (read-only)

params: `{ "path"?: ".", "properties"?: ["position", "material:albedo_color"], "signals"?: false, "methods"?: false }`

Without `properties`: every script variable (exported or not, `_private` ones included:
that's what you debug) plus the engine properties (storage/editor usage) whose value
differs from the class default (`ClassDB.class_get_property_default_value`);
`"defaults_omitted": N` says how many were left out. A Control alone has ~100 inspector
properties, mostly defaults. `properties: ["*"]` lists all of them. A list of names reads
exactly those; nested paths use `Object.get_indexed` syntax: steps through objects /
sub-resources (`"material:albedo_color"`) and into built-in values (`"position:x"`,
`"modulate:a"`). Unknown names → `NOT_FOUND` with similar names, and the hint that getters
work too (or, when the name is a method, `'is_playing' is a method: write "is_playing()"`).

**Getters.** An entry ending in `()` calls an argument-less getter and reports what it
returns under that key: `["get_screen_center_position()", "is_playing()"]`. Derived values
like these exist only as methods, and reading them needed `godot_game_eval` (off by default).
To keep `game.get` a read, only methods that need no arguments (defaults are fine) **and** are
const in the engine (`METHOD_FLAG_CONST` in `get_method_list()`: verified for
Camera2D.get_screen_center_position, AnimationPlayer/AnimatedSprite2D.is_playing,
Viewport.get_visible_rect...) **or** named like a getter (`get_`/`is_`/`has_`/`can_`, which is
how script methods are recognised; GDScript methods are never flagged const) are called.
Others → `BAD_PARAMS` pointing to `godot_game_edit` `call`; unknown names → `NOT_FOUND` with
similar method names. A script getter runs game code: a script error in it is handled like
one in `call` (see "Never a runtime error").

`signals: true` adds `{"name(arg: Type)": [{"to": "path", "method": "_on_x"}]}`: script
signals always, built-in signals only when connected; engine-internal connections (C++
method pointers) are left out, lambdas are kept. `methods: true` adds the script's methods
(`Script.get_script_method_list()`, inherited script methods included) as
`"greet(who: String, times: int) -> String"`.

Result: `{ "path", "class", "script"?, "script_class"?, "properties": {...}, "defaults_omitted"?, "groups"? (non-internal), "child_count", "signals"?, "methods"? }`.

### game.edit

params: `{ "ops": [ {"action": ..., ...}, ... ] }` (1..50 ops)

Ops run in order. The first failing op stops the batch with its error code and the
message `ops[2] (call) failed: ... ops[0..1] were applied and stay applied (a live game has
no undo).`; error `data` is `{ "failed_index", "results" (of the applied ops), "detail"? }`.
Nothing is rolled back: earlier ops may already have had effects (signals, `_ready`,
physics), and nothing is saved to scene files. Result: `{ "results": [...] }`, one per op.

- `set {path?: ".", properties}` — type-directed decoding like `node.set` (codec
  `decode_property`), nested paths like `game.get` (the tail inside a built-in value is
  decoded by the component's current type: a number for `position:x`, a Vector3 for
  `transform:origin`). All values are decoded before any is set, so a bad value leaves
  the node untouched. Node-typed properties take a live path (`"/root/GameState"`) or
  `{"node": "Path"}`. Changing a property of a resource saved as its own file (e.g.
  `"material:albedo_color"` with a shared `.tres`) is allowed in the live game but warns
  that every user of that resource sees it. A value that reads back differently (clamped,
  or changed by a setter) adds a warning; floats compare approximately.
  Result: `{ "action": "set", "path", "changed": {name: value read back}, "warnings"? }`.
- `call {path?: ".", method, args?: []}` — arguments are decoded by the declared argument
  types from `get_method_list()` (`[30, 40]` → Vector2, `"Box/Start"` → the node for a
  Node-typed argument, `{"node": "..."}` for untyped ones); argument count is checked
  against required/default/vararg arguments first (`BAD_PARAMS` with the signature).
  Unknown methods → `NOT_FOUND` with similar names. The return value is encoded. **A
  coroutine** (a method that hits `await` returns a `GDScriptFunctionState`) is awaited
  through its `completed(result)` signal, frame by frame, within a 10 s budget per
  request; if it hasn't finished then, the result has `"pending": true` instead of
  `"return"` and the coroutine keeps running. A method that *returns* a Signal is not
  awaited. Result: `{ "action": "call", "path", "method", "return" | "pending" }`.
- `spawn {class | scene, parent?: ".", name?, properties?}` — `class` is a native or
  `class_name` class inheriting Node (codec `instantiate_class`, editor-only classes
  refused); `scene` a PackedScene path. Properties are set before the node enters the
  tree (like a scene file, so `_ready` sees them). `add_child(node, true)`: a clashing
  name becomes readable (`Enemy2`). Result: `{ "action": "spawn", "path", "class", "warnings"? }`.
- `remove {path}` — removes the node from its parent at once (later ops and
  `game.tree` no longer see it) and `queue_free()`s it. Refuses `/root`, the runtime
  autoload, and the current scene (use `change_scene`). Result: `{ "action": "remove", "removed": path }`.
- `change_scene {scene?}` — `SceneTree.change_scene_to_file(scene)`, or
  `reload_current_scene()` without `scene`; waits for `SceneTree.scene_changed` (same 10 s
  budget) so later ops see the new scene. Result: `{ "action": "change_scene", "current_scene", "note"? }`.

### game.eval (opt-in)

params: `{ "code", "mode"?: "expression", "path"?: ".", "inputs"?: {name: value} }`

**Off by default.** The MCP server only sends this method when started with
`--allow-eval` (or `GODOT_MCP_ALLOW_EVAL=1`, `true`, `yes`, `on`); otherwise
`godot_game_eval` stays listed (the tool list never changes) and returns `DISABLED` with
those instructions, without touching the game. The runtime itself trusts its debugger
(the server or the user's editor).

- `mode: "expression"`: Godot's `Expression` — `parse(code, input names)`, then
  `execute(input values, base = the node at path, show_error = false)`. One expression
  (no statements); `self` and bare method names refer to the node. Parse errors →
  `BAD_PARAMS`, execution errors → `GODOT_ERROR` with `get_error_text()`. **Autoloads and
  engine singletons** are visible by name (`GameState.lives`, `Input.is_action_pressed("jump")`,
  `Engine.get_frames_per_second()`): an Expression only resolves its inputs, `self`'s members
  and built-ins (verified with 4.7.2: `GameState.lives` failed with "Invalid named index
  'GameState' for base type Object", although `godot_debug_control evaluate`, which runs in a
  GDScript frame, sees them), so every autoload (`ProjectSettings` `autoload/<Name>`, the node
  `/root/<Name>`) and engine singleton (`Engine.get_singleton_list()`) whose name occurs in the
  code as a word is added as an input. Only names that occur are added, so a node property
  with the same name as an unused singleton is never shadowed; your own `inputs` win over
  both. `$Node` syntax is GDScript only; use `get_node("Node")`.
- `mode: "gdscript"`: the code is the body of `func run(node, tree, inputs)` in a temporary
  `extends RefCounted` script (indented with tabs, or spaces if the code uses spaces), or a
  whole script when it contains `func run(` (an `extends RefCounted` line is added if it
  has none; `run` may declare fewer parameters). Use `return` for the result; `await`
  works (same 10 s budget as `call`). The script is compiled with `GDScript.reload()` **on a
  worker thread**: on the main thread a parse error calls `debug_break_parse()`, which in
  an editor run stops the game in a break that can't be continued
  (`modules/gdscript/gdscript_editor.cpp` only breaks on the main thread; verified with
  4.7.2). Compile errors → `BAD_PARAMS` listing Godot's parse errors with snippet line
  numbers (`(snippet:1)`).

Everything logged while the code runs is captured with a temporary `Logger`
(`OS.add_logger`): `"output"` (printed lines, max 50 lines / 4000 chars), `"errors"`
(engine and script errors as `"message (file:line)"`), `"warnings"`. Output from other game
code during that time is included too. A **script error** (Logger `ERROR_TYPE_SCRIPT`)
means the snippet stopped early, so the call fails with `GODOT_ERROR` and the captured
output in `data`; engine errors are only reported. (In an editor run a script error stops
the game in the editor's debugger first; see "Never a runtime error" above.)

Result: `{ "result": encoded value | "pending": true, "output"?, "errors"?, "warnings"? }`.
`inputs` values are decoded like untyped properties (`"Vector2(1, 2)"` strings, integral
numbers as ints, `{"node": "Path"}` for nodes).
