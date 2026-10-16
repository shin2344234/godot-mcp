# Bridge protocol (TypeScript server ⇄ Godot)

This document is the contract between the TypeScript MCP server (`server/`) and the
GDScript side (`addons/godot_mcp/`). Both the **editor bridge** (live editor over
WebSocket) and the **headless runner** (one-shot `godot --headless` process) speak the
same method names and parameter shapes, so the server can route a call to whichever
backend is available.

Protocol version: `1`.

## 1. Editor bridge transport

* The editor plugin (`addons/godot_mcp/plugin.gd`) starts a WebSocket server when the
  plugin is enabled.
* **Bind address is always `127.0.0.1`.** Godot's `TCPServer.listen()` binds to all
  interfaces by default; we never rely on that default.
* Port: project setting `godot_mcp/bridge/port` (default **6520**). If the port is
  busy the plugin tries the next 10 ports and uses the first free one.
* On successful listen the plugin writes a **session file**:
  `res://.godot/godot_mcp/session.json` (the `.godot/` folder is git-ignored by Godot's
  default `.gitignore`):

  ```json
  {
    "protocol": 1,
    "port": 6520,
    "token": "<64 hex chars from Crypto.generate_random_bytes(32)>",
    "pid": 12345,
    "godot_version": "4.7.2.stable.official.ed1daf0bf",
    "plugin_version": "0.1.0",
    "project_path": "/abs/path/to/project",
    "started_at": "2026-10-14T23:59:59Z"
  }
  ```

  A new token is generated every time the plugin starts. The file is deleted when the
  plugin is disabled or the editor exits (`_exit_tree`).
* Messages are UTF-8 JSON text frames.

### Handshake

The first frame from the client must be:

```json
{ "type": "hello", "protocol": 1, "token": "<token from session.json>", "client": "godot-mcp-server", "client_version": "0.1.0" }
```

The plugin answers with:

```json
{ "type": "welcome", "protocol": 1, "godot_version": "...", "plugin_version": "0.1.0", "project_path": "...", "project_name": "..." }
```

If the token is wrong or the first frame is not a `hello`, the plugin closes the socket
with code **4001** (reason `"unauthorized"`). A client that does not send `hello` within
5 seconds is closed with **4002** (`"handshake timeout"`). The token comparison should be
constant-time-ish (compare full length; do not early-exit on first mismatch).

Multiple clients may connect at once (each authenticated independently).

### Requests and responses

```json
{ "type": "request", "id": 7, "method": "node.add", "params": { ... } }
```

Success:

```json
{ "type": "response", "id": 7, "result": { ... } }
```

Failure:

```json
{ "type": "response", "id": 7, "error": { "code": "NOT_FOUND", "message": "Node 'Player/Gun' not found under scene root 'Main'.", "data": { "children": ["Sprite2D", "CollisionShape2D"] } } }
```

Error `code` values:

| code | meaning |
|---|---|
| `BAD_PARAMS` | missing/invalid parameter |
| `NOT_FOUND` | file, node, property, or scene not found |
| `NO_SCENE` | the operation needs an edited/open scene and there is none |
| `CONFLICT` | e.g. target already exists, name collision |
| `UNSUPPORTED` | method not available in this backend (e.g. editor-only) |
| `GODOT_ERROR` | a Godot call returned an `Error` (include `error_string(err)` in message) |
| `INTERNAL` | unexpected failure |
| `UNKNOWN_METHOD` | method name not recognized |

**Messages must be actionable for an LLM**: say what was wrong and what would fix it
(e.g. list valid child names, valid class names suggestions, etc.).

### Events

The editor pushes unsolicited frames for games started from the editor (step 3):

```json
{ "type": "event", "event": "game.message", "data": { "session": 1, "message": "mcp:reply", "data": ["{...}"] } }
```

- `game.started` / `game.stopped` `{session}`: an editor debugger session began or ended.
- `game.message` `{session, message, data}`: an `mcp:*` message from the game's runtime.

The server sends to the game with `game.send {session?, command, data}` and lists sessions (with the
runtime's last hello) with `game.status`. Both are editor-only. Details in
[runtime-protocol.md](runtime-protocol.md) section 5.

## 2. Headless runner

Invocation (the addon must be installed in the project):

```
godot --headless --path <project> --script res://addons/godot_mcp/headless/runner.gd -- <request.json>
```

* `<request.json>` is an absolute path to a file containing
  `{ "method": "...", "params": { ... } }`.
* The runner prints exactly one result line to stdout, prefixed with a marker:

  ```
  @@GODOT_MCP_RESULT@@{"result": {...}}
  @@GODOT_MCP_RESULT@@{"error": {"code": "...", "message": "..."}}
  ```

  Anything else on stdout/stderr is Godot noise and is ignored by the server (but kept
  for diagnostics).
* The runner calls `quit(0)` on success and `quit(1)` on error.
* The headless runner has **no editor**: there is no undo history, no "edited scene".
  Scene-editing methods therefore take an explicit `scene` parameter (a `res://` path to
  a `.tscn`), load it with `ResourceLoader.load(path, "", CACHE_MODE_IGNORE)`,
  instantiate with `PackedScene.GEN_EDIT_STATE_MAIN` (so inherited/instanced state is
  preserved), apply the change, then `PackedScene.pack(root)` + `ResourceSaver.save()`.
* Methods marked **editor-only** below return `UNSUPPORTED` from the runner.

## 3. Value encoding (JSON ⇄ Variant)

Shared by both backends (`addons/godot_mcp/core/variant_codec.gd`).

**Encoding (Godot → JSON)**:

* `null`, `bool`, `int`, `float`, `String`, `StringName` → JSON natives.
* `NodePath` → string.
* `Array` / `Packed*Array` → JSON arrays (recursively encoded). Cap at 200 elements;
  if truncated, append the string `"…(+N more)"`.
* `Dictionary` → JSON object with stringified keys (recursively encoded, cap 200 keys).
* Any other built-in value type (Vector2/3/4(i), Rect2(i), Color, Transform2D/3D, Basis,
  Quaternion, Plane, AABB, Projection, RID, Callable, Signal) → the `var_to_str()` string,
  e.g. `"Vector2(1, 2)"`, `"Color(1, 0, 0, 1)"`.
* `Resource` with a non-empty `resource_path` that is not a sub-resource
  (path does not contain `::`) → `{"resource": "res://path.tres", "class": "Texture2D"}`.
* Other `Resource` (embedded/sub-resource) → `{"resource": null, "class": "<class>", "embedded": true}`.
* `Node` → `{"node": "<path relative to scene root>", "class": "<class>"}`.
* Other `Object` → `{"object": "<class>"}`.

**Decoding (JSON → Godot)** is *type-directed*: when setting a property, look up the
property's declared `type` (and `hint`/`hint_string` for objects) from
`get_property_list()` and coerce:

* String input for a non-String property → try `str_to_var(value)`; if that yields the
  right type, use it. So `"Vector2(10, 20)"`, `"Color(1,0,0)"`, `"Vector3(0, 1, 0)"` work.
* For Color properties also accept `"#ff8800"`, `"red"` (named colors, via `Color.from_string`).
* Array input for vector types: `[10, 20]` → Vector2, `[1,2,3]` → Vector3, `[r,g,b(,a)]` → Color, etc.
* Object input `{"x":1,"y":2}` for vector types → Vector2 etc. (keys x,y,z,w / r,g,b,a).
* For Object/Resource properties: string `"res://..."` → `load(path)`;
  `{"new": "ClassName", "properties": {...}}` → `ClassDB.instantiate(ClassName)` with
  properties applied recursively (e.g. `{"new":"RectangleShape2D","properties":{"size":[32,32]}}`).
* `null` → null.
* int ↔ float coercion as needed; enums accept int or a name: the `hint_string` label
  (`"Texture2D"`), the enum constant (`"SOURCE_2D_TEXTURE"`), or the constant without its
  shared prefix, case-insensitive (`"2d texture"`). Some classes (VisualShader nodes) give the
  enum only on the setter's argument, not on the property, so the setter is checked too. A bad
  name lists the valid values.
* Array-header pseudo-properties (type NIL with `PROPERTY_USAGE_ARRAY`, e.g. TileSet
  `physics_layers`, `navigation_layers`) are not real properties: they are skipped by
  property lookup and suggestions, so setting one is `NOT_FOUND`.
* If coercion fails, return `BAD_PARAMS` with the property name, the expected type name
  (`type_string(type)`), and an example of a valid value.

## 4. Node paths

* Node paths in params are **relative to the scene root**: `""` or `"."` = the root,
  `"Player"`, `"Player/Sprite2D"`. A leading `/root/...` or the root's own name as the
  first segment should also be tolerated (strip it).
* Results always report paths relative to the scene root (root = `"."`).

## 5. Methods (step 1)

Step 2 methods are registered by the area modules in `addons/godot_mcp/ops/` and documented per area:
[scenes, nodes, signals and batches](methods/scene-signals.md),
[resources, visual authoring and import](methods/resources-visual-import.md),
[animation and audio](methods/animation-audio.md),
[tile maps and navigation](methods/world.md),
[project settings and export](methods/project-export.md),
[code intelligence and docs](methods/code-docs.md) (these two run in the TypeScript server, not over the bridge).

Methods marked **(E)** are editor-only; **(E/H)** work in both editor and headless.
In the editor, every scene mutation goes through `EditorUndoRedoManager` as one named
action (`"MCP: <method>"`) so the user can Ctrl+Z it, and marks the scene unsaved. In
the editor, `scene` params are optional: if omitted, use the currently edited scene;
if given and it is not the edited scene, open it first (`EditorInterface.open_scene_from_path`).

### editor.status (E)

params: `{}` → result:

```json
{
  "godot_version": "4.7.2.stable...",
  "plugin_version": "0.1.0",
  "project_name": "My Game",
  "project_path": "/abs/path",
  "edited_scene": "res://main.tscn" | null,
  "open_scenes": ["res://main.tscn"],
  "unsaved_scenes": ["res://main.tscn"],
  "is_playing": false,
  "playing_scene": "res://main.tscn" | null
}
```

### scene.tree (E/H)

params: `{ "scene"?: "res://x.tscn", "root"?: "Player", "depth"?: 3, "max_nodes"?: 300, "include_properties"?: false }`

result:

```json
{
  "scene": "res://main.tscn",
  "root": { "name": "Main", "type": "Node2D", "path": ".", "script": "res://main.gd",
            "instance": "res://player.tscn", "groups": ["level"],
            "children": [ ... ], "child_count": 3, "truncated": true },
  "node_count": 12,
  "truncated": false
}
```

To keep big trees cheap, a node entry leaves out `script` and `instance` when they would be
null, `groups` when empty, and `truncated` unless it is true; `children` (possibly empty) and
`child_count` are always present.

`depth` limits recursion (children beyond depth are omitted but `child_count` is kept).
`max_nodes` caps total nodes; set `truncated: true` when hit. Nodes that belong to an
instanced sub-scene are shown with `"instance"` and their internal children are NOT
expanded (unless `editable_children` is on for that instance).

### node.get (E/H)

params: `{ "scene"?, "path": "Player", "properties"?: ["position","scale"] }`

If `properties` is omitted, return the properties whose usage includes
`PROPERTY_USAGE_STORAGE` or `PROPERTY_USAGE_EDITOR` (skipping groups/categories, encoded
with caps) **whose value differs from the class or script default**, and
`"defaults_omitted": <count>` for the rest. `"properties": ["*"]` returns all of them,
defaults included. Embedded sub-resources (e.g. a material) list only their non-default
properties too, with their own `defaults_omitted` (also in node.set read-backs). Result:

```json
{ "path": "Player", "type": "CharacterBody2D", "script": "res://player.gd",
  "properties": { "position": "Vector2(100, 200)", "scale": "Vector2(1, 1)", "motion_mode": 0 },
  "signals_connected": [ { "signal": "body_entered", "target": "..", "method": "_on_body_entered" } ] }
```

### node.add (E/H)

params: `{ "scene"?, "parent": ".", "type"?: "Sprite2D", "instance"?: "res://enemy.tscn", "name"?: "Enemy", "properties"?: { ... }, "index"?: -1 }`

Exactly one of `type` or `instance` is required. `type` must be a ClassDB class that
can be instantiated and inherits Node (or a global script class name from
`ProjectSettings.get_global_class_list()`). Unknown types → `BAD_PARAMS` with up to 5
close matches (simple case-insensitive substring/Levenshtein suggestions). The new node's
`owner` must be set to the scene root (and for instanced scenes, only the instance root's
owner), otherwise it won't be saved. Name collisions: Godot auto-renames; report the
final name. Result: `{ "path": "Enemy", "name": "Enemy", "type": "Sprite2D" }`.

### node.set (E/H)

params: `{ "scene"?, "path": "Player", "properties": { "position": [10, 20], "modulate": "#ff0000" } }`

Unknown property → `NOT_FOUND` listing up to 10 similar property names. Result:
`{ "path": "Player", "changed": { "position": "Vector2(10, 20)", ... } }` (the new values
read back after setting, encoded).

### node.remove (E/H)

params: `{ "scene"?, "path": "Enemy" }` — cannot remove the root (`BAD_PARAMS`).
Result: `{ "removed": "Enemy" }`.

### node.rename (E/H)

params: `{ "scene"?, "path": "Enemy", "name": "Boss" }` → `{ "path": "Boss" }`

### node.reparent (E/H)

params: `{ "scene"?, "path": "Boss", "new_parent": "Enemies", "index"?: -1, "keep_global_transform"?: true }` → `{ "path": "Enemies/Boss" }`

### node.duplicate (E/H)

params: `{ "scene"?, "path": "Enemy", "name"?: "Enemy2" }` → `{ "path": "Enemy2" }`

### script.attach (E/H)

params: `{ "scene"?, "path": "Player", "script": "res://player.gd" | null }` (null detaches)
→ `{ "path": "Player", "script": "res://player.gd" | null }`

### script.validate (E/H)

params: `{ "path"?: "res://player.gd", "source"?: "extends Node\n..." }` (one required; if
both, validate `source` as if it were at `path`).
Create a `GDScript`, set `source_code`, `resource_path` (when path given, use
`take_over_path` carefully or just set a fake path), call `reload()`. Capture parse errors
(install a temporary `Logger` via `OS.add_logger` to collect `_log_error` calls during the
reload; remove it after). Result:

```json
{ "valid": false, "errors": [ { "line": 12, "message": "Identifier \"foo\" not declared in the current scope." } ] }
```

*Godot limitation:* the GDScript compiler reports only a line number per error (no column), so
errors have no `column`. After the first **syntax** error the parser stops (analyzer/type
errors are all reported). An error that comes from a script this one depends on
(`preload`/`extends`) carries an extra `"file": "res://dep.gd"`.

### scene.create (E/H)

params: `{ "path": "res://levels/level1.tscn", "root_type": "Node2D", "root_name"?: "Level1", "open"?: true }`

Fails with `CONFLICT` if the file exists. Creates a root node, packs, saves. In the editor,
opens it if `open` (default true) and rescans the filesystem. Result: `{ "path": "res://levels/level1.tscn" }`.

### scene.open (E)

params: `{ "path": "res://main.tscn" }` → `{ "edited_scene": "res://main.tscn" }`

### scene.save (E/H)

params: `{ "path"?: "res://main.tscn" }` — editor: saves the edited scene (or the given
open scene); headless: no-op success (headless methods save as they go).
Result: `{ "saved": "res://main.tscn" }`.

### scene.save_as (E)

params: `{ "path": "res://main_copy.tscn" }` → `{ "saved": "res://main_copy.tscn" }`

### run.play (E)

params: `{ "scene"?: "main" | "current" | "res://x.tscn" }` (default `"main"`) →
`{ "playing": true, "scene": "res://..." }`. Uses `EditorInterface.play_main_scene()` /
`play_current_scene()` / `play_custom_scene()`.

### run.stop (E)

params: `{}` → `{ "playing": false }`

### filesystem.refresh (E)

params: `{ "paths"?: ["res://player.gd"] }` — called by the server after it writes files
directly to disk. For each path call `EditorInterface.get_resource_filesystem().update_file(path)`
(or `scan()` if no paths); then `EditorInterface.get_script_editor().reload_open_files()`
so open script tabs pick up external changes. Result: `{ "refreshed": n }`.

### logs.read (E)

params: `{ "since"?: 0, "limit"?: 200, "level"?: "all" | "error" | "warning" }`

The plugin installs a `Logger` (Godot 4.5+ `OS.add_logger`) at startup that records
messages and errors **of the editor process** into a ring buffer (max 2000 entries), each
with an increasing `seq`:

```json
{ "entries": [ { "seq": 41, "time": "...", "level": "error", "message": "...", "file": "res://player.gd", "line": 12, "function": "_ready" } ],
  "next": 42, "dropped": 0 }
```

(Game-process output is captured by the server in headless runs; editor-launched game
output arrives with the runtime bridge in step 3.)

### ping (E/H)

params: `{}` → `{ "pong": true }`

## 6. Implementation notes (GDScript side, plugin 0.1.0)

Clarifications of how `addons/godot_mcp` implements the contract above. Fields marked
"extra" are additions; clients must ignore unknown fields.

* **Mutation results** (`node.add/set/remove/rename/reparent/duplicate`, `script.attach`)
  carry extra `"scene": "res://..."` and `"saved"`: `true` headless (the runner saves after
  every call), `false` in the editor (the change is an undoable edit; call `scene.save`).
* `node.add` extra fields: `"instance"` (when instancing) and `"renamed_from"` (when the
  requested name collided and the node was auto-renamed editor-style, `Enemy` → `Enemy2`).
  `node.duplicate` and `node.reparent` auto-rename the same way; `node.rename` returns
  `CONFLICT` with `data.suggestion` instead.
* `node.set` extra `"warnings"`: present when a value reads back differently from what was
  requested (Godot clamped/adjusted it). `node.set` refuses `name` (use `node.rename`).
* Nodes inside an instanced sub-scene (without "Editable Children") can be read but not
  modified: mutations return `BAD_PARAMS` with `data.instance_scene` / `data.path_in_instance`
  telling the client to edit the sub-scene instead (Godot would silently drop such changes
  on save).
* `scene.tree`: `depth` defaults to unlimited (bounded by `max_nodes`, default 300). Node
  entries may carry extra `"script_class"` (global class name), `"inside_instance"` and, for
  the root of an inherited scene, `"inherits"`. A node's `truncated` is true when any of its
  children were omitted (depth or `max_nodes`). `include_properties` returns only stored
  properties that differ from the class/script default.
* `node.get`: `signals_connected[].target` is relative to the **scene root** (like every
  path in results; `"."` = root), and only persistent (scene-saved) connections are listed.
  Extra fields: `"children"` (names), `"groups"`, `"instance"`.
* Value encoding extra: a top-level embedded resource also gets `"properties"` (its stored
  properties, encoded one level deep), so e.g. a `RectangleShape2D`'s `size` is visible.
  A `Curve2D` / `Curve3D` there also gets `"points"` (at most 100): `[x, y]` for a plain
  point, or `{ "position", "in", "out", "tilt"? }` when it has handles or tilt, because the
  stored `_data` dictionary is unreadable and `point_count` alone says nothing about the path.
  Non-finite floats encode as `"inf"`, `"-inf"`, `"nan"`. All JSON text escapes control
  characters (Godot's `JSON.stringify` does not), so strict parsers accept it.
* Value decoding extras: `{"resource": "res://..."}` (the encoder's own form) loads a
  resource; `{"node": "Path"}` or a path string sets Node-typed exports; for `NodePath`
  properties a plain string is used as-is (relative to the node, like the inspector) while
  `{"node": "Path/From/Root"}` is converted to a path relative to the node.
  `"metadata/<name>"` properties are accepted by `node.set`.
* `scene.save` headless: `{"saved": null, "note": ...}` without `path`; with `path` it
  checks the file exists and echoes it.
* `scene.create` extra result fields: `"root_type"`, `"root_name"` (defaults to the file
  name in PascalCase), and in the editor `"opened"`.
* `logs.read`: `level: "warning"` returns warnings **and** errors. Entries from engine errors
  carry `"kind"` (`error`, `warning`, `script_error`, `shader_error`) plus `file`, `line`,
  `function`; `print()` output has level `info` (`printerr()` → `error`). ANSI color codes are
  stripped. `next` is the `since` value for the next call.
* `ping` extra: `"backend": "editor" | "headless"`. `filesystem.refresh` extra:
  `"full_scan": true` when no paths were given.
* Runtime script errors inside the addon (bugs) are reported as `INTERNAL` with
  `data.engine_errors`, instead of returning a half-built result.
* The session file is written atomically (temp file + rename) with mode 0600 where
  supported, and is only deleted by the editor process that wrote it (pid check). A
  killed editor (SIGKILL/SIGTERM) leaves a stale file behind: check `pid` and that the
  connection succeeds.
