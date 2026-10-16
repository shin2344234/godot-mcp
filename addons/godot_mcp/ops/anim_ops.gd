@tool
extends RefCounted
## Animation: AnimationPlayer libraries/tracks/keys and AnimationTree state machines/blend spaces.
##
## Registered in core/methods.gd (MODULES). `methods()` maps each bridge-protocol method
## this module implements to a descriptor (see the comment on Methods.MODULES for kinds).
## The AnimationTree half lives in core/anim_tree_ops.gd and the SpriteFrames half
## (AnimatedSprite2D/3D flip-book animations) in core/sprite_frames_ops.gd, to keep this
## file readable.
##
## How AnimationPlayer edits stay undoable (anim.edit)
## ----------------------------------------------------
## Animations and libraries inside a scene are *sub-resources*: they are not nodes, so the
## node-level tricks of scene_ops.gd do not apply. An anim.edit call is a list of ops that
## must be validated as a whole before anything is touched, and later ops depend on earlier
## ones (add_track returns the index that insert_key then uses). We therefore *simulate* the
## whole call during planning and describe only the net change in the ChangeSet:
##
## * Content edits (set, add_track, remove_track, insert_key, remove_key) on an animation
##   that already exists are applied to a private working copy. The ChangeSet then says
##   "do: anim.copy_from_resource(working copy)" and "undo: anim.copy_from_resource(snapshot
##   taken before)". Resource.copy_from_resource (new in 4.7, verified on 4.7.2) resets the
##   animation and copies every stored property, so the live Animation object keeps its
##   identity: the editor's track editor, which holds a reference to it, keeps working, and
##   undo/redo is exact no matter how many track/key operations the call contained.
##   (Inverse per-key operations would also work but are fragile: indices shift after every
##   insert/remove, and Godot silently replaces a key inserted at an existing time.)
## * Structural edits (create, remove, rename) on an existing library are recorded as
##   AnimationLibrary method calls (add_animation/remove_animation/rename_animation) with
##   their inverses. Undo operations run in the order they were added (ChangeSet contract),
##   so we collect them and add them reversed at the end.
## * Brand-new animations and libraries are not part of the scene yet, so they are simply
##   built during planning; the ChangeSet only adds them (and removes them on undo).
##
## Headless, the backend applies the same ChangeSet directly and packs the scene, so the
## embedded Animation/AnimationLibrary sub-resources are written into the .tscn.
## Libraries or animations saved as their own .tres files are external: packing the scene
## does not write them, so `finish` saves them with ResourceSaver and reports the paths.

const R := preload("../core/mcp_result.gd")
const Params := preload("../core/params.gd")
const Codec := preload("../core/variant_codec.gd")
const NodePaths := preload("../core/node_paths.gd")
const ResPaths := preload("../core/res_paths.gd")
const ChangeSet := preload("../core/change_set.gd")
const Fuzzy := preload("../core/fuzzy.gd")
## Use instead of ResourceSaver.save: keeps uids in headless runs (see res_save.gd).
const ResSave := preload("../core/res_save.gd")
const AnimTree := preload("../core/anim_tree_ops.gd")
const Frames := preload("../core/sprite_frames_ops.gd")

## Track type names used in params and results, indexed by Animation.TrackType.
const TRACK_TYPES: PackedStringArray = ["value", "position_3d", "rotation_3d", "scale_3d", "blend_shape", "method", "bezier", "audio", "animation"]
## Indexed by Animation.InterpolationType.
const INTERPOLATIONS: PackedStringArray = ["nearest", "linear", "cubic", "linear_angle", "cubic_angle"]
## Indexed by Animation.UpdateMode (value tracks only).
const UPDATE_MODES: PackedStringArray = ["continuous", "discrete", "capture"]
## Indexed by Animation.LoopMode.
const LOOP_MODES: PackedStringArray = ["none", "linear", "pingpong"]
const EDIT_OPS: PackedStringArray = ["create", "remove", "rename", "set", "add_track", "remove_track", "insert_key", "remove_key"]
## Characters Godot rejects in animation and library names (AnimationLibrary::is_valid_animation_name).
const _INVALID_NAME_CHARS: PackedStringArray = ["/", ":", ",", "["]


static func methods() -> Dictionary:
	return {
		"anim.read": {"kind": "scene_read", "fn": read_player},
		"anim.read_library": {"kind": "project", "fn": read_library},
		"anim.edit": {"kind": "scene_mutation", "fn": plan_edit},
		"anim.tree_read": {"kind": "scene_read", "fn": AnimTree.read_tree},
		"anim.tree": {"kind": "scene_mutation", "fn": AnimTree.plan_tree},
		# One MCP tool (godot_anim_frames), three methods: the server picks the read, the
		# scene edit (an undoable scene mutation) or the .tres edit (a file resource).
		"anim.frames": {"kind": "scene_mutation", "fn": Frames.plan_node},
		"anim.frames_read": {"kind": "scene_read", "fn": Frames.read_node},
		"anim.frames_file": {"kind": "project", "fn": Frames.edit_file},
	}


# ---------------------------------------------------------------------------------------
# Shared lookups
# ---------------------------------------------------------------------------------------

## Finds a node of class `cls` at `path`, or the only such node in the scene when `path` is
## empty. Errors list the candidates so the caller can pick one.
static func find_node_of_class(root: Node, path: String, cls: String, param_name: String, method: String) -> Dictionary:
	var candidates: Array[String] = []
	_collect_of_class(root, root, cls, candidates)
	if path.is_empty():
		if candidates.size() == 1:
			return R.value(root.get_node(candidates[0]) if candidates[0] != "." else root)
		if candidates.is_empty():
			return R.err(R.NOT_FOUND, "%s: the scene '%s' has no %s node. Add one first, e.g. node.add {\"type\": \"%s\"}." % [method, root.scene_file_path, cls, cls])
		return R.err(R.BAD_PARAMS, "%s: the scene has several %s nodes; pass '%s' with one of: %s." % [method, cls, param_name, ", ".join(candidates)], {"candidates": candidates})
	var res: Dictionary = NodePaths.resolve(root, path, param_name)
	if R.is_err(res):
		return res
	var node: Node = res["value"]
	if not node.is_class(cls):
		var hint: String = (" %s nodes in this scene: %s." % [cls, ", ".join(candidates)]) if not candidates.is_empty() else (" The scene has no %s yet." % cls)
		return R.err(R.BAD_PARAMS, "%s: '%s' is a %s, not an %s.%s" % [method, NodePaths.rel_path(root, node), node.get_class(), cls, hint], {"candidates": candidates})
	return res


static func _collect_of_class(root: Node, node: Node, cls: String, out: Array[String]) -> void:
	if node.is_class(cls):
		out.append(NodePaths.rel_path(root, node))
	for c: Node in NodePaths.listed_children(root, node):
		_collect_of_class(root, c, cls, out)


## Index of `value` in `names` (case-insensitive), or an actionable BAD_PARAMS error.
static func enum_index(names: PackedStringArray, value: String, param_name: String, method: String) -> Dictionary:
	var i: int = names.find(value.to_lower())
	if i < 0:
		return R.err(R.BAD_PARAMS, "%s: '%s' must be one of %s, got '%s'." % [method, param_name, ", ".join(names), value])
	return R.value(i)


## Splits "lib/anim" into ["lib", "anim"]; a bare name is in the default library "".
static func split_anim_name(full: String) -> PackedStringArray:
	var slash: int = full.find("/")
	if slash < 0:
		return PackedStringArray(["", full])
	return PackedStringArray([full.left(slash), full.substr(slash + 1)])


static func join_anim_name(lib: String, anim: String) -> String:
	return anim if lib.is_empty() else "%s/%s" % [lib, anim]


static func _check_anim_name(anim_name: String, what: String, method: String) -> Dictionary:
	if anim_name.strip_edges().is_empty():
		return R.err(R.BAD_PARAMS, "%s: the %s name must not be empty." % [method, what])
	for c: String in _INVALID_NAME_CHARS:
		if anim_name.contains(c):
			return R.err(R.BAD_PARAMS, "%s: invalid %s name '%s': names cannot contain / : , or [ (use 'library' to pick the library)." % [method, what, anim_name])
	return {}


## True for resources saved in their own file (not embedded in the scene).
static func is_external(res: Resource) -> bool:
	return res != null and not res.resource_path.is_empty() and not res.resource_path.contains("::")


# ---------------------------------------------------------------------------------------
# anim.read / anim.read_library
# ---------------------------------------------------------------------------------------

## anim.read: libraries and animations of an AnimationPlayer, or one animation's tracks.
static func read_player(root: Node, params: Variant) -> Dictionary:
	var p := Params.new(params, "anim.read")
	var player_path: String = p.opt_string("player", "")
	var anim_name: String = p.opt_string("animation", "")
	var max_keys: int = p.opt_int("max_keys", 50)
	if p.failed():
		return p.error
	var found: Dictionary = find_node_of_class(root, player_path, "AnimationPlayer", "player", "anim.read")
	if R.is_err(found):
		return found
	var player: AnimationPlayer = found["value"]
	var libraries: Array = []
	for lib_name: StringName in player.get_animation_library_list():
		var lib: AnimationLibrary = player.get_animation_library(lib_name)
		libraries.append(_library_summary(String(lib_name), lib))
	var result: Dictionary = {
		"player": NodePaths.rel_path(root, player),
		"root_node": String(player.root_node),
		"autoplay": player.autoplay,
		"libraries": libraries,
	}
	if not anim_name.is_empty():
		if not player.has_animation(anim_name):
			return _unknown_animation(anim_name, player.get_animation_list(), "anim.read")
		result["animation"] = animation_detail(anim_name, player.get_animation(anim_name), max_keys, root)
	return R.ok(result)


## anim.read_library: the same view for an AnimationLibrary (or Animation) .tres file.
static func read_library(params: Variant, _env: Dictionary) -> Dictionary:
	var p := Params.new(params, "anim.read")
	var raw: String = p.req_string("library")
	var anim_name: String = p.opt_string("animation", "")
	var max_keys: int = p.opt_int("max_keys", 50)
	if p.failed():
		return p.error
	var norm: Dictionary = ResPaths.normalize(raw, "library")
	if R.is_err(norm):
		return norm
	var path: String = norm["value"]
	if not ResPaths.file_exists(path):
		var libs: PackedStringArray = ResPaths.list_files(PackedStringArray(["tres", "res"]), 20)
		return R.err(R.NOT_FOUND, "anim.read: '%s' does not exist. Resource files in the project: %s." % [path, ", ".join(libs) if not libs.is_empty() else "(none)"])
	# Plain load(): in the editor this returns the in-memory copy, including unsaved edits.
	var res: Resource = load(path)
	if res is Animation:
		return R.ok({"library": path, "animation": animation_detail(path.get_file().get_basename(), res as Animation, max_keys, null)})
	if not res is AnimationLibrary:
		return R.err(R.BAD_PARAMS, "anim.read: '%s' is a %s, not an AnimationLibrary. To read an AnimationPlayer in a scene pass 'scene' and 'player' instead." % [path, res.get_class() if res != null else "unloadable file"])
	var lib: AnimationLibrary = res
	var result: Dictionary = _library_summary("", lib)
	result.erase("name")
	result.erase("resource")
	result["library"] = path
	if not anim_name.is_empty():
		if not lib.has_animation(anim_name):
			return _unknown_animation(anim_name, _names(lib.get_animation_list()), "anim.read")
		result["animation"] = animation_detail(anim_name, lib.get_animation(anim_name), max_keys, null)
	return R.ok(result)


static func _names(list: Array[StringName]) -> PackedStringArray:
	var out: PackedStringArray = []
	for n: StringName in list:
		out.append(String(n))
	return out


static func _unknown_animation(anim_name: String, known: PackedStringArray, method: String) -> Dictionary:
	var similar: Array[String] = Fuzzy.suggest(anim_name, known, 5)
	return R.err(R.NOT_FOUND, "%s: no animation '%s'.%s Animations: %s. Names in a named library are written \"library/animation\"." %
		[method, anim_name, Fuzzy.did_you_mean(similar), ", ".join(known) if not known.is_empty() else "(none)"], {"animations": Array(known)})


static func _library_summary(lib_name: String, lib: AnimationLibrary) -> Dictionary:
	var anims: Array = []
	for a: StringName in lib.get_animation_list():
		anims.append(animation_summary(join_anim_name(lib_name, String(a)), lib.get_animation(a)))
	var res_path: Variant = null  # Variant: a ternary mixing String and null is a lint error
	if is_external(lib):
		res_path = lib.resource_path
	return {
		"name": lib_name,
		"resource": res_path,
		"animations": anims,
	}


## Times are stored as 32-bit floats (0.1 reads back as 0.100000001490116); round them to
## 0.1 ms so results stay readable.
static func _r(seconds: float) -> float:
	return snappedf(seconds, 0.0001)


static func animation_summary(full_name: String, anim: Animation) -> Dictionary:
	return {
		"name": full_name,
		"length": _r(anim.length),
		"loop": LOOP_MODES[anim.loop_mode],
		"step": _r(anim.step),
		"track_count": anim.get_track_count(),
	}


## Every track of `anim` with up to `max_keys` keys each.
static func animation_detail(full_name: String, anim: Animation, max_keys: int, root: Node) -> Dictionary:
	var out: Dictionary = animation_summary(full_name, anim)
	if is_external(anim):
		out["resource"] = anim.resource_path
	var tracks: Array = []
	for t: int in range(anim.get_track_count()):
		tracks.append(track_info(anim, t, max_keys, root))
	out["tracks"] = tracks
	return out


static func track_info(anim: Animation, t: int, max_keys: int, root: Node) -> Dictionary:
	var type: int = anim.track_get_type(t)
	var info: Dictionary = {
		"index": t,
		"type": TRACK_TYPES[type],
		"path": String(anim.track_get_path(t)),
	}
	if not anim.track_is_enabled(t):
		info["enabled"] = false
	# Interpolation only means something for tracks whose values are blended.
	if type in [Animation.TYPE_VALUE, Animation.TYPE_POSITION_3D, Animation.TYPE_ROTATION_3D, Animation.TYPE_SCALE_3D, Animation.TYPE_BLEND_SHAPE]:
		info["interpolation"] = INTERPOLATIONS[anim.track_get_interpolation_type(t)]
	if type == Animation.TYPE_VALUE:
		info["update_mode"] = UPDATE_MODES[anim.value_track_get_update_mode(t)]
	var count: int = anim.track_get_key_count(t)
	info["key_count"] = count
	var keys: Array = []
	for k: int in range(mini(count, maxi(max_keys, 0))):
		keys.append({
			"time": _r(anim.track_get_key_time(t, k)),
			"value": _encode_key(anim, t, k, type, root),
			"transition": anim.track_get_key_transition(t, k),
		})
	info["keys"] = keys
	if count > keys.size():
		info["keys_truncated"] = true
	return info


static func _encode_key(anim: Animation, t: int, k: int, type: int, root: Node) -> Variant:
	match type:
		Animation.TYPE_METHOD:
			return {"method": String(anim.method_track_get_name(t, k)), "args": Codec.encode(anim.method_track_get_params(t, k), root)}
		Animation.TYPE_BEZIER:
			return {
				"value": anim.bezier_track_get_key_value(t, k),
				"in_handle": Codec.encode(anim.bezier_track_get_key_in_handle(t, k)),
				"out_handle": Codec.encode(anim.bezier_track_get_key_out_handle(t, k)),
			}
		Animation.TYPE_AUDIO:
			return {
				"stream": Codec.encode(anim.audio_track_get_key_stream(t, k), root),
				"start_offset": anim.audio_track_get_key_start_offset(t, k),
				"end_offset": anim.audio_track_get_key_end_offset(t, k),
			}
		Animation.TYPE_ANIMATION:
			return String(anim.animation_track_get_key_animation(t, k))
	return Codec.encode(anim.track_get_key_value(t, k), root)


# ---------------------------------------------------------------------------------------
# anim.edit
# ---------------------------------------------------------------------------------------

## Planning state of one anim.edit call (see the header comment for the strategy).
class EditState extends RefCounted:
	var root: Node
	var player: AnimationPlayer
	var allow_missing: bool = false
	## library name -> AnimationLibrary (live ones and ones created by this call)
	var libs: Dictionary = {}
	## library name -> {animation name -> Animation}: the library contents as they will be
	## after the ops planned so far (live libraries are not modified during planning).
	var view: Dictionary = {}
	## Libraries created by this call (built directly, then added by the ChangeSet).
	var new_libs: Array[String] = []
	## Animation objects that existed before the call -> true.
	var live: Dictionary = {}
	## Live Animation -> its working copy (content edits go there).
	var work: Dictionary = {}
	## Structural do/undo steps on live libraries: [object, method, args] triples.
	var do_steps: Array = []
	var undo_steps: Array = []
	## Current autoplay value as planned (renames/removals keep it pointing at the right name).
	var autoplay: String = ""
	## External .tres resources the call modifies (saved in finish).
	var external: Array[Resource] = []
	var warnings: Array[String] = []

	func add_external(res: Resource) -> void:
		if res != null and not res.resource_path.is_empty() and not res.resource_path.contains("::") and not res in external:
			external.append(res)


## anim.edit: ordered ops on an AnimationPlayer's animations, as one undo step.
static func plan_edit(root: Node, params: Variant) -> Dictionary:
	var p := Params.new(params, "anim.edit")
	var player_path: String = p.opt_string("player", "")
	var default_anim: String = p.opt_string("animation", "")
	var ops: Array = p.opt_array("ops", [])
	var allow_missing: bool = p.opt_bool("allow_missing", false)
	if p.failed():
		return p.error
	if ops.is_empty():
		return R.err(R.BAD_PARAMS, "anim.edit: 'ops' must be a non-empty array, e.g. [{\"op\": \"create\", \"animation\": \"walk\", \"length\": 0.8, \"loop\": \"linear\"}, {\"op\": \"add_track\", \"animation\": \"walk\", \"type\": \"value\", \"path\": \"Sprite2D:frame\"}].")
	var found: Dictionary = find_node_of_class(root, player_path, "AnimationPlayer", "player", "anim.edit")
	if R.is_err(found):
		return found
	var player: AnimationPlayer = found["value"]
	var edit_err: Dictionary = NodePaths.check_editable(root, player, "edit the animations of")
	if not edit_err.is_empty():
		return edit_err

	var st := EditState.new()
	st.root = root
	st.player = player
	st.allow_missing = allow_missing
	st.autoplay = player.autoplay
	for lib_name: StringName in player.get_animation_library_list():
		var lib: AnimationLibrary = player.get_animation_library(lib_name)
		st.libs[String(lib_name)] = lib
		var contents: Dictionary = {}
		for a: StringName in lib.get_animation_list():
			var anim: Animation = lib.get_animation(a)
			contents[String(a)] = anim
			st.live[anim] = true
		st.view[String(lib_name)] = contents

	var results: Array = []
	for i: int in range(ops.size()):
		if not ops[i] is Dictionary:
			return R.err(R.BAD_PARAMS, "anim.edit: ops[%d] must be an object like {\"op\": \"insert_key\", ...}." % i)
		var op: Dictionary = (ops[i] as Dictionary).duplicate()
		if not op.has("animation") and not default_anim.is_empty():
			op["animation"] = default_anim
		var r: Dictionary = _plan_op(st, op, i)
		if R.is_err(r):
			return r
		results.append(r["value"])

	# Assemble the ChangeSet: content restores first (they target objects, not names, so
	# their position relative to renames does not matter), then the structural steps.
	var cs := ChangeSet.new()
	var restores: Array = []
	for anim: Animation in st.work:
		var snapshot := Animation.new()
		snapshot.copy_from_resource(anim)
		cs.do_method(anim, &"copy_from_resource", [st.work[anim]])
		restores.append([anim, &"copy_from_resource", [snapshot]])
		st.add_external(anim)
	for step: Array in st.do_steps:
		cs.do_method(step[0], step[1], step[2])
	for lib_name: String in st.new_libs:
		cs.do_method(player, &"add_animation_library", [StringName(lib_name), st.libs[lib_name]])
		cs.do_reference(st.libs[lib_name])
	if st.autoplay != player.autoplay:
		cs.do_property(player, &"autoplay", st.autoplay)
	# Undo: exact reverse order of the do side.
	if st.autoplay != player.autoplay:
		cs.undo_property(player, &"autoplay", player.autoplay)
	for k: int in range(st.new_libs.size() - 1, -1, -1):
		cs.undo_method(player, &"remove_animation_library", [StringName(st.new_libs[k])])
	for k: int in range(st.undo_steps.size() - 1, -1, -1):
		var u: Array = st.undo_steps[k]
		cs.undo_method(u[0], u[1], u[2])
	for r: Array in restores:
		cs.undo_method(r[0], r[1], r[2])

	var finish := func() -> Dictionary:
		var saved: Array[String] = []
		for res: Resource in st.external:
			var err: int = ResSave.save(res, res.resource_path)
			if err != OK:
				st.warnings.append("Saving external resource '%s' failed: %s." % [res.resource_path, error_string(err)])
			else:
				saved.append(res.resource_path)
		var anims: Array = []
		for lib_name: StringName in player.get_animation_library_list():
			var lib: AnimationLibrary = player.get_animation_library(lib_name)
			for a: StringName in lib.get_animation_list():
				anims.append(animation_summary(join_anim_name(String(lib_name), String(a)), lib.get_animation(a)))
		var result: Dictionary = {"player": NodePaths.rel_path(root, player), "results": results, "animations": anims}
		if not saved.is_empty():
			result["saved_resources"] = saved
		if not st.warnings.is_empty():
			result["warnings"] = st.warnings
		return result
	return {"changes": cs, "finish": finish}


## Resolves op.animation (+ op.library) against the planned view. Returns
## {"value": [lib_name, anim_name]} or an error.
static func _target_name(st: EditState, op: Dictionary, i: int, must_exist: bool) -> Dictionary:
	var full: String = str(op.get("animation", ""))
	if full.is_empty():
		return R.err(R.BAD_PARAMS, "anim.edit: ops[%d] (%s) needs 'animation' (e.g. \"walk\", or \"library/walk\" for a named library)." % [i, op.get("op")])
	var parts: PackedStringArray = split_anim_name(full)
	if op.has("library") and op["library"] != null:
		parts = PackedStringArray([str(op["library"]), full])
	if must_exist:
		var contents: Dictionary = st.view.get(parts[0], {})
		if not contents.has(parts[1]):
			var known: PackedStringArray = []
			for lib_name: String in st.view:
				for a: String in st.view[lib_name]:
					known.append(join_anim_name(lib_name, a))
			var e: Dictionary = _unknown_animation(join_anim_name(parts[0], parts[1]), known, "anim.edit: ops[%d]" % i)
			if known.is_empty():
				e["error"]["message"] += " Create one first with {\"op\": \"create\", \"animation\": \"%s\"}." % full
			return e
	return R.value(parts)


## The Animation object that content ops on `lib/anim` must modify: the working copy of a
## live animation, or the new animation itself.
static func _editable(st: EditState, lib_name: String, anim_name: String) -> Animation:
	var anim: Animation = st.view[lib_name][anim_name]
	if not st.live.has(anim):
		return anim
	if not st.work.has(anim):
		var copy := Animation.new()
		copy.copy_from_resource(anim)
		st.work[anim] = copy
	return st.work[anim]


static func _plan_op(st: EditState, op: Dictionary, i: int) -> Dictionary:
	var kind: String = str(op.get("op", ""))
	var where: String = "anim.edit: ops[%d] (%s)" % [i, kind]
	match kind:
		"create":
			return _op_create(st, op, i, where)
		"remove":
			return _op_remove(st, op, i)
		"rename":
			return _op_rename(st, op, i, where)
		"set", "add_track", "remove_track", "insert_key", "remove_key":
			var t: Dictionary = _target_name(st, op, i, true)
			if R.is_err(t):
				return t
			var parts: PackedStringArray = t["value"]
			var anim: Animation = _editable(st, parts[0], parts[1])
			var full: String = join_anim_name(parts[0], parts[1])
			match kind:
				"set":
					return _op_set(anim, op, full, where)
				"add_track":
					return _op_add_track(st, anim, op, full, where)
				"remove_track":
					return _op_remove_track(anim, op, full, where)
				"insert_key":
					return _op_insert_key(st, anim, op, full, where)
				_:
					return _op_remove_key(anim, op, full, where)
	return R.err(R.BAD_PARAMS, "anim.edit: ops[%d].op must be one of %s, got '%s'." % [i, ", ".join(EDIT_OPS), kind])


## Applies length/loop/step from `op` to `anim` (used by create and set).
static func _apply_anim_props(anim: Animation, op: Dictionary, where: String) -> Dictionary:
	if op.has("length") and op["length"] != null:
		var length: float = float(op["length"]) if (op["length"] is float or op["length"] is int) else -1.0
		if length < 0.001:
			return R.err(R.BAD_PARAMS, "%s: 'length' must be a number of seconds >= 0.001, got %s." % [where, JSON.stringify(op["length"])])
		anim.length = length
	if op.has("loop") and op["loop"] != null:
		var li: Dictionary = enum_index(LOOP_MODES, str(op["loop"]), "loop", where)
		if R.is_err(li):
			return li
		anim.loop_mode = li["value"] as Animation.LoopMode
	if op.has("step") and op["step"] != null:
		if not (op["step"] is float or op["step"] is int) or float(op["step"]) < 0.0:
			return R.err(R.BAD_PARAMS, "%s: 'step' must be a number of seconds >= 0 (the editor's snap step), got %s." % [where, JSON.stringify(op["step"])])
		anim.step = float(op["step"])
	return {}


static func _op_create(st: EditState, op: Dictionary, i: int, where: String) -> Dictionary:
	var t: Dictionary = _target_name(st, op, i, false)
	if R.is_err(t):
		return t
	var parts: PackedStringArray = t["value"]
	var lib_name: String = parts[0]
	var anim_name: String = parts[1]
	var name_err: Dictionary = _check_anim_name(anim_name, "animation", where)
	if not name_err.is_empty():
		return name_err
	if not lib_name.is_empty():
		var lib_err: Dictionary = _check_anim_name(lib_name, "library", where)
		if not lib_err.is_empty():
			return lib_err
	if st.view.has(lib_name) and (st.view[lib_name] as Dictionary).has(anim_name):
		return R.err(R.CONFLICT, "%s: animation '%s' already exists. Use {\"op\": \"set\"} to change it, or remove it first." % [where, join_anim_name(lib_name, anim_name)])
	var anim := Animation.new()
	var perr: Dictionary = _apply_anim_props(anim, op, where)
	if not perr.is_empty():
		return perr
	var created_lib: bool = false
	if not st.libs.has(lib_name):
		# "Create the AnimationLibrary if missing": a new library is built directly and
		# added to the player by the ChangeSet.
		st.libs[lib_name] = AnimationLibrary.new()
		st.view[lib_name] = {}
		st.new_libs.append(lib_name)
		created_lib = true
	var lib: AnimationLibrary = st.libs[lib_name]
	if lib_name in st.new_libs:
		lib.add_animation(StringName(anim_name), anim)
	else:
		st.do_steps.append([lib, &"add_animation", [StringName(anim_name), anim]])
		st.undo_steps.append([lib, &"remove_animation", [StringName(anim_name)]])
		st.add_external(lib)
	st.view[lib_name][anim_name] = anim
	var out: Dictionary = {"op": "create", "animation": join_anim_name(lib_name, anim_name), "length": anim.length, "loop": LOOP_MODES[anim.loop_mode]}
	if created_lib:
		out["created_library"] = lib_name
	return R.value(out)


static func _op_remove(st: EditState, op: Dictionary, i: int) -> Dictionary:
	var t: Dictionary = _target_name(st, op, i, true)
	if R.is_err(t):
		return t
	var parts: PackedStringArray = t["value"]
	var lib: AnimationLibrary = st.libs[parts[0]]
	var anim: Animation = st.view[parts[0]][parts[1]]
	if parts[0] in st.new_libs:
		lib.remove_animation(StringName(parts[1]))
	else:
		st.do_steps.append([lib, &"remove_animation", [StringName(parts[1])]])
		# Re-adding the original object restores it exactly (the undo history keeps it alive).
		st.undo_steps.append([lib, &"add_animation", [StringName(parts[1]), anim]])
		st.add_external(lib)
	(st.view[parts[0]] as Dictionary).erase(parts[1])
	var full: String = join_anim_name(parts[0], parts[1])
	if st.autoplay == full:
		st.autoplay = ""
	return R.value({"op": "remove", "animation": full})


static func _op_rename(st: EditState, op: Dictionary, i: int, where: String) -> Dictionary:
	var t: Dictionary = _target_name(st, op, i, true)
	if R.is_err(t):
		return t
	var parts: PackedStringArray = t["value"]
	var new_name: String = str(op.get("to", ""))
	if new_name.contains("/"):
		return R.err(R.BAD_PARAMS, "%s: 'to' is the new name inside the same library (no \"/\"); animations cannot be moved between libraries with rename." % where)
	var name_err: Dictionary = _check_anim_name(new_name, "animation", where + " 'to'")
	if not name_err.is_empty():
		return name_err
	var contents: Dictionary = st.view[parts[0]]
	if contents.has(new_name):
		return R.err(R.CONFLICT, "%s: an animation named '%s' already exists in that library." % [where, join_anim_name(parts[0], new_name)])
	var lib: AnimationLibrary = st.libs[parts[0]]
	if parts[0] in st.new_libs:
		lib.rename_animation(StringName(parts[1]), StringName(new_name))
	else:
		st.do_steps.append([lib, &"rename_animation", [StringName(parts[1]), StringName(new_name)]])
		st.undo_steps.append([lib, &"rename_animation", [StringName(new_name), StringName(parts[1])]])
		st.add_external(lib)
	contents[new_name] = contents[parts[1]]
	contents.erase(parts[1])
	var old_full: String = join_anim_name(parts[0], parts[1])
	var new_full: String = join_anim_name(parts[0], new_name)
	if st.autoplay == old_full:
		st.autoplay = new_full
	var trees: Array[String] = []
	_collect_of_class(st.root, st.root, "AnimationTree", trees)
	if not trees.is_empty():
		st.warnings.append("%s: AnimationTree nodes (%s) refer to animations by name and are not updated; fix them with anim.tree if they used '%s'." % [where, ", ".join(trees), old_full])
	return R.value({"op": "rename", "animation": new_full, "renamed_from": old_full})


static func _op_set(anim: Animation, op: Dictionary, full: String, where: String) -> Dictionary:
	if not (op.has("length") or op.has("loop") or op.has("step")):
		return R.err(R.BAD_PARAMS, "%s: pass at least one of 'length' (seconds), 'loop' (none, linear, pingpong) or 'step'." % where)
	var perr: Dictionary = _apply_anim_props(anim, op, where)
	if not perr.is_empty():
		return perr
	return R.value({"op": "set", "animation": full, "length": anim.length, "loop": LOOP_MODES[anim.loop_mode], "step": anim.step})


# --- tracks -------------------------------------------------------------------------------

## Resolves the node (and property info) a track path points at, relative to the player's
## root_node, validating what the track type needs. Returns {"node": Node|null,
## "info": Dictionary} (both empty when unresolvable and allow_missing) or an error.
static func _resolve_track_target(st: EditState, path: String, type: int, where: String, validate: bool) -> Dictionary:
	var base: Node = st.player.get_node_or_null(st.player.root_node)
	var np := NodePath(path)
	var node_part: String = np.get_concatenated_names()
	var sub: String = np.get_concatenated_subnames()
	var needs_property: bool = type in [Animation.TYPE_VALUE, Animation.TYPE_BEZIER, Animation.TYPE_BLEND_SHAPE]
	if validate:
		if needs_property and sub.is_empty():
			var example: String = "MeshInstance3D:Smile" if type == Animation.TYPE_BLEND_SHAPE else "Sprite2D:modulate"
			return R.err(R.BAD_PARAMS, "%s: a %s track path needs \"Node:property\", e.g. \"%s\" (relative to the AnimationPlayer's root_node), got '%s'." % [where, TRACK_TYPES[type], example, path])
		if not needs_property and not sub.is_empty():
			return R.err(R.BAD_PARAMS, "%s: a %s track path is just a node path (no \":property\"), e.g. \"%s\", got '%s'." % [where, TRACK_TYPES[type], node_part if not node_part.is_empty() else ".", path])
	if base == null:
		if validate:
			return R.err(R.BAD_PARAMS, "%s: the AnimationPlayer's root_node '%s' does not resolve to a node, so track paths cannot be checked. Fix root_node with node.set, or pass allow_missing: true." % [where, st.player.root_node])
		return {"node": null, "info": {}}
	var target: Node = base.get_node_or_null(NodePath(node_part if not node_part.is_empty() else "."))
	if target == null:
		if not validate:
			return {"node": null, "info": {}}
		var candidates: Array[String] = []
		_relative_paths(base, base, candidates, 300)
		var similar: Array[String] = Fuzzy.suggest(node_part, candidates, 5)
		return R.err(R.NOT_FOUND, ("%s: no node '%s' relative to the AnimationPlayer's root_node ('%s', which is '%s' in the scene).%s " +
			"Track paths are relative to root_node, e.g. \"Sprite2D:modulate\". Pass allow_missing: true to keep a path that does not exist yet.") %
			[where, node_part, st.player.root_node, NodePaths.rel_path(st.root, base), Fuzzy.did_you_mean(similar)], {"similar": similar})
	var info: Dictionary = {}
	match type:
		Animation.TYPE_VALUE, Animation.TYPE_BEZIER:
			var first: String = sub.get_slice(":", 0)
			info = Codec.find_property(target, first)
			if info.is_empty():
				if validate:
					var e: Dictionary = Codec.unknown_property_error(target, first, "Node '%s' (%s)" % [node_part, target.get_class()])
					e["error"]["message"] = "%s: %s Pass allow_missing: true to keep the path anyway." % [where, e["error"]["message"]]
					return e
			elif sub.contains(":"):
				# "position:x" style sub-property: type of the indexed value.
				var current: Variant = target.get_indexed(NodePath(":" + sub))
				info = {"name": sub, "type": typeof(current)}
			if validate and type == Animation.TYPE_BEZIER and not info.is_empty() and not int(info.get("type", TYPE_NIL)) in [TYPE_FLOAT, TYPE_INT, TYPE_NIL]:
				return R.err(R.BAD_PARAMS, "%s: bezier tracks animate a single number, but '%s' is %s. Use a sub-property such as \"%s:x\" or a value track." % [where, path, type_string(int(info["type"])), path])
		Animation.TYPE_BLEND_SHAPE:
			if validate and not target is MeshInstance3D:
				return R.err(R.BAD_PARAMS, "%s: blend_shape tracks need a MeshInstance3D, but '%s' is a %s." % [where, node_part, target.get_class()])
			var mesh_node := target as MeshInstance3D
			if validate and mesh_node != null and mesh_node.mesh != null and mesh_node.find_blend_shape_by_name(StringName(sub)) < 0:
				var shapes: Array[String] = []
				var array_mesh := mesh_node.mesh as ArrayMesh
				if array_mesh != null:
					for s: int in range(array_mesh.get_blend_shape_count()):
						shapes.append(String(array_mesh.get_blend_shape_name(s)))
				return R.err(R.NOT_FOUND, "%s: the mesh of '%s' has no blend shape '%s'. Blend shapes: %s." % [where, node_part, sub, ", ".join(shapes) if not shapes.is_empty() else "(unknown)"])
		Animation.TYPE_POSITION_3D, Animation.TYPE_ROTATION_3D, Animation.TYPE_SCALE_3D:
			if validate and not target is Node3D:
				return R.err(R.BAD_PARAMS, "%s: %s tracks animate a Node3D transform, but '%s' is a %s. For 2D nodes use a value track such as \"%s:position\"." % [where, TRACK_TYPES[type], node_part, target.get_class(), node_part])
		Animation.TYPE_AUDIO:
			if validate and Codec.find_property(target, "stream").is_empty():
				return R.err(R.BAD_PARAMS, "%s: audio tracks need an AudioStreamPlayer/2D/3D node, but '%s' is a %s." % [where, node_part, target.get_class()])
		Animation.TYPE_ANIMATION:
			if validate and not target is AnimationPlayer:
				return R.err(R.BAD_PARAMS, "%s: animation tracks need another AnimationPlayer node, but '%s' is a %s." % [where, node_part, target.get_class()])
	return {"node": target, "info": info}


static func _relative_paths(base: Node, node: Node, out: Array[String], limit: int) -> void:
	for c: Node in node.get_children():
		if out.size() >= limit:
			return
		out.append(String(base.get_path_to(c)))
		_relative_paths(base, c, out, limit)


static func _op_add_track(st: EditState, anim: Animation, op: Dictionary, full: String, where: String) -> Dictionary:
	var ti: Dictionary = enum_index(TRACK_TYPES, str(op.get("type", "value")), "type", where)
	if R.is_err(ti):
		return ti
	var type: int = ti["value"]
	var path: String = str(op.get("path", ""))
	if path.is_empty():
		return R.err(R.BAD_PARAMS, "%s: 'path' is required, e.g. \"Sprite2D:modulate\" (value/bezier), \"Armature/Skeleton3D\" (position_3d) or \".\" (method track on the root node). Paths are relative to the player's root_node." % where)
	var target: Dictionary = _resolve_track_target(st, path, type, where, not st.allow_missing)
	if R.is_err(target):
		return target
	var existing: int = anim.find_track(NodePath(path), type as Animation.TrackType)
	if existing >= 0:
		return R.err(R.CONFLICT, "%s: '%s' already has a %s track for '%s' (index %d). Insert keys into it with {\"op\": \"insert_key\", \"track\": %d}." % [where, full, TRACK_TYPES[type], path, existing, existing])
	var idx: int = anim.add_track(type as Animation.TrackType)
	anim.track_set_path(idx, NodePath(path))
	if op.has("interpolation") and op["interpolation"] != null:
		var ii: Dictionary = enum_index(INTERPOLATIONS, str(op["interpolation"]), "interpolation", where)
		if R.is_err(ii):
			return ii
		anim.track_set_interpolation_type(idx, ii["value"] as Animation.InterpolationType)
	if op.has("update_mode") and op["update_mode"] != null:
		if type != Animation.TYPE_VALUE:
			return R.err(R.BAD_PARAMS, "%s: 'update_mode' only applies to value tracks." % where)
		var ui: Dictionary = enum_index(UPDATE_MODES, str(op["update_mode"]), "update_mode", where)
		if R.is_err(ui):
			return ui
		anim.value_track_set_update_mode(idx, ui["value"] as Animation.UpdateMode)
	elif type == Animation.TYPE_VALUE and target.get("node") != null:
		# Match the editor: properties that cannot be interpolated (bool, int frame, String,
		# resources) default to discrete updates so keys switch instead of being ignored.
		var vt: int = int((target["info"] as Dictionary).get("type", TYPE_NIL))
		if vt in [TYPE_BOOL, TYPE_INT, TYPE_STRING, TYPE_STRING_NAME, TYPE_OBJECT, TYPE_NODE_PATH]:
			anim.value_track_set_update_mode(idx, Animation.UPDATE_DISCRETE)
	return R.value({"op": "add_track", "animation": full, "track": idx, "type": TRACK_TYPES[type], "path": path})


## Finds a track by index or by path (+ optional type). Returns {"value": index} or an error.
static func _find_track(anim: Animation, op: Dictionary, full: String, where: String) -> Dictionary:
	var track: Variant = op.get("track")
	if track == null:
		return R.err(R.BAD_PARAMS, "%s: 'track' is required: a track index or path (e.g. \"Sprite2D:modulate\"). Use anim.read with 'animation' to list tracks." % where)
	if track is float or track is int:
		var idx: int = int(track)
		if idx < 0 or idx >= anim.get_track_count():
			return R.err(R.NOT_FOUND, "%s: track index %d is out of range; '%s' has %d tracks%s." % [where, idx, full, anim.get_track_count(), _track_list(anim)])
		return R.value(idx)
	var path: String = str(track)
	var type_filter: int = -1
	if op.has("type") and op["type"] != null:
		var ti: Dictionary = enum_index(TRACK_TYPES, str(op["type"]), "type", where)
		if R.is_err(ti):
			return ti
		type_filter = ti["value"]
	var matches: Array[int] = []
	for t: int in range(anim.get_track_count()):
		if String(anim.track_get_path(t)) == path and (type_filter < 0 or anim.track_get_type(t) == type_filter):
			matches.append(t)
	if matches.is_empty():
		return R.err(R.NOT_FOUND, "%s: '%s' has no track with path '%s'%s.%s Add one with {\"op\": \"add_track\", \"path\": \"%s\"}." % [where, full, path, (" and type " + TRACK_TYPES[type_filter]) if type_filter >= 0 else "", _track_list(anim), path])
	if matches.size() > 1:
		return R.err(R.BAD_PARAMS, "%s: several tracks have path '%s' (indices %s); pass 'type' or the track index." % [where, path, str(matches)])
	return R.value(matches[0])


static func _track_list(anim: Animation) -> String:
	if anim.get_track_count() == 0:
		return " (no tracks yet)"
	var parts: Array[String] = []
	for t: int in range(mini(anim.get_track_count(), 30)):
		parts.append("%d: %s %s" % [t, TRACK_TYPES[anim.track_get_type(t)], anim.track_get_path(t)])
	return ". Tracks: " + "; ".join(parts)


static func _op_remove_track(anim: Animation, op: Dictionary, full: String, where: String) -> Dictionary:
	var f: Dictionary = _find_track(anim, op, full, where)
	if R.is_err(f):
		return f
	var idx: int = f["value"]
	var path: String = String(anim.track_get_path(idx))
	anim.remove_track(idx)
	return R.value({"op": "remove_track", "animation": full, "track": idx, "path": path, "note": "Later tracks moved down by one index."})


static func _op_insert_key(st: EditState, anim: Animation, op: Dictionary, full: String, where: String) -> Dictionary:
	var f: Dictionary = _find_track(anim, op, full, where)
	if R.is_err(f):
		return f
	var idx: int = f["value"]
	if not (op.get("time") is float or op.get("time") is int) or float(op["time"]) < 0.0:
		return R.err(R.BAD_PARAMS, "%s: 'time' must be a number of seconds >= 0, got %s." % [where, JSON.stringify(op.get("time"))])
	var time: float = float(op["time"])
	var transition: float = 1.0
	if op.has("transition") and op["transition"] != null:
		if not (op["transition"] is float or op["transition"] is int):
			return R.err(R.BAD_PARAMS, "%s: 'transition' must be a number (easing curve: 1 linear, <1 ease-out, >1 ease-in, negative in-out), got %s." % [where, JSON.stringify(op["transition"])])
		transition = float(op["transition"])
	if not op.has("value"):
		return R.err(R.BAD_PARAMS, "%s: 'value' is required (the key's value, decoded against the track's property type)." % where)
	var type: int = anim.track_get_type(idx)
	var path: String = String(anim.track_get_path(idx))
	var target: Dictionary = _resolve_track_target(st, path, type, where, false)
	var dv: Dictionary = _decode_key_value(st, type, op["value"], target, where)
	if R.is_err(dv):
		return dv
	if time > anim.length:
		st.warnings.append("%s: key at %.3fs is past the end of '%s' (length %.3fs); extend it with {\"op\": \"set\", \"length\": ...}." % [where, time, full, anim.length])
	var replaced: bool = anim.track_find_key(idx, time, Animation.FIND_MODE_APPROX) >= 0
	var key: int = anim.track_insert_key(idx, time, dv["value"], transition)
	if key < 0:
		return R.err(R.GODOT_ERROR, "%s: Godot refused to insert the key into track %d (%s %s)." % [where, idx, TRACK_TYPES[type], path])
	var out: Dictionary = {"op": "insert_key", "animation": full, "track": idx, "key": key, "time": time, "value": _encode_key(anim, idx, key, type, st.root)}
	if replaced:
		out["replaced"] = true
	return R.value(out)


## Builds the Variant that Animation.track_insert_key expects for each track type.
static func _decode_key_value(st: EditState, type: int, value: Variant, target: Dictionary, where: String) -> Dictionary:
	var node: Node = target.get("node")
	match type:
		Animation.TYPE_VALUE:
			var info: Dictionary = target.get("info", {})
			if info.is_empty():
				# Unknown target (allow_missing): only unambiguous literal forms are converted.
				return _prefix(Codec.decode_typed(value, {"name": "value", "type": TYPE_NIL}, st.root), where)
			return _prefix(Codec.decode_typed(value, info, st.root, node), where)
		Animation.TYPE_POSITION_3D, Animation.TYPE_SCALE_3D:
			return _prefix(Codec.decode_typed(value, {"name": "value", "type": TYPE_VECTOR3}, st.root), where)
		Animation.TYPE_ROTATION_3D:
			# Three numbers are Euler angles in degrees (what the inspector shows); four
			# numbers or "Quaternion(...)" are a quaternion.
			var euler: Variant = null
			if value is Array and (value as Array).size() == 3:
				euler = Codec.decode_typed(value, {"name": "value", "type": TYPE_VECTOR3}, st.root)
			if euler is Dictionary and not R.is_err(euler):
				var deg: Vector3 = (euler as Dictionary)["value"]
				return R.value(Quaternion.from_euler(Vector3(deg_to_rad(deg.x), deg_to_rad(deg.y), deg_to_rad(deg.z))))
			return _prefix(Codec.decode_typed(value, {"name": "value", "type": TYPE_QUATERNION}, st.root), where)
		Animation.TYPE_BLEND_SHAPE:
			return _prefix(Codec.decode_typed(value, {"name": "value", "type": TYPE_FLOAT}, st.root), where)
		Animation.TYPE_BEZIER:
			var d: Dictionary = value if value is Dictionary else {"value": value}
			var v: Dictionary = Codec.decode_typed(d.get("value"), {"name": "value", "type": TYPE_FLOAT}, st.root)
			if R.is_err(v):
				return _prefix(v, where)
			var in_h: Dictionary = Codec.decode_typed(d.get("in_handle", [-0.25, 0]), {"name": "in_handle", "type": TYPE_VECTOR2}, st.root)
			var out_h: Dictionary = Codec.decode_typed(d.get("out_handle", [0.25, 0]), {"name": "out_handle", "type": TYPE_VECTOR2}, st.root)
			if R.is_err(in_h):
				return _prefix(in_h, where)
			if R.is_err(out_h):
				return _prefix(out_h, where)
			var ih: Vector2 = in_h["value"]
			var oh: Vector2 = out_h["value"]
			return R.value([v["value"], ih.x, ih.y, oh.x, oh.y])
		Animation.TYPE_METHOD:
			if not value is Dictionary or not (value as Dictionary).get("method") is String:
				return R.err(R.BAD_PARAMS, "%s: method track keys need value {\"method\": \"name\", \"args\": [...]}, got %s." % [where, JSON.stringify(value)])
			var method_name: String = (value as Dictionary)["method"]
			var args: Variant = (value as Dictionary).get("args", [])
			if not args is Array:
				return R.err(R.BAD_PARAMS, "%s: method key 'args' must be an array." % where)
			var decoded_args: Array = []
			for a: Variant in args:
				var da: Dictionary = Codec.decode_typed(a, {"name": "args", "type": TYPE_NIL}, st.root)
				if R.is_err(da):
					return _prefix(da, where)
				decoded_args.append(da["value"])
			if node != null and not node.has_method(method_name) and not st.allow_missing:
				# A warning, not an error: script methods of non-tool scripts are not always
				# visible in the editor (placeholder instances).
				st.warnings.append("%s: '%s' (%s) has no method '%s' right now." % [where, node.name, node.get_class(), method_name])
			return R.value({"method": StringName(method_name), "args": decoded_args})
		Animation.TYPE_AUDIO:
			var ad: Dictionary = value if value is Dictionary else {"stream": value}
			var stream: AudioStream = null
			var sv: Variant = ad.get("stream")
			if sv != null:
				var ds: Dictionary = Codec.decode_typed(sv, {"name": "stream", "type": TYPE_OBJECT, "hint": PROPERTY_HINT_RESOURCE_TYPE, "hint_string": "AudioStream"}, st.root)
				if R.is_err(ds):
					return _prefix(ds, where)
				stream = ds["value"] as AudioStream
				if stream == null:
					return R.err(R.BAD_PARAMS, "%s: audio key 'stream' must be an AudioStream resource (e.g. \"res://sfx/step.wav\"), got %s." % [where, JSON.stringify(sv)])
			return R.value({"stream": stream, "start_offset": float(ad.get("start_offset", 0.0)), "end_offset": float(ad.get("end_offset", 0.0))})
		Animation.TYPE_ANIMATION:
			if not value is String:
				return R.err(R.BAD_PARAMS, "%s: animation track keys take the name of an animation of the target AnimationPlayer (or \"[stop]\"), got %s." % [where, JSON.stringify(value)])
			if node is AnimationPlayer and value != "[stop]" and not (node as AnimationPlayer).has_animation(value):
				st.warnings.append("%s: '%s' has no animation '%s' yet." % [where, node.name, value])
			return R.value(StringName(value))
	return R.err(R.INTERNAL, "%s: unsupported track type %d." % [where, type])


## Prefixes a decode error's message with the op location.
static func _prefix(res: Dictionary, where: String) -> Dictionary:
	if R.is_err(res):
		res["error"]["message"] = "%s: %s" % [where, res["error"]["message"]]
	return res


static func _op_remove_key(anim: Animation, op: Dictionary, full: String, where: String) -> Dictionary:
	var f: Dictionary = _find_track(anim, op, full, where)
	if R.is_err(f):
		return f
	var idx: int = f["value"]
	var count: int = anim.track_get_key_count(idx)
	var key: int = -1
	if op.has("key") and op["key"] != null:
		key = int(op["key"]) if (op["key"] is float or op["key"] is int) else -1
		if key < 0 or key >= count:
			return R.err(R.NOT_FOUND, "%s: key index %s is out of range; track %d has %d keys." % [where, JSON.stringify(op["key"]), idx, count])
	elif op.get("time") is float or op.get("time") is int:
		key = anim.track_find_key(idx, float(op["time"]), Animation.FIND_MODE_APPROX)
		if key < 0:
			var times: Array[String] = []
			for k: int in range(mini(count, 30)):
				times.append("%.3f" % anim.track_get_key_time(idx, k))
			return R.err(R.NOT_FOUND, "%s: track %d has no key at %ss. Key times: %s." % [where, idx, str(op["time"]), ", ".join(times) if not times.is_empty() else "(no keys)"])
	else:
		return R.err(R.BAD_PARAMS, "%s: pass 'time' (seconds) or 'key' (key index) to say which key to remove." % where)
	var time: float = anim.track_get_key_time(idx, key)
	anim.track_remove_key(idx, key)
	return R.value({"op": "remove_key", "animation": full, "track": idx, "time": time})
