---
name: godot
description: How to work on a Godot 4 project with the godot MCP tools (godot_*). Use when the user asks to build, change, debug, run or test anything in a Godot game, scene, node or GDScript file, or the folder contains project.godot.
---

# Working on a Godot 4 project

Use the `godot_*` MCP tools for Godot work. They understand scenes, resources and the
running game, so they're safer than editing project files as text.

1. **Start with `godot_status`.** It tells you whether the Godot editor is connected,
   which Godot binary was found and whether the `godot_mcp` addon is installed.
   - Editor connected: edits go through the editor, are undoable by the user, and need
     `godot_scene_save` afterwards.
   - No editor: edits run in headless Godot and are written to disk; pass `scene`.
   - `addon_installed: false` (or an `addon_hint`): scene, node, run and game tools need
     the addon. Call `godot_addon_install` (copies `addons/godot_mcp` and enables the
     plugin), then retry. If the editor is open, the user restarts it afterwards.
   - Then call `godot_project_info` for the main scene, autoloads and input actions.
2. **Don't hand-edit `.tscn` or `.tres` files.** Use the scene, node, resource and signal
   tools (`godot_node_add`, `godot_node_set`, `godot_signal_connect`, ...). They keep
   UIDs, sub-resources and references valid.
   For several changes to one scene, use **`godot_batch_apply`**: it applies them in
   order, all or nothing, as one undo step.
   Edit scripts with `godot_files_edit` / `godot_files_write`. GDScript is syntax-checked
   on write; `godot_script_validate` and `godot_code_diagnostics` check further.
3. **Check your work by running it.** Call `godot_run_start` with `mode: "process"`, then
   `godot_run_output` with `errors: true` (or `level: "error"`). Fix what it reports
   before you say a change works. Call `godot_run_stop` when you're done.
4. **While the game runs**, look at it instead of guessing:
   - `godot_game_tree` and `godot_game_get` show live nodes and their values.
   - `godot_game_input` presses keys and actions, clicks and drags.
   - `godot_game_time` pauses or steps frames.
   - `godot_game_screenshot` shows what is on screen.
   - The `godot_debug_*` tools handle breakpoints and the call stack.
5. **Look up APIs with the docs tools.** Your training data may predate this Godot
   version. Call `godot_docs_search` / `godot_docs_class`, which read the offline class
   reference for the installed Godot, before using a class or method you aren't sure
   about. Write Godot 4 code: `CharacterBody2D`, `@export`, `signal.connect(callable)`.
   Never use Godot 3 syntax.

Paths are `res://` paths. Node paths are relative to the scene root (`.` is the root).
Never edit `.godot/`. When you move files, use `godot_files_move` so the `.uid` and
`.import` files go with them.
