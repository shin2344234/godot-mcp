extends RefCounted
## Runtime methods: input injection, timing and input recording/replay.
## Server side: server/src/ops/gameInput.ts (godot_game_input, godot_game_time,
## godot_game_record); reference: docs/methods/game-input.md.
## See runtime/mcp_runtime.gd for the method contract and helpers (find_node, encode...).
##
## How injected input reaches the game (verified against Godot 4.7.2 source):
##   Input.parse_input_event(ev) updates the Input singleton (action states, pressed keys,
##   mouse position, touch/mouse emulation) and buffers the event (input accumulation is on
##   by default). Input.flush_buffered_events() then hands it to the DisplayServer's event
##   dispatch, which calls the main Window's input callback -> Window._window_input ->
##   emits `window_input` -> Viewport.push_input: _input, GUI (_gui_input / button
##   signals), _shortcut_input, _unhandled_key_input, _unhandled_input, physics picking.
##   The headless DisplayServer wires the same callback (display_server_headless.cpp), so
##   all of this also works in --headless runs. Positions in mouse/touch events are window
##   pixels; Viewport._make_input_local applies get_final_transform().affine_inverse(), so
##   we convert viewport coordinates with root.get_final_transform() before sending.
##
## Mouse position: Viewport.get_mouse_position() of the main window does NOT come from the
## events. For a viewport attached to the screen on a DisplayServer with FEATURE_MOUSE (any
## windowed game), Godot 4.7.2 computes it from DisplayServer.mouse_get_position(), i.e. the
## real OS pointer (scene/main/viewport.cpp, Viewport::get_mouse_position). Injected events
## alone therefore left get_mouse_position() at wherever the OS pointer was (the window
## center under Xvfb), and a game that aims with it always shot the center. So before every
## injected mouse event we also warp the OS pointer to the event's position
## (Input.warp_mouse, window pixels; see _warp_pointer). Headless runs have no FEATURE_MOUSE,
## and there the viewport uses the last event position, which already worked. Side effect of
## the warp in a window: the OS reports the pointer move back, so the game may see one extra
## InputEventMouseMotion at the same position (with an OS-computed `relative`), and a game
## recording (record.start) captures it too.
##
## Timing: events are only sent right after `await tree.process_frame`. That signal fires at
## the start of SceneTree.process(), before nodes' _process(), so Input.is_action_just_pressed()
## is true in that frame's _process() (and in the next physics tick), exactly like a real key
## press. Sending straight from the request handler would be wrong: requests are handled in
## the debugger poll at the END of a frame, right before the frame counter increments, so a
## "just pressed" would be missed. A tap keeps the input pressed until at least one physics
## tick and one process frame have run, so both _process and _physics_process see it.

const R := preload("../../core/mcp_result.gd")

## Recording cap (mouse motion is chatty: ~60 events/s while the mouse moves).
const MAX_RECORDED_EVENTS: int = 20000
## Format version of recordings produced by record.stop.
const RECORDING_VERSION: int = 1
## Upper bound for one `wait` step / frame counts, so a typo can't hang the runtime.
const MAX_WAIT_MS: float = 120000.0
const MAX_FRAMES: int = 10000

## Warning for input sent while the game is suspended (see input_run).
const PAUSED_INPUT_DROPPED: String = ("The game is paused (godot_game_time pause), so Godot discarded these input events: " +
	"input is disabled while paused and events are not queued, so stepping frames will not apply them. " +
	"Resume first (godot_game_time action \"resume\"), then send the input again.")

const STEP_TYPES: Array[String] = ["key", "action", "move", "click", "drag", "scroll", "text", "joy_button", "joy_axis", "touch", "wait"]

const MOUSE_BUTTONS: Dictionary = {
	"left": MOUSE_BUTTON_LEFT, "right": MOUSE_BUTTON_RIGHT, "middle": MOUSE_BUTTON_MIDDLE,
	"x1": MOUSE_BUTTON_XBUTTON1, "x2": MOUSE_BUTTON_XBUTTON2,
}
const WHEEL_BUTTONS: Dictionary = {
	"up": MOUSE_BUTTON_WHEEL_UP, "down": MOUSE_BUTTON_WHEEL_DOWN,
	"left": MOUSE_BUTTON_WHEEL_LEFT, "right": MOUSE_BUTTON_WHEEL_RIGHT,
}
## SDL-style names, same values as Godot's JoyButton enum (core/input/input_enums.h).
const JOY_BUTTONS: Dictionary = {
	"a": JOY_BUTTON_A, "b": JOY_BUTTON_B, "x": JOY_BUTTON_X, "y": JOY_BUTTON_Y,
	"back": JOY_BUTTON_BACK, "guide": JOY_BUTTON_GUIDE, "start": JOY_BUTTON_START,
	"left_stick": JOY_BUTTON_LEFT_STICK, "right_stick": JOY_BUTTON_RIGHT_STICK,
	"left_shoulder": JOY_BUTTON_LEFT_SHOULDER, "right_shoulder": JOY_BUTTON_RIGHT_SHOULDER,
	"dpad_up": JOY_BUTTON_DPAD_UP, "dpad_down": JOY_BUTTON_DPAD_DOWN,
	"dpad_left": JOY_BUTTON_DPAD_LEFT, "dpad_right": JOY_BUTTON_DPAD_RIGHT,
}
const JOY_AXES: Dictionary = {
	"left_x": JOY_AXIS_LEFT_X, "left_y": JOY_AXIS_LEFT_Y, "right_x": JOY_AXIS_RIGHT_X,
	"right_y": JOY_AXIS_RIGHT_Y, "trigger_left": JOY_AXIS_TRIGGER_LEFT, "trigger_right": JOY_AXIS_TRIGGER_RIGHT,
}

## The active recording, or empty: {"start_us", "events": Array, "truncated", "cb": Callable}.
static var _rec: Dictionary = {}
## True once the headless root viewport has been given the project's window size.
static var _sized: bool = false
## Last mouse position we injected, in window pixels (for InputEventMouseMotion.relative).
static var _mouse: Vector2 = Vector2.ZERO
## Distance (viewport px) above which a move/click reports that get_mouse_position() still
## disagrees with the injected position after the warp (e.g. the OS refused the warp).
const POINTER_MISMATCH_PX: float = 1.5


static func methods() -> Dictionary:
	return {
		"input.run": {"fn": input_run},
		"time.state": {"fn": time_state},
		"time.step_wait": {"fn": time_step_wait},
		"time.wait_for": {"fn": time_wait_for},
		"record.start": {"fn": record_start},
		"record.stop": {"fn": record_stop},
		"record.replay": {"fn": record_replay},
	}


# =======================================================================================
# input.run: a sequence of input steps
# =======================================================================================

## params: {"steps": [{"type": "click", "at": [x, y] | "Node/Path", ...}, ...]}
## Every step is validated before the first one runs, so a typo in step 5 doesn't leave the
## game half-way through a sequence. Returns per-step results plus elapsed time/frames.
static func input_run(rt: Node, params: Dictionary) -> Dictionary:
	var raw: Variant = params.get("steps", [])
	if not raw is Array or (raw as Array).is_empty():
		return R.err(R.BAD_PARAMS, "input.run: 'steps' must be a non-empty array, e.g. [{\"type\": \"key\", \"key\": \"Space\"}].")
	var steps: Array = []
	var i: int = 0
	for s: Variant in raw:
		var parsed: Dictionary = _parse_step(s, i)
		if R.is_err(parsed):
			return parsed
		steps.append(parsed["value"])
		i += 1

	var tree: SceneTree = rt.get_tree()
	var warnings: Array = []
	var note: String = await _ensure_window_size(rt)
	if note != "":
		warnings.append(note)
	# While the whole game is suspended (godot_game_time pause), Godot's SceneDebugger
	# disables the root viewport's input and no node can process, so every event below is
	# DROPPED, not queued: stepping frames afterwards does not deliver it. (The old warning
	# suggested stepping, which misled the agent into thinking the input would apply.)
	var suspended: bool = not rt.can_process()
	if suspended:
		warnings.append(PAUSED_INPUT_DROPPED)
	elif tree.paused:
		warnings.append("SceneTree.paused is true: only nodes with process_mode Always/When Paused receive input.")

	var start_ms: int = Time.get_ticks_msec()
	var start_frame: int = Engine.get_process_frames()
	var results: Array = []
	# Sync to the start of a frame first (see "Timing" in the header comment).
	await tree.process_frame
	for st: Dictionary in steps:
		var out: Dictionary = await _run_step(rt, st)
		if R.is_err(out):
			var e: Dictionary = out["error"]
			e["message"] = "steps[%d] (%s): %s" % [results.size(), st["type"], e["message"]]
			if not e.has("data"):
				e["data"] = {"completed": results}
			return out
		results.append(out["value"])
	var result: Dictionary = {
		"steps": results,
		"elapsed_ms": Time.get_ticks_msec() - start_ms,
		"frames": Engine.get_process_frames() - start_frame,
		"viewport": _vec(tree.root.get_visible_rect().size),
	}
	# With a stretch mode (display/window/stretch/mode) the game's coordinates, which `at`
	# uses, are not window pixels: a 640x360 game in a 1280x720 window. Screenshots are
	# captured at window resolution (canvas_items stretch), so `region` and screenshot sizes
	# are in window pixels; say so here once, next to `viewport`, when the two differ.
	var window := Vector2(tree.root.size)
	if not window.is_equal_approx(tree.root.get_visible_rect().size):
		result["window"] = _vec(window)
	if suspended:
		# Machine-readable twin of the warning: nothing reached the game.
		result["discarded"] = true
	if not warnings.is_empty():
		result["warnings"] = warnings
	return R.ok(result)


## Validates one step and resolves names (keys, buttons, actions) to engine values.
## Positions are resolved when the step runs, because nodes move.
static func _parse_step(s: Variant, i: int) -> Dictionary:
	if not s is Dictionary:
		return R.err(R.BAD_PARAMS, "steps[%d] must be an object like {\"type\": \"click\", \"at\": \"StartButton\"}." % i)
	var st: Dictionary = (s as Dictionary).duplicate()
	var t: String = str(st.get("type", ""))
	var where: String = "steps[%d] (%s)" % [i, t]
	if not t in STEP_TYPES:
		return R.err(R.BAD_PARAMS, "steps[%d]: unknown type '%s'. Valid types: %s." % [i, t, ", ".join(STEP_TYPES)])
	var phase: String = str(st.get("phase", "tap"))
	if not phase in ["tap", "press", "release"]:
		return R.err(R.BAD_PARAMS, "%s: phase must be tap, press or release (got '%s')." % [where, phase])
	st["phase"] = phase
	# "_has_ms": drag/touch use a default duration when ms is not given.
	st["_has_ms"] = st.has("ms")
	st["ms"] = clampf(float(st.get("ms", 0.0)), 0.0, MAX_WAIT_MS)
	match t:
		"key":
			var key: String = str(st.get("key", ""))
			var code: int = OS.find_keycode_from_string(key)
			if key == "" or (code & KEY_CODE_MASK) == 0:
				return R.err(R.BAD_PARAMS, "%s: unknown key '%s'. Use Godot key names such as Space, Enter, Escape, Tab, Left, Up, A, 1, F1, Shift, or combos like Ctrl+S / Shift+Tab." % [where, key])
			st["_code"] = code
		"action":
			var action: String = str(st.get("action", ""))
			if not InputMap.has_action(action):
				return R.err(R.BAD_PARAMS, "%s: the game has no input action '%s'. %s" % [where, action, _actions_hint()], {"actions": _action_names()})
		"move", "click":
			if not st.has("at"):
				return R.err(R.BAD_PARAMS, "%s: needs 'at': [x, y] in viewport pixels or a node path like \"UI/StartButton\" (clicks its center)." % where)
		"drag":
			if not st.has("at") or not st.has("to"):
				return R.err(R.BAD_PARAMS, "%s: needs 'at' (start) and 'to' (end), each [x, y] or a node path." % where)
		"text":
			if str(st.get("text", "")) == "":
				return R.err(R.BAD_PARAMS, "%s: needs 'text' (the string to type into the focused control)." % where)
		"joy_axis":
			var axis: Variant = _lookup(st.get("axis"), JOY_AXES)
			if axis == null:
				return R.err(R.BAD_PARAMS, "%s: 'axis' must be one of %s (or an axis number)." % [where, ", ".join(JOY_AXES.keys())])
			st["_axis"] = axis
			if not st.has("value"):
				return R.err(R.BAD_PARAMS, "%s: needs 'value' (-1..1; triggers 0..1)." % where)
		"wait":
			if not st["_has_ms"] and not st.has("frames"):
				return R.err(R.BAD_PARAMS, "%s: needs 'ms' or 'frames'." % where)
	if t in ["click", "drag", "move"] or (t == "scroll" and st.has("button")):
		var table: Dictionary = WHEEL_BUTTONS if t == "scroll" else MOUSE_BUTTONS
		var b: Variant = _lookup(st.get("button", "down" if t == "scroll" else "left"), table)
		if b == null:
			return R.err(R.BAD_PARAMS, "%s: 'button' must be one of %s." % [where, ", ".join(table.keys())])
		st["_button"] = b
	elif t == "scroll":
		st["_button"] = MOUSE_BUTTON_WHEEL_DOWN
	elif t == "joy_button":
		var jb: Variant = _lookup(st.get("button"), JOY_BUTTONS)
		if jb == null:
			return R.err(R.BAD_PARAMS, "%s: 'button' must be one of %s (or a button number 0-127)." % [where, ", ".join(JOY_BUTTONS.keys())])
		st["_button"] = jb
	return R.value(st)


## A name from `table`, or a number (as int/float/numeric string). null when invalid.
static func _lookup(v: Variant, table: Dictionary) -> Variant:
	if v is int or v is float:
		return int(v)
	var s: String = str(v).to_lower() if v != null else ""
	if table.has(s):
		return table[s]
	if s.is_valid_int():
		return s.to_int()
	return null


## Runs one validated step. Coroutine; returns {"value": result} or an error.
static func _run_step(rt: Node, st: Dictionary) -> Dictionary:
	var tree: SceneTree = rt.get_tree()
	var root: Window = tree.root
	var t: String = st["type"]
	var phase: String = st["phase"]
	var ms: float = st["ms"]
	var res: Dictionary = {"type": t}
	match t:
		"wait":
			var start: int = Time.get_ticks_msec()
			var frames: int = clampi(int(st.get("frames", 0)), 0, MAX_FRAMES)
			for _f: int in frames:
				await tree.process_frame
			if ms > 0.0:
				await _sleep(rt, ms)
			res["elapsed_ms"] = Time.get_ticks_msec() - start

		"key":
			var code: int = st["_code"]
			res["key"] = st["key"]
			var mods: Array[int] = _modifier_keys(code)
			if phase != "release":
				var held: int = 0
				for m: int in mods:
					held |= _mask_of(m)
					_send(_key_event(m | held, true, false))
				var down: InputEventKey = _key_event(code, true, true)
				_send(down)
				_put_consumed(root, res)
				# Which input actions this key triggers (InputMap.event_is_action), so the
				# result confirms the binding the game polls ("Right" -> move_right, ui_right).
				var acts: Array = _actions_of(down)
				if not acts.is_empty():
					res["actions"] = acts
			if phase == "tap":
				await _hold(rt, ms)
			if phase != "press":
				_send(_key_event(code, false, false))
				var rel: Array[int] = mods.duplicate()
				rel.reverse()
				var held_r: int = code & KEY_MODIFIER_MASK
				for m: int in rel:
					held_r &= ~_mask_of(m)
					_send(_key_event(m | held_r, false, false))

		"action":
			var action: String = st["action"]
			res["action"] = action
			if phase != "release":
				var ev := InputEventAction.new()
				ev.action = StringName(action)
				ev.pressed = true
				ev.strength = clampf(float(st.get("value", 1.0)), 0.0, 1.0)
				_send(ev)
				_put_consumed(root, res)
				res["pressed"] = Input.is_action_pressed(action)
			if phase == "tap":
				await _hold(rt, ms)
			if phase != "press":
				var up := InputEventAction.new()
				up.action = StringName(action)
				up.pressed = false
				_send(up)

		"move":
			var p: Dictionary = _resolve_pos(rt, st["at"])
			if R.is_err(p):
				return p
			_move_to(root, p["value"], Input.get_mouse_button_mask())
			res["at"] = _vec(p["value"])
			_add_target(res, p)
			res["hovered"] = _path_or_null(rt, root.gui_get_hovered_control())
			_put_physics(rt, root, p["value"], res)
			_check_pointer(root, p["value"], res)

		"click":
			var p: Dictionary = _resolve_pos(rt, st["at"])
			if R.is_err(p):
				return p
			var pos: Vector2 = p["value"]
			var button: int = st["_button"]
			res["at"] = _vec(pos)
			_add_target(res, p)
			# Hover first (mouse_entered, hover state), then press on the next frame like a user.
			_move_to(root, pos, Input.get_mouse_button_mask())
			await tree.process_frame
			# Physics objects under the pointer, looked up BEFORE the click: a click can free
			# what it hits (a coin collected on click, a "Restart" button reloading the scene).
			_put_physics(rt, root, pos, res)
			# The hovered Control before the press, as a fallback for `hit`: Viewport can drop
			# its hover state with a deferred call (Viewport._drop_mouse_over while enter/exit
			# notifications are being sent), and in the e2e test a click right after the
			# headless resize then read gui_get_hovered_control() == null although the press
			# reached the button.
			var hovered_before: Control = root.gui_get_hovered_control()
			var double: bool = bool(st.get("double", false))
			# Everything about the hit Control is captured right after the press is delivered,
			# as plain strings/bools: when the click reloads the scene (a "Play again" button),
			# the Control is freed during the hold/release below, and reading its path
			# afterwards gave "" (the old report showed hit: "").
			var hit_path: Variant = null
			var hit_target: Variant = null
			var handled: bool = false
			for n: int in (2 if double else 1):
				if phase != "release":
					_send(_mouse_button(root, pos, button, true, n == 1))
					if n == 0:
						var hit: Control = root.gui_get_hovered_control()
						if hit == null and is_instance_valid(hovered_before):
							hit = hovered_before
						handled = root.is_input_handled()
						hit_path = _path_or_null(rt, hit)
						if p.has("node") and hit != null:
							var target: Node = p["node"]
							hit_target = hit == target or target.is_ancestor_of(hit)
				if phase == "tap":
					await _hold(rt, ms)
				if phase != "press":
					_send(_mouse_button(root, pos, button, false, false))
				if double and n == 0:
					await tree.process_frame
			res["hit"] = hit_path
			if handled:
				res["handled"] = true
			if hit_target != null:
				res["hit_target"] = hit_target
			_check_pointer(root, pos, res)

		"drag":
			var a: Dictionary = _resolve_pos(rt, st["at"])
			if R.is_err(a):
				return a
			var b: Dictionary = _resolve_pos(rt, st["to"])
			if R.is_err(b):
				return b
			var from: Vector2 = a["value"]
			var to: Vector2 = b["value"]
			var button: int = st["_button"]
			var n_steps: int = clampi(int(st.get("steps", 10)), 1, 1000)
			var dur: float = ms if st["_has_ms"] else 300.0
			res["at"] = _vec(from)
			res["to"] = _vec(to)
			_move_to(root, from, Input.get_mouse_button_mask())
			await tree.process_frame
			_send(_mouse_button(root, from, button, true, false))
			res["hit"] = _path_or_null(rt, root.gui_get_hovered_control())
			await _hold(rt, 0.0)
			for k: int in range(1, n_steps + 1):
				_move_to(root, from.lerp(to, float(k) / n_steps), Input.get_mouse_button_mask())
				await _sleep(rt, dur / n_steps)
			_send(_mouse_button(root, to, button, false, false))
			res["released_on"] = _path_or_null(rt, root.gui_get_hovered_control())

		"scroll":
			if st.has("at"):
				var p: Dictionary = _resolve_pos(rt, st["at"])
				if R.is_err(p):
					return p
				_move_to(root, p["value"], Input.get_mouse_button_mask())
				res["at"] = _vec(p["value"])
				await tree.process_frame
			var wheel: int = st["_button"]
			var pos: Vector2 = root.get_mouse_position()
			var clicks: int = clampi(int(st.get("value", 1)), 1, 100)
			for _c: int in clicks:
				var down := _mouse_button(root, pos, wheel, true, false)
				down.factor = 1.0
				_send(down)
				var up := _mouse_button(root, pos, wheel, false, false)
				up.factor = 1.0
				_send(up)
				await tree.process_frame
			res["hit"] = _path_or_null(rt, root.gui_get_hovered_control())

		"text":
			var text: String = str(st["text"])
			var focus: Control = root.gui_get_focus_owner()
			for k: int in text.length():
				var c: int = text.unicode_at(k)
				if c == 10 or c == 13:
					_send(_key_event(KEY_ENTER, true, false))
					_send(_key_event(KEY_ENTER, false, false))
				elif c == 9:
					_send(_key_event(KEY_TAB, true, false))
					_send(_key_event(KEY_TAB, false, false))
				else:
					_send(_char_event(c, true))
					_send(_char_event(c, false))
			await tree.process_frame
			res["focus"] = _path_or_null(rt, focus)
			if focus == null:
				res["warning"] = "No Control had keyboard focus, so nothing received the text. Click the field first (or call grab_focus())."
			elif "text" in focus:
				res["text"] = str(focus.get("text")).left(200)

		"joy_button":
			var device: int = int(st.get("device", 0))
			var jb: int = st["_button"]
			res["button"] = st["button"]
			if phase != "release":
				var jdown: InputEventJoypadButton = _joy_button(device, jb, true)
				_send(jdown)
				_put_consumed(root, res)
				var jacts: Array = _actions_of(jdown)
				if not jacts.is_empty():
					res["actions"] = jacts
			if phase == "tap":
				await _hold(rt, ms)
			if phase != "press":
				_send(_joy_button(device, jb, false))

		"joy_axis":
			var device: int = int(st.get("device", 0))
			var axis: int = st["_axis"]
			var ev := InputEventJoypadMotion.new()
			ev.device = device
			ev.axis = axis as JoyAxis
			ev.axis_value = clampf(float(st["value"]), -1.0, 1.0)
			_send(ev)
			res["axis"] = st["axis"]
			res["value"] = ev.axis_value
			if ms > 0.0:
				# Hold for `ms`, then return the stick to center.
				await _sleep(rt, ms)
				var back := InputEventJoypadMotion.new()
				back.device = device
				back.axis = axis as JoyAxis
				back.axis_value = 0.0
				_send(back)

		"touch":
			var index: int = int(st.get("device", 0))
			var a: Dictionary = _resolve_pos(rt, st.get("at", _vec(root.get_mouse_position())))
			if R.is_err(a):
				return a
			var from: Vector2 = a["value"]
			res["at"] = _vec(from)
			_add_target(res, a)
			if phase != "release" or st.has("to"):
				_send(_touch(root, index, from, true))
				res["hit"] = _path_or_null(rt, root.gui_get_hovered_control())
			var last: Vector2 = from
			if st.has("to"):
				var b: Dictionary = _resolve_pos(rt, st["to"])
				if R.is_err(b):
					return b
				var to: Vector2 = b["value"]
				res["to"] = _vec(to)
				var n_steps: int = clampi(int(st.get("steps", 10)), 1, 1000)
				var dur: float = ms if st["_has_ms"] else 300.0
				await _hold(rt, 0.0)
				for k: int in range(1, n_steps + 1):
					var pt: Vector2 = from.lerp(to, float(k) / n_steps)
					var drag := InputEventScreenDrag.new()
					drag.index = index
					drag.position = _to_window(root, pt)
					drag.relative = _to_window(root, pt) - _to_window(root, last)
					drag.screen_relative = drag.relative
					drag.pressure = 1.0
					_send(drag)
					last = pt
					await _sleep(rt, dur / n_steps)
			elif phase == "tap":
				await _hold(rt, ms)
			if phase != "press" or st.has("to"):
				_send(_touch(root, index, last, false))
	return R.value(res)


# ---------------------------------------------------------------------------------------
# Event helpers
# ---------------------------------------------------------------------------------------

## Delivers one event now (we're right after process_frame, see the header comment).
## Mouse events also carry the modifier keys currently held (a "Shift" key step + click
## gives a shift-click, like a real keyboard).
static func _send(ev: InputEvent) -> void:
	if ev is InputEventMouse or ev is InputEventGesture:
		var m: InputEventWithModifiers = ev
		m.shift_pressed = m.shift_pressed or Input.is_key_pressed(KEY_SHIFT)
		m.ctrl_pressed = m.ctrl_pressed or Input.is_key_pressed(KEY_CTRL)
		m.alt_pressed = m.alt_pressed or Input.is_key_pressed(KEY_ALT)
		m.meta_pressed = m.meta_pressed or Input.is_key_pressed(KEY_META)
	# Move the real pointer first, so get_mouse_position() already matches while the game
	# handles the event (see "Mouse position" in the header comment).
	if ev is InputEventMouse:
		_warp_pointer((ev as InputEventMouse).position)
	Input.parse_input_event(ev)
	Input.flush_buffered_events()


## Warps the OS pointer to `window_pos` (window pixels, what mouse events carry), so that
## Viewport.get_mouse_position() reports the injected position in a windowed game.
## Skipped where it isn't needed or can't work:
##   - headless (no FEATURE_MOUSE): the viewport already uses the last event's position;
##   - MOUSE_MODE_CAPTURED: the pointer is locked to the window center and games read
##     `relative` instead (DisplayServer only records the position then, no harm either way);
##   - no change since the last warp/real position, to avoid needless OS round trips.
## Input.warp_mouse() is relative to the focused game window (DisplayServerX11 warps in
## the last focused or the main window; on Windows it is skipped when no game window has
## focus), so it is best effort: _check_pointer reports when it didn't take effect.
static func _warp_pointer(window_pos: Vector2) -> void:
	if DisplayServer.get_name() == "headless" or not DisplayServer.has_feature(DisplayServer.FEATURE_MOUSE):
		return
	if Input.mouse_mode == Input.MOUSE_MODE_CAPTURED:
		return
	var w := Vector2i(window_pos.round())
	if Vector2i(DisplayServer.mouse_get_position() - DisplayServer.window_get_position()) == w:
		return
	Input.warp_mouse(Vector2(w))


## After a move/click: if the game's get_mouse_position() still isn't where we pointed
## (warp refused by the OS, captured mouse, a window manager moving things), say so in the
## step result instead of letting the agent assume the aim worked.
static func _check_pointer(root: Window, pos: Vector2, res: Dictionary) -> void:
	if DisplayServer.get_name() == "headless" or Input.mouse_mode == Input.MOUSE_MODE_CAPTURED:
		return
	var actual: Vector2 = root.get_mouse_position()
	if actual.distance_to(pos) > POINTER_MISMATCH_PX:
		res["mouse_position"] = _vec(actual)
		res["warning"] = ("get_viewport().get_mouse_position() reads %s, not %s: the OS pointer could not be moved there " +
			"(is the game window focused and on screen?). Event positions (event.position) are still correct.") % [_vec(actual), _vec(pos)]


## Waits `ms` real milliseconds (unaffected by time scale or pause), then syncs to the start
## of a frame so the next event is sent at the right moment.
static func _sleep(rt: Node, ms: float) -> void:
	var tree: SceneTree = rt.get_tree()
	if ms > 0.0:
		# process_always (runs while SceneTree.paused), not in physics, ignore_time_scale.
		await tree.create_timer(ms / 1000.0, true, false, true).timeout
	await tree.process_frame


## Keeps a press down long enough to be seen: `ms` (if any), then at least one physics tick
## (_physics_process polling) and one process frame (_process polling).
static func _hold(rt: Node, ms: float) -> void:
	var tree: SceneTree = rt.get_tree()
	if ms > 0.0:
		await tree.create_timer(ms / 1000.0, true, false, true).timeout
	await tree.physics_frame
	await tree.process_frame


## Key event for a keycode that may carry modifier masks (OS.find_keycode_from_string
## returns e.g. KEY_S | KEY_MASK_CTRL for "Ctrl+S"). keycode, physical_keycode and
## key_label are all set, because project input maps usually bind physical keys.
static func _key_event(code: int, pressed: bool, with_unicode: bool) -> InputEventKey:
	var k := InputEventKey.new()
	var base: int = code & KEY_CODE_MASK
	k.keycode = base as Key
	k.physical_keycode = base as Key
	k.key_label = base as Key
	k.pressed = pressed
	k.shift_pressed = (code & KEY_MASK_SHIFT) != 0
	k.ctrl_pressed = (code & KEY_MASK_CTRL) != 0
	k.alt_pressed = (code & KEY_MASK_ALT) != 0
	k.meta_pressed = (code & KEY_MASK_META) != 0
	# Printable keys without Ctrl/Alt/Meta also carry the character (text fields need it).
	if with_unicode and pressed and base >= 32 and base <= 126 and not (k.ctrl_pressed or k.alt_pressed or k.meta_pressed):
		var u: int = base
		if base >= KEY_A and base <= KEY_Z and not k.shift_pressed:
			u = base + 32 # lowercase letter
		k.unicode = u
	return k


## Key event that types one character (text step). ASCII letters/digits/space also get a
## keycode so games that read keycodes see them; other characters are unicode-only.
static func _char_event(c: int, pressed: bool) -> InputEventKey:
	var k := InputEventKey.new()
	var code: int = 0
	if c >= 97 and c <= 122:
		code = c - 32 # a-z -> KEY_A..KEY_Z
	elif (c >= 65 and c <= 90) or (c >= 48 and c <= 57) or c == 32:
		code = c
		k.shift_pressed = c >= 65 and c <= 90
	k.keycode = code as Key
	k.physical_keycode = code as Key
	k.key_label = code as Key
	k.pressed = pressed
	if pressed:
		k.unicode = c
	return k


## Modifier keys contained in a keycode's mask, in press order.
static func _modifier_keys(code: int) -> Array[int]:
	var out: Array[int] = []
	if code & KEY_MASK_CTRL:
		out.append(KEY_CTRL)
	if code & KEY_MASK_ALT:
		out.append(KEY_ALT)
	if code & KEY_MASK_SHIFT:
		out.append(KEY_SHIFT)
	if code & KEY_MASK_META:
		out.append(KEY_META)
	return out


static func _mask_of(modifier_key: int) -> int:
	match modifier_key:
		KEY_CTRL:
			return KEY_MASK_CTRL
		KEY_ALT:
			return KEY_MASK_ALT
		KEY_SHIFT:
			return KEY_MASK_SHIFT
		KEY_META:
			return KEY_MASK_META
	return 0


static func _mouse_button(root: Window, pos: Vector2, button: int, pressed: bool, double: bool) -> InputEventMouseButton:
	var mb := InputEventMouseButton.new()
	var w: Vector2 = _to_window(root, pos)
	mb.position = w
	mb.global_position = w
	mb.button_index = button as MouseButton
	mb.pressed = pressed
	mb.double_click = double
	# MouseButtonMask bit for button b is 1 << (b - 1) for every button, wheel included.
	var bit: int = 1 << (button - 1)
	var mask: int = Input.get_mouse_button_mask()
	mb.button_mask = ((mask | bit) if pressed else (mask & ~bit)) as MouseButtonMask
	return mb


static func _move_to(root: Window, pos: Vector2, mask: int) -> void:
	var w: Vector2 = _to_window(root, pos)
	var mm := InputEventMouseMotion.new()
	mm.position = w
	mm.global_position = w
	mm.relative = w - _mouse
	mm.screen_relative = mm.relative
	mm.button_mask = mask as MouseButtonMask
	_mouse = w
	_send(mm)


static func _touch(root: Window, index: int, pos: Vector2, pressed: bool) -> InputEventScreenTouch:
	var st := InputEventScreenTouch.new()
	st.index = index
	st.position = _to_window(root, pos)
	st.pressed = pressed
	return st


static func _joy_button(device: int, button: int, pressed: bool) -> InputEventJoypadButton:
	var jb := InputEventJoypadButton.new()
	jb.device = device
	jb.button_index = button as JoyButton
	jb.pressed = pressed
	jb.pressure = 1.0 if pressed else 0.0
	return jb


## Viewport coordinates (what nodes see in event.position / get_mouse_position()) ->
## window pixels (what Input.parse_input_event expects for the main window).
static func _to_window(root: Window, pos: Vector2) -> Vector2:
	return root.get_final_transform() * pos


## Resolves a step position: [x, y] (viewport pixels) or a node path (its center on screen).
## Returns {"value": Vector2, "node"?: Node, "offscreen"?: true}.
static func _resolve_pos(rt: Node, at: Variant) -> Dictionary:
	if at is Array and (at as Array).size() == 2:
		return R.value(Vector2(float(at[0]), float(at[1])))
	if at is Dictionary and (at as Dictionary).has("x") and (at as Dictionary).has("y"):
		return R.value(Vector2(float(at["x"]), float(at["y"])))
	if not at is String:
		return R.err(R.BAD_PARAMS, "positions are [x, y] in viewport pixels or a node path string (got %s)." % JSON.stringify(at))
	var found: Dictionary = rt.find_node(at)
	if R.is_err(found):
		return found
	var node: Node = found["value"]
	var pos: Vector2
	if node is Control:
		var c: Control = node
		if not c.is_visible_in_tree():
			return R.err(R.BAD_PARAMS, "'%s' is hidden (visible = false), so it can't be clicked. Show it first or target another node." % at)
		pos = c.get_global_transform_with_canvas() * (c.size / 2.0)
	elif node is Node2D:
		pos = (node as Node2D).get_global_transform_with_canvas().origin
	elif node is Node3D:
		var cam: Camera3D = node.get_viewport().get_camera_3d()
		if cam == null:
			return R.err(R.NOT_FOUND, "'%s' is a 3D node but its viewport has no current Camera3D to project it with. Pass [x, y] instead." % at)
		var gp: Vector3 = (node as Node3D).global_position
		if cam.is_position_behind(gp):
			return R.err(R.BAD_PARAMS, "'%s' is behind the camera, so it has no screen position." % at)
		pos = cam.unproject_position(gp)
	else:
		return R.err(R.BAD_PARAMS, "'%s' is a %s, which has no screen position. Target a Control, Node2D or Node3D, or pass [x, y]." % [at, node.get_class()])
	var out: Dictionary = {"value": pos, "node": node}
	if node.get_viewport() != rt.get_tree().root:
		out["note"] = "inside a SubViewport; the position is in that viewport's pixels and may not map to the window"
	elif not rt.get_tree().root.get_visible_rect().has_point(pos):
		out["note"] = "outside the visible viewport %s" % [_vec(rt.get_tree().root.get_visible_rect().size)]
	return out


## `handled: true` when a node marked the event as handled (the GUI consumed it, or a script
## called get_viewport().set_input_as_handled()). Only ever reported when true: games that
## poll Input (Input.is_action_pressed in _physics_process) never mark events, so the old
## `handled: false` on every key/action step read like a failure although the game reacted.
static func _put_consumed(root: Window, res: Dictionary) -> void:
	if root.is_input_handled():
		res["handled"] = true


## InputMap actions an event triggers (project actions first, then the built-in ui_* ones).
## Non-exact matching (extra modifiers allowed), the way Input matches events to actions.
static func _actions_of(ev: InputEvent) -> Array:
	var own: Array = []
	var ui: Array = []
	for a: StringName in InputMap.get_actions():
		if InputMap.event_is_action(ev, a):
			(ui if String(a).begins_with("ui_") else own).append(String(a))
	own.sort()
	ui.sort()
	return own + ui


## Most physics objects listed per pointer position (the top ones are what matter).
const MAX_PHYSICS_HITS: int = 4


## Adds `physics`: the CollisionObject2D/3D nodes under a viewport position, because
## `hit`/`hovered` only report Controls (Viewport.gui_get_hovered_control) and a click on a
## crate or a coin otherwise said nothing at all. Omitted when there is none.
##   2D: like Viewport's own physics picking (scene/main/viewport.cpp, _process_picking): the
##   position goes through the inverse canvas transform (Camera2D zoom/offset) into world
##   coordinates and PhysicsDirectSpaceState2D.intersect_point() is asked, once for the
##   viewport's own canvas (canvas_instance_id 0) and once per CanvasLayer with that layer's
##   transform: the physics server only matches objects whose canvas id equals the query's
##   (modules/godot_physics_2d/godot_space_2d.cpp). Bodies AND areas are reported,
##   input_pickable or not (pick_point false): this is "what is there", not "who gets
##   input_event".
##   3D: a ray from the current Camera3D through the position (project_ray_origin/normal,
##   up to camera.far), first collider only.
## Queries run outside the physics step; Godot allows that on the main thread (the space is
## only locked while it steps) and they see the positions of the last physics tick.
static func _put_physics(rt: Node, root: Window, pos: Vector2, res: Dictionary) -> void:
	var found: Array = []
	var world2d: World2D = root.find_world_2d()
	if world2d != null:
		var space: PhysicsDirectSpaceState2D = world2d.direct_space_state
		if space != null:
			var layers: Array = [null]
			layers.append_array(root.find_children("*", "CanvasLayer", true, false))
			for layer: Variant in layers:
				var xform: Transform2D = root.get_canvas_transform()
				var q := PhysicsPointQueryParameters2D.new()
				if layer != null:
					var cl: CanvasLayer = layer
					# A CanvasLayer with a custom_viewport draws elsewhere; skip it.
					if cl.get_viewport() != root or cl.custom_viewport != null:
						continue
					xform = cl.get_final_transform()
					q.canvas_instance_id = cl.get_instance_id()
				q.position = xform.affine_inverse() * pos
				q.collide_with_areas = true
				q.collide_with_bodies = true
				for hit: Dictionary in space.intersect_point(q, MAX_PHYSICS_HITS):
					var obj: Object = hit.get("collider")
					if obj is Node and not found.has(obj) and obj != rt:
						found.append(obj)
	var cam: Camera3D = root.get_camera_3d()
	var world3d: World3D = root.find_world_3d()
	if cam != null and world3d != null and world3d.direct_space_state != null:
		var from: Vector3 = cam.project_ray_origin(pos)
		var rq := PhysicsRayQueryParameters3D.create(from, from + cam.project_ray_normal(pos) * cam.far)
		rq.collide_with_areas = true
		var hit3: Dictionary = world3d.direct_space_state.intersect_ray(rq)
		if hit3.get("collider") is Node:
			found.append(hit3["collider"])
	if found.is_empty():
		return
	var paths: Array = []
	for n: Node in found.slice(0, MAX_PHYSICS_HITS):
		paths.append(rt.path_of(n))
	res["physics"] = paths


static func _add_target(res: Dictionary, p: Dictionary) -> void:
	if p.has("note"):
		res["note"] = p["note"]


static func _path_or_null(rt: Node, n: Node) -> Variant:
	return rt.path_of(n) if n != null else null


## Compact [x, y] with one decimal.
static func _vec(v: Vector2) -> Array:
	return [snappedf(v.x, 0.1), snappedf(v.y, 0.1)]


static func _action_names() -> Array:
	var names: Array = []
	for a: StringName in InputMap.get_actions():
		if not str(a).begins_with("ui_"):
			names.append(str(a))
	names.sort()
	return names


static func _actions_hint() -> String:
	var names: Array = _action_names()
	if names.is_empty():
		return "The project defines no actions of its own (only the built-in ui_* actions such as ui_accept, ui_cancel, ui_left)."
	return "Project actions: %s (plus the built-in ui_* actions such as ui_accept, ui_cancel)." % ", ".join(names)


## Headless runs start with a 64x64 root window (DisplayServerHeadless reports no window
## size), so anchored UI is squashed and anything beyond 64 px can't be clicked. The first
## input call gives the root viewport the project's window size (display/window/size/
## viewport_width/height), which is what the same game gets in a window. Returns a note
## for the result, or "".
static func _ensure_window_size(rt: Node) -> String:
	if _sized or DisplayServer.get_name() != "headless":
		return ""
	_sized = true
	var root: Window = rt.get_tree().root
	var want := Vector2i(
		int(ProjectSettings.get_setting("display/window/size/viewport_width", 1152)),
		int(ProjectSettings.get_setting("display/window/size/viewport_height", 648)))
	if root.size == want:
		return ""
	var old: Vector2i = root.size
	root.size = want
	# Let containers and anchors re-layout before positions are computed.
	await rt.get_tree().process_frame
	return "Headless run: resized the root viewport from %dx%d to the project's window size %dx%d so the UI lays out and receives clicks as in a window." % [old.x, old.y, want.x, want.y]


# =======================================================================================
# Timing
# =======================================================================================

## Pause state as the game sees it. "suspended" is the editor-style whole-game pause
## (scene:suspend_changed; GDScript can't read SceneTree.is_suspended(), but a
## PROCESS_MODE_ALWAYS node like this runtime only stops processing while suspended).
## Engine.time_scale reads 0 while suspended (Engine.freeze_time_scale).
static func time_state(rt: Node, _params: Dictionary) -> Dictionary:
	var tree: SceneTree = rt.get_tree()
	return R.ok({
		"suspended": not rt.can_process(),
		"paused": tree.paused,
		"time_scale": Engine.time_scale,
		"frames": Engine.get_process_frames(),
		"physics_frames": Engine.get_physics_frames(),
	})


## One step of a suspended game. The server sends this request first and Godot's
## "scene:next_frame" right after it; SceneDebugger then un-suspends the tree and
## re-suspends it on RenderingServer.frame_post_draw, i.e. after exactly one main-loop
## iteration. The two usually land in the same debugger poll, this one first, but not
## always: in the e2e tests this request sometimes started when the game had already been
## un-suspended (next_frame handled before it). So nothing here depends on the order:
## frames and ticks are counted by signal callbacks that only count while the tree is not
## suspended, and the coroutine just waits for "un-suspended, then suspended again".
##
## What one iteration runs (Main::iteration, main/main.cpp 4.7.2): first 0..N physics
## ticks, how many depending on the real time since the previous iteration (the main loop
## keeps iterating while suspended; only the nodes stop), then one process frame, then the
## draw. Under a slow renderer (llvmpipe, ~30 fps) that is ~2 physics ticks per frame at 60
## ticks/s, which is why stepping by frames could never step a single physics tick.
##
## params.ticks = true (godot_game_time step physics_ticks): the iteration runs at most ONE
## physics tick: Engine.max_physics_steps_per_frame is set to 1 for it (Main::iteration
## reads it at the start of every iteration, clamps the tick count to it and shortens the
## process delta to match). An iteration can also run zero ticks when frames are faster
## than ticks (a headless game runs uncapped), so Engine.max_fps is capped to the tick rate
## meanwhile (fewer empty iterations), and the server repeats steps until the wanted number
## of ticks has run. Both settings are restored before this returns, while the game is
## suspended again, so the game never runs with them.
##
## A headless game never draws (DisplayServerHeadless.can_any_window_draw() is false, so
## Main::iteration skips RenderingServer.draw) and would never be re-suspended, so there we
## add a helper that runs last in the stepped frame's _process and forces one draw, which
## emits frame_post_draw. Suspended nodes don't process (Node.can_process() is false while
## the SceneTree is suspended, whatever the process_mode), so whether it is added before or
## after the un-suspend, it first runs in the stepped frame.
##
## Returns what the step really ran: {"frames": process frames, "physics_ticks": physics
## ticks} in which nodes were processed. (Engine.get_process_frames() and
## get_physics_frames() can't tell: the engine keeps counting while suspended.)
static func time_step_wait(rt: Node, params: Dictionary) -> Dictionary:
	var tree: SceneTree = rt.get_tree()
	var one_tick: bool = bool(params.get("ticks", false))
	# SceneTree.physics_frame / process_frame are emitted for every tick / frame, suspended
	# or not; one counts only when nodes were processed in it (this PROCESS_MODE_ALWAYS
	# node can process exactly when the tree is not suspended).
	var counts: Dictionary = {"ticks": 0, "frames": 0}
	var on_tick := func() -> void:
		if rt.can_process():
			counts["ticks"] += 1
	var on_frame := func() -> void:
		if rt.can_process():
			counts["frames"] += 1
	tree.physics_frame.connect(on_tick)
	tree.process_frame.connect(on_frame)
	var saved_steps: int = Engine.max_physics_steps_per_frame
	var saved_fps: int = Engine.max_fps
	if one_tick:
		Engine.max_physics_steps_per_frame = 1
		if Engine.max_fps == 0 or Engine.max_fps > Engine.physics_ticks_per_second:
			Engine.max_fps = Engine.physics_ticks_per_second
	if DisplayServer.get_name() == "headless":
		rt.add_child(_StepEnd.new(), false, Node.INTERNAL_MODE_BACK)
	# Phase 1: wait for the un-suspend (process_frame keeps being emitted while suspended).
	var deadline: int = Time.get_ticks_msec() + 3000
	while not rt.can_process() and Time.get_ticks_msec() < deadline:
		await tree.process_frame
	var resumed: bool = rt.can_process()
	# Phase 2: wait until SceneDebugger has suspended the game again.
	var guard: int = 0
	while rt.can_process() and guard < 60:
		guard += 1
		await tree.process_frame
	tree.physics_frame.disconnect(on_tick)
	tree.process_frame.disconnect(on_frame)
	Engine.max_physics_steps_per_frame = saved_steps
	Engine.max_fps = saved_fps
	if not resumed:
		return R.err(R.GODOT_ERROR, "The game did not run the stepped frame (Godot's scene:next_frame had no effect within 3 s). Check that it is still paused (godot_game_time state).")
	if rt.can_process():
		return R.err(R.GODOT_ERROR, "The game did not pause again after stepping a frame (it may not be drawing frames, e.g. a minimized window). It is running now; pause it again with action \"pause\".")
	return R.ok({"frames": counts["frames"], "physics_ticks": counts["ticks"]})


## Runs last in the frame after a step (highest process_priority) and forces a draw so
## SceneDebugger's frame_post_draw hook re-suspends the game. Headless only.
class _StepEnd extends Node:
	func _init() -> void:
		process_mode = Node.PROCESS_MODE_ALWAYS
		process_priority = 2147483647

	func _process(_delta: float) -> void:
		RenderingServer.force_draw(false, 0.0)
		queue_free()


## params: exactly one of
##   {"node": path}                        wait until the node exists
##   {"signal": name, "node"?: emitter}     wait until it emits (args are returned)
##   {"condition": expr, "node"?: base}     wait until the Expression is truthy
##   {"frames": n} / {"seconds": s}         wait n process frames / s seconds of game time
## plus "timeout_ms" (real time, default 10000). Runs as a coroutine, so other requests are
## served meanwhile.
static func time_wait_for(rt: Node, params: Dictionary) -> Dictionary:
	var tree: SceneTree = rt.get_tree()
	var timeout_ms: int = clampi(int(params.get("timeout_ms", 10000)), 0, int(MAX_WAIT_MS) * 5)
	var start_ms: int = Time.get_ticks_msec()
	var deadline: int = start_ms + timeout_ms
	var start_frame: int = Engine.get_process_frames()
	var node_path: String = str(params.get("node", ""))
	var out: Dictionary = {}

	if params.has("signal"):
		var sig: String = str(params["signal"])
		var found: Dictionary = rt.find_node(node_path if node_path != "" else ".")
		if R.is_err(found):
			return found
		var emitter: Node = found["value"]
		if not emitter.has_signal(sig):
			var names: Array = []
			for s: Dictionary in emitter.get_signal_list():
				names.append(s["name"])
			names.sort()
			return R.err(R.NOT_FOUND, "'%s' (%s) has no signal '%s'. Its signals: %s." % [rt.path_of(emitter), emitter.get_class(), sig, ", ".join(names)])
		var state: Dictionary = {"fired": false, "args": []}
		# Variadic lambda (GDScript 4.5+): accepts whatever the signal passes.
		var cb := func(...args: Array) -> void:
			if not state["fired"]:
				state["fired"] = true
				state["args"] = args
		emitter.connect(sig, cb)
		var emitter_path: String = rt.path_of(emitter)
		while not state["fired"] and Time.get_ticks_msec() < deadline and is_instance_valid(emitter):
			await tree.process_frame
		if is_instance_valid(emitter) and emitter.is_connected(sig, cb):
			emitter.disconnect(sig, cb)
		if not state["fired"] and not is_instance_valid(emitter):
			# The emitter was freed (queue_free, scene change) before emitting: the signal
			# can't come any more. That is an outcome the agent waits for as often as the
			# signal itself (an enemy despawning), so it is a result, not an error.
			return R.ok({"freed": true, "node": emitter_path, "elapsed_ms": Time.get_ticks_msec() - start_ms, "frames": Engine.get_process_frames() - start_frame})
		if not state["fired"]:
			return _timeout(rt, "signal '%s' of '%s' was not emitted" % [sig, node_path if node_path != "" else "."], timeout_ms)
		out["args"] = rt.encode(state["args"])

	elif params.has("condition"):
		var expr := Expression.new()
		var text: String = str(params["condition"])
		# Autoloads and engine singletons named in the condition are passed as Expression
		# inputs (an Expression can't see globals by itself; see rt.expression_globals).
		var globals: Array = rt.expression_globals(text, {})
		if expr.parse(text, globals[0]) != OK:
			return R.err(R.BAD_PARAMS, "condition does not parse: %s. Example: \"get_node('Player').position.x > 300\" (evaluated on the base node, default the current scene)." % expr.get_error_text())
		var found: Dictionary = rt.find_node(node_path if node_path != "" else ".")
		if R.is_err(found):
			return found
		var base: Node = found["value"]
		var base_path: String = rt.path_of(base)
		var last_error: String = ""
		var first: bool = true
		var value: Variant = null
		while true:
			if not is_instance_valid(base):
				# The base node was freed while waiting (an enemy that queue_free()s itself
				# while its "_dying" flag is being watched). The condition can never become
				# true any more; that is an answer, so report it as a result.
				out["freed"] = true
				out["node"] = base_path
				break
			# const_calls_only = true: a condition may read properties and call const
			# methods (get_node, is_visible...), never change the game.
			value = expr.execute(globals[1], base, false, true)
			if expr.has_execute_failed():
				last_error = expr.get_error_text()
				if first:
					return R.err(R.BAD_PARAMS, "condition failed to evaluate: %s. Only properties and const methods can be used (no calls that change state); paths are relative to the base node '%s'." % [last_error, rt.path_of(base)])
			elif value:
				break
			first = false
			if Time.get_ticks_msec() >= deadline:
				var detail: String = ("last error: " + last_error) if last_error != "" else ("last value: %s" % JSON.stringify(rt.encode(value)))
				return _timeout(rt, "condition '%s' stayed false (%s)" % [text, detail], timeout_ms)
			await tree.process_frame
		out["value"] = rt.encode(value)

	elif params.has("frames"):
		var n: int = clampi(int(params["frames"]), 0, MAX_FRAMES)
		while Engine.get_process_frames() - start_frame < n:
			if Time.get_ticks_msec() >= deadline:
				return _timeout(rt, "%d frames did not pass" % n, timeout_ms)
			await tree.process_frame

	elif params.has("seconds"):
		var secs: float = maxf(0.0, float(params["seconds"]))
		# Game time: scaled by time_scale, counts while SceneTree.paused, frozen while suspended.
		var timer: SceneTreeTimer = tree.create_timer(secs, true, false, false)
		while timer.time_left > 0.0:
			if Time.get_ticks_msec() >= deadline:
				return _timeout(rt, "%.2f s of game time did not pass (%.2f s left)" % [secs, timer.time_left], timeout_ms)
			await tree.process_frame

	elif node_path != "":
		while true:
			var found: Dictionary = rt.find_node(node_path)
			if not R.is_err(found):
				out["node"] = rt.path_of(found["value"])
				out["type"] = (found["value"] as Node).get_class()
				break
			if Time.get_ticks_msec() >= deadline:
				return _timeout(rt, "no node appeared at '%s'" % node_path, timeout_ms)
			await tree.process_frame
	else:
		return R.err(R.BAD_PARAMS, "wait_for needs one of: node (wait until it exists), signal (+ node = emitter), condition (+ node = base), frames, seconds.")

	out["elapsed_ms"] = Time.get_ticks_msec() - start_ms
	out["frames"] = Engine.get_process_frames() - start_frame
	return R.ok(out)


static func _timeout(rt: Node, what: String, timeout_ms: int) -> Dictionary:
	var hint: String = " The game is paused (godot_game_time pause), so it can't progress; resume it." if not rt.can_process() else ""
	return R.err("TIMEOUT", "Timed out after %d ms: %s.%s Raise timeout_ms, or check the game state (godot_game_tree, godot_run_output)." % [timeout_ms, what, hint], {"frames": Engine.get_process_frames()})


# =======================================================================================
# Recording and replay
# =======================================================================================

## Starts recording every input event the main window receives (real devices and injected
## ones alike) from Window.window_input, with times relative to now.
static func record_start(rt: Node, _params: Dictionary) -> Dictionary:
	if not _rec.is_empty():
		return R.err(R.CONFLICT, "Already recording (%d events so far). Stop it with action \"stop\" first." % (_rec["events"] as Array).size())
	var root: Window = rt.get_tree().root
	_rec = {"start_us": Time.get_ticks_usec(), "events": [], "truncated": false}
	var cb := func(ev: InputEvent) -> void:
		_record_event(ev)
	_rec["cb"] = cb
	root.window_input.connect(cb)
	return R.ok({"recording": true, "viewport": _vec(root.get_visible_rect().size)})


static func _record_event(ev: InputEvent) -> void:
	if _rec.is_empty():
		return
	# Skip events Godot synthesizes from other events (touch <-> mouse emulation); replaying
	# the original makes Godot synthesize them again.
	if ev.device == InputEvent.DEVICE_ID_EMULATION:
		return
	var events: Array = _rec["events"]
	if events.size() >= MAX_RECORDED_EVENTS:
		_rec["truncated"] = true
		return
	var e: Dictionary = _encode_event(ev)
	if e.is_empty():
		return
	e["t"] = int((Time.get_ticks_usec() - int(_rec["start_us"])) / 1000.0)
	events.append(e)


## Stops recording. params: {"path"?: "user://run1.json"} also saves it as JSON. Without a
## path the recording is returned inline; with one, only a summary is returned.
static func record_stop(rt: Node, params: Dictionary) -> Dictionary:
	if _rec.is_empty():
		return R.err(R.CONFLICT, "Not recording. Start with action \"start\".")
	var root: Window = rt.get_tree().root
	var cb: Callable = _rec["cb"]
	if root.window_input.is_connected(cb):
		root.window_input.disconnect(cb)
	var events: Array = _rec["events"]
	var recording: Dictionary = {
		"version": RECORDING_VERSION,
		"duration_ms": int((Time.get_ticks_usec() - int(_rec["start_us"])) / 1000.0),
		"viewport": _vec(root.get_visible_rect().size),
		"window": _vec(Vector2(root.size)),
		"events": events,
	}
	var truncated: bool = _rec["truncated"]
	_rec = {}
	var out: Dictionary = {"event_count": events.size(), "duration_ms": recording["duration_ms"]}
	if truncated:
		out["warning"] = "Stopped storing after %d events (the cap); later input was not recorded." % MAX_RECORDED_EVENTS
	var path: String = str(params.get("path", ""))
	if path != "":
		if not (path.begins_with("user://") or path.begins_with("res://")):
			return R.err(R.BAD_PARAMS, "path must start with user:// or res:// (got '%s'). The recording was discarded; this is the data:" % path, recording)
		DirAccess.make_dir_recursive_absolute(path.get_base_dir())
		var f := FileAccess.open(path, FileAccess.WRITE)
		if f == null:
			return R.godot_err("Saving the recording to %s" % path, FileAccess.get_open_error())
		f.store_string(JSON.stringify(recording))
		f.close()
		out["path"] = path
		out["absolute_path"] = ProjectSettings.globalize_path(path)
	else:
		out["recording"] = recording
	return R.ok(out)


## Replays a recording with its original timing. params: {"recording"?: {...} | "path"?: str,
## "speed"?: 1.0}. Timing is real time divided by speed; positions are window pixels as
## recorded (not rescaled if the window size changed).
static func record_replay(rt: Node, params: Dictionary) -> Dictionary:
	var rec: Variant = params.get("recording")
	var path: String = str(params.get("path", ""))
	if rec == null and path != "":
		if not FileAccess.file_exists(path):
			return R.err(R.NOT_FOUND, "No recording file at '%s'. Save one with action \"stop\" and a path." % path)
		rec = JSON.parse_string(FileAccess.get_file_as_string(path))
	if not rec is Dictionary or not (rec as Dictionary).get("events") is Array:
		return R.err(R.BAD_PARAMS, "replay needs 'recording' (the object action \"stop\" returned, with an 'events' array) or 'path' to a saved recording.")
	var events: Array = rec["events"]
	var speed: float = clampf(float(params.get("speed", 1.0)), 0.01, 100.0)
	var tree: SceneTree = rt.get_tree()
	var root: Window = tree.root
	var warnings: Array = []
	var note: String = await _ensure_window_size(rt)
	if note != "":
		warnings.append(note)
	var rec_window: Variant = (rec as Dictionary).get("window")
	if rec_window is Array and Vector2(float(rec_window[0]), float(rec_window[1])) != Vector2(root.size):
		warnings.append("Recorded in a %sx%s window, replaying in %dx%d: positions are not rescaled." % [rec_window[0], rec_window[1], root.size.x, root.size.y])
	var suspended: bool = not rt.can_process()
	if suspended:
		warnings.append(PAUSED_INPUT_DROPPED)

	await tree.process_frame
	var start_ms: int = Time.get_ticks_msec()
	var start_frame: int = Engine.get_process_frames()
	var sent: int = 0
	var skipped: int = 0
	for e: Variant in events:
		if not e is Dictionary:
			skipped += 1
			continue
		var due: float = float((e as Dictionary).get("t", 0)) / speed
		while Time.get_ticks_msec() - start_ms < due:
			await tree.process_frame
		var ev: InputEvent = _decode_event(e)
		if ev == null:
			skipped += 1
			continue
		# Same as live input: keep get_mouse_position() in step with replayed mouse events.
		if ev is InputEventMouse:
			_warp_pointer((ev as InputEventMouse).position)
		Input.parse_input_event(ev)
		Input.flush_buffered_events()
		sent += 1
		if ev is InputEventMouse:
			_mouse = (ev as InputEventMouse).position
	var out: Dictionary = {"replayed": sent, "elapsed_ms": Time.get_ticks_msec() - start_ms, "frames": Engine.get_process_frames() - start_frame}
	if suspended:
		out["discarded"] = true
	if skipped > 0:
		out["skipped"] = skipped
	if not warnings.is_empty():
		out["warnings"] = warnings
	return R.ok(out)


## Compact JSON for one event ({} for types we don't record). Short keys keep long
## recordings small: e = kind, p = pressed, x/y = window position, rx/ry = relative.
static func _encode_event(ev: InputEvent) -> Dictionary:
	var e: Dictionary = {}
	if ev is InputEventKey:
		# "key": logical key with modifiers ("Ctrl+S"), falling back to the physical key;
		# "phys" only when it differs (non-QWERTY layouts); "u": the typed character.
		var k: InputEventKey = ev
		e = {"e": "key", "p": k.pressed}
		if k.keycode != KEY_NONE:
			e["key"] = OS.get_keycode_string(k.get_keycode_with_modifiers())
			if k.physical_keycode != KEY_NONE and k.physical_keycode != k.keycode:
				e["phys"] = OS.get_keycode_string(k.physical_keycode)
		elif k.physical_keycode != KEY_NONE:
			e["key"] = OS.get_keycode_string(k.get_physical_keycode_with_modifiers())
		else:
			_put_mods(e, k)
		if k.unicode != 0:
			e["u"] = k.unicode
		if k.echo:
			e["echo"] = true
	elif ev is InputEventMouseButton:
		var mb: InputEventMouseButton = ev
		e = {"e": "mb", "b": int(mb.button_index), "p": mb.pressed, "x": snappedf(mb.position.x, 0.1), "y": snappedf(mb.position.y, 0.1)}
		if mb.double_click:
			e["dbl"] = true
		if mb.factor != 1.0 and mb.factor != 0.0:
			e["f"] = mb.factor
		_put_mods(e, mb)
	elif ev is InputEventMouseMotion:
		var mm: InputEventMouseMotion = ev
		e = {"e": "mm", "x": snappedf(mm.position.x, 0.1), "y": snappedf(mm.position.y, 0.1), "rx": snappedf(mm.relative.x, 0.1), "ry": snappedf(mm.relative.y, 0.1)}
		if mm.button_mask != 0:
			e["m"] = int(mm.button_mask)
		_put_mods(e, mm)
	elif ev is InputEventAction:
		var a: InputEventAction = ev
		e = {"e": "act", "a": str(a.action), "p": a.pressed}
		if a.strength != 1.0 and a.pressed:
			e["s"] = a.strength
	elif ev is InputEventJoypadButton:
		var jb: InputEventJoypadButton = ev
		e = {"e": "jb", "d": jb.device, "b": int(jb.button_index), "p": jb.pressed}
	elif ev is InputEventJoypadMotion:
		var jm: InputEventJoypadMotion = ev
		e = {"e": "jm", "d": jm.device, "a": int(jm.axis), "v": snappedf(jm.axis_value, 0.001)}
	elif ev is InputEventScreenTouch:
		var st: InputEventScreenTouch = ev
		e = {"e": "st", "i": st.index, "p": st.pressed, "x": snappedf(st.position.x, 0.1), "y": snappedf(st.position.y, 0.1)}
		if st.double_tap:
			e["dbl"] = true
	elif ev is InputEventScreenDrag:
		var sd: InputEventScreenDrag = ev
		e = {"e": "sd", "i": sd.index, "x": snappedf(sd.position.x, 0.1), "y": snappedf(sd.position.y, 0.1), "rx": snappedf(sd.relative.x, 0.1), "ry": snappedf(sd.relative.y, 0.1)}
	elif ev is InputEventMagnifyGesture:
		var mg: InputEventMagnifyGesture = ev
		e = {"e": "mag", "x": mg.position.x, "y": mg.position.y, "f": mg.factor}
	elif ev is InputEventPanGesture:
		var pg: InputEventPanGesture = ev
		e = {"e": "pan", "x": pg.position.x, "y": pg.position.y, "dx": pg.delta.x, "dy": pg.delta.y}
	return e


## Inverse of _encode_event. Returns null for unknown or malformed entries.
static func _decode_event(e: Dictionary) -> InputEvent:
	var pos := Vector2(float(e.get("x", 0.0)), float(e.get("y", 0.0)))
	match str(e.get("e", "")):
		"key":
			var k := InputEventKey.new()
			if e.has("key"):
				var code: int = OS.find_keycode_from_string(str(e["key"]))
				k.keycode = (code & KEY_CODE_MASK) as Key
				k.physical_keycode = ((OS.find_keycode_from_string(str(e["phys"])) & KEY_CODE_MASK) if e.has("phys") else (code & KEY_CODE_MASK)) as Key
				k.key_label = k.keycode
				k.shift_pressed = (code & KEY_MASK_SHIFT) != 0
				k.ctrl_pressed = (code & KEY_MASK_CTRL) != 0
				k.alt_pressed = (code & KEY_MASK_ALT) != 0
				k.meta_pressed = (code & KEY_MASK_META) != 0
			else:
				_get_mods(e, k)
			k.pressed = bool(e.get("p", false))
			k.echo = bool(e.get("echo", false))
			k.unicode = int(e.get("u", 0))
			return k
		"mb":
			var mb := InputEventMouseButton.new()
			mb.button_index = int(e.get("b", 1)) as MouseButton
			mb.pressed = bool(e.get("p", false))
			mb.position = pos
			mb.global_position = pos
			mb.double_click = bool(e.get("dbl", false))
			mb.factor = float(e.get("f", 1.0))
			var bit: int = 1 << (int(mb.button_index) - 1)
			var mask: int = Input.get_mouse_button_mask()
			mb.button_mask = ((mask | bit) if mb.pressed else (mask & ~bit)) as MouseButtonMask
			_get_mods(e, mb)
			return mb
		"mm":
			var mm := InputEventMouseMotion.new()
			mm.position = pos
			mm.global_position = pos
			mm.relative = Vector2(float(e.get("rx", 0.0)), float(e.get("ry", 0.0)))
			mm.screen_relative = mm.relative
			mm.button_mask = int(e.get("m", 0)) as MouseButtonMask
			_get_mods(e, mm)
			return mm
		"act":
			var a := InputEventAction.new()
			a.action = StringName(str(e.get("a", "")))
			a.pressed = bool(e.get("p", false))
			a.strength = float(e.get("s", 1.0 if a.pressed else 0.0))
			return a
		"jb":
			var jb := InputEventJoypadButton.new()
			jb.device = int(e.get("d", 0))
			jb.button_index = int(e.get("b", 0)) as JoyButton
			jb.pressed = bool(e.get("p", false))
			jb.pressure = 1.0 if jb.pressed else 0.0
			return jb
		"jm":
			var jm := InputEventJoypadMotion.new()
			jm.device = int(e.get("d", 0))
			jm.axis = int(e.get("a", 0)) as JoyAxis
			jm.axis_value = float(e.get("v", 0.0))
			return jm
		"st":
			var st := InputEventScreenTouch.new()
			st.index = int(e.get("i", 0))
			st.pressed = bool(e.get("p", false))
			st.position = pos
			st.double_tap = bool(e.get("dbl", false))
			return st
		"sd":
			var sd := InputEventScreenDrag.new()
			sd.index = int(e.get("i", 0))
			sd.position = pos
			sd.relative = Vector2(float(e.get("rx", 0.0)), float(e.get("ry", 0.0)))
			sd.screen_relative = sd.relative
			sd.pressure = 1.0
			return sd
		"mag":
			var mg := InputEventMagnifyGesture.new()
			mg.position = pos
			mg.factor = float(e.get("f", 1.0))
			return mg
		"pan":
			var pg := InputEventPanGesture.new()
			pg.position = pos
			pg.delta = Vector2(float(e.get("dx", 0.0)), float(e.get("dy", 0.0)))
			return pg
	return null


static func _mods_string(m: InputEventWithModifiers) -> String:
	var parts: PackedStringArray = []
	if m.ctrl_pressed:
		parts.append("Ctrl")
	if m.alt_pressed:
		parts.append("Alt")
	if m.shift_pressed:
		parts.append("Shift")
	if m.meta_pressed:
		parts.append("Meta")
	return "+".join(parts)


static func _put_mods(e: Dictionary, m: InputEventWithModifiers) -> void:
	var s: String = _mods_string(m)
	if s != "":
		e["mods"] = s


static func _get_mods(e: Dictionary, m: InputEventWithModifiers) -> void:
	var s: String = str(e.get("mods", ""))
	m.ctrl_pressed = s.contains("Ctrl")
	m.alt_pressed = s.contains("Alt")
	m.shift_pressed = s.contains("Shift")
	m.meta_pressed = s.contains("Meta")
