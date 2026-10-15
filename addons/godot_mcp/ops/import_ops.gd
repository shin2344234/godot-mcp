@tool
extends RefCounted
## Import settings: read and change .import options, reimport.
##
## Registered in core/methods.gd (MODULES). `methods()` maps each bridge-protocol method
## this module implements to a descriptor (see the comment on Methods.MODULES for kinds).
##
## An imported asset (png, wav, glb, ttf, ...) has a `<file>.import` ConfigFile next to it:
## [remap] (importer, type, uid, path to the imported copy), [deps] (source_file,
## dest_files) and [params] (the importer's options). import.get parses it; import.set
## rewrites [params] (and optionally the importer) and then reimports:
## * editor: EditorFileSystem.reimport_files([path]) - blocking, exactly what the Import
##   dock does after writing the same file;
## * headless: a `--script` run has no EditorFileSystem and never imports, so the method
##   returns `"reimport": "pending"` and the TypeScript server runs
##   `godot --headless --path <project> --import` afterwards (server/src/ops/imports.ts).
## Documented in docs/methods/resources-visual-import.md.

const R := preload("../core/mcp_result.gd")
const Params := preload("../core/params.gd")
const Codec := preload("../core/variant_codec.gd")
const ResPaths := preload("../core/res_paths.gd")
const Fuzzy := preload("../core/fuzzy.gd")
const RU := preload("../core/resource_util.gd")

## Importers a file may be switched to, by source extension (Godot 4.7 importer names).
## "keep" leaves the file as-is (no import); "skip" excludes it from the project.
const IMPORTERS_BY_EXT: Dictionary = {
	"png": "texture,image,bitmap,texture_atlas,2d_array_texture,cubemap_texture,cubemap_array_texture,3d_texture,keep,skip",
	"jpg": "texture,image,bitmap,texture_atlas,2d_array_texture,cubemap_texture,cubemap_array_texture,3d_texture,keep,skip",
	"jpeg": "texture,image,bitmap,texture_atlas,2d_array_texture,cubemap_texture,cubemap_array_texture,3d_texture,keep,skip",
	"webp": "texture,image,bitmap,texture_atlas,2d_array_texture,cubemap_texture,cubemap_array_texture,3d_texture,keep,skip",
	"svg": "texture,image,bitmap,texture_atlas,keep,skip",
	"bmp": "texture,image,bitmap,keep,skip",
	"tga": "texture,image,bitmap,keep,skip",
	"exr": "texture,image,2d_array_texture,cubemap_texture,cubemap_array_texture,3d_texture,keep,skip",
	"hdr": "texture,image,2d_array_texture,cubemap_texture,cubemap_array_texture,3d_texture,keep,skip",
	"ktx": "texture,image,keep,skip",
	"dds": "texture,image,keep,skip",
	"wav": "wav,keep,skip",
	"ogg": "oggvorbisstr,keep,skip",
	"mp3": "mp3,keep,skip",
	"ttf": "font_data_dynamic,keep,skip",
	"otf": "font_data_dynamic,keep,skip",
	"woff": "font_data_dynamic,keep,skip",
	"woff2": "font_data_dynamic,keep,skip",
	"fnt": "font_data_bmfont,keep,skip",
	"glb": "scene,animation_library,keep,skip",
	"gltf": "scene,animation_library,keep,skip",
	"fbx": "scene,animation_library,keep,skip",
	"blend": "scene,animation_library,keep,skip",
	"obj": "wavefront_obj,scene,keep,skip",
	"dae": "scene,animation_library,keep,skip",
	"csv": "csv_translation,keep,skip",
}


static func methods() -> Dictionary:
	return {
		"import.get": {"kind": "project", "fn": get_import},
		"import.set": {"kind": "project", "fn": set_import},
	}


## params: {path} -> importer, type, uid, options, dest files and whether they exist.
static func get_import(params: Variant, _env: Dictionary) -> Dictionary:
	var p := Params.new(params, "import.get")
	var raw: String = p.req_string("path")
	if p.failed():
		return p.error
	var loaded: Dictionary = _load_import(raw, "import.get")
	if R.is_err(loaded):
		return loaded
	return R.ok(_describe(loaded["path"], loaded["config"]))


## params: {path, options?: {key: value}, importer?}
static func set_import(params: Variant, env: Dictionary) -> Dictionary:
	var p := Params.new(params, "import.set")
	var raw: String = p.req_string("path")
	var options: Dictionary = p.opt_dict("options", {})
	var importer: String = p.opt_string("importer", "")
	if p.failed():
		return p.error
	if options.is_empty() and importer.is_empty():
		return R.err(R.BAD_PARAMS, "import.set: pass 'options' (e.g. {\"compress/mode\": 2, \"mipmaps/generate\": true}) and/or 'importer'. Call import.get first to see the available option keys and current values.")
	var loaded: Dictionary = _load_import(raw, "import.set")
	if R.is_err(loaded):
		return loaded
	var path: String = loaded["path"]
	var cf: ConfigFile = loaded["config"]
	var current_importer: String = str(cf.get_value("remap", "importer", ""))
	var warnings: Array[String] = []
	var importer_changed: bool = not importer.is_empty() and importer != current_importer
	if importer_changed:
		var ext: String = path.get_extension().to_lower()
		var allowed: PackedStringArray = str(IMPORTERS_BY_EXT.get(ext, "keep,skip")).split(",")
		if not importer in allowed:
			return R.err(R.BAD_PARAMS, "import.set: importer '%s' cannot import .%s files.%s Valid importers for .%s: %s." % [importer, ext, Fuzzy.did_you_mean(Fuzzy.suggest(importer, allowed, 3)), ext, ", ".join(allowed)], {"valid": Array(allowed)})
		cf.set_value("remap", "importer", importer)
		warnings.append("Importer changed from '%s' to '%s': options the new importer does not have are ignored and missing ones get their defaults on reimport." % [current_importer, importer])

	var existing: PackedStringArray = cf.get_section_keys("params") if cf.has_section("params") else PackedStringArray()
	var changed: Dictionary = {}
	for k: Variant in options:
		var key: String = str(k)
		var value: Variant = options[k]
		if key in existing:
			var cur: Variant = cf.get_value("params", key)
			var dec: Dictionary = _coerce(key, value, cur)
			if R.is_err(dec):
				return dec
			value = dec["value"]
		elif not importer_changed:
			var similar: Array[String] = Fuzzy.suggest(key, existing, 5)
			return R.err(R.NOT_FOUND, "import.set: the '%s' importer of '%s' has no option '%s'.%s Call import.get to list all options." % [current_importer, path, key, Fuzzy.did_you_mean(similar)], {"similar": similar})
		cf.set_value("params", key, value)
		changed[key] = Codec.encode(value)
	var err: int = cf.save(path + ".import")
	if err != OK:
		return R.godot_err("Writing '%s.import'" % path, err)

	var out: Dictionary = {"path": path, "changed": changed}
	if importer_changed:
		out["importer_changed"] = {"from": current_importer, "to": importer}
	if bool(env.get("editor", false)) and env.get("filesystem") != null:
		(env["filesystem"] as Object).call("reimport_files", PackedStringArray([path]))
		var after := ConfigFile.new()
		after.load(path + ".import")
		out.merge(_describe(path, after))
		out["reimport"] = "done"
	else:
		# The server runs `godot --headless --import` next and then reads the result back.
		out["reimport"] = "pending"
	if not warnings.is_empty():
		out["warnings"] = warnings
	return R.ok(out)


## Loads `<path>.import`. Returns {"path", "config"} or an error explaining why there is none.
static func _load_import(raw: String, label: String) -> Dictionary:
	var where: Dictionary = RU.resolve(raw)
	if R.is_err(where):
		return where
	var path: String = where["value"]
	if path.ends_with(".import"):
		path = path.trim_suffix(".import")
	if not FileAccess.file_exists(path):
		return R.err(R.NOT_FOUND, "%s: '%s' does not exist. Use files.list to find the asset." % [label, path])
	if not FileAccess.file_exists(path + ".import"):
		var ext: String = path.get_extension().to_lower()
		var hint: String = "This file type is not imported (scenes, .tres, scripts and shaders are loaded directly; use resource.read)." if ext in ["tscn", "tres", "gd", "gdshader", "res", "scn", "cs", "json", "cfg"] else "It has not been imported yet: open the project in the Godot editor (or run `godot --headless --import`) so Godot creates the .import file."
		return R.err(R.NOT_FOUND, "%s: '%s' has no .import file. %s" % [label, path, hint])
	var cf := ConfigFile.new()
	var err: int = cf.load(path + ".import")
	if err != OK:
		return R.godot_err("Reading '%s.import'" % path, err)
	return {"path": path, "config": cf}


static func _describe(path: String, cf: ConfigFile) -> Dictionary:
	var options: Dictionary = {}
	if cf.has_section("params"):
		for key: String in cf.get_section_keys("params"):
			options[key] = Codec.encode(cf.get_value("params", key))
	var dests: Array = []
	var all_exist: bool = true
	for d: Variant in cf.get_value("deps", "dest_files", []):
		var exists: bool = FileAccess.file_exists(str(d))
		all_exist = all_exist and exists
		dests.append({"path": str(d), "exists": exists})
	var importer: String = str(cf.get_value("remap", "importer", ""))
	var out: Dictionary = {
		"path": path,
		"importer": importer,
		"type": cf.get_value("remap", "type", null),
		"uid": cf.get_value("remap", "uid", null),
		"options": options,
		"dest_files": dests,
		# "keep"/"skip" produce no imported copy; otherwise every dest file must exist.
		"imported": all_exist and not dests.is_empty() and bool(cf.get_value("remap", "valid", true)),
	}
	if cf.has_section_key("remap", "valid") and not bool(cf.get_value("remap", "valid")):
		out["import_failed"] = true
	if importer in ["keep", "skip"]:
		out["imported"] = null
	return out


## Coerces a JSON value to the type of the option's current value (ints stay ints, enums
## given as integral floats, booleans as true/false, vectors/colors via the codec).
static func _coerce(key: String, value: Variant, current: Variant) -> Dictionary:
	if current == null or current is String:
		return R.value(value if not value is float or not _is_integral(value) else int(value))
	var t: int = typeof(current)
	var r: Dictionary = Codec.decode_typed(value, {"name": key, "type": t}, null)
	if R.is_err(r):
		var e: Dictionary = r["error"]
		e["message"] = "import.set: option '%s' currently is %s (%s). %s" % [key, JSON.stringify(Codec.encode(current)), type_string(t), e["message"]]
	return r


static func _is_integral(v: float) -> bool:
	return is_finite(v) and v == floorf(v)
