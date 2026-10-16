@tool
extends RefCounted
## Shared helpers for the resource / visual / import modules (ops/resource_ops.gd,
## ops/visual_ops.gd, ops/import_ops.gd): path + UID resolution, saving without losing
## UIDs, nested property planning, and compact resource encoding.
##
## Why UIDs need special care: outside the editor (our headless runner is a plain
## `--script` process) Godot only knows the UIDs that were in `.godot/uid_cache.bin` when the
## process started, ResourceLoader.get_resource_uid() only consults that cache, and
## ResourceSaver.save() writes NO uid at all (the editor installs the callback that picks
## one). core/res_save.gd (shared) reads UIDs from the files and restores them after saving;
## here we add uid -> path lookup by scanning, and .uid sidecars for new non-text files.

const R := preload("mcp_result.gd")
const ResPaths := preload("res_paths.gd")
const Codec := preload("variant_codec.gd")
const Fuzzy := preload("fuzzy.gd")
const ResSave := preload("res_save.gd")

## Theme item data types as they appear in Theme property paths ("Button/colors/font_color"):
## path segment -> [singular used in method names, value type, resource class hint].
const THEME_DATA: Dictionary = {
	"colors": ["color", TYPE_COLOR, ""],
	"constants": ["constant", TYPE_INT, ""],
	"font_sizes": ["font_size", TYPE_INT, ""],
	"fonts": ["font", TYPE_OBJECT, "Font"],
	"icons": ["icon", TYPE_OBJECT, "Texture2D"],
	"styles": ["stylebox", TYPE_OBJECT, "StyleBox"],
}

## Upper bound on files visited when scanning the project (uid lookup, dependents).
const SCAN_LIMIT: int = 20000


# ---------------------------------------------------------------------------------------
# Paths and UIDs
# ---------------------------------------------------------------------------------------

## Resolves a client path or `uid://` reference to a res:// path.
## Returns {"value": "res://...", "uid": "uid://..." or ""} or an error.
static func resolve(raw: String, param_name: String = "path") -> Dictionary:
	var p: String = raw.strip_edges()
	if p.begins_with("uid://"):
		var found: String = uid_to_path(p)
		if found.is_empty():
			return R.err(R.NOT_FOUND, "No project file has the UID '%s' (in parameter '%s'). Check the UID, or pass the res:// path instead." % [p, param_name])
		return {"value": found, "uid": p}
	var res: Dictionary = ResPaths.normalize(p, param_name)
	if R.is_err(res):
		return res
	return {"value": res["value"], "uid": uid_text(res["value"])}


## `uid://...` -> res:// path, or "" if unknown. Uses Godot's UID cache first and falls back
## to scanning project files (needed headless for files created since the last editor scan).
static func uid_to_path(uid: String) -> String:
	var id: int = ResourceUID.text_to_id(uid)
	if id == ResourceUID.INVALID_ID:
		return ""
	if ResourceUID.has_id(id):
		return ResourceUID.get_id_path(id)
	var hit: Array[String] = []
	_scan_for_uid("res://", uid, hit, [0])
	return hit[0] if not hit.is_empty() else ""


static func _scan_for_uid(dir_path: String, uid: String, hit: Array[String], visited: Array) -> void:
	var dir: DirAccess = DirAccess.open(dir_path)
	if dir == null:
		return
	for f: String in dir.get_files():
		if not hit.is_empty() or int(visited[0]) > SCAN_LIMIT:
			return
		visited[0] = int(visited[0]) + 1
		var full: String = dir_path.path_join(f)
		var ext: String = f.get_extension().to_lower()
		if ext == "uid" or ext == "import":
			var source: String = full.get_basename()
			if uid_text(source) == uid:
				hit.append(source)
		elif ext == "tres" or ext == "tscn":
			if uid_text(full) == uid:
				hit.append(full)
	for d: String in dir.get_directories():
		if d.begins_with("."):
			continue
		_scan_for_uid(dir_path.path_join(d), uid, hit, visited)


## The uid of a project file as text ("uid://..."), or "" if it has none. Works headless
## (core/res_save.gd reads text headers, .uid sidecars and .import files itself).
static func uid_text(path: String) -> String:
	var id: int = ResSave.uid_of(path)
	return ResourceUID.id_to_text(id) if id != ResourceUID.INVALID_ID else ""


## Best-effort resource type of a project file without loading it.
static func file_type(path: String) -> String:
	var ext: String = path.get_extension().to_lower()
	match ext:
		"tscn", "scn":
			return "PackedScene"
		"gd":
			return "GDScript"
		"cs":
			return "CSharpScript"
		"gdshader":
			return "Shader"
		"gdshaderinc":
			return "ShaderInclude"
		"tres":
			var f: FileAccess = FileAccess.open(path, FileAccess.READ)
			if f != null:
				var m: RegExMatch = RegEx.create_from_string("type=\"([A-Za-z0-9_]+)\"").search(f.get_line())
				if m != null:
					return m.get_string(1)
	if FileAccess.file_exists(path + ".import"):
		var cf := ConfigFile.new()
		if cf.load(path + ".import") == OK:
			return str(cf.get_value("remap", "type", ""))
	return ""


## Splits one ResourceLoader.get_dependencies() entry. Godot 4.7 returns either
## "res://path" or, when the reference carries a uid, "uid://xxx::<type>::res://fallback"
## (the type part is empty from the scripting API). Returns {"path", "uid", "by_uid"}
## where by_uid tells whether the reference itself is a uid (else uid is looked up).
static func parse_dependency(dep: String) -> Dictionary:
	var parts: PackedStringArray = dep.split("::")
	var first: String = parts[0]
	if first.begins_with("uid://"):
		var fallback: String = parts[2] if parts.size() > 2 else ""
		var resolved: String = uid_to_path(first)
		return {"path": resolved if not resolved.is_empty() else fallback, "uid": first, "by_uid": true}
	return {"path": first, "uid": uid_text(first) if ResPaths.file_exists(first) else "", "by_uid": false}


## Headless only: gives a freshly saved non-text file (e.g. a .gdshader) the `<file>.uid`
## sidecar the editor would create. (Text resources get a header uid from ResSave.save.)
## Returns the uid text, or "" on failure.
static func assign_uid(path: String) -> String:
	var id: int = ResourceUID.create_id()
	var text: String = ResourceUID.id_to_text(id)
	if ResourceSaver.set_uid(path, id) != OK:
		var f: FileAccess = FileAccess.open(path + ".uid", FileAccess.WRITE)
		if f == null:
			return ""
		f.store_string(text + "\n")
		f.close()
	if not ResourceUID.has_id(id):
		ResourceUID.add_id(id, path)
	return text


## Saves `res` to `path` through core/res_save.gd, which keeps (headless) the file's uid and
## its [ext_resource] uids that a plain ResourceSaver.save() would drop.
## Returns {} on success or an error.
static func save(res: Resource, path: String) -> Dictionary:
	var err: int = ResSave.save(res, path)
	if err != OK:
		return R.godot_err("Saving '%s'" % path, err)
	return {}


## Loads an existing resource for reading or editing. The default cache mode matters in the
## editor: the cached instance is the one open scenes and inspectors share, so edits to it
## show up everywhere. Returns {"value": Resource} or an error.
static func load_existing(path: String, label: String) -> Dictionary:
	if not ResPaths.file_exists(path):
		var similar: Array[String] = Fuzzy.suggest(path.get_file(), _sibling_files(path), 5)
		return R.err(R.NOT_FOUND, "%s: '%s' does not exist.%s Use files.list to browse the project." % [label, path, Fuzzy.did_you_mean(similar)])
	var res: Resource = ResourceLoader.load(path)
	if res == null:
		return R.err(R.GODOT_ERROR, "%s: Godot could not load '%s' as a resource (unrecognized format, import failed, or broken dependencies). Check godot_editor_logs / the Godot output." % [label, path])
	return R.value(res)


static func _sibling_files(path: String) -> Array[String]:
	var out: Array[String] = []
	var dir: DirAccess = DirAccess.open(path.get_base_dir())
	if dir != null:
		for f: String in dir.get_files():
			if not f.ends_with(".import") and not f.ends_with(".uid"):
				out.append(f)
	return out


# ---------------------------------------------------------------------------------------
# Property planning (used by resource.set / resource.create)
# ---------------------------------------------------------------------------------------

## Validates and decodes one property assignment on a resource. `key` may be a plain
## property, a nested path for set_indexed ("next_pass:albedo_color", "size:x") or a Theme
## item path ("Button/colors/font_color"). Returns
##   {"key": key, "value": decoded, "old": current value, "undo": [method, args]}
## where "undo" is how to restore the old state, or an error.
static func plan_property(res: Resource, key: String, value: Variant, label: String) -> Dictionary:
	if res is Theme and key.count("/") == 2:
		return _plan_theme_item(res as Theme, key, value)
	var segments: PackedStringArray = key.split(":")
	var first: String = segments[0]
	if Codec.find_property(res, first).is_empty():
		if segments.size() == 1:
			var dynamic: Dictionary = _plan_dynamic_property(res, key, value)
			if not dynamic.is_empty():
				return dynamic
		return unknown_property(res, first, label)
	if segments.size() == 1:
		var r: Dictionary = Codec.decode_property(res, key, value, null)
		if R.is_err(r):
			return r
		return {"key": key, "value": r["value"], "old": res.get(key), "undo": ["set_indexed", [key, res.get(key)]]}
	# Nested: walk to the object (or value) that owns the last segment.
	var base_path: String = ":".join(segments.slice(0, segments.size() - 1))
	var leaf: String = segments[segments.size() - 1]
	var owner_value: Variant = res.get_indexed(NodePath(base_path))
	var decoded: Dictionary
	if owner_value is Object:
		var owner_obj: Object = owner_value
		if Codec.find_property(owner_obj, leaf).is_empty():
			return unknown_property(owner_obj, leaf, "%s '%s' (%s)" % [label, base_path, owner_obj.get_class()])
		decoded = Codec.decode_property(owner_obj, leaf, value, null)
	elif owner_value == null:
		return R.err(R.BAD_PARAMS, "Cannot set '%s': '%s' is null on %s. Assign it first, e.g. {\"%s\": {\"new\": \"<ResourceClass>\"}}, then set its properties." % [key, base_path, label, base_path])
	else:
		# A component of a built-in value, e.g. "size:x" on a Vector2 or "albedo_color:a".
		var current: Variant = res.get_indexed(NodePath(key))
		if current == null:
			return R.err(R.NOT_FOUND, "Cannot set '%s': %s has no component '%s' (it is a %s)." % [key, base_path, leaf, type_string(typeof(owner_value))])
		decoded = Codec.decode_typed(value, {"name": key, "type": typeof(current)}, null)
	if R.is_err(decoded):
		return decoded
	var old: Variant = res.get_indexed(NodePath(key))
	return {"key": key, "value": decoded["value"], "old": old, "undo": ["set_indexed", [key, old]]}


## Properties that only appear in get_property_list() once they are set. Several engine
## classes implement indexed properties in _set()/_get()/_get_property_list() and list only
## the entries that already exist, e.g. (Godot 4.7.2):
##   MeshLibrary "item/<id>/name|mesh|mesh_transform|shapes|preview|navigation_mesh|..."
##     (scene/resources/3d/mesh_library.cpp: MeshLibrary::_set creates the item on the
##     first "item/<id>/..." assignment, _get_property_list lists existing items only);
##   TileSet "physics_layer_<n>/...", "custom_data_layer_<n>/..." (layers are added on set).
## A .tres stores exactly these keys, so accepting them lets resource.create/set build a
## MeshLibrary (GridMap) from scratch. To tell a real dynamic key from a typo without
## touching `res`, the key is set to null on a throwaway duplicate; if the duplicate then
## lists the key, it is valid and its PropertyInfo types the value. (A plain "set, then
## get" check is not enough: MeshLibrary::_set creates item <id> even for an unknown
## "item/<id>/typo" key before returning false.) Returns {} when the key is not dynamic.
static func _plan_dynamic_property(res: Resource, key: String, value: Variant) -> Dictionary:
	if not key.contains("/") or key.begins_with("metadata/"):
		return {}
	var probe: Resource = res.duplicate(false)
	if probe == null:
		return {}
	probe.set(key, null)
	var info: Dictionary = Codec.find_property(probe, key)
	if info.is_empty():
		return {}
	var decoded: Dictionary = Codec.decode_typed(value, info, null, probe)
	if R.is_err(decoded):
		return decoded
	var existed: bool = not Codec.find_property(res, key).is_empty()
	var old: Variant = res.get(key) if existed else null
	var undo: Array = ["set_indexed", [key, old]]
	# Undoing the first assignment of a new MeshLibrary item removes the item again.
	if res is MeshLibrary and key.begins_with("item/"):
		var id: int = key.get_slice("/", 1).to_int()
		if not (res as MeshLibrary).get_item_list().has(id):
			undo = ["remove_item", [id]]
	return {"key": key, "value": decoded["value"], "old": old, "undo": undo, "dynamic": true}


static func _plan_theme_item(theme: Theme, key: String, value: Variant) -> Dictionary:
	var parts: PackedStringArray = key.split("/")
	var type_name: String = parts[0]
	var data_type: String = parts[1]
	var item_name: String = parts[2]
	if type_name.is_empty() or item_name.is_empty() or not THEME_DATA.has(data_type):
		return R.err(R.BAD_PARAMS, "Theme item path '%s' must look like \"<Type>/<data type>/<item>\", e.g. \"Button/colors/font_color\"; data type is one of %s." % [key, ", ".join(THEME_DATA.keys())])
	var spec: Array = THEME_DATA[data_type]
	var single: String = spec[0]
	var info: Dictionary = {"name": key, "type": spec[1], "hint": PROPERTY_HINT_RESOURCE_TYPE if spec[2] != "" else PROPERTY_HINT_NONE, "hint_string": spec[2]}
	var decoded: Dictionary = Codec.decode_typed(value, info, null)
	if R.is_err(decoded):
		return decoded
	var existed: bool = theme.call("has_" + single, item_name, type_name)
	var old: Variant = theme.get(key) if existed else null
	var undo: Array = ["set_indexed", [key, old]] if existed else ["clear_" + single, [item_name, type_name]]
	return {"key": key, "value": decoded["value"], "old": old, "undo": undo}


static func unknown_property(obj: Object, prop: String, label: String) -> Dictionary:
	var similar: Array[String] = Fuzzy.suggest(prop, Codec.property_names(obj), 8)
	var msg: String = "%s has no property '%s'.%s Use resource.read to see the current properties." % [label, prop, Fuzzy.did_you_mean(similar)]
	if obj is Theme:
		msg += " Theme items use paths like \"Button/colors/font_color\"."
	if obj is TileSet:
		# The inspector shows "Physics Layers", "Navigation Layers"... as arrays, but those
		# are not properties (see Codec.is_array_header): layers are added, then set by index.
		msg += " TileSet layers are not properties: add them with godot_tileset_edit, then set e.g. \"physics_layer_0/collision_layer\"."
	return R.err(R.NOT_FOUND, msg, {"similar": similar})


# ---------------------------------------------------------------------------------------
# Encoding
# ---------------------------------------------------------------------------------------

## Stored properties of `obj` whose value differs from the class (or script) default,
## encoded for JSON. Embedded sub-resources are expanded `depth` levels deep.
## `skip_theme_items` hides Theme item properties ("Type/colors/x"); they are listed
## separately by theme_items().
static func non_default_properties(obj: Object, depth: int, skip_theme_items: bool = false) -> Dictionary:
	var out: Dictionary = {}
	var script: Script = obj.get_script() as Script
	var script_props: Dictionary = {}
	if script != null:
		for info: Dictionary in script.get_script_property_list():
			script_props[str(info["name"])] = true
	for info: Dictionary in obj.get_property_list():
		var usage: int = info["usage"]
		if (usage & PROPERTY_USAGE_STORAGE) == 0:
			continue
		if usage & (PROPERTY_USAGE_GROUP | PROPERTY_USAGE_SUBGROUP | PROPERTY_USAGE_CATEGORY):
			continue
		var pname: String = info["name"]
		if pname in ["resource_path", "resource_scene_unique_id", "script", "resource_local_to_scene"] or pname.begins_with("metadata/_"):
			continue
		if skip_theme_items and pname.count("/") == 2:
			continue
		var value: Variant = obj.get(pname)
		var default: Variant
		if script_props.has(pname):
			default = script.get_property_default_value(pname)
		else:
			default = ClassDB.class_get_property_default_value(obj.get_class(), pname)
		if typeof(value) == typeof(default) and not value is Object and value == default:
			continue
		if value == null and default == null:
			continue
		if pname == "resource_name" and str(value).is_empty():
			continue
		out[pname] = encode_value(value, depth)
	if obj is Curve2D or obj is Curve3D:
		# Readable points instead of the packed internal `_data` (in, out, position triples).
		out.erase("_data")
		out["points"] = Codec.curve_points(obj)
	return out


## Encodes a property value: embedded resources become {"class", "embedded", "properties"}
## while `depth` > 0, external ones {"resource": path, "class"}; everything else uses the
## shared codec.
##
## Arrays and dictionaries are walked element by element with the SAME depth (containers do
## not count as a level): resources nested in them are expanded too. This matters for
## classes that keep their sub-resources in plain containers, e.g. SpriteFrames.animations is
## [{name, speed, loop, frames: [{texture: <embedded AtlasTexture>, duration}]}]: with the
## old "Array whose first element is a Resource" rule the AtlasTextures came out as
## {"class", "embedded", "resource": null} at any depth, so their atlas/region were invisible
## (MCP_TEST_LOG). `nest` guards against self-referencing containers.
static func encode_value(value: Variant, depth: int, nest: int = 0) -> Variant:
	if nest > Codec.MAX_DEPTH:
		return "…(max depth)"
	if value is Resource:
		var r: Resource = value
		var rp: String = r.resource_path
		if not rp.is_empty() and not rp.contains("::"):
			return {"resource": rp, "class": r.get_class()}
		var out: Dictionary = {"class": r.get_class(), "embedded": true}
		if depth > 0:
			out["properties"] = non_default_properties(r, depth - 1)
		return out
	if value is Array:
		var arr: Array = value
		var items: Array = []
		for i: int in range(mini(arr.size(), Codec.MAX_ITEMS)):
			items.append(encode_value(arr[i], depth, nest + 1))
		if arr.size() > Codec.MAX_ITEMS:
			items.append("…(+%d more)" % (arr.size() - Codec.MAX_ITEMS))
		return items
	if value is Dictionary:
		var d: Dictionary = value
		var out_d: Dictionary = {}
		var count: int = 0
		for key: Variant in d:
			if count >= Codec.MAX_ITEMS:
				out_d["…"] = "(+%d more keys)" % (d.size() - Codec.MAX_ITEMS)
				break
			var k: String = str(key) if (key is String or key is StringName) else var_to_str(key)
			out_d[k] = encode_value(d[key], depth, nest + 1)
			count += 1
		return out_d
	return Codec.encode(value)


# ---------------------------------------------------------------------------------------
# Size cap for read results
# ---------------------------------------------------------------------------------------

## Shrinks an already-encoded JSON value so its JSON text stays around `budget` characters.
## Used by resource.read: a TileSet keeps one property per tile and polygon, so a plain read
## of a real tile set was ~4k tokens (~9k with depth 2, MCP_TEST_LOG) and drowned the
## answer. Rules, applied recursively:
## * a dictionary keeps its small entries whole (smallest first, up to half the budget);
##   the big ones share the rest and are shrunk in turn; entries that still do not fit are
##   dropped and named under the key "…" so the caller can ask for them;
## * an array keeps a prefix and ends with "…(+N more)";
## * a long string is cut with "…(+N chars)".
## Key order is preserved. Returns the value unchanged when it already fits.
static func fit(v: Variant, budget: int) -> Variant:
	if _json_len(v) <= budget:
		return v
	if v is Dictionary:
		return _fit_dict(v, budget)
	if v is Array:
		return _fit_array(v, budget)
	if v is String:
		var s: String = v
		var keep: int = maxi(budget - 24, 16)
		return s.left(keep) + "…(+%d chars)" % (s.length() - keep)
	return v


static func _json_len(v: Variant) -> int:
	return JSON.stringify(v).length()


static func _fit_dict(d: Dictionary, budget: int) -> Dictionary:
	var keys: Array = d.keys()
	var sizes: Dictionary = {}
	for k: Variant in keys:
		sizes[k] = _json_len(d[k]) + str(k).length() + 4
	# Small entries (up to 1/8 of the budget each) are kept whole, in key order, while they
	# fit in half the budget: a TileSet source then shows its first tiles completely rather
	# than a scattering of every tile's smallest keys. Big entries share what is left.
	var whole: Dictionary = {}
	var used: int = 2
	var big: Array = []
	var omitted: Array[String] = []
	for k: Variant in keys:
		var s: int = sizes[k]
		if s > budget / 8.0:
			big.append(k)
		elif omitted.is_empty() and used + s <= budget / 2.0:
			whole[k] = true
			used += s
		else:
			# A strict prefix: once one small entry is left out, so are the ones after it.
			omitted.append(str(k))
	var shrunk: Dictionary = {}
	if not big.is_empty():
		var share: int = floori(float(budget - used - 80) / big.size())
		for k: Variant in big:
			var child: Variant = d[k]
			if share >= 160 and (child is Dictionary or child is Array or child is String):
				shrunk[k] = fit(child, share - str(k).length() - 4)
			else:
				omitted.append(str(k))
	var out: Dictionary = {}
	for k: Variant in keys:
		if whole.has(k):
			out[k] = d[k]
		elif shrunk.has(k):
			out[k] = shrunk[k]
	if not omitted.is_empty():
		var names: Array[String] = omitted.slice(0, 8)
		out["…"] = "%d more key(s) left out to keep the result small: %s%s" % [omitted.size(), ", ".join(names), ", ..." if omitted.size() > names.size() else ""]
	return out


static func _fit_array(a: Array, budget: int) -> Array:
	var out: Array = []
	var used: int = 2
	for i: int in range(a.size()):
		var item: Variant = a[i]
		var s: int = _json_len(item) + 1
		if used + s > budget - 24:
			if out.is_empty() and (item is Dictionary or item is Array) and budget > 200:
				# Even the first element is too big: shrink it rather than return nothing.
				out.append(fit(item, budget - 40))
			var rest: int = a.size() - out.size()
			if rest > 0:
				out.append("…(+%d more)" % rest)
			return out
		out.append(item)
		used += s
	return out


## Compact listing of a Theme's items: {Type: {colors: {name: value}, constants: {...}, ...}}.
static func theme_items(theme: Theme, depth: int, max_types: int = 60) -> Dictionary:
	var out: Dictionary = {}
	var types: PackedStringArray = theme.get_type_list()
	for i: int in range(mini(types.size(), max_types)):
		var type_name: String = types[i]
		var entry: Dictionary = {}
		for data_type: String in THEME_DATA:
			var single: String = THEME_DATA[data_type][0]
			var names: PackedStringArray = theme.call("get_%s_list" % single, type_name)
			if names.is_empty():
				continue
			var items: Dictionary = {}
			for item_name: String in names:
				items[item_name] = encode_value(theme.call("get_" + single, item_name, type_name), depth)
			entry[data_type] = items
		var variation: String = theme.get_type_variation_base(type_name)
		if not variation.is_empty():
			entry["variation_of"] = variation
		out[type_name] = entry
	if types.size() > max_types:
		out["…"] = "(+%d more types)" % (types.size() - max_types)
	return out


## "" -> null: JSON null reads better than an empty string for "no uid" / "unknown type".
static func or_null(s: String) -> Variant:
	if s.is_empty():
		return null
	return s
