@tool
extends RefCounted
## SpriteFrames editing (anim.frames, anim.frames_read, anim.frames_file): the animations of
## an AnimatedSprite2D / AnimatedSprite3D, i.e. the core 2D "flip-book" animation workflow.
##
## Registered by ops/anim_ops.gd (methods()); documented in docs/methods/animation-audio.md.
## Why a dedicated tool: a SpriteFrames stores everything in ONE property, `animations`, an
## Array of {name, speed, loop, frames: [{texture, duration}]} dictionaries whose frame
## textures are usually embedded AtlasTextures (a cell of a sprite sheet). resource.set can
## only replace that whole array (there is no "animations/0/speed" property), and building
## nested AtlasTextures by hand with resource.create is error-prone. Here the caller says
## "cut cells 0..3 of this 4x1 sheet" and we build the AtlasTextures.
##
## How edits stay exact and undoable
## ---------------------------------
## All ops of one call run on a private working copy (a fresh SpriteFrames whose `animations`
## is a copy of the live one), through the real SpriteFrames API (add_animation, add_frame,
## rename_animation, ...), so Godot's own validation applies and later ops see the result of
## earlier ones. The net change is then one property swap: `animations` = the working copy's
## array (undo: the array read before the call). `_get_animations()` builds a fresh Array of
## fresh Dictionaries on every read (verified on 4.7.2), so the snapshot cannot be changed
## behind our back; frame textures are shared references, which is fine because we never
## modify an existing texture. Setting `animations` does not emit `changed` (verified), so
## the ChangeSet calls emit_changed() too: the editor's SpriteFrames panel listens to it.
##
## The node's own `animation` / `autoplay` follow renames and removals (like anim.edit does
## for AnimationPlayer.autoplay). AnimatedSprite2D.set_animation() prints an engine error
## when the name is missing from its SpriteFrames (also when sprite_frames is null), so the
## ChangeSet orders the steps such that the name is always valid when it is assigned.
##
## Editor: one undo step ("MCP: anim.frames"); the scene is marked unsaved. Headless: the
## backend packs the scene, so embedded SpriteFrames land in the .tscn. A SpriteFrames saved
## in its own .tres is external: `finish` saves it (anim.frames on a node) and it is listed in
## `saved_resources`; anim.frames_file edits a .tres directly (one undo step that also saves,
## like resource.set).

const R := preload("mcp_result.gd")
const Params := preload("params.gd")
const Codec := preload("variant_codec.gd")
const NodePaths := preload("node_paths.gd")
const ResPaths := preload("res_paths.gd")
const ChangeSet := preload("change_set.gd")
const Fuzzy := preload("fuzzy.gd")
const ResSave := preload("res_save.gd")
const RU := preload("resource_util.gd")

const OPS: PackedStringArray = ["add", "remove", "rename", "set", "add_frames", "clear"]
## Frames listed per animation in summaries (a long animation would otherwise flood the result).
const MAX_LISTED_FRAMES: int = 64


# ---------------------------------------------------------------------------------------
# Lookups
# ---------------------------------------------------------------------------------------

## The AnimatedSprite2D/3D at `path`, or the scene's only one when `path` is empty.
static func _find_sprite(root: Node, path: String, method: String) -> Dictionary:
	var candidates: Array[String] = []
	_collect(root, root, candidates)
	if path.is_empty():
		if candidates.size() == 1:
			return R.value(root if candidates[0] == "." else root.get_node(candidates[0]))
		if candidates.is_empty():
			return R.err(R.NOT_FOUND, "%s: the scene '%s' has no AnimatedSprite2D/AnimatedSprite3D. Add one first (node.add {\"type\": \"AnimatedSprite2D\"}), or pass 'path' to edit a SpriteFrames .tres file." % [method, root.scene_file_path])
		return R.err(R.BAD_PARAMS, "%s: the scene has several animated sprites; pass 'node' with one of: %s." % [method, ", ".join(candidates)], {"candidates": candidates})
	var res: Dictionary = NodePaths.resolve(root, path, "node")
	if R.is_err(res):
		return res
	var node: Node = res["value"]
	if not (node is AnimatedSprite2D or node is AnimatedSprite3D):
		var hint: String = (" Animated sprites in this scene: %s." % ", ".join(candidates)) if not candidates.is_empty() else ""
		return R.err(R.BAD_PARAMS, "%s: '%s' is a %s, not an AnimatedSprite2D/AnimatedSprite3D (only those use SpriteFrames; for AnimationPlayer use anim.edit).%s" % [method, NodePaths.rel_path(root, node), node.get_class(), hint], {"candidates": candidates})
	return res


static func _collect(root: Node, node: Node, out: Array[String]) -> void:
	if node is AnimatedSprite2D or node is AnimatedSprite3D:
		out.append(NodePaths.rel_path(root, node))
	for c: Node in NodePaths.listed_children(root, node):
		_collect(root, c, out)


## True for resources saved in their own file (not embedded in a scene).
static func _is_external(res: Resource) -> bool:
	return res != null and not res.resource_path.is_empty() and not res.resource_path.contains("::")


# ---------------------------------------------------------------------------------------
# Summary (what every call returns)
# ---------------------------------------------------------------------------------------

## Compact view of every animation: speed, loop, frame count and where each frame comes
## from. Frames that are all cells of one sheet collapse to {"atlas": path, "regions": [...]},
## which is what a reader wants to check ("did I cut the right cells?"). `durations` is only
## listed when some frame is not 1.0.
static func summary(frames: SpriteFrames) -> Array:
	var out: Array = []
	for anim_name: StringName in frames.get_animation_names():
		var count: int = frames.get_frame_count(anim_name)
		var entry: Dictionary = {
			"name": String(anim_name),
			"speed": snappedf(frames.get_animation_speed(anim_name), 0.001),
			"loop": frames.get_animation_loop(anim_name),
			"frame_count": count,
		}
		var listed: int = mini(count, MAX_LISTED_FRAMES)
		var atlas_key: Variant = null  # the shared atlas path (or false once frames differ)
		var regions: Array = []
		var items: Array = []
		var durations: Array = []
		var odd_duration: bool = false
		for i: int in range(listed):
			var tex: Texture2D = frames.get_frame_texture(anim_name, i)
			var d: float = frames.get_frame_duration(anim_name, i)
			durations.append(snappedf(d, 0.001))
			if not is_equal_approx(d, 1.0):
				odd_duration = true
			var item: Variant = _frame_json(tex)
			items.append(item)
			if item is Dictionary and (item as Dictionary).has("region") and (item as Dictionary)["atlas"] is String:
				var a: String = (item as Dictionary)["atlas"]
				if atlas_key == null:
					atlas_key = a
				elif atlas_key is String and atlas_key != a:
					atlas_key = false
				regions.append((item as Dictionary)["region"])
			else:
				atlas_key = false
		if atlas_key is String:
			entry["atlas"] = atlas_key
			entry["regions"] = regions
		elif listed > 0:
			entry["frames"] = items
		if odd_duration:
			entry["durations"] = durations
		if count > listed:
			entry["frames_truncated"] = true
		out.append(entry)
	return out


## One frame texture as JSON: a path for a texture file, {"atlas", "region"} for an
## AtlasTexture cell, {"class", "embedded": true} for other embedded textures.
static func _frame_json(tex: Texture2D) -> Variant:
	if tex == null:
		return null
	if tex is AtlasTexture and not _is_external(tex):
		var at := tex as AtlasTexture
		var atlas: Variant = null
		if at.atlas != null:
			atlas = at.atlas.resource_path if _is_external(at.atlas) else "(embedded %s)" % at.atlas.get_class()
		var r: Rect2 = at.region
		return {"atlas": atlas, "region": [_num(r.position.x), _num(r.position.y), _num(r.size.x), _num(r.size.y)]}
	if _is_external(tex):
		return tex.resource_path
	return {"class": tex.get_class(), "embedded": true}


## Whole numbers as ints so regions read [0, 0, 16, 16] rather than [0.0, 0.0, 16.0, 16.0].
static func _num(f: float) -> Variant:
	if f == floorf(f) and absf(f) < 1e9:
		return int(f)
	return f


static func _node_result(root: Node, node: Node, frames: SpriteFrames) -> Dictionary:
	var out: Dictionary = {
		"node": NodePaths.rel_path(root, node),
		"resource": null,
		"animation": String(node.get("animation")),
		"autoplay": str(node.get("autoplay")),
		"animations": summary(frames),
	}
	# Separate assignment: a String-or-null ternary trips the strict lint.
	if _is_external(frames):
		out["resource"] = frames.resource_path
	return out


# ---------------------------------------------------------------------------------------
# anim.frames_read (scene_read)
# ---------------------------------------------------------------------------------------

## params: {scene?, node?} -> the node's SpriteFrames summary.
static func read_node(root: Node, params: Variant) -> Dictionary:
	var p := Params.new(params, "anim.frames")
	var path: String = p.opt_string("node", "")
	if p.failed():
		return p.error
	var found: Dictionary = _find_sprite(root, path, "anim.frames")
	if R.is_err(found):
		return found
	var node: Node = found["value"]
	var frames: SpriteFrames = node.get("sprite_frames")
	if frames == null:
		return R.ok({"node": NodePaths.rel_path(root, node), "resource": null, "animations": [],
			"note": "This node has no SpriteFrames yet; pass ops (e.g. {\"op\": \"add\", \"animation\": \"walk\", \"texture\": \"res://hero.png\", \"hframes\": 4}) to create one."})
	return R.ok(_node_result(root, node, frames))


# ---------------------------------------------------------------------------------------
# anim.frames (scene_mutation)
# ---------------------------------------------------------------------------------------

## params: {scene?, node?, ops: [...]}. See the header comment for the undo strategy.
static func plan_node(root: Node, params: Variant) -> Dictionary:
	var p := Params.new(params, "anim.frames")
	var path: String = p.opt_string("node", "")
	var ops: Array = p.opt_array("ops", [])
	if p.failed():
		return p.error
	if ops.is_empty():
		return R.err(R.BAD_PARAMS, "anim.frames: 'ops' must be a non-empty array (omit it to read the SpriteFrames).")
	var found: Dictionary = _find_sprite(root, path, "anim.frames")
	if R.is_err(found):
		return found
	var node: Node = found["value"]
	var edit_err: Dictionary = NodePaths.check_editable(root, node, "edit the SpriteFrames of")
	if not edit_err.is_empty():
		return edit_err

	var live: SpriteFrames = node.get("sprite_frames")
	var created: bool = live == null
	var old_anims: Array = []
	if not created:
		old_anims = live.get("animations")
	# The working copy. A new SpriteFrames comes with Godot's empty "default" animation.
	var work := SpriteFrames.new()
	if not created:
		work.set("animations", live.get("animations"))
	var st: Dictionary = {
		"animation": String(node.get("animation")),
		"autoplay": str(node.get("autoplay")),
		"touched_default": false,
		"first_added": "",
		"warnings": [],
	}
	var applied: Dictionary = _apply_ops(work, ops, st)
	if R.is_err(applied):
		return applied
	var results: Array = applied["value"]

	# A SpriteFrames created by this call: drop Godot's placeholder "default" when the ops
	# made other animations and never used it (an empty extra animation only confuses), and
	# point the node at the first animation the call added.
	var dropped_default: bool = false
	if created and not bool(st["touched_default"]) and work.has_animation(&"default") \
			and work.get_frame_count(&"default") == 0 and work.get_animation_names().size() > 1:
		work.remove_animation(&"default")
		dropped_default = true
		if st["animation"] == "default":
			st["animation"] = st["first_added"]

	var new_anims: Array = work.get("animations")
	var old_animation: String = String(node.get("animation"))
	var new_animation: String = st["animation"]
	# The node's animation must name an existing animation, or Godot prints errors on every
	# draw. If it vanished (removed, or renamed without us seeing it), use the first one.
	if not work.has_animation(StringName(new_animation)):
		var names: PackedStringArray = work.get_animation_names()
		new_animation = names[0] if not names.is_empty() else ""
	var old_autoplay: String = str(node.get("autoplay"))
	var new_autoplay: String = st["autoplay"]

	var cs := ChangeSet.new()
	var frames: SpriteFrames = work if created else live
	if created:
		# `work` itself becomes the node's SpriteFrames. Setting its animations again on the do
		# side keeps redo exact after the undo-side add_animation below.
		cs.do_property(work, &"animations", new_anims)
		cs.do_property(node, &"sprite_frames", work)
	else:
		cs.do_property(live, &"animations", new_anims)
		cs.do_method(live, &"emit_changed")
	if new_animation != old_animation and not new_animation.is_empty():
		cs.do_property(node, &"animation", StringName(new_animation))
	if new_autoplay != old_autoplay:
		cs.do_property(node, &"autoplay", new_autoplay)
	# Undo, in execution order: put the old animations back first, so that restoring the
	# node's old animation name finds it.
	if created:
		if new_animation != old_animation and not new_animation.is_empty():
			if not work.has_animation(StringName(old_animation)):
				cs.undo_method(work, &"add_animation", [StringName(old_animation)])
			cs.undo_property(node, &"animation", StringName(old_animation))
		cs.undo_property(node, &"sprite_frames", null)
	else:
		cs.undo_property(live, &"animations", old_anims)
		cs.undo_method(live, &"emit_changed")
		if new_animation != old_animation and not new_animation.is_empty():
			cs.undo_property(node, &"animation", StringName(old_animation))
	if new_autoplay != old_autoplay:
		cs.undo_property(node, &"autoplay", old_autoplay)
	if not created and _is_external(live) and Engine.is_editor_hint():
		# The .tres is saved in finish (below); undo must save the restored state too, or the
		# file and the editor would disagree. (Headless has no undo.)
		cs.undo_method(ResourceSaver, &"save", [live, live.resource_path])

	var warnings: Array = st["warnings"]
	var finish := func() -> Dictionary:
		var result: Dictionary = _node_result(root, node, frames)
		result["results"] = results
		if created:
			result["created_frames"] = true
		if dropped_default:
			result["note"] = "New SpriteFrames: Godot's empty \"default\" animation was dropped and the node's animation set to '%s'." % new_animation
		if _is_external(frames):
			# Packing the scene does not write an external .tres; save it here.
			var err: int = ResSave.save(frames, frames.resource_path)
			if err != OK:
				warnings.append("Saving '%s' failed: %s." % [frames.resource_path, error_string(err)])
			else:
				result["saved_resources"] = [frames.resource_path]
		if not warnings.is_empty():
			result["warnings"] = warnings
		return result
	return {"changes": cs, "finish": finish}


# ---------------------------------------------------------------------------------------
# anim.frames_file (project): a SpriteFrames .tres
# ---------------------------------------------------------------------------------------

## params: {path, ops?: [...]}. Without ops: the summary. With ops: edit and save (editor:
## one undo step that also saves, like resource.set).
static func edit_file(params: Variant, env: Dictionary) -> Dictionary:
	var p := Params.new(params, "anim.frames")
	var raw: String = p.req_string("path")
	var ops: Array = p.opt_array("ops", [])
	if p.failed():
		return p.error
	var where: Dictionary = RU.resolve(raw)
	if R.is_err(where):
		return where
	var path: String = where["value"]
	var loaded: Dictionary = RU.load_existing(path, "anim.frames")
	if R.is_err(loaded):
		return loaded
	if not loaded["value"] is SpriteFrames:
		return R.err(R.BAD_PARAMS, "anim.frames: '%s' is a %s, not a SpriteFrames. Create one with resource.create {\"type\": \"SpriteFrames\"}, or pass 'node' to edit an AnimatedSprite2D in a scene." % [path, (loaded["value"] as Object).get_class()])
	var frames: SpriteFrames = loaded["value"]
	if ops.is_empty():
		return R.ok({"path": path, "animations": summary(frames)})
	var work := SpriteFrames.new()
	var old_anims: Array = frames.get("animations")
	work.set("animations", old_anims)
	var st: Dictionary = {"animation": "", "autoplay": "", "touched_default": true, "first_added": "", "warnings": []}
	var applied: Dictionary = _apply_ops(work, ops, st)
	if R.is_err(applied):
		return applied
	var new_anims: Array = work.get("animations")
	var editor: bool = bool(env.get("editor", false))
	if editor and env.get("undo_redo") != null:
		var cs := ChangeSet.new()
		cs.do_property(frames, &"animations", new_anims)
		cs.do_method(frames, &"emit_changed")
		cs.do_method(ResourceSaver, &"save", [frames, path])
		cs.undo_property(frames, &"animations", old_anims)
		cs.undo_method(frames, &"emit_changed")
		cs.undo_method(ResourceSaver, &"save", [frames, path])
		cs.commit_to_undo_redo(env["undo_redo"], "MCP: anim.frames", frames)
	else:
		frames.set("animations", new_anims)
		var saved: Dictionary = RU.save(frames, path)
		if not saved.is_empty():
			return saved
	var out: Dictionary = {"path": path, "results": applied["value"], "animations": summary(frames), "saved": true, "undoable": editor}
	if not (st["warnings"] as Array).is_empty():
		out["warnings"] = st["warnings"]
	return R.ok(out)


# ---------------------------------------------------------------------------------------
# Ops (shared by both entry points)
# ---------------------------------------------------------------------------------------

## Applies `ops` in order to `work`. `st` tracks the node's animation/autoplay names through
## renames and removals. Returns {"value": [per-op results]} or the first error, prefixed
## "anim.frames: ops[i] (op):". Nothing outside `work` is touched, so an error leaves the
## live SpriteFrames as it was.
static func _apply_ops(work: SpriteFrames, ops: Array, st: Dictionary) -> Dictionary:
	var results: Array = []
	for i: int in range(ops.size()):
		if not ops[i] is Dictionary:
			return R.err(R.BAD_PARAMS, "anim.frames: ops[%d] must be an object like {\"op\": \"add\", \"animation\": \"walk\"}." % i)
		var op: Dictionary = ops[i]
		var kind: String = str(op.get("op", ""))
		var where: String = "anim.frames: ops[%d] (%s)" % [i, kind]
		var r: Dictionary
		if not kind in OPS:
			r = R.err(R.BAD_PARAMS, "anim.frames: ops[%d].op must be one of %s, got '%s'.%s" % [i, ", ".join(OPS), kind, Fuzzy.did_you_mean(Fuzzy.suggest(kind, OPS, 2))])
		else:
			var anim_name: String = str(op.get("animation", "")) if op.get("animation") != null else ""
			if anim_name.strip_edges().is_empty():
				r = R.err(R.BAD_PARAMS, "%s: 'animation' (the animation name, e.g. \"walk\") is required." % where)
			else:
				if anim_name == "default":
					st["touched_default"] = true
				match kind:
					"add":
						r = _op_add(work, op, anim_name, st, where)
					"remove":
						r = _op_remove(work, anim_name, st, where)
					"rename":
						r = _op_rename(work, op, anim_name, st, where)
					"set":
						r = _op_set(work, op, anim_name, where)
					"add_frames":
						r = _op_add_frames(work, op, anim_name, st, where)
					"clear":
						r = _require(work, anim_name, where)
						if not R.is_err(r):
							var had: int = work.get_frame_count(StringName(anim_name))
							work.clear(StringName(anim_name))
							r = R.value({"animation": anim_name, "removed_frames": had})
		if R.is_err(r):
			return r
		var entry: Dictionary = r["value"]
		entry["op"] = kind
		results.append(entry)
	return R.value(results)


## {} when `anim_name` exists in `work`, else an error listing the animations.
static func _require(work: SpriteFrames, anim_name: String, where: String) -> Dictionary:
	if work.has_animation(StringName(anim_name)):
		return {}
	var known: PackedStringArray = work.get_animation_names()
	return R.err(R.NOT_FOUND, "%s: no animation '%s'.%s Animations: %s. Create it with {\"op\": \"add\", \"animation\": \"%s\"}." %
		[where, anim_name, Fuzzy.did_you_mean(Fuzzy.suggest(anim_name, known, 3)), ", ".join(known) if not known.is_empty() else "(none)", anim_name], {"animations": Array(known)})


static func _op_add(work: SpriteFrames, op: Dictionary, anim_name: String, st: Dictionary, where: String) -> Dictionary:
	if work.has_animation(StringName(anim_name)):
		return R.err(R.CONFLICT, "%s: animation '%s' already exists. Use {\"op\": \"set\"} / {\"op\": \"add_frames\"} to change it, or remove it first." % [where, anim_name])
	work.add_animation(StringName(anim_name))
	if str(st["first_added"]).is_empty():
		st["first_added"] = anim_name
	var pr: Dictionary = _apply_props(work, op, anim_name, where)
	if R.is_err(pr):
		return pr
	var out: Dictionary = {"animation": anim_name, "speed": work.get_animation_speed(StringName(anim_name)), "loop": work.get_animation_loop(StringName(anim_name))}
	if op.get("texture") != null:
		var fr: Dictionary = _op_add_frames(work, op, anim_name, st, where)
		if R.is_err(fr):
			return fr
		out.merge(fr["value"])
	return R.value(out)


static func _op_remove(work: SpriteFrames, anim_name: String, st: Dictionary, where: String) -> Dictionary:
	var e: Dictionary = _require(work, anim_name, where)
	if not e.is_empty():
		return e
	work.remove_animation(StringName(anim_name))
	if st["autoplay"] == anim_name:
		st["autoplay"] = ""
	return R.value({"animation": anim_name})


static func _op_rename(work: SpriteFrames, op: Dictionary, anim_name: String, st: Dictionary, where: String) -> Dictionary:
	var e: Dictionary = _require(work, anim_name, where)
	if not e.is_empty():
		return e
	var to: String = str(op.get("to", "")) if op.get("to") != null else ""
	if to.strip_edges().is_empty():
		return R.err(R.BAD_PARAMS, "%s: 'to' (the new name) is required." % where)
	if work.has_animation(StringName(to)):
		return R.err(R.CONFLICT, "%s: an animation named '%s' already exists." % [where, to])
	work.rename_animation(StringName(anim_name), StringName(to))
	# The node's current animation and autoplay follow the rename, as in the editor.
	if st["animation"] == anim_name:
		st["animation"] = to
	if st["autoplay"] == anim_name:
		st["autoplay"] = to
	if st["first_added"] == anim_name:
		st["first_added"] = to
	return R.value({"animation": to, "renamed_from": anim_name})


static func _op_set(work: SpriteFrames, op: Dictionary, anim_name: String, where: String) -> Dictionary:
	var e: Dictionary = _require(work, anim_name, where)
	if not e.is_empty():
		return e
	if op.get("speed") == null and op.get("loop") == null:
		return R.err(R.BAD_PARAMS, "%s: pass 'speed' (frames per second) and/or 'loop' (true/false)." % where)
	var pr: Dictionary = _apply_props(work, op, anim_name, where)
	if R.is_err(pr):
		return pr
	return R.value({"animation": anim_name, "speed": work.get_animation_speed(StringName(anim_name)), "loop": work.get_animation_loop(StringName(anim_name))})


## speed / loop of one animation, validated.
static func _apply_props(work: SpriteFrames, op: Dictionary, anim_name: String, where: String) -> Dictionary:
	var speed: Variant = op.get("speed")
	if speed != null:
		if not (speed is float or speed is int) or float(speed) < 0.0:
			return R.err(R.BAD_PARAMS, "%s: 'speed' must be frames per second >= 0 (e.g. 10), got %s." % [where, _j(speed)])
		work.set_animation_speed(StringName(anim_name), float(speed))
	var loop: Variant = op.get("loop")
	if loop != null:
		if not loop is bool:
			return R.err(R.BAD_PARAMS, "%s: 'loop' must be true or false, got %s." % [where, _j(loop)])
		work.set_animation_loop(StringName(anim_name), loop)
	return R.value(true)


# --- frames ------------------------------------------------------------------------------

static func _op_add_frames(work: SpriteFrames, op: Dictionary, anim_name: String, st: Dictionary, where: String) -> Dictionary:
	var e: Dictionary = _require(work, anim_name, where)
	if not e.is_empty():
		return e
	var made: Dictionary = _frames_from_op(op, st, where)
	if R.is_err(made):
		return made
	var duration: float = 1.0
	var dv: Variant = op.get("duration")
	if dv != null:
		if not (dv is float or dv is int) or float(dv) <= 0.0:
			return R.err(R.BAD_PARAMS, "%s: 'duration' is the relative length of each frame (> 0; 1 = one tick at 'speed' fps), got %s." % [where, _j(dv)])
		duration = float(dv)
	var textures: Array = made["value"]
	for tex: Texture2D in textures:
		work.add_frame(StringName(anim_name), tex, duration)
	var out: Dictionary = {"animation": anim_name, "added": textures.size(), "frame_count": work.get_frame_count(StringName(anim_name))}
	if made.has("cell_size"):
		out["cell_size"] = made["cell_size"]
	return R.value(out)


## Builds the frame textures an op asks for. Returns {"value": [Texture2D], "cell_size"?} or
## an error.
##   texture: "res://a.png"                    -> the whole texture, one frame
##   texture: ["res://a.png", "res://b.png"]   -> each whole texture, one frame each
##   texture + hframes/vframes or frame_size    -> AtlasTexture cells of a sprite sheet,
##     chosen with cells (row-major indices or [column, row] pairs) or start + count
##     (default: every cell from start).
static func _frames_from_op(op: Dictionary, st: Dictionary, where: String) -> Dictionary:
	var tex_v: Variant = op.get("texture")
	var has_grid: bool = op.get("hframes") != null or op.get("vframes") != null or op.get("frame_size") != null
	if tex_v is Array:
		if has_grid:
			return R.err(R.BAD_PARAMS, "%s: a list of textures adds each whole texture; to cut a sprite sheet pass ONE 'texture' with hframes/vframes or frame_size." % where)
		var list: Array = []
		for item: Variant in tex_v:
			var t: Dictionary = _load_texture(item, where)
			if R.is_err(t):
				return t
			list.append(t["value"])
		if list.is_empty():
			return R.err(R.BAD_PARAMS, "%s: 'texture' is an empty list." % where)
		return R.value(list)
	if not tex_v is String:
		return R.err(R.BAD_PARAMS, "%s: 'texture' is required: a res:// texture (a sprite sheet with hframes/vframes or frame_size, or a whole image), or a list of textures." % where)
	var loaded: Dictionary = _load_texture(tex_v, where)
	if R.is_err(loaded):
		return loaded
	var sheet: Texture2D = loaded["value"]
	if not has_grid:
		if op.get("cells") != null or op.get("start") != null or op.get("count") != null:
			return R.err(R.BAD_PARAMS, "%s: 'cells' / 'start' / 'count' pick cells of a sprite sheet, so also pass hframes (columns) and vframes (rows), or frame_size [w, h]." % where)
		return R.value([sheet])

	# Grid: columns x rows, cell size in pixels.
	var size: Vector2 = sheet.get_size()
	var cols: int = 0
	var rows: int = 0
	var cell := Vector2.ZERO
	if op.get("frame_size") != null:
		if op.get("hframes") != null or op.get("vframes") != null:
			return R.err(R.BAD_PARAMS, "%s: pass either frame_size [w, h] or hframes/vframes, not both." % where)
		var fs: Dictionary = Codec.decode_typed(op["frame_size"], {"name": "frame_size", "type": TYPE_VECTOR2}, null)
		if R.is_err(fs):
			return fs
		cell = fs["value"]
		if cell.x < 1 or cell.y < 1:
			return R.err(R.BAD_PARAMS, "%s: frame_size must be at least [1, 1] pixels." % where)
		cols = floori(size.x / cell.x)
		rows = floori(size.y / cell.y)
		if cols < 1 or rows < 1:
			return R.err(R.BAD_PARAMS, "%s: frame_size %s is larger than the texture (%dx%d)." % [where, _j(op["frame_size"]), int(size.x), int(size.y)])
	else:
		var h: Dictionary = _positive_int(op.get("hframes", 1), "hframes", where)
		if R.is_err(h):
			return h
		var v: Dictionary = _positive_int(op.get("vframes", 1), "vframes", where)
		if R.is_err(v):
			return v
		cols = h["value"]
		rows = v["value"]
		cell = Vector2(floorf(size.x / cols), floorf(size.y / rows))
		if cell.x < 1 or cell.y < 1:
			return R.err(R.BAD_PARAMS, "%s: %d x %d cells do not fit in the %dx%d texture." % [where, cols, rows, int(size.x), int(size.y)])
	if not is_equal_approx(fmod(size.x, cell.x), 0.0) or not is_equal_approx(fmod(size.y, cell.y), 0.0):
		(st["warnings"] as Array).append("%s: the %dx%d texture is not a whole number of %dx%d cells; the leftover pixels at the right/bottom are not used." % [where, int(size.x), int(size.y), int(cell.x), int(cell.y)])
	var total: int = cols * rows

	var picked: Array[int] = []
	if op.get("cells") != null:
		if op.get("start") != null or op.get("count") != null:
			return R.err(R.BAD_PARAMS, "%s: pass either 'cells' or 'start'/'count', not both." % where)
		if not op["cells"] is Array or (op["cells"] as Array).is_empty():
			return R.err(R.BAD_PARAMS, "%s: 'cells' must be a non-empty list of cell indices (row-major, 0..%d) or [column, row] pairs." % [where, total - 1])
		for c: Variant in op["cells"]:
			var idx: int = -1
			if (c is float or c is int) and float(c) == floorf(c):
				idx = int(c)
			elif c is Array and (c as Array).size() == 2 and (c[0] is float or c[0] is int) and (c[1] is float or c[1] is int):
				var col: int = int(c[0])
				var row: int = int(c[1])
				idx = row * cols + col if col >= 0 and col < cols and row >= 0 and row < rows else -1
			if idx < 0 or idx >= total:
				return R.err(R.BAD_PARAMS, "%s: cell %s is outside the %d x %d grid (indices 0..%d, row-major; or [column, row] with column < %d, row < %d)." % [where, _j(c), cols, rows, total - 1, cols, rows])
			picked.append(idx)
	else:
		var s: Dictionary = _positive_int(op.get("start", 0), "start", where, 0)
		if R.is_err(s):
			return s
		var start: int = s["value"]
		if start >= total:
			return R.err(R.BAD_PARAMS, "%s: start %d is past the last cell (%d cells: %d x %d)." % [where, start, total, cols, rows])
		var n: Dictionary = _positive_int(op.get("count", total - start), "count", where)
		if R.is_err(n):
			return n
		var count: int = n["value"]
		if start + count > total:
			return R.err(R.BAD_PARAMS, "%s: start %d + count %d runs past the last cell (the %d x %d grid has %d cells)." % [where, start, count, cols, rows, total])
		for k: int in range(start, start + count):
			picked.append(k)
	var out: Array = []
	for idx: int in picked:
		var at := AtlasTexture.new()
		at.atlas = sheet
		@warning_ignore("integer_division")
		at.region = Rect2((idx % cols) * cell.x, (idx / cols) * cell.y, cell.x, cell.y)
		out.append(at)
	return {"value": out, "cell_size": [int(cell.x), int(cell.y)]}


static func _positive_int(v: Variant, field: String, where: String, minimum: int = 1) -> Dictionary:
	if (v is float or v is int) and float(v) == floorf(v) and int(v) >= minimum:
		return R.value(int(v))
	return R.err(R.BAD_PARAMS, "%s: '%s' must be a whole number >= %d, got %s." % [where, field, minimum, _j(v)])


static func _load_texture(raw: Variant, where: String) -> Dictionary:
	if not raw is String:
		return R.err(R.BAD_PARAMS, "%s: textures are res:// paths (e.g. \"res://art/hero.png\"), got %s." % [where, _j(raw)])
	var norm: Dictionary = ResPaths.normalize(raw, "texture")
	if R.is_err(norm):
		return norm
	var path: String = norm["value"]
	if not ResourceLoader.exists(path):
		var hint: String = " The file exists but is not imported yet: import it (godot_import_get / opening the editor) and retry." if FileAccess.file_exists(path) else " Use files.list to find the image."
		return R.err(R.NOT_FOUND, "%s: texture '%s' does not exist as a resource.%s" % [where, path, hint])
	var res: Resource = load(path)
	if not res is Texture2D:
		return R.err(R.BAD_PARAMS, "%s: '%s' is a %s, not a Texture2D." % [where, path, res.get_class() if res != null else "unloadable file"])
	return R.value(res)


## JSON text for error messages, with whole numbers written as ints: JSON numbers arrive as
## floats in Godot, and "[64.0, 64.0]" for the [64, 64] the caller sent reads like a bug.
static func _j(v: Variant) -> String:
	return JSON.stringify(_ints(v))


static func _ints(v: Variant) -> Variant:
	if v is float and is_finite(v) and float(v) == floorf(v) and absf(v) < 1e15:
		return int(v)
	if v is Array:
		var out: Array = []
		for x: Variant in v:
			out.append(_ints(x))
		return out
	return v
