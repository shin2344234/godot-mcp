@tool
extends RefCounted
## Step 3 editor method: screenshots of the editor's 2D / 3D viewports
## (godot_game_screenshot with source "editor_2d" / "editor_3d").
## Descriptor contract: see core/methods.gd (kinds scene_mutation / scene_read / project,
## optional "editor_only": true).
##
## Cropping, scaling, encoding, saving and comparing are shared with the game runtime
## (runtime/ops/rt_view.gd, static helpers), so both sources return the same shape.
##
## Module methods run synchronously in the editor backend (EditorBackend._dispatch_module
## doesn't await), so this can't wait for frames. The editor redraws its viewports when
## something changes, and the texture holds the last drawn frame, which is what the user
## sees. When the requested viewport isn't on screen (another main screen is active), it
## switches the editor to it and answers {"retry_after_ms"}; the server waits and asks
## again (server/src/ops/gameView.ts).

const R := preload("../core/mcp_result.gd")
const View := preload("../runtime/ops/rt_view.gd")

## How long the server should wait after a main-screen switch before asking again.
const RETRY_AFTER_MS: int = 300


static func methods() -> Dictionary:
	return {
		"editor.screenshot": {"kind": "project", "editor_only": true, "fn": screenshot},
	}


## params: view ("2d" | "3d"), viewport (3D only, 0-3), plus the image params of
## View.process_image (region, max_size, format, quality, save_to, compare_to, tolerance).
static func screenshot(params: Dictionary, env: Dictionary) -> Dictionary:
	if DisplayServer.get_name() == "headless":
		return R.err(R.UNSUPPORTED, "The Godot editor runs headless (no display), so its 2D/3D viewports render nothing. " +
			"Open the project in a normal (windowed) Godot editor, or capture a windowed game with source \"game\" instead.")
	# Through env (not the EditorInterface identifier) so this script also compiles in the
	# headless runner, which loads every module.
	var ei: Object = env.get("interface")
	if ei == null:
		return R.err(R.UNSUPPORTED, "Editor viewport screenshots need the live Godot editor.")
	var view: String = str(params.get("view", "2d")).to_lower()
	var vp: SubViewport
	var screen: String
	if view == "2d":
		vp = ei.call("get_editor_viewport_2d")
		screen = "2D"
	elif view == "3d":
		var idx: int = int(params.get("viewport", 0))
		if idx < 0 or idx > 3:
			return R.err(R.BAD_PARAMS, "viewport must be 0-3 (the 3D editor's split views), got %d." % idx)
		vp = ei.call("get_editor_viewport_3d", idx)
		screen = "3D"
	else:
		return R.err(R.BAD_PARAMS, "view must be \"2d\" or \"3d\", got '%s'." % view)
	if vp == null:
		return R.err(R.GODOT_ERROR, "The editor returned no %s viewport." % screen)

	# A viewport inside a hidden main screen (or a hidden 3D split view) isn't drawn.
	if not _on_screen(vp):
		if bool(params.get("_retried", false)):
			# Giving up: still put the user's screen back.
			if not str(params.get("_restore", "")).is_empty():
				ei.call("set_main_screen_editor", str(params["_restore"]))
			return R.err(R.CONFLICT, ("The editor's %s viewport is still not visible after switching to the %s screen " +
				"(for a 3D split view, pick a layout that shows it in View > Viewports).") % [screen, screen])
		var previous: String = current_main_screen(ei)
		ei.call("set_main_screen_editor", screen)
		var answer: Dictionary = {"retry_after_ms": RETRY_AFTER_MS, "switched_main_screen": screen}
		# The server passes this back as "_restore" on its retries, so the screen the user
		# was looking at comes back once the capture is done (see below).
		if not previous.is_empty() and previous != screen:
			answer["previous_main_screen"] = previous
		return R.ok(answer)

	var img: Image = vp.get_texture().get_image() if vp.get_texture() != null else null
	if img == null or img.is_empty():
		return R.err(R.GODOT_ERROR, "The editor's %s viewport returned no image." % screen)
	img.convert(Image.FORMAT_RGBA8)
	if vp.use_hdr_2d and RenderingServer.get_rendering_device() != null:
		img.linear_to_srgb()
	var out: Dictionary = View.process_image(img, params, "editor %s viewport" % screen)
	# The image is in hand, so put back the main screen this call switched away from. The
	# 2D dogfood test took an editor_3d screenshot of a 2D project and the editor stayed on
	# the 3D screen afterwards: a screenshot should not change what the user is looking at.
	var restore: String = str(params.get("_restore", ""))
	if not restore.is_empty():
		ei.call("set_main_screen_editor", restore)
		if not R.is_err(out):
			(out["result"] as Dictionary)["restored_main_screen"] = restore
	if R.is_err(out):
		return out
	# A screenshot saved into the project should show up in the FileSystem dock.
	var saved: String = str((out["result"] as Dictionary).get("saved_to", ""))
	var fs: Object = env.get("filesystem")
	if saved.begins_with("res://") and fs != null:
		fs.call("update_file", saved)
	return out


## Name of the editor's current main screen ("2D", "3D", "Script", "Game", "AssetLib" or
## a plugin's), or "" if it can't be told.
##
## EditorInterface can set the main screen (set_main_screen_editor) but has no getter. The
## screen buttons in the editor's title bar are toggle Buttons named after the plugin, with
## theme type variation "MainScreenButton", and exactly the selected one is pressed
## (EditorMainScreen::add_main_plugin / select, editor/editor_main_screen.cpp, 4.7.2). They
## are internal children, hence find_children(..., owned = false).
static func current_main_screen(ei: Object) -> String:
	var base: Control = ei.call("get_base_control")
	if base == null:
		return ""
	for n: Node in base.find_children("*", "Button", true, false):
		var b: Button = n
		if b.theme_type_variation == &"MainScreenButton" and b.button_pressed:
			return String(b.name)
	return ""


## True if every Control above the viewport is visible (so the editor draws it).
static func _on_screen(vp: Viewport) -> bool:
	var n: Node = vp.get_parent()
	while n != null:
		if n is CanvasItem:
			return (n as CanvasItem).is_visible_in_tree()
		n = n.get_parent()
	return true
