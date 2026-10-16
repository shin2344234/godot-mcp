extends SceneTree
## Helper for scripts/gen-import-defaults.sh (not part of the addon). Two steps:
##
##   godot --headless --path <tmp> --script gen.gd -- make
##       writes one source file per importer, `<importer>.<ext>`, with a `.import` file next
##       to it that names only the importer. The shell script then runs `--import`, which
##       imports each file with that importer and writes ALL of its options, with their
##       defaults, into the file's [params] (EditorFileSystem::_reimport_file, Godot 4.7.2).
##       Contents don't matter for most importers: a file that fails to import still gets
##       its [params] written (verified on 4.7.2 with a junk .ogg and .ttf), so only the
##       image importers get a real PNG (some of them read the size) and wav a real WAV.
##
##   godot --headless --path <tmp> --script gen.gd -- convert <out.cfg>
##       collects those [params] into one section per importer name.
##
## The importer list is import_ops.gd's IMPORTERS_BY_EXT (keep/skip have no options).

## [importer, extension of the source file to create for it]. Some importers add options
## for some extensions (texture: svg/scale and editor/* for .svg; scene: fbx/* for .fbx),
## so an importer can appear more than once; its section is the union. The addon compares
## only the keys an asset's own .import file has, so a key missing here (e.g. the blender/*
## options of .blend files: importing a .blend without a configured Blender aborts the
## whole headless import pass, verified on 4.7.2) just means that option is always shown.
## Only one texture_atlas file: two of them (both with the default empty atlas_file) make
## the 4.7.2 import pass hang forever.
const IMPORTERS: Array = [
	["texture", "png"], ["texture", "svg"], ["image", "png"], ["bitmap", "png"], ["bitmap", "svg"],
	["texture_atlas", "png"], ["2d_array_texture", "png"],
	["cubemap_texture", "png"], ["cubemap_array_texture", "png"], ["3d_texture", "png"],
	["wav", "wav"], ["oggvorbisstr", "ogg"], ["mp3", "mp3"], ["font_data_dynamic", "ttf"],
	["font_data_bmfont", "fnt"], ["scene", "glb"], ["scene", "gltf"], ["scene", "fbx"],
	["scene", "dae"], ["animation_library", "glb"], ["animation_library", "fbx"],
	["wavefront_obj", "obj"], ["csv_translation", "csv"],
]

const SVG: String = "<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"8\" height=\"8\"><rect width=\"8\" height=\"8\" fill=\"red\"/></svg>\n"


func _initialize() -> void:
	var args: PackedStringArray = OS.get_cmdline_user_args()
	var err: int = OK
	if args.size() >= 1 and args[0] == "make":
		err = _make()
	elif args.size() >= 2 and args[0] == "convert":
		err = _convert(args[1])
	else:
		push_error("gen.gd: usage: -- make | -- convert <out.cfg>")
		err = ERR_INVALID_PARAMETER
	quit(0 if err == OK else 1)


func _make() -> int:
	var img := Image.create(8, 8, false, Image.FORMAT_RGBA8)
	img.fill(Color(1, 0, 0, 1))
	for pair: Array in IMPORTERS:
		var importer: String = pair[0]
		var path: String = "res://%s.%s" % [importer, pair[1]]
		match str(pair[1]):
			"png":
				img.save_png(path)
			"svg":
				_write(path, SVG)
			"wav":
				var wav := AudioStreamWAV.new()
				wav.format = AudioStreamWAV.FORMAT_16_BITS
				wav.mix_rate = 8000
				wav.data = PackedByteArray([0, 0, 0, 0])
				wav.save_to_wav(path)
			"csv":
				_write(path, "keys,en\nHELLO,Hello\n")
			_:
				_write(path, "placeholder: only the importer's option list is wanted\n")
		_write(path + ".import", "[remap]\n\nimporter=\"%s\"\n" % importer)
	return OK


func _convert(out_path: String) -> int:
	var out := ConfigFile.new()
	for pair: Array in IMPORTERS:
		var importer: String = pair[0]
		var cf := ConfigFile.new()
		var path: String = "res://%s.%s.import" % [importer, pair[1]]
		if cf.load(path) != OK:
			push_error("gen.gd: cannot read %s" % path)
			return FAILED
		if str(cf.get_value("remap", "importer", "")) != importer:
			push_error("gen.gd: %s was imported with '%s', not '%s'" % [path, cf.get_value("remap", "importer", ""), importer])
			return FAILED
		var keys: PackedStringArray = cf.get_section_keys("params") if cf.has_section("params") else PackedStringArray()
		# An importer without options (e.g. "image") gets no section; the addon then shows
		# all options, which are none anyway.
		for key: String in keys:
			if not out.has_section_key(importer, key):
				out.set_value(importer, key, cf.get_value("params", key))
		print("gen.gd: %s (.%s): %d options" % [importer, pair[1], keys.size()])
	return out.save(out_path)


func _write(path: String, text: String) -> void:
	var f := FileAccess.open(path, FileAccess.WRITE)
	f.store_string(text)
	f.close()
