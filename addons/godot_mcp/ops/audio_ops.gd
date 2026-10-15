@tool
extends RefCounted
## Audio: bus layout (default_bus_layout.tres) read and edit.
##
## Registered in core/methods.gd (MODULES). `methods()` maps each bridge-protocol method
## this module implements to a descriptor (see the comment on Methods.MODULES for kinds).
##
## The bus layout is the AudioBusLayout resource named by the project setting
## audio/buses/default_bus_layout (default "res://default_bus_layout.tres"). It does not
## have to exist: without it the project has just the Master bus.
##
## Both backends use AudioServer as the editing engine, because its API (add_bus, move_bus,
## add_bus_effect, ...) already implements every rule of a bus layout, and
## AudioServer.generate_bus_layout() turns the result into the resource we save. This works
## headless too: a --script run has a real AudioServer on the Dummy driver (verified on
## 4.7.2: set_bus_layout / generate_bus_layout / add_bus_effect all behave normally).
##
## * Headless: load the layout file into AudioServer, apply the ops, generate, save.
## * Editor: the Audio bottom panel (EditorAudioBuses) shows AudioServer's live state. It
##   rebuilds on AudioServer's `bus_layout_changed` / `bus_renamed` signals and auto-saves
##   the layout file when AudioServer is flagged as edited (editor/audio/editor_audio_buses.cpp).
##   AudioServer.set_bus_layout() however emits no signal and clears the edited flag, so
##   whoever calls it must refresh the panel and save the file. We apply the ops to
##   AudioServer to validate them and compute the new layout, put the old layout back, and
##   then commit one EditorUndoRedoManager action whose do/undo both call
##   _LayoutApplier.apply(): set_bus_layout(layout), emit bus_layout_changed (the panel
##   rebuilds), save the file and tell the FileSystem dock. Ctrl+Z therefore restores both
##   the live buses and the file. (Global history: the bus layout belongs to no scene.)
##
## Effects are resources shared between AudioServer and any layout generated from it, so
## set_effect never modifies an effect in place: it replaces it with an edited duplicate,
## which keeps the "old" layout used for undo intact.

const R := preload("../core/mcp_result.gd")
const Params := preload("../core/params.gd")
const Codec := preload("../core/variant_codec.gd")
const ResPaths := preload("../core/res_paths.gd")
const ChangeSet := preload("../core/change_set.gd")
const Fuzzy := preload("../core/fuzzy.gd")
## Use instead of ResourceSaver.save: keeps uids in headless runs (see res_save.gd).
const ResSave := preload("../core/res_save.gd")

const DEFAULT_LAYOUT: String = "res://default_bus_layout.tres"
const EDIT_OPS: PackedStringArray = ["add_bus", "remove_bus", "rename_bus", "move_bus", "set", "add_effect", "remove_effect", "set_effect"]


static func methods() -> Dictionary:
	return {
		"audio.buses": {"kind": "project", "fn": read_buses},
		"audio.edit": {"kind": "project", "fn": edit_buses},
	}


## Applies a layout in the editor (an undo/redo target, kept alive by the undo history).
class _LayoutApplier extends RefCounted:
	var path: String
	var filesystem: Object

	func apply(layout: AudioBusLayout) -> void:
		AudioServer.set_bus_layout(layout)
		# set_bus_layout does not notify anyone; the Audio panel rebuilds on this signal.
		AudioServer.bus_layout_changed.emit()
		var err: int = ResSave.save(layout, path)
		if err != OK:
			push_warning("Godot MCP: saving the bus layout to '%s' failed: %s" % [path, error_string(err)])
		elif filesystem != null:
			filesystem.call("update_file", path)


## res:// path of the project's bus layout file (the setting may hold a uid:// reference).
static func layout_path() -> String:
	var setting: String = str(ProjectSettings.get_setting("audio/buses/default_bus_layout", DEFAULT_LAYOUT))
	if setting.is_empty():
		return DEFAULT_LAYOUT
	if setting.begins_with("uid://"):
		var id: int = ResourceUID.text_to_id(setting)
		if id != ResourceUID.INVALID_ID and ResourceUID.has_id(id):
			return ResourceUID.get_id_path(id)
		return DEFAULT_LAYOUT
	return setting


## Headless: loads the layout file (or a Master-only layout when it does not exist) into
## AudioServer. Returns {"value": layout, "exists": bool} or an error.
static func _load_into_server(path: String) -> Dictionary:
	var layout: AudioBusLayout = null
	var exists: bool = ResPaths.file_exists(path)
	if exists:
		layout = ResourceLoader.load(path, "", ResourceLoader.CACHE_MODE_IGNORE) as AudioBusLayout
		if layout == null:
			return R.err(R.GODOT_ERROR, "The bus layout '%s' (project setting audio/buses/default_bus_layout) could not be loaded as an AudioBusLayout. Fix or delete the file." % path)
	else:
		layout = AudioBusLayout.new()
	AudioServer.set_bus_layout(layout)
	return {"value": layout, "exists": exists}


## Current buses as JSON, read from AudioServer.
static func buses_info() -> Array:
	var out: Array = []
	for i: int in range(AudioServer.bus_count):
		var effects: Array = []
		for e: int in range(AudioServer.get_bus_effect_count(i)):
			var fx: AudioEffect = AudioServer.get_bus_effect(i, e)
			effects.append({
				"index": e,
				"class": fx.get_class(),
				"enabled": AudioServer.is_bus_effect_enabled(i, e),
				"properties": Codec.encode_object_properties(fx, null),
			})
		var send: Variant = null  # Master has no send
		if i > 0:
			send = String(AudioServer.get_bus_send(i))
		var bus: Dictionary = {
			"index": i,
			"name": AudioServer.get_bus_name(i),
			"volume_db": AudioServer.get_bus_volume_db(i),
			"mute": AudioServer.is_bus_mute(i),
			"solo": AudioServer.is_bus_solo(i),
			"bypass_effects": AudioServer.is_bus_bypassing_effects(i),
			"send": send,
			"effects": effects,
		}
		out.append(bus)
	return out


## audio.buses
static func read_buses(params: Variant, env: Dictionary) -> Dictionary:
	var p := Params.new(params, "audio.buses")
	if p.failed():
		return p.error
	var path: String = layout_path()
	var exists: bool = ResPaths.file_exists(path)
	if not bool(env.get("editor", false)):
		var loaded: Dictionary = _load_into_server(path)
		if R.is_err(loaded):
			return loaded
	var result: Dictionary = {
		"layout": path,
		"layout_exists": exists,
		# In the editor AudioServer is the live state the Audio panel shows (it may hold
		# changes the panel has not auto-saved yet); headless it was just loaded from the file.
		"source": "audio_server" if bool(env.get("editor", false)) else "file",
		"buses": buses_info(),
	}
	if not exists:
		result["note"] = "No bus layout file yet: the project only has the Master bus. audio.edit creates '%s'." % path
	return R.ok(result)


## audio.edit
static func edit_buses(params: Variant, env: Dictionary) -> Dictionary:
	var p := Params.new(params, "audio.edit")
	var ops: Array = p.opt_array("ops", [])
	if p.failed():
		return p.error
	if ops.is_empty():
		return R.err(R.BAD_PARAMS, "audio.edit: 'ops' must be a non-empty array, e.g. [{\"op\": \"add_bus\", \"name\": \"Music\"}, {\"op\": \"add_effect\", \"bus\": \"Music\", \"type\": \"AudioEffectReverb\"}].")
	var editor: bool = bool(env.get("editor", false))
	var path: String = layout_path()
	var old: AudioBusLayout
	if editor:
		old = AudioServer.generate_bus_layout()
	else:
		var loaded: Dictionary = _load_into_server(path)
		if R.is_err(loaded):
			return loaded
		old = loaded["value"]

	var results: Array = []
	var warnings: Array[String] = []
	for i: int in range(ops.size()):
		var r: Dictionary
		if not ops[i] is Dictionary:
			r = R.err(R.BAD_PARAMS, "audio.edit: ops[%d] must be an object like {\"op\": \"set\", \"bus\": \"Music\", \"volume_db\": -6}." % i)
		else:
			r = _apply_op(ops[i], "audio.edit: ops[%d] (%s)" % [i, (ops[i] as Dictionary).get("op", "")], warnings)
		if R.is_err(r):
			# Nothing may stick: put the previous state back.
			AudioServer.set_bus_layout(old)
			if editor:
				AudioServer.bus_layout_changed.emit()
			return r
		results.append(r["value"])

	var new_layout: AudioBusLayout = AudioServer.generate_bus_layout()
	if editor:
		# Undo back to the old state, then redo it as one undoable action (see header).
		AudioServer.set_bus_layout(old)
		var applier := _LayoutApplier.new()
		applier.path = path
		applier.filesystem = env.get("filesystem")
		var cs := ChangeSet.new()
		cs.do_method(applier, &"apply", [new_layout])
		cs.undo_method(applier, &"apply", [old])
		cs.commit_to_undo_redo(env["undo_redo"], "MCP: audio.edit", null)
	else:
		var err: int = ResSave.save(new_layout, path)
		if err != OK:
			return R.godot_err("Saving the bus layout to '%s'" % path, err)
	var result: Dictionary = {"layout": path, "saved": true, "results": results, "buses": buses_info()}
	if not warnings.is_empty():
		result["warnings"] = warnings
	return R.ok(result)


## Resolves a bus given by name or index. Returns {"value": index} or an error.
static func _bus(op: Dictionary, key: String, where: String) -> Dictionary:
	var v: Variant = op.get(key)
	var names: Array[String] = []
	for i: int in range(AudioServer.bus_count):
		names.append(AudioServer.get_bus_name(i))
	if v is float or v is int:
		var idx: int = int(v)
		if idx < 0 or idx >= AudioServer.bus_count:
			return R.err(R.NOT_FOUND, "%s: bus index %d is out of range (0..%d). Buses: %s." % [where, idx, AudioServer.bus_count - 1, ", ".join(names)])
		return R.value(idx)
	if v is String:
		var idx2: int = AudioServer.get_bus_index(StringName(v))
		if idx2 < 0:
			return R.err(R.NOT_FOUND, "%s: no bus named '%s'.%s Buses: %s." % [where, v, Fuzzy.did_you_mean(Fuzzy.suggest(v, names, 3)), ", ".join(names)])
		return R.value(idx2)
	return R.err(R.BAD_PARAMS, "%s: '%s' is required: a bus name such as \"Master\" or its index." % [where, key])


static func _not_master(idx: int, what: String, where: String) -> Dictionary:
	if idx == 0:
		return R.err(R.BAD_PARAMS, "%s: the Master bus (index 0) cannot be %s." % [where, what])
	return {}


static func _check_new_name(bus_name: String, ignore: int, where: String) -> Dictionary:
	if bus_name.strip_edges().is_empty():
		return R.err(R.BAD_PARAMS, "%s: 'name' is required." % where)
	var existing: int = AudioServer.get_bus_index(StringName(bus_name))
	if existing >= 0 and existing != ignore:
		return R.err(R.CONFLICT, "%s: a bus named '%s' already exists (index %d)." % [where, bus_name, existing])
	return {}


## volume_db / mute / solo / bypass_effects / send on bus `idx`. Returns {} or an error.
static func _set_bus_fields(idx: int, op: Dictionary, where: String) -> Dictionary:
	if op.get("volume_db") != null:
		if not (op["volume_db"] is float or op["volume_db"] is int):
			return R.err(R.BAD_PARAMS, "%s: 'volume_db' must be a number (decibels, 0 = unchanged, -80 = silent), got %s." % [where, JSON.stringify(op["volume_db"])])
		AudioServer.set_bus_volume_db(idx, float(op["volume_db"]))
	for key: String in ["mute", "solo", "bypass_effects"]:
		if op.get(key) == null:
			continue
		if not op[key] is bool:
			return R.err(R.BAD_PARAMS, "%s: '%s' must be true or false." % [where, key])
		match key:
			"mute":
				AudioServer.set_bus_mute(idx, op[key])
			"solo":
				AudioServer.set_bus_solo(idx, op[key])
			_:
				AudioServer.set_bus_bypass_effects(idx, op[key])
	if op.get("send") != null:
		if idx == 0:
			return R.err(R.BAD_PARAMS, "%s: the Master bus outputs to the speakers and has no 'send'." % where)
		var target: Dictionary = _bus(op, "send", where + " 'send'")
		if R.is_err(target):
			return target
		if int(target["value"]) == idx:
			return R.err(R.BAD_PARAMS, "%s: a bus cannot send to itself." % where)
		AudioServer.set_bus_send(idx, StringName(AudioServer.get_bus_name(target["value"])))
	return {}


## Sets `props` on `fx` (type-directed decoding). Returns {} or an error.
static func _set_effect_props(fx: AudioEffect, props: Variant, where: String) -> Dictionary:
	if props == null:
		return {}
	if not props is Dictionary:
		return R.err(R.BAD_PARAMS, "%s: 'properties' must be an object, e.g. {\"room_size\": 0.6}." % where)
	for key: Variant in props:
		var pname: String = str(key)
		if Codec.find_property(fx, pname).is_empty() or pname.begins_with("resource_"):
			var e: Dictionary = Codec.unknown_property_error(fx, pname, fx.get_class())
			e["error"]["message"] = "%s: %s" % [where, (e["error"]["message"] as String).replace(" Use node.get to list all properties and their current values.", " audio.buses lists each effect's properties.")]
			return e
		var r: Dictionary = Codec.decode_property(fx, pname, props[key], null)
		if R.is_err(r):
			r["error"]["message"] = "%s: %s" % [where, r["error"]["message"]]
			return r
		fx.set(pname, r["value"])
	return {}


static func _effect_index(bus: int, op: Dictionary, where: String) -> Dictionary:
	var v: Variant = op.get("effect")
	var count: int = AudioServer.get_bus_effect_count(bus)
	if not (v is float or v is int) or int(v) < 0 or int(v) >= count:
		var list: Array[String] = []
		for e: int in range(count):
			list.append("%d: %s" % [e, AudioServer.get_bus_effect(bus, e).get_class()])
		return R.err(R.NOT_FOUND, "%s: 'effect' must be an effect index on bus '%s'. Effects: %s." % [where, AudioServer.get_bus_name(bus), "; ".join(list) if not list.is_empty() else "(none)"])
	return R.value(int(v))


static func _apply_op(op: Dictionary, where: String, warnings: Array[String]) -> Dictionary:
	var kind: String = str(op.get("op", ""))
	match kind:
		"add_bus":
			var bus_name: String = str(op.get("name", "")) if op.get("name") != null else ""
			var ne: Dictionary = _check_new_name(bus_name, -1, where)
			if not ne.is_empty():
				return ne
			var at: int = -1
			if op.get("index") != null:
				at = int(op["index"]) if (op["index"] is float or op["index"] is int) else -2
				if at < 1 or at > AudioServer.bus_count:
					return R.err(R.BAD_PARAMS, "%s: 'index' must be 1..%d (index 0 is always Master); omit it to append." % [where, AudioServer.bus_count])
			AudioServer.add_bus(at)
			var idx: int = at if at >= 0 else AudioServer.bus_count - 1
			AudioServer.set_bus_name(idx, bus_name)
			AudioServer.set_bus_send(idx, &"Master")
			var fe: Dictionary = _set_bus_fields(idx, op, where)
			if not fe.is_empty():
				return fe
			return R.value({"op": kind, "bus": bus_name, "index": idx})
		"remove_bus":
			var b: Dictionary = _bus(op, "bus", where)
			if R.is_err(b):
				return b
			var idx2: int = b["value"]
			var nm: Dictionary = _not_master(idx2, "removed", where)
			if not nm.is_empty():
				return nm
			var removed: String = AudioServer.get_bus_name(idx2)
			AudioServer.remove_bus(idx2)
			# Buses that sent to the removed one would silently fall back to Master; make it explicit.
			for i: int in range(1, AudioServer.bus_count):
				if String(AudioServer.get_bus_send(i)) == removed:
					AudioServer.set_bus_send(i, &"Master")
					warnings.append("%s: bus '%s' sent to '%s' and now sends to Master." % [where, AudioServer.get_bus_name(i), removed])
			return R.value({"op": kind, "bus": removed})
		"rename_bus":
			var b3: Dictionary = _bus(op, "bus", where)
			if R.is_err(b3):
				return b3
			var idx3: int = b3["value"]
			var nm3: Dictionary = _not_master(idx3, "renamed", where)
			if not nm3.is_empty():
				return nm3
			var new_name: String = str(op.get("name", "")) if op.get("name") != null else ""
			var ne3: Dictionary = _check_new_name(new_name, idx3, where)
			if not ne3.is_empty():
				return ne3
			var old_name: String = AudioServer.get_bus_name(idx3)
			AudioServer.set_bus_name(idx3, new_name)
			# AudioServer does not update sends that name the old bus; the editor panel does.
			for i: int in range(1, AudioServer.bus_count):
				if String(AudioServer.get_bus_send(i)) == old_name:
					AudioServer.set_bus_send(i, StringName(new_name))
			return R.value({"op": kind, "bus": new_name, "renamed_from": old_name})
		"move_bus":
			var b4: Dictionary = _bus(op, "bus", where)
			if R.is_err(b4):
				return b4
			var idx4: int = b4["value"]
			var nm4: Dictionary = _not_master(idx4, "moved", where)
			if not nm4.is_empty():
				return nm4
			var to: int = int(op["index"]) if (op.get("index") is float or op.get("index") is int) else -1
			if to < 1 or to >= AudioServer.bus_count:
				return R.err(R.BAD_PARAMS, "%s: 'index' (the bus's new position) must be 1..%d; index 0 is always Master." % [where, AudioServer.bus_count - 1])
			var moved: String = AudioServer.get_bus_name(idx4)
			# AudioServer.move_bus takes the insertion point before removal; convert from
			# the final index the caller gave.
			if to != idx4:
				AudioServer.move_bus(idx4, to + 1 if to > idx4 else to)
			return R.value({"op": kind, "bus": moved, "index": AudioServer.get_bus_index(StringName(moved))})
		"set":
			var b5: Dictionary = _bus(op, "bus", where)
			if R.is_err(b5):
				return b5
			if not (op.has("volume_db") or op.has("mute") or op.has("solo") or op.has("bypass_effects") or op.has("send")):
				return R.err(R.BAD_PARAMS, "%s: pass at least one of volume_db, mute, solo, bypass_effects, send." % where)
			var fe5: Dictionary = _set_bus_fields(b5["value"], op, where)
			if not fe5.is_empty():
				return fe5
			return R.value({"op": kind, "bus": AudioServer.get_bus_name(b5["value"])})
		"add_effect":
			var b6: Dictionary = _bus(op, "bus", where)
			if R.is_err(b6):
				return b6
			var idx6: int = b6["value"]
			var type: String = str(op.get("type", "")) if op.get("type") != null else ""
			if type.is_empty():
				return R.err(R.BAD_PARAMS, "%s: 'type' is required, e.g. \"AudioEffectReverb\", \"AudioEffectCompressor\", \"AudioEffectLowPassFilter\"." % where)
			var created: Dictionary = Codec.instantiate_class(type, "AudioEffect")
			if R.is_err(created):
				created["error"]["message"] = "%s: %s" % [where, created["error"]["message"]]
				return created
			var fx: AudioEffect = created["value"]
			var pe: Dictionary = _set_effect_props(fx, op.get("properties"), where)
			if not pe.is_empty():
				return pe
			var at6: int = -1
			if op.get("index") != null:
				at6 = int(op["index"]) if (op["index"] is float or op["index"] is int) else -2
				if at6 < 0 or at6 > AudioServer.get_bus_effect_count(idx6):
					return R.err(R.BAD_PARAMS, "%s: 'index' must be 0..%d; omit it to append." % [where, AudioServer.get_bus_effect_count(idx6)])
			AudioServer.add_bus_effect(idx6, fx, at6)
			var eidx: int = at6 if at6 >= 0 else AudioServer.get_bus_effect_count(idx6) - 1
			if op.get("enabled") is bool:
				AudioServer.set_bus_effect_enabled(idx6, eidx, op["enabled"])
			return R.value({"op": kind, "bus": AudioServer.get_bus_name(idx6), "effect": eidx, "class": fx.get_class()})
		"remove_effect", "set_effect":
			var b7: Dictionary = _bus(op, "bus", where)
			if R.is_err(b7):
				return b7
			var idx7: int = b7["value"]
			var ei: Dictionary = _effect_index(idx7, op, where)
			if R.is_err(ei):
				return ei
			var e7: int = ei["value"]
			var cls: String = AudioServer.get_bus_effect(idx7, e7).get_class()
			if kind == "remove_effect":
				AudioServer.remove_bus_effect(idx7, e7)
				return R.value({"op": kind, "bus": AudioServer.get_bus_name(idx7), "effect": e7, "class": cls})
			if op.get("properties") == null and not op.get("enabled") is bool:
				return R.err(R.BAD_PARAMS, "%s: pass 'properties' and/or 'enabled'." % where)
			var enabled: bool = AudioServer.is_bus_effect_enabled(idx7, e7)
			if op.get("properties") != null:
				# Replace with an edited copy (never mutate: the undo layout shares the object).
				var copy: AudioEffect = AudioServer.get_bus_effect(idx7, e7).duplicate() as AudioEffect
				var pe7: Dictionary = _set_effect_props(copy, op["properties"], where)
				if not pe7.is_empty():
					return pe7
				AudioServer.remove_bus_effect(idx7, e7)
				AudioServer.add_bus_effect(idx7, copy, e7)
			AudioServer.set_bus_effect_enabled(idx7, e7, op["enabled"] if op.get("enabled") is bool else enabled)
			return R.value({"op": kind, "bus": AudioServer.get_bus_name(idx7), "effect": e7, "class": cls,
				"enabled": AudioServer.is_bus_effect_enabled(idx7, e7),
				"properties": Codec.encode_object_properties(AudioServer.get_bus_effect(idx7, e7), null)})
	return R.err(R.BAD_PARAMS, "%s: 'op' must be one of %s." % [where, ", ".join(EDIT_OPS)])
