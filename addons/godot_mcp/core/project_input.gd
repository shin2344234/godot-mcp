@tool
extends RefCounted
## Input map helpers for input.edit (ops/project_ops.gd): JSON event specs <-> InputEvents.
##
## An action is stored in project.godot as `input/<action>` = {"deadzone": float,
## "events": [InputEvent...]}, exactly what the editor's Input Map tab writes. These
## helpers build the InputEvent objects from compact JSON specs an LLM can write:
##
##   {"type": "key", "key": "Space"}                     physical key (editor default)
##   {"type": "key", "key": "Ctrl+S", "physical": false} key by keycode, with modifiers
##   {"type": "mouse_button", "button": "left"}          or a MouseButton number (1 = left)
##   {"type": "joy_button", "button": "a"}               or a JoyButton number (0 = A/Cross)
##   {"type": "joy_axis", "axis": "left_x", "value": -1} direction is the sign of value
##   "Space"                                             shorthand for a physical key
##
## Every key spec, string shorthand or object, binds the physical key unless it says
## "physical": false; results describe physical bindings as "key: <name> - Physical" for
## all keys (Godot's own as_text() leaves the suffix off non-printable keys such as Up).
##
## Defaults follow the editor's "Add Event" dialog (InputEventConfigurationDialog in 4.7):
## key events use the physical keycode and every event applies to all devices (-1).

const R := preload("mcp_result.gd")
const Params := preload("params.gd")
const Fuzzy := preload("fuzzy.gd")

## InputMap.DEFAULT_DEADZONE in 4.7 (what InputMap.add_action and the editor use for new
## actions). Verified on the 4.7.2 binary: InputMap.action_get_deadzone of a new action.
const DEFAULT_DEADZONE: float = 0.2

## The editor stores events with device -1 ("All Devices"); a bare InputEventKey.new()
## would otherwise default to the keyboard device id.
const ALL_DEVICES: int = -1

const EVENT_TYPES: PackedStringArray = ["key", "mouse_button", "joy_button", "joy_axis"]

const MOUSE_BUTTONS: Dictionary = {
	"left": MOUSE_BUTTON_LEFT, "right": MOUSE_BUTTON_RIGHT, "middle": MOUSE_BUTTON_MIDDLE,
	"wheel_up": MOUSE_BUTTON_WHEEL_UP, "wheel_down": MOUSE_BUTTON_WHEEL_DOWN,
	"wheel_left": MOUSE_BUTTON_WHEEL_LEFT, "wheel_right": MOUSE_BUTTON_WHEEL_RIGHT,
	"xbutton1": MOUSE_BUTTON_XBUTTON1, "xbutton2": MOUSE_BUTTON_XBUTTON2,
}

const JOY_BUTTONS: Dictionary = {
	"a": JOY_BUTTON_A, "b": JOY_BUTTON_B, "x": JOY_BUTTON_X, "y": JOY_BUTTON_Y,
	"back": JOY_BUTTON_BACK, "guide": JOY_BUTTON_GUIDE, "start": JOY_BUTTON_START,
	"left_stick": JOY_BUTTON_LEFT_STICK, "right_stick": JOY_BUTTON_RIGHT_STICK,
	"left_shoulder": JOY_BUTTON_LEFT_SHOULDER, "right_shoulder": JOY_BUTTON_RIGHT_SHOULDER,
	"dpad_up": JOY_BUTTON_DPAD_UP, "dpad_down": JOY_BUTTON_DPAD_DOWN,
	"dpad_left": JOY_BUTTON_DPAD_LEFT, "dpad_right": JOY_BUTTON_DPAD_RIGHT,
	"misc1": JOY_BUTTON_MISC1, "paddle1": JOY_BUTTON_PADDLE1, "paddle2": JOY_BUTTON_PADDLE2,
	"paddle3": JOY_BUTTON_PADDLE3, "paddle4": JOY_BUTTON_PADDLE4, "touchpad": JOY_BUTTON_TOUCHPAD,
}

## Common controller vocabulary mapped onto the names above (PlayStation / Xbox / Nintendo
## labels, short forms).
const JOY_BUTTON_ALIASES: Dictionary = {
	"cross": "a", "circle": "b", "square": "x", "triangle": "y", "select": "back", "share": "back",
	"view": "back", "home": "guide", "ps": "guide", "menu": "start", "options": "start",
	"l3": "left_stick", "r3": "right_stick", "lb": "left_shoulder", "rb": "right_shoulder",
	"l1": "left_shoulder", "r1": "right_shoulder", "up": "dpad_up", "down": "dpad_down",
	"left": "dpad_left", "right": "dpad_right",
}

## Key spellings OS.find_keycode_from_string does not know.
const KEY_ALIASES: Dictionary = {
	"esc": "Escape", "return": "Enter", "spacebar": "Space", "del": "Delete", "ins": "Insert",
	"pgup": "PageUp", "pgdn": "PageDown", "control": "Ctrl", "cmd": "Meta", "command": "Meta",
	"win": "Meta", "option": "Alt", "arrowup": "Up", "arrowdown": "Down", "arrowleft": "Left",
	"arrowright": "Right",
}

const JOY_AXES: Dictionary = {
	"left_x": JOY_AXIS_LEFT_X, "left_y": JOY_AXIS_LEFT_Y, "right_x": JOY_AXIS_RIGHT_X,
	"right_y": JOY_AXIS_RIGHT_Y, "trigger_left": JOY_AXIS_TRIGGER_LEFT, "trigger_right": JOY_AXIS_TRIGGER_RIGHT,
}


const JOY_AXIS_ALIASES: Dictionary = {
	"lt": "trigger_left", "rt": "trigger_right", "l2": "trigger_left", "r2": "trigger_right",
	"left_trigger": "trigger_left", "right_trigger": "trigger_right",
}


## Action names the editor accepts (ActionMapEditor::_check_new_action_name).
static func action_name_error(action: String) -> String:
	if action.is_empty():
		return "Action names cannot be empty."
	for c: String in ["/", ":", "=", "\\", "\""]:
		if action.contains(c):
			return "Invalid action name '%s': it cannot contain '/', ':', '=', '\\' or '\"'." % action
	return ""


## Builds an InputEvent from a JSON spec. Returns {"value": InputEvent} or an error.
static func parse_event(spec: Variant, where: String) -> Dictionary:
	if spec is String:
		spec = {"type": "key", "key": spec}
	if not spec is Dictionary:
		return R.err(R.BAD_PARAMS, "%s: 'event' must be an object such as {\"type\": \"key\", \"key\": \"Space\"} or a key name string, got %s." % [where, JSON.stringify(spec)])
	var s := Params.new(spec, where)
	var type: String = s.opt_string("type", "key")
	var device: int = s.opt_int("device", ALL_DEVICES)
	if s.failed():
		return s.error
	match type:
		"key":
			return _parse_key(s, device, where)
		"mouse_button":
			var button: Dictionary = _named_index(s.raw("button"), MOUSE_BUTTONS, "mouse button", 1, 9, where, "button")
			if R.is_err(button):
				return button
			var mb := InputEventMouseButton.new()
			mb.button_index = int(button["value"]) as MouseButton
			mb.device = device
			var mods: Dictionary = _apply_modifiers(s, mb, 0)
			if R.is_err(mods):
				return mods
			return R.value(mb)
		"joy_button":
			var jb_index: Dictionary = _named_index(s.raw("button"), JOY_BUTTONS, "joypad button", 0, 127, where, "button")
			if R.is_err(jb_index):
				return jb_index
			var jb := InputEventJoypadButton.new()
			jb.button_index = int(jb_index["value"]) as JoyButton
			jb.device = device
			return R.value(jb)
		"joy_axis":
			var axis: Dictionary = _named_index(s.raw("axis"), JOY_AXES, "joypad axis", 0, 9, where, "axis")
			if R.is_err(axis):
				return axis
			var value: Variant = s.raw("value", null)
			if not (value is float or value is int) or float(value) == 0.0:
				return R.err(R.BAD_PARAMS, "%s: joy_axis events need 'value': -1 (negative direction, e.g. left/up) or 1 (positive direction)." % where)
			var jm := InputEventJoypadMotion.new()
			jm.axis = int(axis["value"]) as JoyAxis
			jm.axis_value = -1.0 if float(value) < 0.0 else 1.0
			jm.device = device
			return R.value(jm)
	return R.err(R.BAD_PARAMS, "%s: unknown event type '%s'. Valid types: %s." % [where, type, ", ".join(EVENT_TYPES)])


static func _parse_key(s: Params, device: int, where: String) -> Dictionary:
	var key_name: String = s.req_string("key")
	var physical: bool = s.opt_bool("physical", true)
	if s.failed():
		return s.error
	# OS.find_keycode_from_string understands Godot's key names ("A", "Space", "Enter",
	# "Escape", "Up", "F1", "Kp 1") and modifier prefixes ("Ctrl+S"), case-insensitively.
	var parts: PackedStringArray = key_name.strip_edges().split("+")
	for i: int in parts.size():
		parts[i] = str(KEY_ALIASES.get(parts[i].strip_edges().to_lower(), parts[i].strip_edges()))
	var code: int = OS.find_keycode_from_string("+".join(parts))
	var base: int = code & KEY_CODE_MASK
	if base == KEY_NONE:
		return R.err(R.BAD_PARAMS, ("%s: unknown key '%s'. Use Godot key names such as \"A\", \"Space\", \"Enter\", \"Escape\", \"Tab\", " +
			"\"Up\", \"Left\", \"F1\", \"Kp 1\", optionally with modifiers like \"Ctrl+S\" or \"Shift+Tab\".") % [where, key_name])
	var ev := InputEventKey.new()
	if physical:
		ev.physical_keycode = base as Key
	else:
		ev.keycode = base as Key
	ev.device = device
	var mods: Dictionary = _apply_modifiers(s, ev, code & KEY_MODIFIER_MASK)
	if R.is_err(mods):
		return mods
	return R.value(ev)


## Sets ctrl/shift/alt/meta from explicit booleans, defaulting to the modifiers that were
## part of the key string (e.g. "Ctrl+S").
static func _apply_modifiers(s: Params, ev: InputEventWithModifiers, mask: int) -> Dictionary:
	ev.ctrl_pressed = s.opt_bool("ctrl", mask & KEY_MASK_CTRL != 0)
	ev.shift_pressed = s.opt_bool("shift", mask & KEY_MASK_SHIFT != 0)
	ev.alt_pressed = s.opt_bool("alt", mask & KEY_MASK_ALT != 0)
	ev.meta_pressed = s.opt_bool("meta", mask & KEY_MASK_META != 0)
	if s.failed():
		return s.error
	return {}


## Resolves a button/axis given by name ("left", "JOY_BUTTON_A", "Left Stick") or number.
static func _named_index(raw: Variant, names: Dictionary, what: String, lo: int, hi: int, where: String, field: String) -> Dictionary:
	if raw is float or raw is int:
		var n: int = int(raw)
		if float(raw) != float(n) or n < lo or n > hi:
			return R.err(R.BAD_PARAMS, "%s: '%s' must be a %s name or a number between %d and %d, got %s." % [where, field, what, lo, hi, JSON.stringify(raw)])
		return R.value(n)
	if raw is String:
		var key: String = (raw as String).strip_edges().to_lower().replace(" ", "_").replace("-", "_")
		for prefix: String in ["mouse_button_", "joy_button_", "joy_axis_"]:
			key = key.trim_prefix(prefix)
		if names == JOY_BUTTONS and JOY_BUTTON_ALIASES.has(key):
			key = JOY_BUTTON_ALIASES[key]
		elif names == JOY_AXES and JOY_AXIS_ALIASES.has(key):
			key = JOY_AXIS_ALIASES[key]
		if names.has(key):
			return R.value(int(names[key]))
		if key.is_valid_int():
			return _named_index(key.to_int(), names, what, lo, hi, where, field)
		return R.err(R.BAD_PARAMS, "%s: unknown %s '%s'.%s Valid names: %s (or a number)." % [where, what, raw, Fuzzy.did_you_mean(Fuzzy.suggest(key, names.keys(), 3)), ", ".join(PackedStringArray(names.keys()))])
	return R.err(R.BAD_PARAMS, "%s: missing '%s' (a %s name such as \"%s\", or a number)." % [where, field, what, str(names.keys()[0])])


## One readable line per event, e.g. "key: W - Physical", "joy_axis: Joypad Motion on Axis 0 ...".
static func describe_event(ev: Variant) -> String:
	if not ev is InputEvent:
		return "unknown: %s" % str(ev)
	var type: String = "event"
	if ev is InputEventKey:
		type = "key"
	elif ev is InputEventMouseButton:
		type = "mouse_button"
	elif ev is InputEventJoypadButton:
		type = "joy_button"
	elif ev is InputEventJoypadMotion:
		type = "joy_axis"
	else:
		type = (ev as InputEvent).get_class()
	var text: String = (ev as InputEvent).as_text()
	if ev is InputEventKey:
		var k := ev as InputEventKey
		# InputEventKey.as_text() adds " - Physical" only to printable keys: a physical
		# Up/Left/Escape/F1 reads "Up", exactly like a keycode binding (verified on 4.7.2),
		# so "Up" next to "W - Physical" looked like a different kind of binding
		# (MCP_TEST_LOG Phase A). Say it for every physical key; keycode bindings stay bare.
		if k.keycode == KEY_NONE and k.physical_keycode != KEY_NONE:
			text = k.as_text_physical_keycode() + " - Physical"
	var dev: int = (ev as InputEvent).device
	if dev != ALL_DEVICES:
		text += " (device %d)" % dev
	return "%s: %s" % [type, text]


## {"deadzone": 0.2, "events": ["key: Space - Physical", ...]} for results.
static func describe_action(action: Variant) -> Variant:
	if not action is Dictionary:
		return null
	var events: Array = []
	for ev: Variant in (action as Dictionary).get("events", []):
		events.append(describe_event(ev))
	return {"deadzone": float((action as Dictionary).get("deadzone", DEFAULT_DEADZONE)), "events": events}


## A fresh copy of an action dictionary (new Dictionary and events Array; the InputEvent
## objects are shared, they are never mutated). The copy keeps undo's "old" value intact.
static func copy_action(action: Variant) -> Dictionary:
	var out: Dictionary = {"deadzone": DEFAULT_DEADZONE, "events": []}
	if action is Dictionary:
		out["deadzone"] = float((action as Dictionary).get("deadzone", DEFAULT_DEADZONE))
		out["events"] = ((action as Dictionary).get("events", []) as Array).duplicate()
	return out


## Index of the first event in `events` matching `ev` (same class, same key/button/axis
## and modifiers), or -1.
static func find_event(events: Array, ev: InputEvent) -> int:
	for i: int in events.size():
		var existing: Variant = events[i]
		if existing is InputEvent and (existing as InputEvent).get_class() == ev.get_class() and (existing as InputEvent).is_match(ev, true):
			return i
	return -1
