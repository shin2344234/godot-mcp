# Tools

godot-mcp exposes 90 operations in 21 groups. Every MCP tool is named `godot_` plus the
operation with dots replaced by underscores: the operation `node.add` is the tool
`godot_node_add`.

**Contents:**
[Modes and toolsets](#modes-and-toolsets) ·
[Editor or headless](#editor-or-headless) ·
[Tools by group](#tools-by-group) ·
[Resources](#resources) ·
[Prompts](#prompts)

## Modes and toolsets

| Mode | Tools listed | Size of the definitions |
|---|---|---|
| `full` (default) | 91: every operation as its own tool, plus `godot_tools` | about 15k tokens |
| `compact` | 17: the 14 core tools (marked ★ below) plus `godot_tools`, `godot_call_read` and `godot_call_write` | about 2.2k tokens |

In compact mode the agent finds the other operations with `godot_tools` (`action: "search"`
with keywords, then `action: "describe"` for their parameter schemas) and runs them through
`godot_call_read` (read-only operations) or `godot_call_write` (everything else), passing
`operation` and `args`. In full mode `godot_tools` is still useful to search the catalog.

The tool list never changes during a session. To make it shorter:

- `--toolsets a,b,c` (or `GODOT_MCP_TOOLSETS`) keeps only the named groups. `core` is always on.
- `--read-only` (or `GODOT_MCP_READ_ONLY=1`) hides every tool that changes something.

Which mode suits which client, and every other option, is in
[setup.md](setup.md#options).

Each tool carries MCP hints: `readOnlyHint` for the tools marked **read** below,
`destructiveHint` for those marked **destructive** (they can delete or overwrite work), and
`idempotentHint` where repeating a call changes nothing more. Clients use them to decide when
to ask you first. Clients that support elicitation also get a yes/no question from the server
before irreversible steps such as deleting a file.

## Editor or headless

Most tools work both with the Godot editor open (through the editor plugin, undoable with
Ctrl+Z) and with it closed (through a one-shot headless Godot process that saves the file).
These need the live editor: `godot_scene_open`, `godot_scene_save_as`, `godot_scene_close`,
`godot_editor_logs`, `godot_editor_ui`, and editor-view screenshots with
`godot_game_screenshot`. Ask the agent to call `godot_editor_launch` to open it.

The `game_*` and `debug_*` tools work on a game started with `godot_run_start`. Its default
`mode: "auto"` plays the game in the connected editor, or starts a separate Godot process when
the editor is closed or the call asks for something only a process run can do. Breakpoints,
stepping and the script profiler need `mode: "process"`, where the server itself is the
game's debugger; everything else works in both modes. `godot_game_eval` also needs the server
option `--allow-eval`.

The `code_*` tools use the editor's GDScript language server, or start a private headless
editor when yours is closed. See [overview.md](overview.md) for how the pieces fit together.

## Tools by group

Tools marked ★ are the core set that compact mode lists directly. "Details" links go to the
reference pages with every parameter, result shape and limit.

### Core (`core`)

Details: [methods/core-files-editor.md](methods/core-files-editor.md).

| Tool | Kind | What it does |
|---|---|---|
| `godot_status` ★ | read | Call this first. Shows the project, whether the live editor is connected (open scenes, unsaved changes, playing state), the Godot executable found, and running games. |
| `godot_addon_install` | write, destructive | Install or update addons/godot_mcp (the editor bridge and game runtime this server needs) from the copy bundled with the server, and enable it in project.godot. |
| `godot_project_info` ★ | read | Godot project facts from project.godot: name, Godot version, main scene, autoloads, input action names, renderer, enabled plugins, C# and test framework detection. |
| `godot_project_settings` | read | Read raw values from project.godot, filtered by key prefix (e.g. "display/window", "input/jump"). Only non-default values are stored in the file. |

### Files (`files`)

Details: [methods/core-files-editor.md](methods/core-files-editor.md).

| Tool | Kind | What it does |
|---|---|---|
| `godot_files_list` ★ | read | List a project folder (res://...). Skips .godot/ and .git/; hides .uid/.import sidecars and, when recursive, addons/ contents unless all. Use recursive with a glob-like "pattern" (e.g. "*.tscn") to find files by type. |
| `godot_files_read` ★ | read | Read a text file (script, scene .tscn, resource .tres, shader, config) with line numbers. Use offset/limit for long files. |
| `godot_files_search` | read | Search text across project files (scripts, scenes, resources, shaders). Literal by default; set regex for a regular expression. |
| `godot_files_write` ★ | write, destructive | Create or overwrite a text file (e.g. a .gd script or .gdshader). GDScript files are then checked for parse and type errors (as godot_script_validate). Prefer godot_files_edit for small changes to existing files. |
| `godot_files_edit` ★ | write | Replace an exact snippet in a text file (old_text -> new_text). old_text must match exactly once unless replace_all. GDScript files are then checked for parse and type errors (as godot_script_validate). |
| `godot_files_move` | write | Move or rename a file or folder, carrying its .uid/.import sidecar files. References by uid:// keep working; plain res:// references in other files are NOT updated. |
| `godot_files_delete` | write, destructive | Delete a file (and its .uid/.import sidecars). Deleting a folder requires recursive: true. This cannot be undone. |

### Scenes (`scene`)

Details: [bridge-protocol.md](bridge-protocol.md#5-core-scene-node-script-and-run-methods), [methods/scene-signals.md](methods/scene-signals.md).

| Tool | Kind | What it does |
|---|---|---|
| `godot_scene_tree` ★ | read | Show the node tree (names, types, scripts, instanced sub-scenes) of a scene. Use depth/max_nodes to keep large scenes small; start from a subtree with root. |
| `godot_scene_create` | write | Create a new .tscn file with a root node of the given type (e.g. Node2D, Node3D, Control, CharacterBody2D). |
| `godot_scene_open` | write | Open a scene in the editor so later node operations target it. |
| `godot_scene_save` ★ | write | Save the edited scene in the editor (headless edits are saved automatically). |
| `godot_scene_save_as` | write | Save the edited scene under a new path (editor only). |
| `godot_scene_inherit` | write | Create a new scene file that inherits a base scene (like "New Inherited Scene"); opens it in the editor. |
| `godot_scene_close` | write | Close a scene tab in the editor. Refuses unsaved changes unless save or discard is true. |
| `godot_batch_apply` | write | Apply up to 100 scene edits (node.add, node.set, signal.connect, ...) to one scene in order, all-or-nothing; one undo step in the editor. |

### Nodes (`node`)

Details: [bridge-protocol.md](bridge-protocol.md#5-core-scene-node-script-and-run-methods), [methods/scene-signals.md](methods/scene-signals.md).

| Tool | Kind | What it does |
|---|---|---|
| `godot_node_get` ★ | read | Read a node's type, script, non-default property values and connected signals. Pass properties to read only some. |
| `godot_node_add` ★ | write | Add a node of a built-in type (e.g. Sprite2D, CollisionShape2D, Label) or an instance of a .tscn scene, with optional initial properties. Undoable in the editor. |
| `godot_node_set` ★ | write | Set one or more properties on a node (position, texture, shape, modulate, ...). Returns the values read back. Undoable in the editor. |
| `godot_node_remove` | write, destructive | Delete a node and its children from the scene. Undoable in the editor; permanent when headless. |
| `godot_node_rename` | write | Rename a node. Note: scripts or NodePaths that refer to the old name are not updated. |
| `godot_node_reparent` | write | Move a node under a different parent (and/or to a child index), keeping its global transform by default. |
| `godot_node_duplicate` | write | Duplicate a node (with children, script and properties) next to the original. |
| `godot_node_instance` | write | Instance a .tscn as a linked sub-scene under a parent, optionally with Editable Children. Undoable in the editor. |
| `godot_node_find` | read | Find nodes in a scene by name (glob/substring), type (incl. subclasses), group, script or property value. |
| `godot_node_move` | write | Move a node to another position among its siblings (draw/process order). Undoable in the editor. |
| `godot_node_groups` | write | Add or remove a node's groups (saved in the scene). Undoable in the editor. |

### Scripts (`script`)

Details: [bridge-protocol.md](bridge-protocol.md#5-core-scene-node-script-and-run-methods).

| Tool | Kind | What it does |
|---|---|---|
| `godot_script_attach` | write | Attach a .gd (or .cs) script to a node, or detach with script: null. Create the file first with godot_files_write. |
| `godot_script_validate` | read | Check GDScript for parse/type errors without running the game. Pass a file path, or source text to check before writing. |

### Running the game (`run`)

Details: [bridge-protocol.md](bridge-protocol.md#5-core-scene-node-script-and-run-methods), [methods/debug.md](methods/debug.md#godot_run_output-errors-view), [methods/game-input.md](methods/game-input.md#recording-video-godot_run_start-write_movie).

| Tool | Kind | What it does |
|---|---|---|
| `godot_run_start` ★ | write | Start the game (main scene, the current scene, or a given scene). Returns a run_id; read errors and prints with godot_run_output, stop with godot_run_stop. |
| `godot_run_stop` ★ | write | Stop a running game (the given run_id, the latest process run, or the game playing in the editor). |
| `godot_run_output` ★ | read | Read output and errors of a game started with godot_run_start (process or editor mode). Use level "error" to see only errors, and "since" (the "next" value from the last call) to page. |

### Editor (`editor`)

Details: [methods/core-files-editor.md](methods/core-files-editor.md), [methods/tests-editor-ui.md](methods/tests-editor-ui.md).

| Tool | Kind | What it does |
|---|---|---|
| `godot_editor_logs` | read | Read messages, warnings and errors printed by the editor process (plugin and tool scripts, import errors; not a running game's prints). Repeats are merged with a count. Page with "since". |
| `godot_editor_launch` | write | Open this project in the Godot editor and wait until the MCP plugin connects (the plugin must be enabled in the project). |
| `godot_editor_ui` | write | Get/set the selected nodes, open a script at a line, save all scenes and scripts, or show a toast. |

### Signals (`signal`)

Details: [methods/scene-signals.md](methods/scene-signals.md).

| Tool | Kind | What it does |
|---|---|---|
| `godot_signal_list` | read | List saved signal connections of a node or scene and flag problems (missing/mismatched handlers, unconnected _on_* methods). |
| `godot_signal_connect` | write | Connect a node's signal to a method (saved in the scene), optionally creating the handler stub in the target's script. |
| `godot_signal_disconnect` | write | Remove a saved signal connection from a scene. Undoable in the editor. |

### Resources (`resource`)

Details: [methods/resources-visual-import.md](methods/resources-visual-import.md).

| Tool | Kind | What it does |
|---|---|---|
| `godot_resource_read` | read | Read a .tres/.res/.gdshader (or uid://): class, uid, non-default properties, shader uniforms, theme items. |
| `godot_resource_create` | write | Create a resource file of any Resource class (materials, Theme, Gradient, shapes...) or a .gdshader with code. |
| `godot_resource_set` | write | Set properties of an existing resource file and save it (undoable in the editor; open scenes update). |
| `godot_resource_deps` | read | List a file's dependencies (missing ones flagged), optionally the files that use it; resolves uid:// paths. |

### Visual shaders and UI layout (`visual`)

Details: [methods/resources-visual-import.md](methods/resources-visual-import.md).

| Tool | Kind | What it does |
|---|---|---|
| `godot_visual_shader_graph` | write | Edit or create a VisualShader .tres with ordered node ops (add, connect, set...). |
| `godot_visual_shader_graph_read` | read | List a VisualShader's nodes (id, class, properties) and connections per shader type. |
| `godot_visual_layout` | write | Apply a Control layout preset, anchors/offsets, size flags or minimum size. Undoable. |
| `godot_visual_shader_check` | read | Compile shader code or a .gdshader/VisualShader file and report errors with line numbers. |

### Animation (`anim`)

Details: [methods/animation-audio.md](methods/animation-audio.md).

| Tool | Kind | What it does |
|---|---|---|
| `godot_anim_read` | read | List an AnimationPlayer's libraries and animations, or with animation the tracks and keys of one. Pass library (a .tres) instead of a scene player to read an AnimationLibrary file. |
| `godot_anim_edit` | write | Create/remove/rename animations and add tracks and keys on an AnimationPlayer. ops run in order as one undo step; track paths are "Node:property" relative to the player's root_node. |
| `godot_anim_tree_read` | read | Show an AnimationTree's graph (states, transitions, blend points, blend tree nodes) and its parameters. |
| `godot_anim_tree` | write | Build an AnimationTree state machine, blend space or blend tree (states, transitions, start/end, blend points). ops run in order as one undo step. |
| `godot_anim_frames` | write | Read or edit the SpriteFrames of an AnimatedSprite2D/3D (or a .tres): add/rename/remove animations, speed/loop, frames cut from a sprite sheet. No ops = summary. |

### Tile maps, grid maps and navigation (`world`)

Details: [methods/world.md](methods/world.md).

| Tool | Kind | What it does |
|---|---|---|
| `godot_grid_read` | read | Read a TileMapLayer/GridMap: cells, bounds and the TileSet tiles/terrains or MeshLibrary items to paint with. |
| `godot_grid_edit` | write | Paint a TileMapLayer/GridMap with ordered ops (set, erase, fill_rect, terrain; clear wipes all cells). One undo step. |
| `godot_tileset_edit` | write | Create/edit a TileSet .tres: atlas sources, collision (one-way), navigation, occlusion, terrains, custom data, per-tile values, alternative tiles, animation. Saved at once. |
| `godot_navigation_bake` | write | Bake a NavigationRegion2D/3D from its child colliders, meshes, GridMaps and TileMapLayers. |
| `godot_navigation_path` | read | Shortest path between two points over the scene's baked navigation regions. |

### Audio (`audio`)

Details: [methods/animation-audio.md](methods/animation-audio.md).

| Tool | Kind | What it does |
|---|---|---|
| `godot_audio_buses` | read | List the audio buses (volume, mute, solo, send) and their effects from the project's bus layout. |
| `godot_audio_edit` | write | Add, remove, rename, move and set buses (volume, mute, solo, send) and their effects; saves the bus layout. |

### Project configuration (`project`)

Details: [methods/project-export.md](methods/project-export.md).

| Tool | Kind | What it does |
|---|---|---|
| `godot_project_set` | write | Change project settings (project.godot); null resets one to its default. Values are converted to each setting's type. |
| `godot_input_edit` | write | Edit the input map (actions and their key/mouse/gamepad bindings), applied in order and saved to project.godot. |
| `godot_autoload_edit` | write | Add, remove or reorder autoloads (global singletons loaded at startup). |
| `godot_project_plugins` | write | Enable or disable editor plugins (addons) and list the available ones. |
| `godot_project_validate` | read | Health check for missing dependencies, stale or duplicate UIDs, script compile errors, broken autoloads, main scene and plugins. |

### Import settings (`import`)

Details: [methods/resources-visual-import.md](methods/resources-visual-import.md).

| Tool | Kind | What it does |
|---|---|---|
| `godot_import_get` | read | Show an asset's importer, non-default options (full: all), uid and whether its imported files exist (imports new assets first). |
| `godot_import_set` | write | Change an asset's import options (or importer) and reimport it. |

### Export (`export`)

Details: [methods/project-export.md](methods/project-export.md).

| Tool | Kind | What it does |
|---|---|---|
| `godot_export_presets` | read | List export presets (platform, path, filters, options; secrets redacted) and whether export templates are installed. |
| `godot_export_preset_set` | write | Change an export preset's fields/options, or create a preset, in export_presets.cfg. |
| `godot_export_run` | write | Build the game with an export preset (release, debug, pack-only .pck/.zip, or patch); long-running. |

### Code intelligence (`code`)

Details: [methods/code-docs.md](methods/code-docs.md).

| Tool | Kind | What it does |
|---|---|---|
| `godot_code_diagnostics` | read | GDScript errors and warnings for .gd files or a folder, from the language server. |
| `godot_code_symbols` | read | Outline of a .gd file (funcs, signals, vars, consts, classes with lines), or find symbols by name with query. |
| `godot_code_lookup` | read | Hover docs, definition, references, signature, completion or highlights at a position in a .gd file. |
| `godot_code_rename` | write | Rename a GDScript symbol across the project via the language server (skips comments/strings). dry_run previews. |

### Class reference (`docs`)

Details: [methods/code-docs.md](methods/code-docs.md).

| Tool | Kind | What it does |
|---|---|---|
| `godot_docs_search` | read | Search the offline class reference (engine + project classes) by class/member name or words. |
| `godot_docs_class` | read | Class reference for an engine or project class, or one member ("Class.member"), as markdown. |

### Live game (`game`)

Details: [methods/live-game.md](methods/live-game.md), [methods/game-input.md](methods/game-input.md), [methods/game-view.md](methods/game-view.md).

| Tool | Kind | What it does |
|---|---|---|
| `godot_game_tree` | read | The running game's live nodes as a flat list (path, class, script, rect/pos, visible text). Filters list matches only; text "Start" finds the button to click. |
| `godot_game_get` | read | Current values of a live node: script variables and non-default properties (or listed ones, "prop:sub" ok), groups; optionally signal connections and script methods. |
| `godot_game_edit` | write | Change the running game with ops in order: set properties, call a method (returns its value, awaits coroutines), spawn, remove, change/reload scene. Stops at the first failing op; earlier ops stay (no undo, nothing saved). |
| `godot_game_eval` | write, destructive | Evaluate code in the running game: an Expression with self = node (default; autoloads and singletons by name), or a GDScript body of func run(node, tree, inputs) (use return). Off unless the server runs with --allow-eval. |
| `godot_game_input` | write | Send input steps in order (keys, actions, clicks on positions or nodes, drags, scroll, typing, joypad, touch, waits). Reports the Control and physics object under each click. |
| `godot_game_time` | write | Pause/resume the whole game (Godot's suspend: no node processes; SceneTree.paused untouched), step frames or physics ticks, set speed, or wait for a node, signal, condition, frames or seconds. |
| `godot_game_record` | write | Record the game's input events (real and injected) with timestamps, stop to get them as compact JSON (or save to a file), and replay them with the original timing. |
| `godot_game_screenshot` | read | Screenshot the running game (window, a node's viewport, or a region) or the editor's 2D/3D view, scaled down. Can save it and diff against a saved image. |
| `godot_game_perf` | read | Performance monitors of the running game (fps, frame times, memory, objects, draw calls...); optionally sample frames (stats, spikes) and profile script functions. |

### Debugger (`debug`)

Details: [methods/debug.md](methods/debug.md).

| Tool | Kind | What it does |
|---|---|---|
| `godot_debug_state` | read | Is the game stopped (breakpoint, error, pause)? Call stack and variables (locals, members, globals) of a frame. |
| `godot_debug_control` | write | Continue, pause, step_into/over/out (returns the new location and locals), or evaluate an expression in a stopped game (process runs). |
| `godot_debug_breakpoints` | write | List, add, remove or clear breakpoints of a game started with godot_run_start (process mode), running or stopped. |

### Tests (`test`)

Details: [methods/tests-editor-ui.md](methods/tests-editor-ui.md).

| Tool | Kind | What it does |
|---|---|---|
| `godot_test_run` | write | Run GUT or GdUnit4 tests headlessly (all, a folder, a file or one test name); returns totals and failures with file:line. |

### Discovery

Always listed, outside the 21 groups.

| Tool | Kind | What it does |
|---|---|---|
| `godot_tools` | read | Search all operations by keyword (`action: "search"`), or get full parameter schemas for some (`action: "describe"`). An empty query returns a compact index. |
| `godot_call_read` | read | Compact mode only: run any read-only operation found with `godot_tools`. |
| `godot_call_write` | write, destructive | Compact mode only: run any operation found with `godot_tools` that changes something. |

## Resources

Clients that read MCP resources can attach these directly:

| URI | Contents |
|---|---|
| `godot://project/info` | Project name, Godot version, main scene, autoloads, input actions, plugins |
| `godot://editor/status` | Whether the editor is connected, open and unsaved scenes, whether the game is playing |
| `godot://editor/logs` | Recent editor output and errors (needs the editor open with the plugin) |
| `godot://scene/{path}` | Node tree of a `.tscn` scene (names, types, scripts, sub-scenes) |
| `godot://script/{path}` | Source of a GDScript, shader or C# file in the project |

The scene and script templates autocomplete project paths, and the server lists the
project's scenes and scripts as concrete resources.

## Prompts

Prompts are ready-made tasks that clients show as slash commands or menu entries.

| Prompt | Arguments | What it does |
|---|---|---|
| `scaffold-player` | `dimension`, `style`, `scene` | Create a controllable player scene (2D or 3D) with a movement script, collision and input actions |
| `triage-errors` | `scene`, `error` | Run the game (or a scene), collect errors and warnings, and fix their causes |
| `port-from-godot-3` | `script` | Convert a Godot 3 GDScript file to Godot 4 syntax and APIs |
| `write-shader` | `effect`, `kind`, `node` | Write a Godot shader for an effect and apply it to a node with a ShaderMaterial |
