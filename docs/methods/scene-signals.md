# Methods: scene extras, signals and batches (step 2)

Bridge-protocol methods added by `addons/godot_mcp/ops/scene_extra_ops.gd`,
`addons/godot_mcp/ops/signal_ops.gd` and `addons/godot_mcp/core/scene_batch.gd`. Conventions
are the same as section 5 of [bridge-protocol.md](../bridge-protocol.md). **(E)** = editor
only, **(E/H)** = editor and headless. Scene-bound methods take an optional `scene` (the edited
scene in the editor, required headless). Mutations are one undo action `"MCP: <method>"` in
the editor and return `"scene"` and `"saved"` (false in the editor, true headless), like step 1
mutations. Node paths are relative to the scene root (section 4).

MCP tools: `godot_node_instance`, `godot_node_find`, `godot_node_move`, `godot_node_groups`,
`godot_scene_inherit`, `godot_scene_close`, `godot_batch_apply` (`server/src/ops/sceneExtra.ts`)
and `godot_signal_list`, `godot_signal_connect`, `godot_signal_disconnect`
(`server/src/ops/signals.ts`).

### node.instance (E/H)

params: `{ "scene"?, "instance": "res://enemy.tscn", "parent"?: ".", "name"?, "properties"?: {...}, "index"?: -1, "editable_children"?: false }`

Instantiates the scene with `GEN_EDIT_STATE_INSTANCE` and gives only the instance root
`owner = scene root`, so the .tscn stores `instance=ExtResource(...)` plus overrides (not a copy
of the sub-scene's nodes). `editable_children` calls `set_editable_instance` (`[editable path=...]`).
`properties` are overrides on the instance root. Refuses cycles with `BAD_PARAMS`: the instanced
scene (or any scene it instances, recursively via `ResourceLoader.get_dependencies`) must not be
the edited scene or any sub-scene the parent lives in. Name collisions auto-rename (`renamed_from`).
Result: `{ "path": "Enemies/P2", "name": "P2", "type": "CharacterBody2D", "instance": "res://player.tscn", "editable_children": true }`.
(`node.add {instance}` still works; `node.instance` adds the editable flag and the deep cycle check.)

### scene.inherit (E/H)

params: `{ "path": "res://hero.tscn", "base": "res://player.tscn", "root_name"?: "Hero", "open"?: true }`

Creates a new inherited scene ("New Inherited Scene"). `root_name` defaults to the file name in
PascalCase. `CONFLICT` if `path` exists, `NOT_FOUND` (listing scenes) if `base` is missing.
Godot does not expose `Node.set_scene_inherited_state`, so the addon writes a one-line seed
(`[node name="Hero" instance=ExtResource("1_base")]`), loads it with `GEN_EDIT_STATE_MAIN` (which
sets the inherited state) and immediately re-saves it with `PackedScene.pack()` +
`core/res_save.gd`, so the final file is Godot's own serialization with UIDs. In the editor the
FileSystem dock is updated and the scene is opened when `open` is true.
Result: `{ "path", "base", "root_name", "opened": bool }`.

### node.find (E/H)

params: `{ "scene"?, "name"?, "type"?, "group"?, "script"?, "property"?, "value"?, "root"?: ".", "limit"?: 100 }`

At least one filter is required; all given filters must match. `name`: case-insensitive
substring, or a glob when it contains `*` / `?`. `type`: `is_class()` (subclasses match) or a
global script class name (also matching scripts that extend it); unknown types → `BAD_PARAMS`
with suggestions. `script`: res:// path of the attached script. `property`: the node has it;
with `value`, the decoded value (type-directed, like `node.set`) must be equal. Searches the
nodes `scene.tree` would list (internal nodes of non-editable instances are skipped).
`limit` 1..1000. Result:
`{ "matches": [{ "path", "type", "script_class"?, "instance"? }], "total": 7, "truncated": false }`.

### node.move (E/H)

params: `{ "scene"?, "path": "Timer", "index": 0 }` — reorders among siblings (`move_child`);
negative `index` counts from the end (`-1` = last). Out of range → `BAD_PARAMS` naming the valid
range. Result: `{ "path", "index", "old_index", "order": ["Timer", "Player", ...] }`.

### node.groups (E/H)

params: `{ "scene"?, "path": "Label", "add"?: ["ui"], "remove"?: ["old"] }` — persistent groups
(`add_to_group(name, true)`), saved as `groups=[...]`. Adding a group the node has or removing one
it doesn't have is not an error; it is reported in `"unchanged"`. A name in both lists →
`BAD_PARAMS`. Result: `{ "path", "groups": [...], "unchanged"?: ["not in 'old'"] }`.

### scene.close (E)

params: `{ "path"?: "res://level.tscn", "save"?: false, "discard"?: false }`

Closes a scene tab (default: the edited scene). `EditorInterface.close_scene()` (4.5+) closes the
*active* tab and discards unsaved changes, so the addon switches to the requested tab first and
checks `get_unsaved_scenes()` (4.7): with unsaved changes it returns `CONFLICT` unless `save: true`
(saves, then closes) or `discard: true`. A path that is not open → `NOT_FOUND` with the open scenes.
Result: `{ "closed": "res://level.tscn", "saved": bool, "discarded_changes": bool, "edited_scene": "res://main.tscn" | null }`.

### batch.apply (E/H)

params: `{ "scene"?, "ops": [{ "method": "node.add", "params": {...} }, ...] }` (1..100 ops)

Applies scene mutations to ONE scene, in order, all-or-nothing. `method` is any scene-mutation
method: the step 1 ones (`node.add`, `node.set`, `node.remove`, `node.rename`, `node.reparent`,
`node.duplicate`, `script.attach`) and every module method of kind `scene_mutation` (e.g.
`node.instance`, `node.move`, `node.groups`, `signal.connect`, `signal.disconnect`, other areas'
scene mutations). The list comes from the backends (`env.scene_mutations`), so the addon is the
authority: an unknown name → `BAD_PARAMS` with did-you-mean and `data.methods` (the full list).
The server only normalizes tool names (`"godot_node_set"` → `"node.set"`) and refuses nesting.
`scene` goes at the top level; an op whose `params.scene` names another scene → `BAD_PARAMS`.

Each op is planned against the scene *as changed by the previous ops* (add a node, then set its
properties or connect its signals). Result:
`{ "count": 3, "results": [{ "method": "node.add", ...that method's result }, ...] }`
(each result is computed right after its op). If op *k* fails, nothing is applied and the error
keeps the op's code, prefixes the message with `batch.apply: ops[k] (method) failed, so nothing
was applied:` and has `data: { "failed_index": k, "method", "error_data"? }`.

Editor: ONE undo action `"MCP: batch.apply"`. Ops are applied directly while planning, then
reverted, then committed as a single combined action (do operations in order, undo operations of
the last op first). UndoRedo's `MERGE_ALL` is deliberately not used: in Godot 4.7.2 it merges
only within 800 ms of the previous same-name action and runs merged undo operations
first-to-last, which undoes dependent ops (add, then reparent) in the wrong order and would merge
two quick batches. A failed batch leaves no history entry. Headless: ops run on the loaded scene
and the file is saved once, only when all succeed.
Not rolled back: files written by ops (the stub from `signal.connect` `create_method`).

### signal.list (E/H)

params: `{ "scene"?, "path"?: ".", "recursive"?: true, "include_available"?: false }`

Persistent connections (`CONNECT_PERSIST`, i.e. saved in the .tscn) whose source is the node (or,
with `recursive`, any listed node in its subtree). Connections made in code are never listed.
Result (optional fields only when they carry information):

```json
{
  "connections": [
    { "from": "Timer", "signal": "timeout", "to": ".", "method": "_on_timer_timeout",
      "flags": ["deferred", "one_shot"], "binds": [5, "x"], "unbinds": 1, "inherited": true,
      "problem": "method '_on_x' does not exist on '.' (Node2D, script res://main.gd); ..." }
  ],
  "unconnected_handlers": [ { "to": ".", "method": "_on_area_2d_body_exited", "from": "Area2D", "signal": "body_exited" } ],
  "unconnected_note": "...",
  "problem_count": 2,
  "available": { "Timer": ["timeout()", "ready()", "child_entered_tree(node: Node)", ...] }
}
```

`inherited`: the connection comes from an instanced/inherited sub-scene (Godot's internal
`CONNECT_INHERITED` = 32); it cannot be removed here. `problem`: the target method does not exist
in the target's class or script (or base scripts), or the script method's parameter count does not
fit `signal args - unbinds + binds`. `unconnected_handlers`: script methods (of nodes in scope)
named like the editor's default handlers (`_on_<node>_<signal>` with the node name in snake_case,
as written or lower-case, or `_on_<signal>` for the node's own signals) that no saved connection
targets; skipped when the name appears elsewhere in the script source (likely connected in code).
`available` (only with `include_available`): every signal of each node in scope with argument types.

### signal.connect (E/H)

params: `{ "scene"?, "from": "Area2D", "signal": "body_entered", "to"?: ".", "method"?: "_on_area_2d_body_entered", "binds"?: [...], "unbinds"?: 0, "flags"?: ["deferred", "one_shot"], "create_method"?: false }` (the addon also accepts `"reference_counted"`; the MCP tool exposes only the first two)

Connects with `CONNECT_PERSIST` always added. `method` defaults to the editor's name
(`_on_<from in snake_case>_<signal>`, or `_on_<signal>` when `from` == `to`). `binds` are decoded
like untyped values (constructor strings, `{"new": ...}`); the callable is built as
`Callable(to, method).bindv(binds).unbind(unbinds)`, the order Godot uses when loading saved
connections, so the .tscn gets `binds=` / `unbinds=`. Errors: unknown signal → `NOT_FOUND` with
did-you-mean; source inside a non-editable instance → `BAD_PARAMS`; the same signal → target method
already connected → `CONFLICT`; missing method → `NOT_FOUND` with suggestions, unless
`create_method: true`.

`create_method` appends a stub to the target's script file, typed from the signal arguments (minus
unbinds) plus `extra_arg_N` for binds:
`func _on_area_2d_body_entered(body: Node2D) -> void:\n\tpass # Replace with function body.` Only
for a `.gd` file on disk (built-in or C# scripts → `UNSUPPORTED`; no script → `BAD_PARAMS`). The
stub is written as the first "do" step of the action because Godot 4.7 refuses to connect a
Callable whose method does not exist; the script resource is reloaded, and in the editor the
FileSystem dock and open script tabs are refreshed. Writing is idempotent; undo removes the
connection but leaves the function in the file.
Result: `{ "from", "signal", "to", "method", "connected": true, "flags"?, "binds"?, "unbinds"?, "method_created"?: { "script", "code" }, "warnings"? }`
(`warnings`: the existing method's parameter count does not fit what the connection passes).

### signal.disconnect (E/H)

params: `{ "scene"?, "from": "Timer", "signal": "timeout", "to"?: ".", "method": "_on_timer_timeout" }`

Removes a saved connection (undoable; undo reconnects with the same binds and flags). Not found →
`NOT_FOUND` listing the existing saved connections of that signal (`data.existing`). Inherited
connections → `BAD_PARAMS` (edit the sub-scene). Result: `{ "from", "signal", "to", "method", "disconnected": true }`.

## Implementation notes

* `batch.apply` is a `project`-kind module method; both backends add `scene_mutations`
  (method → planner) to the `env` they pass, so the batch code does not depend on
  `core/methods.gd`. `core/scene_batch.gd` reads `ChangeSet._do_ops` / `_undo_ops` directly for
  the direct revert and the combined commit.
* `node.set` accepts `"metadata/<name>"` but not nested resource paths such as
  `"material:albedo_color"` (no `set_indexed` support yet).
