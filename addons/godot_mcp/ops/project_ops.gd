@tool
extends RefCounted
## Project configuration: settings, input map, autoloads, plugins, project-wide validation.
##
## Registered in core/methods.gd (MODULES). `methods()` maps each bridge-protocol method
## this module implements to a descriptor (see the comment on Methods.MODULES for kinds).
##
## Everything here persists to project.godot through Godot's own ProjectSettings API
## (ProjectSettings.set_setting + ProjectSettings.save()), never by editing the file text:
##
## * Editor: the change is one EditorUndoRedoManager action in the *global* history
##   (ProjectSettings is the action's context object), so Ctrl+Z reverts it, and save()
##   runs on do and undo so project.godot always matches memory. The editor must be the
##   one writing project.godot while it is open: it keeps every setting in memory and
##   would overwrite an on-disk edit with its next save. ProjectSettings emits
##   `settings_changed`, which the editor listens to (EditorNode::_update_from_settings);
##   the Project Settings dialog rebuilds its tabs every time it is opened.
## * Headless: the runner is started with `--path <project>`, so ProjectSettings holds the
##   project's settings; we set and save() directly. Verified on 4.7.2: save() from a
##   --script run writes only non-default values, keeps section/key order, and (like the
##   editor) replaces the top-of-file comment with Godot's standard header.
##
## Values are decoded against each setting's declared type (ProjectSettings property
## info) with the shared codec, so "display/window/size/viewport_width": "1280" or
## "rendering/environment/defaults/default_clear_color": "#202020" both work.

const R := preload("../core/mcp_result.gd")
const Params := preload("../core/params.gd")
const Codec := preload("../core/variant_codec.gd")
const Fuzzy := preload("../core/fuzzy.gd")
const ResPaths := preload("../core/res_paths.gd")
const Constants := preload("../core/constants.gd")
const ScriptValidate := preload("../core/script_validate.gd")
const InputSpec := preload("../core/project_input.gd")
const Validate := preload("../core/project_validate.gd")

const AUTOLOAD_PREFIX: String = "autoload/"
const PLUGINS_SETTING: String = "editor_plugins/enabled"
const SELF_PLUGIN: String = "res://addons/godot_mcp/plugin.cfg"
## Extensions Godot accepts as an autoload (a script or a scene).
const AUTOLOAD_EXTENSIONS: PackedStringArray = ["gd", "cs", "tscn", "scn"]
## GDScript keywords; an autoload with one of these names could never be referenced.
const RESERVED_WORDS: PackedStringArray = [
	"if", "elif", "else", "for", "while", "match", "when", "break", "continue", "pass", "return",
	"class", "class_name", "extends", "is", "in", "as", "self", "super", "signal", "func",
	"static", "const", "enum", "var", "breakpoint", "preload", "await", "yield", "assert",
	"void", "true", "false", "null", "not", "and", "or", "PI", "TAU", "INF", "NAN", "trait",
]


static func methods() -> Dictionary:
	return {
		"project.set": {"kind": "project", "fn": set_settings},
		"input.edit": {"kind": "project", "fn": edit_input},
		"autoload.edit": {"kind": "project", "fn": edit_autoload},
		"project.plugins": {"kind": "project", "fn": edit_plugins},
		"project.validate": {"kind": "project", "fn": Validate.run},
	}


# ---------------------------------------------------------------------------------------
# Shared: applying setting changes
# ---------------------------------------------------------------------------------------

## Applies `changes` ([key, old_value, new_value] triples; null erases a setting) and
## `orders` ([key, new_order] pairs, applied after the values) to ProjectSettings, then
## saves project.godot. In the editor this is one undo action named `action`.
## Returns {} on success or an error Dictionary.
static func commit_settings(changes: Array, orders: Array, action: String, env: Dictionary) -> Dictionary:
	if changes.is_empty() and orders.is_empty():
		return {}
	# Orders of keys that exist now, restored on undo (erasing and re-adding a setting
	# would otherwise move it to the end of its section, e.g. reorder autoloads).
	var old_orders: Array = []
	for c: Array in changes:
		if ProjectSettings.has_setting(c[0]):
			old_orders.append([c[0], ProjectSettings.get_order(c[0])])
	for o: Array in orders:
		if ProjectSettings.has_setting(o[0]):
			old_orders.append([o[0], ProjectSettings.get_order(o[0])])

	var ur: Object = env.get("undo_redo")
	if bool(env.get("editor", false)) and ur != null:
		# Context object ProjectSettings -> EditorUndoRedoManager files the action under
		# the global history (not the edited scene's), like the Project Settings dialog.
		# mark_unsaved = false: project.godot is saved right away, no scene becomes dirty.
		ur.call("create_action", action, UndoRedo.MERGE_DISABLE, ProjectSettings, false, false)
		for c: Array in changes:
			ur.call("add_do_property", ProjectSettings, c[0], c[2])
			ur.call("add_undo_property", ProjectSettings, c[0], c[1])
		for o: Array in orders:
			ur.call("add_do_method", ProjectSettings, "set_order", o[0], o[1])
		for o: Array in old_orders:
			ur.call("add_undo_method", ProjectSettings, "set_order", o[0], o[1])
		ur.call("add_do_method", ProjectSettings, "save")
		ur.call("add_undo_method", ProjectSettings, "save")
		ur.call("commit_action")
	else:
		for c: Array in changes:
			ProjectSettings.set_setting(c[0], c[2])
		for o: Array in orders:
			if ProjectSettings.has_setting(o[0]):
				ProjectSettings.set_order(o[0], o[1])
	# Saved again explicitly so a failure is reported (the undo method's return is lost).
	var err: int = ProjectSettings.save()
	if err != OK:
		return R.godot_err("Saving project.godot", err)
	return {}


## Setting name -> property info dictionary, for every registered setting.
static func _property_infos() -> Dictionary:
	var out: Dictionary = {}
	for info: Dictionary in ProjectSettings.get_property_list():
		var n: String = info["name"]
		if n.contains("/"):
			out[n] = info
	return out


## Keys that have their own, safer tool.
static func _redirect(method: String, key: String) -> String:
	if key.begins_with("input/"):
		return "%s: input actions ('%s') are edited with input.edit (ops add_action/add_event/...), which builds valid InputEvents." % [method, key]
	if key.begins_with(AUTOLOAD_PREFIX):
		return "%s: autoloads ('%s') are edited with autoload.edit (op add/remove/move), which validates the name and path." % [method, key]
	if key.begins_with("editor_plugins/"):
		return "%s: editor plugins are enabled/disabled with project.plugins." % method
	return ""


# ---------------------------------------------------------------------------------------
# project.set
# ---------------------------------------------------------------------------------------

static func set_settings(params: Dictionary, env: Dictionary) -> Dictionary:
	var p := Params.new(params, "project.set")
	var settings: Dictionary = p.opt_dict("settings", {})
	var create: bool = p.opt_bool("create", false)
	if p.failed():
		return p.error
	if settings.is_empty():
		return R.err(R.BAD_PARAMS, "project.set: pass 'settings', an object of setting name -> value, e.g. {\"settings\": {\"display/window/size/viewport_width\": 1280}}. A null value resets a setting to its default.")
	var infos: Dictionary = _property_infos()
	var changes: Array = []
	var changed: Dictionary = {}
	var restart: Array = []
	var warnings: Array = []
	for raw_key: Variant in settings:
		var key: String = str(raw_key).strip_edges().trim_prefix("/")
		var value: Variant = settings[raw_key]
		var redirect: String = _redirect("project.set", key)
		if not redirect.is_empty():
			return R.err(R.BAD_PARAMS, redirect)
		if not key.contains("/") or key.ends_with("/"):
			return R.err(R.BAD_PARAMS, "project.set: '%s' is not a setting name; names look like \"section/group/name\", e.g. \"display/window/size/viewport_width\". Use godot_project_settings to browse existing names." % key)
		var exists: bool = ProjectSettings.has_setting(key)
		# The bridge port is registered by the editor plugin only, so headless it may not
		# exist yet; it is still a known setting.
		if not exists and value != null and not create and key != Constants.PORT_SETTING:
			var similar: Array[String] = Fuzzy.suggest(key, infos.keys(), 5)
			return R.err(R.NOT_FOUND, "project.set: '%s' is not an existing project setting.%s To add a custom setting, pass \"create\": true." % [key, Fuzzy.did_you_mean(similar)], {"similar": similar})
		var old: Variant = ProjectSettings.get_setting(key) if exists else null
		var info: Dictionary = infos.get(key, {})
		var new_value: Variant = null
		if value == null:
			if not exists:
				warnings.append("'%s' is not set; nothing to reset." % key)
				continue
			# Built-in settings go back to their default value (which save() then omits from
			# project.godot); custom settings without a default are erased.
			if ProjectSettings.property_can_revert(key):
				new_value = ProjectSettings.property_get_revert(key)
		else:
			var decoded: Dictionary = _decode_setting(key, value, info)
			if R.is_err(decoded):
				return decoded
			new_value = decoded["value"]
			var hint_err: String = _check_hint(key, new_value, info)
			if not hint_err.is_empty():
				return R.err(R.BAD_PARAMS, "project.set: " + hint_err)
		if key == Constants.PORT_SETTING:
			if not new_value is int or int(new_value) < 1024 or int(new_value) > 65535:
				return R.err(R.BAD_PARAMS, "project.set: '%s' must be an integer port between 1024 and 65535 (the Godot MCP bridge would not start otherwise)." % key)
			warnings.append("The bridge port change takes effect the next time the Godot MCP plugin starts (re-enable it or restart the editor).")
		if not info.is_empty() and int(info.get("usage", 0)) & PROPERTY_USAGE_RESTART_IF_CHANGED:
			restart.append(key)
		changes.append([key, old, new_value])
		changed[key] = {"old": Codec.encode(old), "new": Codec.encode(new_value)}
	var err: Dictionary = commit_settings(changes, [], "MCP: project.set", env)
	if R.is_err(err):
		return err
	var result: Dictionary = {"changed": changed, "saved": true}
	if not restart.is_empty():
		result["restart_required"] = restart
		warnings.append("Some changed settings only apply after restarting the editor/game: %s." % ", ".join(PackedStringArray(restart)))
	if not warnings.is_empty():
		result["warnings"] = warnings
	return R.ok(result)


## Decodes a JSON value for a setting with the codec, using the setting's property info
## (custom settings without info take the type of their current value, or stay untyped).
static func _decode_setting(key: String, value: Variant, info: Dictionary) -> Dictionary:
	var typed: Dictionary = info.duplicate()
	if typed.is_empty():
		typed = {"name": key, "type": TYPE_NIL}
		if ProjectSettings.has_setting(key):
			var current: Variant = ProjectSettings.get_setting(key)
			if current != null:
				typed["type"] = typeof(current)
	var decoded: Dictionary = Codec.decode_typed(value, typed, null)
	if R.is_err(decoded):
		var e: Dictionary = decoded["error"]
		e["message"] = "project.set: " + str(e["message"])
	return decoded


## Validates range and enum hints the codec does not enforce. Returns "" or a message.
static func _check_hint(key: String, value: Variant, info: Dictionary) -> String:
	var hint: int = int(info.get("hint", PROPERTY_HINT_NONE))
	var hint_string: String = str(info.get("hint_string", ""))
	if hint == PROPERTY_HINT_RANGE and (value is int or value is float):
		var parts: PackedStringArray = hint_string.split(",")
		if parts.size() >= 2 and parts[0].is_valid_float() and parts[1].is_valid_float():
			var lo: float = parts[0].to_float()
			var hi: float = parts[1].to_float()
			if float(value) < lo and not "or_less" in parts:
				return "'%s' must be >= %s, got %s." % [key, parts[0], str(value)]
			if float(value) > hi and not "or_greater" in parts:
				return "'%s' must be <= %s, got %s." % [key, parts[1], str(value)]
	elif hint == PROPERTY_HINT_ENUM and value is String:
		var options: PackedStringArray = []
		for opt: String in hint_string.split(","):
			options.append(opt.get_slice(":", 0).strip_edges())
		if not options.is_empty() and not (value as String) in options:
			return "'%s' must be one of: %s; got '%s'." % [key, ", ".join(options), value]
	elif hint == PROPERTY_HINT_FILE and value is String and not (value as String).is_empty():
		var path: String = value
		if path.begins_with("uid://"):
			var id: int = ResourceUID.text_to_id(path)
			if not ResourceUID.has_id(id):
				return "'%s': unknown UID '%s'. Pass a res:// path instead." % [key, path]
		elif path.begins_with("res://") and not ResPaths.file_exists(path):
			return "'%s': file '%s' does not exist." % [key, path]
	return ""


# ---------------------------------------------------------------------------------------
# input.edit
# ---------------------------------------------------------------------------------------

const INPUT_OPS: PackedStringArray = ["add_action", "remove_action", "add_event", "remove_event", "clear_events", "set_deadzone"]


static func edit_input(params: Dictionary, env: Dictionary) -> Dictionary:
	var p := Params.new(params, "input.edit")
	var ops: Array = p.opt_array("ops", [])
	if p.failed():
		return p.error
	if ops.is_empty():
		return R.err(R.BAD_PARAMS, "input.edit: pass 'ops', e.g. [{\"op\": \"add_action\", \"action\": \"jump\"}, {\"op\": \"add_event\", \"action\": \"jump\", \"event\": {\"type\": \"key\", \"key\": \"Space\"}}]. Ops: %s." % ", ".join(INPUT_OPS))
	# action name -> working copy ({"deadzone", "events"}) or null (removed). Untouched
	# actions are not in the map; the first op on an action loads it from ProjectSettings.
	var working: Dictionary = {}
	var touched: Array[String] = []
	var warnings: Array = []
	for i: int in ops.size():
		var where: String = "input.edit ops[%d]" % i
		if not ops[i] is Dictionary:
			return R.err(R.BAD_PARAMS, "%s must be an object like {\"op\": \"add_event\", \"action\": \"jump\", \"event\": {...}}." % where)
		var op := Params.new(ops[i], where)
		var kind: String = op.req_string("op")
		var action: String = op.req_string("action")
		if op.failed():
			return op.error
		if not kind in INPUT_OPS:
			return R.err(R.BAD_PARAMS, "%s: unknown op '%s'.%s Valid ops: %s." % [where, kind, Fuzzy.did_you_mean(Fuzzy.suggest(kind, INPUT_OPS, 2)), ", ".join(INPUT_OPS)])
		var name_err: String = InputSpec.action_name_error(action)
		if not name_err.is_empty():
			return R.err(R.BAD_PARAMS, "%s: %s" % [where, name_err])
		var key: String = "input/" + action
		if not working.has(action):
			working[action] = null
			if ProjectSettings.has_setting(key):
				working[action] = InputSpec.copy_action(ProjectSettings.get_setting(key))
		var current: Variant = working[action]
		if kind != "add_action" and current == null:
			return _unknown_action(where, action)
		match kind:
			"add_action":
				if current != null:
					return R.err(R.CONFLICT, "%s: action '%s' already exists. Use add_event to add bindings to it." % [where, action])
				var dz: Dictionary = _deadzone(op, where, InputSpec.DEFAULT_DEADZONE)
				if R.is_err(dz):
					return dz
				working[action] = {"deadzone": dz["value"], "events": []}
				if op.has("event"):
					var first: Dictionary = InputSpec.parse_event(op.raw("event"), where)
					if R.is_err(first):
						return first
					(working[action]["events"] as Array).append(first["value"])
			"remove_action":
				if _is_builtin_action(action):
					# Built-in ui_* actions cannot be deleted; "removing" one restores the
					# engine default (and drops it from project.godot).
					working[action] = InputSpec.copy_action(ProjectSettings.property_get_revert(key))
					warnings.append("'%s' is a built-in action and cannot be deleted; it was reset to its default bindings." % action)
				else:
					working[action] = null
			"add_event":
				var parsed: Dictionary = InputSpec.parse_event(op.raw("event"), where)
				if R.is_err(parsed):
					return parsed
				var events: Array = (current as Dictionary)["events"]
				if InputSpec.find_event(events, parsed["value"]) >= 0:
					warnings.append("'%s' already has %s; not added twice." % [action, InputSpec.describe_event(parsed["value"])])
				else:
					events.append(parsed["value"])
			"remove_event":
				var events_r: Array = (current as Dictionary)["events"]
				var idx: int = -1
				if op.has("index"):
					idx = op.opt_int("index", -1)
					if op.failed():
						return op.error
					if idx < 0 or idx >= events_r.size():
						return R.err(R.BAD_PARAMS, "%s: index %d is out of range; '%s' has %d event(s): %s." % [where, idx, action, events_r.size(), JSON.stringify(InputSpec.describe_action(current)["events"])])
				elif op.has("event"):
					var spec: Dictionary = InputSpec.parse_event(op.raw("event"), where)
					if R.is_err(spec):
						return spec
					idx = InputSpec.find_event(events_r, spec["value"])
					if idx < 0:
						return R.err(R.NOT_FOUND, "%s: '%s' has no event matching %s. Its events: %s." % [where, action, InputSpec.describe_event(spec["value"]), JSON.stringify(InputSpec.describe_action(current)["events"])])
				else:
					return R.err(R.BAD_PARAMS, "%s: remove_event needs 'index' (0-based) or 'event' (the binding to remove)." % where)
				events_r.remove_at(idx)
			"clear_events":
				(current as Dictionary)["events"] = []
			"set_deadzone":
				if not op.has("deadzone"):
					return R.err(R.BAD_PARAMS, "%s: set_deadzone needs 'deadzone' (0 to 1)." % where)
				var dz2: Dictionary = _deadzone(op, where, 0.0)
				if R.is_err(dz2):
					return dz2
				(current as Dictionary)["deadzone"] = dz2["value"]
		if not action in touched:
			touched.append(action)

	var changes: Array = []
	var actions: Dictionary = {}
	for action: String in touched:
		var key: String = "input/" + action
		var old: Variant = ProjectSettings.get_setting(key) if ProjectSettings.has_setting(key) else null
		var new_value: Variant = working[action]
		if old == null and new_value == null:
			continue
		if new_value != null and _is_builtin_action(action) and new_value != ProjectSettings.property_get_revert(key):
			warnings.append("'%s' is a built-in action: your edited copy is now stored in project.godot and overrides the engine default (remove_action restores the default)." % action)
		changes.append([key, old, new_value])
		actions[action] = InputSpec.describe_action(new_value)
	var err: Dictionary = commit_settings(changes, [], "MCP: input.edit", env)
	if R.is_err(err):
		return err
	var result: Dictionary = {"actions": actions, "saved": true}
	if not warnings.is_empty():
		result["warnings"] = warnings
	return R.ok(result)


## Built-in actions (InputMap::get_builtins) are all named ui_* and have an engine default.
## (property_can_revert alone is not enough: project actions loaded from project.godot
## also report a revert value.)
static func _is_builtin_action(action: String) -> bool:
	return action.begins_with("ui_") and ProjectSettings.property_can_revert("input/" + action)


static func _deadzone(op: Params, where: String, default: float) -> Dictionary:
	var raw: Variant = op.raw("deadzone", default)
	if raw == null:
		raw = default
	if not (raw is float or raw is int) or float(raw) < 0.0 or float(raw) > 1.0:
		return R.err(R.BAD_PARAMS, "%s: 'deadzone' must be a number between 0 and 1 (default %s), got %s." % [where, str(InputSpec.DEFAULT_DEADZONE), JSON.stringify(raw)])
	return R.value(float(raw))


static func _unknown_action(where: String, action: String) -> Dictionary:
	var names: Array[String] = []
	for info: Dictionary in ProjectSettings.get_property_list():
		var n: String = info["name"]
		if n.begins_with("input/"):
			names.append(n.trim_prefix("input/"))
	var similar: Array[String] = Fuzzy.suggest(action, names, 5)
	return R.err(R.NOT_FOUND, "%s: input action '%s' does not exist.%s Create it first with {\"op\": \"add_action\", \"action\": \"%s\"}." % [where, action, Fuzzy.did_you_mean(similar), action], {"similar": similar})


# ---------------------------------------------------------------------------------------
# autoload.edit
# ---------------------------------------------------------------------------------------

const AUTOLOAD_OPS: PackedStringArray = ["add", "remove", "move"]


## Autoloads in load order: [{"name", "key", "value", "path", "singleton", "order"}].
static func autoload_list() -> Array:
	var out: Array = []
	for info: Dictionary in ProjectSettings.get_property_list():
		var key: String = info["name"]
		if not key.begins_with(AUTOLOAD_PREFIX):
			continue
		var value: String = str(ProjectSettings.get_setting(key, ""))
		var singleton: bool = value.begins_with("*")
		var path: String = value.trim_prefix("*")
		# 4.7's Autoload tab stores "*uid://..." (EditorAutoloadSettings::autoload_add);
		# show the res:// path it points to as well.
		if path.begins_with("uid://"):
			var id: int = ResourceUID.text_to_id(path)
			if ResourceUID.has_id(id):
				path = ResourceUID.get_id_path(id)
		out.append({"name": key.trim_prefix(AUTOLOAD_PREFIX), "key": key, "value": value, "path": path,
			"singleton": singleton, "order": ProjectSettings.get_order(key)})
	out.sort_custom(func(a: Dictionary, b: Dictionary) -> bool: return int(a["order"]) < int(b["order"]))
	return out


static func _public_autoloads(list: Array) -> Array:
	var out: Array = []
	for a: Dictionary in list:
		out.append({"name": a["name"], "path": a["path"], "singleton": a["singleton"]})
	return out


static func edit_autoload(params: Dictionary, env: Dictionary) -> Dictionary:
	var p := Params.new(params, "autoload.edit")
	var op: String = p.req_string("op")
	var name: String = p.req_string("name")
	var raw_path: String = p.opt_string("path", "")
	var singleton: bool = p.opt_bool("singleton", true)
	var index: int = p.opt_int("index", -1)
	if p.failed():
		return p.error
	if not op in AUTOLOAD_OPS:
		return R.err(R.BAD_PARAMS, "autoload.edit: 'op' must be one of %s, got '%s'." % [", ".join(AUTOLOAD_OPS), op])
	var list: Array = autoload_list()
	var names: Array[String] = []
	for a: Dictionary in list:
		names.append(str(a["name"]))
	var key: String = AUTOLOAD_PREFIX + name
	var warnings: Array = []

	if op == "add":
		if name in names:
			return R.err(R.CONFLICT, "autoload.edit: an autoload named '%s' already exists (%s). Remove it first or pick another name." % [name, list[names.find(name)]["path"]])
		var name_err: String = _autoload_name_error(name)
		if not name_err.is_empty():
			return R.err(R.BAD_PARAMS, "autoload.edit: " + name_err)
		if raw_path.is_empty():
			return R.err(R.BAD_PARAMS, "autoload.edit: 'add' needs 'path', the res:// path of a script (.gd) or scene (.tscn), e.g. {\"op\": \"add\", \"name\": \"Game\", \"path\": \"res://game.gd\"}.")
		var norm: Dictionary = ResPaths.normalize(raw_path, "path")
		if R.is_err(norm):
			return norm
		var path: String = norm["value"]
		if not path.get_extension().to_lower() in AUTOLOAD_EXTENSIONS:
			return R.err(R.BAD_PARAMS, "autoload.edit: an autoload must be a script or scene (%s), got '%s'." % [", ".join(AUTOLOAD_EXTENSIONS), path])
		if not FileAccess.file_exists(path):
			return R.err(R.NOT_FOUND, "autoload.edit: '%s' does not exist. Create the script first (godot_files_write) or check the path." % path)
		if path.get_extension().to_lower() == "gd":
			var source: String = FileAccess.get_file_as_string(path)
			var check: Dictionary = ScriptValidate.validate_source(source, path)
			if not bool(check["valid"]):
				warnings.append("'%s' has compile errors; the game will fail to start until they are fixed: %s" % [path, JSON.stringify(check["errors"])])
			# Godot instantiates an autoload script's native base and refuses anything that is
			# not a Node: "Failed to instantiate an autoload, script '...' does not inherit
			# from 'Node'." (main/main.cpp, Godot 4.7.2; the Autoload tab checks the same in
			# EditorAutoloadSettings::_create_autoload). Such an autoload can never work, so
			# refuse it. A scene is always fine: a PackedScene's root is a Node.
			var base: String = _script_native_base(path, source, bool(check["valid"]))
			if not base.is_empty() and not ClassDB.is_parent_class(base, "Node"):
				return R.err(R.BAD_PARAMS, ("autoload.edit: '%s' extends %s, which is not a Node; Godot only autoloads Node scripts and fails at startup with \"script does not inherit from 'Node'\". " +
					"Make the script extend Node (or a Node subclass), or load the %s from a Node autoload instead (e.g. `var data := preload(\"%s\")`).") % [path, base, base, path])
		if index > list.size():
			index = list.size()
		var plugin: Object = env.get("plugin")
		if bool(env.get("editor", false)) and plugin != null and singleton and index < 0:
			# The editor's own path (Project Settings > Autoload "Add"): undoable, refreshes
			# the Autoload tab and stores "*uid://..." like a manual add would.
			plugin.call("add_autoload_singleton", name, path)
			if not ProjectSettings.has_setting(key):
				return R.err(R.GODOT_ERROR, "autoload.edit: the editor refused to add autoload '%s' -> '%s'. Check editor.logs for the reason." % [name, path])
			var save_err: int = ProjectSettings.save()
			if save_err != OK:
				return R.godot_err("Saving project.godot", save_err)
		else:
			var value: String = ("*" if singleton else "") + ResourceUID.path_to_uid(path)
			var orders: Array = []
			if index >= 0:
				var keys: Array = []
				for a: Dictionary in list:
					keys.append(a["key"])
				keys.insert(index, key)
				orders = _reorder(list, keys)
			var err: Dictionary = commit_settings([[key, null, value]], orders, "MCP: autoload.edit (add %s)" % name, env)
			if R.is_err(err):
				return err
	else:
		if not name in names:
			var similar: Array[String] = Fuzzy.suggest(name, names, 3)
			return R.err(R.NOT_FOUND, "autoload.edit: no autoload named '%s'.%s Autoloads: %s." % [name, Fuzzy.did_you_mean(similar), ", ".join(names) if not names.is_empty() else "(none)"])
		if op == "remove":
			var plugin_r: Object = env.get("plugin")
			if bool(env.get("editor", false)) and plugin_r != null:
				plugin_r.call("remove_autoload_singleton", name)
				var save_err2: int = ProjectSettings.save()
				if save_err2 != OK:
					return R.godot_err("Saving project.godot", save_err2)
			else:
				var err_r: Dictionary = commit_settings([[key, ProjectSettings.get_setting(key), null]], [], "MCP: autoload.edit (remove %s)" % name, env)
				if R.is_err(err_r):
					return err_r
		else: # move
			if not p.has("index"):
				return R.err(R.BAD_PARAMS, "autoload.edit: 'move' needs 'index' (0 = loaded first). Current order: %s." % ", ".join(names))
			var keys_m: Array = []
			for a: Dictionary in list:
				if a["key"] != key:
					keys_m.append(a["key"])
			keys_m.insert(clampi(index, 0, keys_m.size()), key)
			var err_m: Dictionary = commit_settings([], _reorder(list, keys_m), "MCP: autoload.edit (move %s)" % name, env)
			if R.is_err(err_m):
				return err_m
	var result: Dictionary = {"autoloads": _public_autoloads(autoload_list()), "saved": true}
	if not warnings.is_empty():
		result["warnings"] = warnings
	return R.ok(result)


## Native class a GDScript file ends up instantiating (e.g. "Node2D", "MeshLibrary"), or ""
## when it can't be told. A script that compiles answers through
## Script.get_instance_base_type(), which follows `extends` through class_name and path
## bases. One with compile errors is resolved from its text instead: `extends <Native>`,
## `extends <class_name>` (via the global class list) or `extends "res://base.gd"`,
## followed up to 16 levels; no `extends` at all means RefCounted (GDScript's default).
static func _script_native_base(path: String, source: String, compiles: bool) -> String:
	if compiles:
		var script := GDScript.new()
		script.source_code = source
		script.set_path_cache(path)
		if script.reload() == OK:
			var native: String = String(script.get_instance_base_type())
			if not native.is_empty():
				return native
	var re := RegEx.create_from_string("(?m)^(?:@\\w+(?:\\([^)\\n]*\\))?\\s+)*(?:class_name\\s+\\w+\\s+)?extends\\s+(\"[^\"]*\"|'[^']*'|[A-Za-z_][\\w.]*)")
	var text: String = source
	for _hop: int in 16:
		var m: RegExMatch = re.search(text)
		if m == null:
			return "RefCounted"
		var target: String = m.get_string(1)
		var next_path: String = ""
		if target.begins_with("\"") or target.begins_with("'"):
			next_path = target.substr(1, target.length() - 2)
		elif ClassDB.class_exists(target):
			return target
		else:
			for entry: Dictionary in ProjectSettings.get_global_class_list():
				if str(entry.get("class", "")) == target:
					next_path = str(entry.get("path", ""))
					break
		if next_path.is_empty() or not FileAccess.file_exists(next_path):
			return ""
		text = FileAccess.get_file_as_string(next_path)
	return ""


## Assigns the existing autoload order numbers (sorted) to `keys` in sequence, the way the
## Autoload tab reorders by drag and drop. A key not yet in `list` (being added) gets a
## slot after the current maximum. Returns [key, order] pairs.
static func _reorder(list: Array, keys: Array) -> Array:
	var slots: Array = []
	for a: Dictionary in list:
		slots.append(int(a["order"]))
	slots.sort()
	var next: int = (slots.back() + 1) if not slots.is_empty() else 1
	while slots.size() < keys.size():
		slots.append(next)
		next += 1
	var out: Array = []
	for i: int in keys.size():
		out.append([keys[i], slots[i]])
	return out


## Same rules as EditorAutoloadSettings::_autoload_name_is_valid (4.7). "" when valid.
static func _autoload_name_error(name: String) -> String:
	if not name.is_valid_unicode_identifier():
		return "'%s' is not a valid identifier (letters, digits and _, not starting with a digit), e.g. \"GameState\"." % name
	if ClassDB.class_exists(name):
		return "'%s' collides with the engine class %s; pick another name (e.g. \"%sManager\")." % [name, name, name]
	for g: Dictionary in ProjectSettings.get_global_class_list():
		if str(g.get("class", "")) == name:
			return "'%s' collides with the global script class declared in %s (class_name); pick another name." % [name, g.get("path", "?")]
	for t: int in TYPE_MAX:
		if type_string(t) == name:
			return "'%s' collides with the built-in type %s." % [name, name]
	if Engine.has_singleton(name):
		return "'%s' collides with the engine singleton %s." % [name, name]
	if name in RESERVED_WORDS:
		return "'%s' is a GDScript keyword and cannot be an autoload name." % name
	return ""


# ---------------------------------------------------------------------------------------
# project.plugins
# ---------------------------------------------------------------------------------------

## Every plugin.cfg under res://addons, found like the editor's Plugins tab does
## (EditorPluginSettings::_get_plugins: recurse until a folder has a plugin.cfg).
static func find_plugins() -> PackedStringArray:
	var out: PackedStringArray = []
	_scan_plugins("res://addons", out)
	out.sort()
	return out


static func _scan_plugins(dir_path: String, out: PackedStringArray) -> void:
	var dir: DirAccess = DirAccess.open(dir_path)
	if dir == null:
		return
	for d: String in dir.get_directories():
		if d.begins_with("."):
			continue
		var full: String = dir_path.path_join(d)
		if FileAccess.file_exists(full.path_join("plugin.cfg")):
			out.append(full.path_join("plugin.cfg"))
		else:
			_scan_plugins(full, out)


static func enabled_plugins() -> PackedStringArray:
	var v: Variant = ProjectSettings.get_setting(PLUGINS_SETTING, PackedStringArray())
	return PackedStringArray(v) if v is PackedStringArray or v is Array else PackedStringArray()


static func _plugin_info(cfg_path: String, enabled: PackedStringArray) -> Dictionary:
	var cfg := ConfigFile.new()
	var info: Dictionary = {"path": cfg_path, "enabled": cfg_path in enabled}
	if cfg.load(cfg_path) == OK:
		info["name"] = str(cfg.get_value("plugin", "name", cfg_path.get_base_dir().get_file()))
		info["version"] = str(cfg.get_value("plugin", "version", ""))
	return info


## "x", "addons/x", "res://addons/x" or ".../plugin.cfg" -> "res://addons/x/plugin.cfg".
static func _normalize_plugin(raw: String, available: PackedStringArray) -> Dictionary:
	var s: String = raw.strip_edges().trim_suffix("/")
	var candidate: String
	if s.begins_with("res://"):
		candidate = s if s.ends_with(".cfg") else s.path_join("plugin.cfg")
	elif s.begins_with("addons/"):
		candidate = "res://" + (s if s.ends_with(".cfg") else s.path_join("plugin.cfg"))
	else:
		candidate = "res://addons/%s/plugin.cfg" % s
	if candidate in available:
		return R.value(candidate)
	# Match by the plugin's display name too ("Godot MCP").
	for cfg_path: String in available:
		var cfg := ConfigFile.new()
		if cfg.load(cfg_path) == OK and str(cfg.get_value("plugin", "name", "")).to_lower() == s.to_lower():
			return R.value(cfg_path)
	var short: Array[String] = []
	for a: String in available:
		short.append(a.trim_prefix("res://addons/").trim_suffix("/plugin.cfg"))
	return R.err(R.NOT_FOUND, "project.plugins: no plugin '%s' (looked for %s).%s Available plugins: %s." %
		[raw, candidate, Fuzzy.did_you_mean(Fuzzy.suggest(s.get_file(), short, 3)), ", ".join(short) if not short.is_empty() else "(none under res://addons)"])


static func edit_plugins(params: Dictionary, env: Dictionary) -> Dictionary:
	var p := Params.new(params, "project.plugins")
	var enable_raw: Array = p.opt_array("enable", [])
	var disable_raw: Array = p.opt_array("disable", [])
	var force: bool = p.opt_bool("force", false)
	if p.failed():
		return p.error
	var available: PackedStringArray = find_plugins()
	var enable: PackedStringArray = []
	var disable: PackedStringArray = []
	for raw: Variant in enable_raw:
		var n: Dictionary = _normalize_plugin(str(raw), available)
		if R.is_err(n):
			return n
		enable.append(n["value"])
	for raw: Variant in disable_raw:
		var n2: Dictionary = _normalize_plugin(str(raw), available)
		if R.is_err(n2):
			return n2
		if n2["value"] in enable:
			return R.err(R.BAD_PARAMS, "project.plugins: '%s' is in both 'enable' and 'disable'." % n2["value"])
		disable.append(n2["value"])
	if SELF_PLUGIN in disable and not force:
		return R.err(R.BAD_PARAMS, "project.plugins: disabling godot_mcp itself would cut the editor's connection to this MCP server. Pass \"force\": true if that is really intended.")

	var warnings: Array = []
	var changed: Array = []
	var self_disable: bool = false
	if bool(env.get("editor", false)) and env.get("interface") != null:
		var ei: Object = env["interface"]
		for path: String in enable:
			if bool(ei.call("is_plugin_enabled", path)):
				continue
			ei.call("set_plugin_enabled", path, true)
			if bool(ei.call("is_plugin_enabled", path)):
				changed.append({"path": path, "enabled": true})
			else:
				warnings.append("The editor could not enable '%s' (bad plugin.cfg or a script error in the plugin); see editor.logs." % path)
		for path: String in disable:
			if not bool(ei.call("is_plugin_enabled", path)):
				continue
			if path == SELF_PLUGIN:
				# Deferred, so this response still goes out before the bridge shuts down.
				Callable(ei, "set_plugin_enabled").call_deferred(path, false)
				self_disable = true
				changed.append({"path": path, "enabled": false})
				continue
			ei.call("set_plugin_enabled", path, false)
			changed.append({"path": path, "enabled": false})
		if not changed.is_empty() and not self_disable:
			var save_err: int = ProjectSettings.save()
			if save_err != OK:
				return R.godot_err("Saving project.godot", save_err)
	else:
		# Headless: the enabled list is the editor_plugins/enabled setting (sorted, erased
		# when empty, exactly like EditorNode::_update_addon_config). The editor loads the
		# plugins the next time it opens the project.
		var current: PackedStringArray = enabled_plugins()
		var next: PackedStringArray = current.duplicate()
		for path: String in enable:
			if not path in next:
				next.append(path)
				changed.append({"path": path, "enabled": true})
		for path: String in disable:
			if path in next:
				next.remove_at(next.find(path))
				changed.append({"path": path, "enabled": false})
		next.sort()
		if next != current:
			var old: Variant = ProjectSettings.get_setting(PLUGINS_SETTING) if ProjectSettings.has_setting(PLUGINS_SETTING) else null
			var new_value: Variant = null # an empty list erases the setting
			if not next.is_empty():
				new_value = next
			var err: Dictionary = commit_settings([[PLUGINS_SETTING, old, new_value]], [], "MCP: project.plugins", env)
			if R.is_err(err):
				return err
			if not changed.is_empty():
				warnings.append("Saved to project.godot; the editor loads the change the next time it opens the project.")
	var now_enabled: PackedStringArray = enabled_plugins()
	if self_disable:
		# The deferred call has not run yet; report the state it is about to produce.
		if SELF_PLUGIN in now_enabled:
			now_enabled.remove_at(now_enabled.find(SELF_PLUGIN))
		warnings.append("godot_mcp is being disabled: the editor bridge closes right after this response.")
	var plugins: Array = []
	for cfg_path: String in available:
		plugins.append(_plugin_info(cfg_path, now_enabled))
	for path: String in now_enabled:
		if not path in available:
			plugins.append({"path": path, "enabled": true, "missing": true})
			warnings.append("'%s' is enabled but its plugin.cfg does not exist; disable it with {\"disable\": [\"%s\"]}." % [path, path])
	var result: Dictionary = {"plugins": plugins, "changed": changed}
	if not warnings.is_empty():
		result["warnings"] = warnings
	return R.ok(result)
