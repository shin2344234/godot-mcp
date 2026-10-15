# Methods: resources, visual authoring, import settings

Step 2 bridge-protocol methods implemented by `addons/godot_mcp/ops/resource_ops.gd`,
`ops/visual_ops.gd` and `ops/import_ops.gd` (helpers: `core/resource_util.gd`,
`core/visual_shader_ports.gd`, `core/res_save.gd`). Same conventions as section 5 of
[bridge-protocol.md](../bridge-protocol.md): **(E/H)** = editor and headless. Values use the
codec of section 3. Every result also gets `"backend": "editor" | "headless"` from the server.

Path parameters accept `res://...`, a project-relative path, or a `uid://...` reference.
Headless, Godot only knows the UIDs in `.godot/uid_cache.bin` (written by the editor), so
unknown UIDs are resolved by scanning the project (text headers, `.uid` sidecars, `.import`
files).

## UIDs and saving (both modes)

* In the editor, `ResourceSaver.save()` writes UIDs and notifies the editor file system.
* Headless, `ResourceSaver.save()` writes **no** UIDs (the editor installs the callback that
  supplies them). All saves go through `core/res_save.gd`, which puts back the file's
  previous header uid (or creates one for a new text file) and the `uid` of every
  `[ext_resource]`. New non-text files (`.gdshader`, `.gdshaderinc`) get the `<file>.uid`
  sidecar the editor would create.

## resource.read (E/H)

params: `{ "path": "res://m.tres" | "uid://...", "properties"?: ["albedo_color", "next_pass:albedo_color"], "depth"?: 1 }`

Loads the resource (default cache: in the editor this is the instance open scenes share, so
unsaved in-memory edits are visible). Result:

```json
{ "path": "res://resources/sample_material.tres", "class": "StandardMaterial3D", "uid": "uid://dg2xiy8hs44vm",
  "resource_path": "res://resources/sample_material.tres",
  "properties": { "albedo_color": "Color(1, 0.53, 0, 1)",
                  "albedo_texture": { "resource": "res://icon.svg", "class": "CompressedTexture2D" },
                  "next_pass": { "class": "StandardMaterial3D", "embedded": true, "properties": { "albedo_color": "Color(0, 0, 1, 1)" } } } }
```

* `properties` lists stored properties whose value differs from the class (or script)
  default. Embedded sub-resources are expanded `depth` levels (0..4, default 1); deeper
  ones show only `class` + `embedded`. With `properties` given, only those are returned
  (nested `a:b` paths allowed; unknown names → `NOT_FOUND` with suggestions).
* Extra keys: `script` / `script_class` (custom resources), `uniforms` for a Shader
  (`[{"name", "type", "hint_string"?}]`), `theme_items` for a Theme:
  `{"Button": {"colors": {"font_color": "Color(...)"}, "styles": {...}, "variation_of"?: "..."}}`
  (data types `colors`, `constants`, `font_sizes`, `fonts`, `icons`, `styles`; max 60
  types). Theme item properties are not repeated in `properties`.
* A Shader's `code` is cut at 20 000 characters.

## resource.create (E/H)

params: `{ "path": "res://materials/red.tres", "type"?: "StandardMaterial3D", "properties"?: {...}, "code"?: "shader_type spatial; ...", "overwrite"?: false }`

* `type`: any instantiable Resource class or global script class (`Codec.instantiate_class`,
  did-you-mean on typos). Required except for `.gdshader` (Shader) / `.gdshaderinc`
  (ShaderInclude), where `code` sets the source (a `.gdshader` without code gets a minimal
  spatial template).
* `properties` use the same keys as `resource.set` (nested paths, Theme item paths).
* The extension must be one ResourceSaver supports for that class (`.tres`, `.res`, ...;
  otherwise `BAD_PARAMS` listing the valid ones). Missing folders are created.
* Existing file → `CONFLICT` unless `overwrite: true` (the file keeps its uid; in the editor
  the new instance takes over the cached path).

Result: `{ "path", "type", "uid": "uid://..." | null, "properties_set": [...], "overwritten"?: true }`.

## resource.set (E/H)

params: `{ "path", "properties": { "albedo_color": "#ff0000", "next_pass:albedo_color": [0, 1, 0], "size:x": 32, "Button/colors/font_color": "#ffffff" } }`

* Keys: a property; a nested `set_indexed` path (`"next_pass:albedo_color"`, components
  like `"albedo_color:a"`); on a Theme, `"<Type>/<data type>/<item>"` (creates the item if
  needed). A null intermediate (`next_pass` unset) → `BAD_PARAMS` suggesting
  `{"next_pass": {"new": "StandardMaterial3D"}}` first.
* Dynamic `_set` keys that a class lists only once they exist are accepted too, e.g.
  MeshLibrary `"item/<id>/name"`, `"item/<id>/mesh"`, `"item/<id>/mesh_transform"` (creates
  the item; undo removes it) or TileSet `"physics_layer_<n>/collision_layer"`. A key counts
  as valid if a throwaway duplicate lists it after `set(key, null)`; its PropertyInfo types
  the value (so `{"new": "BoxMesh"}` works for `item/0/mesh`). Same for `resource.create`.
* All values are validated before anything changes. Imported assets (`.import` next to
  them) and scenes are refused with a pointer to `import.set` / `node.set`.
* Editor: edits the cached instance (open scenes update immediately) as one
  EditorUndoRedoManager action `"MCP: resource.set"` that also saves; undo restores the old
  values (removes Theme items it created) and saves again. Headless: load, set, save.

Result: `{ "path", "class", "changed": { key: <value read back> }, "saved": true, "undoable": bool, "warnings"?: [...] }`.

## resource.deps (E/H)

params: `{ "path": "res://x.tres" | "uid://...", "dependents"?: false, "limit"?: 100 }`

Result:

```json
{ "path": "res://resources/sample_material.tres", "uid": "uid://...", "type": "StandardMaterial3D",
  "dependencies": [ { "path": "res://icon.svg", "uid": "uid://co7qc6cxx4spi", "type": "CompressedTexture2D", "exists": true } ],
  "missing": [],
  "dependents": [ { "path": "res://player.tscn", "type": "PackedScene", "via": "uid" | "path" | "text" } ],
  "dependents_truncated": false, "files_scanned": 48 }
```

* Dependencies come from `ResourceLoader.get_dependencies()`. In 4.7 an entry is
  `"res://path"` or `"uid://xxx::<type>::res://fallback"` (type empty from scripts); the uid
  is resolved, falling back to the recorded path. `type` is determined without loading
  (scene/script/shader by extension, `.tres` header, `.import` `[remap] type`).
* `missing` = dependencies whose file does not exist (broken references).
* `dependents` (only with `dependents: true`): `.tscn/.scn/.tres/.res/.material` files whose
  dependencies reference the file (`via` says whether by uid or path), plus `.gd`,
  `.gdshader(inc)`, `.cs`, `.cfg` and `project.godot` containing the quoted path or the uid
  (`via: "text"`). Hidden folders and `.godot/` are skipped; at most `limit` results and
  20 000 files.

## visual.shader_graph (E/H)

params:

```json
{ "path": "res://shaders/glow.tres", "create"?: false, "mode"?: "spatial", "shader_type"?: "fragment",
  "ops": [
    { "op": "add_node", "type": "ColorConstant", "id"?: 2, "position"?: [-300, 0], "properties"?: { "constant": "#ff0000" }, "inputs"?: { "1": 2.0 } },
    { "op": "connect", "from": 2, "from_port"?: 0, "to": 0, "to_port"?: "albedo" },
    { "op": "disconnect", "from": 2, "from_port"?: 0, "to": 0, "to_port"?: 0 },
    { "op": "set", "id": 2, "properties"?: {...}, "position"?: [x, y], "inputs"?: {...} },
    { "op": "remove_node", "id": 2 } ] }
```

* `create: true` makes a new VisualShader (`mode`: spatial, canvas_item, particles, sky,
  fog; texture_blit also accepted) when the file is missing. `mode` cannot change an
  existing shader.
* `shader_type` (graph) defaults per mode: fragment (spatial/canvas_item), process
  (particles), sky, fog. Each op may override it.
* `type`: a VisualShaderNode class, `VisualShaderNode` prefix optional; unknown names get
  suggestions. `id` defaults to the next free id (0 = Output, 1 reserved).
  `VisualShaderNodeInput.input_name` is validated against the names valid for the
  mode/shader type (from the engine's port table), with did-you-mean.
* `to_port` may be an Output-node port name when `to` is 0 (`"albedo"`, `"Normal Map"`,
  `"normal_map"`). Port indices are checked with the engine's `can_connect_nodes()`; when
  it refuses, the error says why: port index out of range (with the node's port count, and
  the Output port list), incompatible port families (scalar/vector/boolean vs transform vs
  sampler), or a cycle. Connecting to an input that is already linked replaces that link
  (as the graph editor does; reported as `replaced`). Connecting an existing link is a no-op
  (`already_connected: true`).
* `inputs` sets input-port default values: numbers, booleans, `[x, y(, z, w)]` or literals
  like `"Vector3(1, 0, 0)"`.
* Ops apply in order and all-or-nothing: headless the file is only saved when every op
  succeeded; in the editor the ops are first rehearsed on a deep copy of the cached shader.
  Errors are prefixed `ops[i] (op):`.
* Graph edits are saved immediately and are **not** in the editor's undo history (a
  VisualShader is a file resource). An open visual shader editor tab may need reopening to
  show the change.

Result: `{ "path", "mode", "created", "uid"?, "results": [ {"op": "add_node", "id": 2, "class": "...", "shader_type": "fragment"}, {"op": "connect", "from", "from_port", "to", "to_port", "replaced"?}, ... ], "saved": true }`.

*Why port probing:* Godot keeps `get_input_port_count/get_output_port_count/get_*_port_name`
C++-only. Counts are found by asking `can_connect_nodes()` against temporary helper nodes
(a fresh Reroute accepts any output; constant / transform / sampler sources probe inputs),
which are removed again. Port names are only known for the Output node and Input nodes
(`core/visual_shader_ports.gd`, copied from 4.7.2's `visual_shader.cpp`).

## visual.shader_graph_read (E/H)

params: `{ "path", "shader_type"? }` → result:

```json
{ "path": "res://shaders/glow.tres", "mode": "spatial", "uid": "uid://...",
  "types": { "fragment": {
     "nodes": [ { "id": 0, "class": "VisualShaderNodeOutput", "position": [400, 150], "ports": "0 Albedo, 1 Alpha, ..." },
                { "id": 10, "class": "VisualShaderNodeFloatOp", "position": [-300, 300], "properties": { "operator": 2 }, "inputs": { "0": 0.0, "1": 2.5 } } ],
     "connections": [ { "from": 10, "from_port": 0, "to": 0, "to_port": 5 } ] } } }
```

Without `shader_type`, untouched graphs (only the Output node, no connections) are omitted.
`properties` are the node's non-default settings (bookkeeping like `expanded_output_ports`
is hidden).

## visual.layout (E/H, scene mutation)

params: `{ "scene"?, "path": "HUD/Panel", "preset"?: "full_rect", "resize_mode"?: "minsize", "margin"?: 0, "anchors"?: [l, t, r, b], "offsets"?: [l, t, r, b], "size_flags"?: { "horizontal"?: "expand_fill", "vertical"?: ["fill", "expand"], "stretch_ratio"?: 1.0 }, "custom_minimum_size"?: [w, h] }`

* `preset`: a Control.LayoutPreset name (`top_left`, `top_right`, `bottom_left`,
  `bottom_right`, `center_left`, `center_top`, `center_right`, `center_bottom`, `center`,
  `left_wide`, `top_wide`, `right_wide`, `bottom_wide`, `vcenter_wide`, `hcenter_wide`,
  `full_rect`; spaces/dashes/`PRESET_` tolerated, did-you-mean) or its number.
  `resize_mode`: `minsize`, `keep_width`, `keep_height`, `keep_size`. Applied like the
  inspector: `layout_mode` becomes Anchors (unless the node is a scene root/uncontrolled),
  then `set_anchors_and_offsets_preset(preset, resize_mode, margin)` and the matching grow
  directions. That call sizes the rect from the content minimum and ignores
  `custom_minimum_size`, which Godot applies later by growing the rect in the grow
  direction; with `custom_minimum_size` in the same call, the offsets of non-stretched axes
  are written for that grown rect (e.g. `top_right`, margin 16, `[200, 30]` →
  `[-216, 16, -16, 46]`).
* `anchors` are set as given with the offsets unchanged; `offsets` are applied after.
* `size_flags` values: `fill`, `expand`, `expand_fill`, `shrink_center`, `shrink_end`,
  `shrink_begin`, a list or `"fill|expand"`, or a number.
* Not a Control → `BAD_PARAMS`. Inside a Container, presets/anchors/offsets are refused (the
  container positions the child); size flags and minimum size are allowed.
* Editor: one undo step (anchors, offsets, grow, layout mode, flags, minimum size restored).

Result: `{ "path", "layout_mode": "anchors", "anchors": [...], "offsets": [...], "grow": [h, v], "preset"?, "size_flags"?: [h, v], "custom_minimum_size"?, "warnings"?, "scene", "saved" }`.

*Headless limitation:* outside a SceneTree a parent has no computed rect, so a Control
stretched by its anchors has size 0 and `keep_*` presets keep that zero size (a warning
says so). Controls with an explicit size (position-mode offsets) work as in the editor.

## visual.shader_check (E/H)

params: `{ "code"?: "shader_type spatial; ...", "path"?: "res://x.gdshader" | VisualShader .tres | ShaderMaterial .tres }`

With `code`, `path` (optional) only says where the code would live, for relative
`#include`s. Result:

```json
{ "valid": false, "errors": [ { "line": 3, "message": "Unknown identifier in expression: 'missing_value'." } ],
  "source": "code" | "file" | "visual_shader", "mode": "spatial", "path"?: "...", "uniforms"?: [ { "name": "k", "type": "float" } ] }
```

How it works: there is no public validate API, but in Godot 4.7 the dummy renderer used by
`--headless` runs the real `ShaderCompiler` in `shader_set_code` (and so does the editor's
renderer). The compiler reports through the engine error stream (`ERROR_TYPE_SHADER`), which
a temporary `Logger` (`OS.add_logger`) collects while `Shader.code` is assigned; a
synchronous `get_shader_uniform_list()` flushes a threaded RenderingServer first.
Limits: one line number per error, no column; parsing stops at the first syntax error; a
failed preprocessor directive (e.g. `#include` of a missing file) is reported on its line as
"Preprocessor directive failed" because Godot drops the preprocessor's own message; in the
editor the same errors also appear in the editor log (`logs.read`). A VisualShader is checked
through its generated code.

## import.get (E/H)

params: `{ "path": "res://icon.svg" }` → result:

```json
{ "path": "res://icon.svg", "importer": "texture", "type": "CompressedTexture2D", "uid": "uid://...",
  "options": { "compress/mode": 0, "mipmaps/generate": false, "...": "..." },
  "dest_files": [ { "path": "res://.godot/imported/icon.svg-<md5>.ctex", "exists": true } ],
  "imported": true, "import_failed"?: true }
```

Parsed from `<path>.import` with ConfigFile. `imported` = every dest file exists and the
import did not fail (`null` for the `keep`/`skip` importers). A file without `.import` →
`NOT_FOUND` explaining whether the type is never imported (use `resource.read`) or the
asset was not imported yet; the latter carries `data.needs_import: true`, and the
**server** then imports it and retries (both `import.get` and `import.set`): headless with
`godot --headless --path <project> --import`, in the editor with a full filesystem scan
(`filesystem.refresh`), polling up to 30 s until the `.import` file exists.

## import.set (E/H)

params: `{ "path", "options"?: { "compress/mode": 2, "mipmaps/generate": true }, "importer"?: "image" }`

* Option keys must exist in the current `[params]` (did-you-mean otherwise); values are
  coerced to the current value's type (enums are ints, see `import.get`).
* `importer` may switch to another importer valid for the file extension (e.g. png:
  texture, image, bitmap, texture_atlas, 2d_array_texture, cubemap_texture,
  cubemap_array_texture, 3d_texture, keep, skip; ogg: oggvorbisstr; glb: scene,
  animation_library). Then unknown option keys are accepted; the new importer ignores
  what it does not know and fills defaults.
* The `.import` file is rewritten, then the asset is reimported:
  editor → `EditorFileSystem.reimport_files([path])` (blocking);
  headless → the addon answers `"reimport": "pending"` and the **server** runs
  `godot --headless --path <project> --import` (reports MCP progress), then reads the
  result back with `import.get`.

Result: `{ "path", "changed": {...}, "importer_changed"?: {"from", "to"}, "reimport": "done", "warnings"?, ...import.get fields }`.
