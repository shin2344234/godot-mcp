@tool
extends RefCounted
## Runtime methods: screenshots and performance (godot_game_screenshot / godot_game_perf).
## See runtime/mcp_runtime.gd for the method contract and helpers (find_node, path_of...).
##
## The image helpers below (process_image, load_image_file, save_image, compare_images) are
## static and synchronous so the editor side (ops/editor_view_ops.gd, editor viewport
## screenshots) can reuse them; that is also why this script is @tool.
##
## Images travel back as base64 inside the JSON reply. Debugger packets (game -> server or
## game -> editor) and bridge frames are capped at 8 MiB, so the encoded image is kept well
## below that (MAX_IMAGE_BYTES; base64 adds a third).

const R := preload("../../core/mcp_result.gd")

## Longest side of the returned image unless the caller asks otherwise. Big enough to read
## UI text in a 1080p game, small enough to keep tokens and payloads modest.
const DEFAULT_MAX_SIZE: int = 768
const MAX_MAX_SIZE: int = 4096
## Encoded image limit (before base64). 5 MiB -> ~6.7 MiB base64, under the 8 MiB caps.
const MAX_IMAGE_BYTES: int = 5 * 1024 * 1024
## Per-channel difference (0-255) below which a pixel counts as unchanged in a comparison.
const DEFAULT_TOLERANCE: int = 16
## game.perf sampling limits (the server's request timeout is sized from these).
const MAX_SAMPLE_SECONDS: float = 30.0
const MAX_SAMPLES: int = 200000
## How many spike frames game.perf lists (the worst ones, in time order).
const MAX_SPIKES: int = 10
## How long to wait for the next drawn frame before capturing whatever is there (low
## processor mode or an occluded window may not draw for a while).
const FRAME_WAIT_SECONDS: float = 0.5

const HEADLESS_GAME: String = ("The game runs headless (DisplayServer 'headless'), so it renders nothing to capture. " +
	"Stop it (godot_run_stop) and start it with godot_run_start headless:false; that needs a display " +
	"(on Linux a DISPLAY or WAYLAND_DISPLAY, e.g. under Xvfb).")


static func methods() -> Dictionary:
	return {
		"game.screenshot": {"fn": screenshot},
		"game.perf": {"fn": perf},
	}


# ---------------------------------------------------------------------------------------
# game.screenshot
# ---------------------------------------------------------------------------------------

## Captures the main window, a node's viewport, or a region of either.
## params: node?, region? {x, y, w, h}, max_size?, format? ("png"|"jpg"), quality?,
## save_to?, compare_to?, tolerance?. See process_image for the result.
static func screenshot(rt: Node, params: Dictionary) -> Dictionary:
	if DisplayServer.get_name() == "headless":
		return R.err(R.UNSUPPORTED, HEADLESS_GAME)
	var picked: Dictionary = _pick_viewport(rt, params)
	if R.is_err(picked):
		return picked
	var vp: Viewport = picked["value"]
	var label: String = "main window" if vp == rt.get_tree().root else rt.path_of(vp)

	# A SubViewport that doesn't update by itself (disabled, or only when visible) is asked
	# to render once for the capture; its own mode is restored afterwards.
	var sub: SubViewport = vp as SubViewport
	var prev_mode: int = -1
	if sub != null and sub.render_target_update_mode != SubViewport.UPDATE_ALWAYS:
		prev_mode = sub.render_target_update_mode
		sub.render_target_update_mode = SubViewport.UPDATE_ONCE

	# Wait for a freshly drawn frame so the capture shows the current state (the texture
	# holds the last frame rendered; just after a change it can be one frame behind).
	await _wait_frame_drawn(rt.get_tree())
	if not is_instance_valid(vp):
		return R.err(R.NOT_FOUND, "The viewport was freed while waiting for a frame. Try again.")
	if prev_mode >= 0:
		sub.render_target_update_mode = prev_mode as SubViewport.UpdateMode

	var img: Image = vp.get_texture().get_image() if vp.get_texture() != null else null
	if img == null or img.is_empty():
		return R.err(R.GODOT_ERROR, "Viewport '%s' returned no image (size %s). If it is a SubViewport, check its size and that it is in the tree." % [label, vp.get_visible_rect().size])
	# HDR 2D viewports (Forward+/Mobile only) hold linear colors; convert like Godot's own
	# debugger screenshot does (scene/debugger/scene_debugger.cpp, _msg_rq_screenshot).
	img.convert(Image.FORMAT_RGBA8)
	if vp.use_hdr_2d and RenderingServer.get_rendering_device() != null:
		img.linear_to_srgb()
	var out: Dictionary = process_image(img, params, label)
	if not R.is_err(out):
		(out["result"] as Dictionary)["frame"] = Engine.get_process_frames()
	return out


## Viewport to capture: params.node names a Viewport (SubViewport/Window), a
## SubViewportContainer (its SubViewport), or any node (the viewport it belongs to, e.g.
## the one a Camera3D renders into). Default: the main window.
static func _pick_viewport(rt: Node, params: Dictionary) -> Dictionary:
	var path: String = str(params.get("node", "")).strip_edges()
	if path.is_empty():
		return R.value(rt.get_tree().root)
	var found: Dictionary = rt.find_node(path)
	if R.is_err(found):
		return found
	var node: Node = found["value"]
	if node is Viewport:
		return R.value(node)
	if node is SubViewportContainer:
		for child: Node in node.get_children():
			if child is SubViewport:
				return R.value(child)
		return R.err(R.NOT_FOUND, "SubViewportContainer '%s' has no SubViewport child to capture." % path)
	return R.value(node.get_viewport())


## Resolves after the next frame is drawn, or after FRAME_WAIT_SECONDS at most.
static func _wait_frame_drawn(tree: SceneTree) -> void:
	var waiter := _FirstOf.new()
	RenderingServer.frame_post_draw.connect(waiter.done, CONNECT_ONE_SHOT)
	# process_always (works while paused), ignore_time_scale (works in slow motion).
	tree.create_timer(FRAME_WAIT_SECONDS, true, false, true).timeout.connect(waiter.done)
	await waiter.finished
	if RenderingServer.frame_post_draw.is_connected(waiter.done):
		RenderingServer.frame_post_draw.disconnect(waiter.done)


## Emits `finished` once, on the first of several signals connected to `done`.
class _FirstOf extends RefCounted:
	signal finished
	var _fired: bool = false

	func done() -> void:
		if _fired:
			return
		_fired = true
		finished.emit()


## Shared by the game and the editor: crop to params.region, scale down to
## params.max_size, encode (PNG or JPEG), optionally save (full resolution) and compare
## with a saved image. `img` must be RGBA8. Returns R.ok with:
##   image (base64), mime_type, width, height (returned image), scale (returned/source),
##   source {viewport, width, height}, region? {x, y, w, h}, bytes, saved_to?, diff?
static func process_image(img: Image, params: Dictionary, label: String) -> Dictionary:
	var fmt: String = str(params.get("format", "png")).to_lower()
	if not fmt in ["png", "jpg", "jpeg"]:
		return R.err(R.BAD_PARAMS, "format must be \"png\" or \"jpg\", got '%s'." % fmt)
	img.clear_mipmaps()
	var source_size: Vector2i = img.get_size()
	var offset := Vector2i.ZERO
	var result: Dictionary = {}

	# Region, in pixels of the captured viewport image (before scaling).
	var region_param: Variant = params.get("region")
	if region_param is Dictionary:
		var r: Dictionary = region_param
		var rect := Rect2i(int(r.get("x", 0)), int(r.get("y", 0)), int(r.get("w", 0)), int(r.get("h", 0)))
		var clipped: Rect2i = rect.intersection(Rect2i(Vector2i.ZERO, source_size))
		if clipped.size.x <= 0 or clipped.size.y <= 0:
			return R.err(R.BAD_PARAMS, "region %s is outside the %dx%d image of '%s'. Give x, y, w, h in its pixels (w and h > 0)." % [rect, source_size.x, source_size.y, label])
		img = img.get_region(clipped)
		offset = clipped.position
		result["region"] = {"x": clipped.position.x, "y": clipped.position.y, "w": clipped.size.x, "h": clipped.size.y}
	elif region_param != null:
		return R.err(R.BAD_PARAMS, "region must be an object {x, y, w, h} in pixels.")

	# Save first, at full resolution (a later compare_to scales the reference as needed).
	var quality: float = clampf(float(params.get("quality", 0.85)), 0.01, 1.0)
	var save_to: String = str(params.get("save_to", "")).strip_edges()
	if not save_to.is_empty():
		var saved: Dictionary = save_image(img, save_to, quality)
		if R.is_err(saved):
			return saved
		result["saved_to"] = save_to

	# Scale down so the longest side fits max_size (never up).
	var max_size: int = clampi(int(params.get("max_size", DEFAULT_MAX_SIZE)), 16, MAX_MAX_SIZE)
	var scale: float = 1.0
	var longest: int = maxi(img.get_width(), img.get_height())
	if longest > max_size:
		scale = float(max_size) / float(longest)
		img = img.duplicate() as Image
		img.resize(maxi(1, roundi(img.get_width() * scale)), maxi(1, roundi(img.get_height() * scale)), Image.INTERPOLATE_LANCZOS)

	var compare_to: String = str(params.get("compare_to", "")).strip_edges()
	if not compare_to.is_empty():
		var tolerance: int = clampi(int(params.get("tolerance", DEFAULT_TOLERANCE)), 0, 255)
		var diff: Dictionary = compare_images(img, compare_to, tolerance, scale, offset)
		if R.is_err(diff):
			return diff
		result["diff"] = diff["value"]

	var bytes: PackedByteArray
	var mime: String = "image/png"
	if fmt == "png":
		bytes = img.save_png_to_buffer()
	else:
		bytes = img.save_jpg_to_buffer(quality)
		mime = "image/jpeg"
	if bytes.is_empty():
		return R.err(R.GODOT_ERROR, "Encoding the screenshot as %s failed." % fmt)
	if bytes.size() > MAX_IMAGE_BYTES:
		return R.err(R.BAD_PARAMS, "The encoded screenshot is %d KiB, over the %d KiB limit. Use a smaller max_size, a region, or format \"jpg\"." % [bytes.size() >> 10, MAX_IMAGE_BYTES >> 10])

	result.merge({
		"image": Marshalls.raw_to_base64(bytes),
		"mime_type": mime,
		"width": img.get_width(),
		"height": img.get_height(),
		"scale": snappedf(scale, 0.0001),
		"source": {"viewport": label, "width": source_size.x, "height": source_size.y},
		"bytes": bytes.size(),
	})
	return R.ok(result)


## Checks a res:// or user:// image path. Returns R.value(extension) or an error.
static func _check_image_path(path: String, param: String) -> Dictionary:
	if not (path.begins_with("res://") or path.begins_with("user://")):
		return R.err(R.BAD_PARAMS, "%s must be a res:// or user:// path (user:// is safest for a running game), got '%s'." % [param, path])
	var ext: String = path.get_extension().to_lower()
	if not ext in ["png", "jpg", "jpeg"]:
		return R.err(R.BAD_PARAMS, "%s must end in .png, .jpg or .jpeg, got '%s'." % [param, path])
	return R.value(ext)


## Saves `img` to a res:// or user:// path as PNG or JPEG (by extension), creating folders.
static func save_image(img: Image, path: String, quality: float) -> Dictionary:
	var checked: Dictionary = _check_image_path(path, "save_to")
	if R.is_err(checked):
		return checked
	var dir_err: int = DirAccess.make_dir_recursive_absolute(path.get_base_dir())
	if dir_err != OK and dir_err != ERR_ALREADY_EXISTS:
		return R.godot_err("Creating folder %s" % path.get_base_dir(), dir_err)
	var err: int = img.save_png(path) if checked["value"] == "png" else img.save_jpg(path, quality)
	if err != OK:
		return R.godot_err("Saving %s" % path, err)
	return R.value(path)


## Loads a PNG/JPEG from a res:// or user:// path. Reads the raw file (not through the
## importer), so it works for files a game just saved and logs no "load as image" warning.
static func load_image_file(path: String) -> Dictionary:
	var checked: Dictionary = _check_image_path(path, "compare_to")
	if R.is_err(checked):
		return checked
	if not FileAccess.file_exists(path):
		return R.err(R.NOT_FOUND, "No image at '%s'. Save a reference first with save_to." % path)
	var bytes: PackedByteArray = FileAccess.get_file_as_bytes(path)
	var img := Image.new()
	var err: int = img.load_png_from_buffer(bytes) if checked["value"] == "png" else img.load_jpg_from_buffer(bytes)
	if err != OK:
		return R.godot_err("Decoding %s" % path, err)
	return R.value(img)


## Compares `current` (the returned, possibly scaled image) with the image at `path`
## (scaled to the same size if needed). A pixel counts as changed when any channel differs
## by more than `tolerance`. changed_rect is in source viewport pixels (scale and region
## offset undone), so it can be passed back as a region.
static func compare_images(current: Image, path: String, tolerance: int, scale: float, offset: Vector2i) -> Dictionary:
	var loaded: Dictionary = load_image_file(path)
	if R.is_err(loaded):
		return loaded
	var ref: Image = loaded["value"]
	var ref_size: Vector2i = ref.get_size()
	ref.convert(Image.FORMAT_RGBA8)
	var resized: bool = ref_size != current.get_size()
	if resized:
		# Same filter as the screenshot's own downscale (process_image), so a reference saved
		# at full size and a scaled capture of the same frame compare as identical.
		ref.resize(current.get_width(), current.get_height(), Image.INTERPOLATE_LANCZOS)
	var cur: Image = current
	if cur.get_format() != Image.FORMAT_RGBA8:
		cur = current.duplicate() as Image
		cur.convert(Image.FORMAT_RGBA8)

	var a: PackedByteArray = cur.get_data()
	var b: PackedByteArray = ref.get_data()
	var w: int = cur.get_width()
	var h: int = cur.get_height()
	var changed: int = 0
	var min_x: int = w
	var min_y: int = h
	var max_x: int = -1
	var max_y: int = -1
	var i: int = 0
	# Plain loop over the RGBA bytes (much faster than get_pixel). The compared image is the
	# scaled one (default <= 768 px), which keeps this to a fraction of a second.
	for y: int in h:
		for x: int in w:
			if absi(a[i] - b[i]) > tolerance or absi(a[i + 1] - b[i + 1]) > tolerance \
					or absi(a[i + 2] - b[i + 2]) > tolerance or absi(a[i + 3] - b[i + 3]) > tolerance:
				changed += 1
				min_x = mini(min_x, x)
				max_x = maxi(max_x, x)
				min_y = mini(min_y, y)
				max_y = maxi(max_y, y)
			i += 4

	var out: Dictionary = {
		"reference": path,
		"changed_percent": snappedf(100.0 * changed / float(maxi(1, w * h)), 0.01),
		"changed_pixels": changed,
		"compared_size": [w, h],
		"tolerance": tolerance,
		"changed_rect": null,
	}
	if resized:
		out["reference_size"] = [ref_size.x, ref_size.y]
		out["note"] = "The reference had a different size and was scaled to %dx%d for the comparison." % [w, h]
	if changed > 0:
		var x0: int = offset.x + floori(min_x / scale)
		var y0: int = offset.y + floori(min_y / scale)
		var x1: int = offset.x + ceili((max_x + 1) / scale)
		var y1: int = offset.y + ceili((max_y + 1) / scale)
		out["changed_rect"] = {"x": x0, "y": y0, "w": x1 - x0, "h": y1 - y0}
	return R.value(out)


# ---------------------------------------------------------------------------------------
# game.perf
# ---------------------------------------------------------------------------------------

## Performance monitor snapshot, plus per-frame sampling when params.sample_seconds > 0.
static func perf(rt: Node, params: Dictionary) -> Dictionary:
	var out: Dictionary = {"monitors": snapshot()}
	var seconds: float = float(params.get("sample_seconds", 0.0))
	if seconds > 0.0:
		out["sample"] = await _sample(rt.get_tree(), minf(seconds, MAX_SAMPLE_SECONDS))
	return R.ok(out)


static func _ms(seconds: float) -> float:
	return snappedf(seconds * 1000.0, 0.001)


static func _mib(bytes: float) -> float:
	return snappedf(bytes / 1048576.0, 0.01)


static func _mon(m: Performance.Monitor) -> float:
	return Performance.get_monitor(m)


## Current values of Godot's Performance monitors (Godot 4.7.2 list, doc/classes/
## Performance.xml), grouped and in readable units (ms, MiB). Navigation and physics groups
## are left out when they are all zero (no such servers in use), to keep the reply short.
static func snapshot() -> Dictionary:
	var out: Dictionary = {
		"time": {
			"fps": _mon(Performance.TIME_FPS),
			"process_ms": _ms(_mon(Performance.TIME_PROCESS)),
			"physics_ms": _ms(_mon(Performance.TIME_PHYSICS_PROCESS)),
			"navigation_ms": _ms(_mon(Performance.TIME_NAVIGATION_PROCESS)),
		},
		"memory": {
			"static_mib": _mib(_mon(Performance.MEMORY_STATIC)),
			"static_max_mib": _mib(_mon(Performance.MEMORY_STATIC_MAX)),
			"message_buffer_max_mib": _mib(_mon(Performance.MEMORY_MESSAGE_BUFFER_MAX)),
		},
		"objects": {
			"objects": int(_mon(Performance.OBJECT_COUNT)),
			"resources": int(_mon(Performance.OBJECT_RESOURCE_COUNT)),
			"nodes": int(_mon(Performance.OBJECT_NODE_COUNT)),
			"orphan_nodes": int(_mon(Performance.OBJECT_ORPHAN_NODE_COUNT)),
		},
		"render": {
			"objects_in_frame": int(_mon(Performance.RENDER_TOTAL_OBJECTS_IN_FRAME)),
			"primitives_in_frame": int(_mon(Performance.RENDER_TOTAL_PRIMITIVES_IN_FRAME)),
			"draw_calls_in_frame": int(_mon(Performance.RENDER_TOTAL_DRAW_CALLS_IN_FRAME)),
			"video_mem_mib": _mib(_mon(Performance.RENDER_VIDEO_MEM_USED)),
			"texture_mem_mib": _mib(_mon(Performance.RENDER_TEXTURE_MEM_USED)),
			"buffer_mem_mib": _mib(_mon(Performance.RENDER_BUFFER_MEM_USED)),
		},
		"pipeline_compilations": {
			"canvas": int(_mon(Performance.PIPELINE_COMPILATIONS_CANVAS)),
			"mesh": int(_mon(Performance.PIPELINE_COMPILATIONS_MESH)),
			"surface": int(_mon(Performance.PIPELINE_COMPILATIONS_SURFACE)),
			"draw": int(_mon(Performance.PIPELINE_COMPILATIONS_DRAW)),
			"specialization": int(_mon(Performance.PIPELINE_COMPILATIONS_SPECIALIZATION)),
		},
		"audio": {"output_latency_ms": _ms(_mon(Performance.AUDIO_OUTPUT_LATENCY))},
		"engine": {
			"frames_drawn": Engine.get_frames_drawn(),
			"max_fps": Engine.max_fps,
			"physics_ticks_per_second": Engine.physics_ticks_per_second,
			"time_scale": Engine.time_scale,
			"vsync": ["disabled", "enabled", "adaptive", "mailbox"][clampi(DisplayServer.window_get_vsync_mode(), 0, 3)],
			"display": DisplayServer.get_name(),
			"rendering_method": RenderingServer.get_current_rendering_method(),
		},
	}
	_add_nonzero(out, "physics_2d", {
		"active_objects": Performance.PHYSICS_2D_ACTIVE_OBJECTS,
		"collision_pairs": Performance.PHYSICS_2D_COLLISION_PAIRS,
		"islands": Performance.PHYSICS_2D_ISLAND_COUNT,
	})
	_add_nonzero(out, "physics_3d", {
		"active_objects": Performance.PHYSICS_3D_ACTIVE_OBJECTS,
		"collision_pairs": Performance.PHYSICS_3D_COLLISION_PAIRS,
		"islands": Performance.PHYSICS_3D_ISLAND_COUNT,
	})
	_add_nonzero(out, "navigation_2d", {
		"maps": Performance.NAVIGATION_2D_ACTIVE_MAPS,
		"regions": Performance.NAVIGATION_2D_REGION_COUNT,
		"agents": Performance.NAVIGATION_2D_AGENT_COUNT,
		"links": Performance.NAVIGATION_2D_LINK_COUNT,
		"polygons": Performance.NAVIGATION_2D_POLYGON_COUNT,
		"edges": Performance.NAVIGATION_2D_EDGE_COUNT,
		"obstacles": Performance.NAVIGATION_2D_OBSTACLE_COUNT,
	})
	_add_nonzero(out, "navigation_3d", {
		"maps": Performance.NAVIGATION_3D_ACTIVE_MAPS,
		"regions": Performance.NAVIGATION_3D_REGION_COUNT,
		"agents": Performance.NAVIGATION_3D_AGENT_COUNT,
		"links": Performance.NAVIGATION_3D_LINK_COUNT,
		"polygons": Performance.NAVIGATION_3D_POLYGON_COUNT,
		"edges": Performance.NAVIGATION_3D_EDGE_COUNT,
		"obstacles": Performance.NAVIGATION_3D_OBSTACLE_COUNT,
	})
	# Custom monitors (Performance.add_custom_monitor) are reported by name; a monitor whose
	# callable returns a non-number shows as null.
	var custom: Dictionary = {}
	for id: StringName in Performance.get_custom_monitor_names():
		var v: Variant = Performance.get_custom_monitor(id)
		custom[str(id)] = v if (v is int or v is float) else null
	if not custom.is_empty():
		out["custom"] = custom
	return out


## Adds group `key` (name -> monitor) to `out` unless every value is zero.
static func _add_nonzero(out: Dictionary, key: String, monitors: Dictionary) -> void:
	var group: Dictionary = {}
	var any: bool = false
	for name: String in monitors:
		var v: int = int(Performance.get_monitor(monitors[name]))
		group[name] = v
		any = any or v != 0
	if any:
		out[key] = group


## Records every frame for `seconds`: frame interval (wall clock between process frames),
## process/physics step times and draw calls; returns min/avg/max/p95 per metric, spikes,
## and how object/node/orphan counts and static memory moved meanwhile.
static func _sample(tree: SceneTree, seconds: float) -> Dictionary:
	var frame_ms := PackedFloat64Array()
	var process_ms := PackedFloat64Array()
	var physics_ms := PackedFloat64Array()
	var draw_calls := PackedFloat64Array()
	var t_ms := PackedFloat64Array()
	var frames := PackedInt64Array()
	var before: Dictionary = _counts()

	# Start on a frame boundary so the first interval is a whole frame.
	await tree.process_frame
	var start: int = Time.get_ticks_usec()
	var last: int = start
	var end: int = start + int(seconds * 1000000.0)
	while true:
		await tree.process_frame
		var now: int = Time.get_ticks_usec()
		frame_ms.append((now - last) / 1000.0)
		t_ms.append(snappedf((now - start) / 1000.0, 0.1))
		frames.append(Engine.get_process_frames())
		process_ms.append(Performance.get_monitor(Performance.TIME_PROCESS) * 1000.0)
		physics_ms.append(Performance.get_monitor(Performance.TIME_PHYSICS_PROCESS) * 1000.0)
		draw_calls.append(Performance.get_monitor(Performance.RENDER_TOTAL_DRAW_CALLS_IN_FRAME))
		last = now
		if now >= end or frame_ms.size() >= MAX_SAMPLES:
			break

	var after: Dictionary = _counts()
	var duration_s: float = (last - start) / 1000000.0
	var frame_stats: Dictionary = _stats(frame_ms)
	var out: Dictionary = {
		"seconds": snappedf(duration_s, 0.001),
		"frames": frame_ms.size(),
		"avg_fps": snappedf(frame_ms.size() / maxf(duration_s, 0.000001), 0.1),
		"frame_ms": frame_stats,
		"process_ms": _stats(process_ms),
		"physics_ms": _stats(physics_ms),
		"draw_calls": _stats(draw_calls),
		"delta": {
			"objects": after["objects"] - before["objects"],
			"nodes": after["nodes"] - before["nodes"],
			"orphan_nodes": after["orphan_nodes"] - before["orphan_nodes"],
			"static_memory_mib": snappedf(after["static_mib"] - before["static_mib"], 0.01),
		},
	}

	# Spikes: frames that took at least twice the median frame interval and 4 ms more than
	# it (the absolute margin keeps tiny jitter on very fast frames from counting).
	var median: float = frame_stats["median"]
	var threshold: float = maxf(median * 2.0, median + 4.0)
	var spikes: Array = []
	for i: int in frame_ms.size():
		if frame_ms[i] >= threshold:
			spikes.append(i)
	out["spike_threshold_ms"] = snappedf(threshold, 0.001)
	out["spike_count"] = spikes.size()
	if not spikes.is_empty():
		# Keep the worst MAX_SPIKES, then list them in time order.
		spikes.sort_custom(func(x: int, y: int) -> bool: return frame_ms[x] > frame_ms[y])
		spikes = spikes.slice(0, MAX_SPIKES)
		spikes.sort()
		var listed: Array = []
		for i: int in spikes:
			listed.append({
				"t_ms": t_ms[i],
				"frame": frames[i],
				"frame_ms": snappedf(frame_ms[i], 0.001),
				"process_ms": snappedf(process_ms[i], 0.001),
				"physics_ms": snappedf(physics_ms[i], 0.001),
			})
		out["spikes"] = listed
	return out


static func _counts() -> Dictionary:
	return {
		"objects": int(Performance.get_monitor(Performance.OBJECT_COUNT)),
		"nodes": int(Performance.get_monitor(Performance.OBJECT_NODE_COUNT)),
		"orphan_nodes": int(Performance.get_monitor(Performance.OBJECT_ORPHAN_NODE_COUNT)),
		"static_mib": _mib(Performance.get_monitor(Performance.MEMORY_STATIC)),
	}


## min / avg / median / p95 / max of a series (nearest-rank percentiles), 3 decimals.
static func _stats(values: PackedFloat64Array) -> Dictionary:
	if values.is_empty():
		return {"min": 0.0, "avg": 0.0, "median": 0.0, "p95": 0.0, "max": 0.0}
	var sorted: PackedFloat64Array = values.duplicate()
	sorted.sort()
	var total: float = 0.0
	for v: float in sorted:
		total += v
	var n: int = sorted.size()
	return {
		"min": snappedf(sorted[0], 0.001),
		"avg": snappedf(total / n, 0.001),
		"median": snappedf(sorted[n >> 1], 0.001),
		"p95": snappedf(sorted[mini(n - 1, ceili(n * 0.95) - 1)], 0.001),
		"max": snappedf(sorted[n - 1], 0.001),
	}
