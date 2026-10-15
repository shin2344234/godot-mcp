extends SceneTree
## Second step of scripts/gen-export-defaults.sh: turns the export_presets.cfg the editor
## saved (one preset per platform, every option filled in) into
## addons/godot_mcp/core/export_defaults.cfg: one section per platform name, holding the
## platform's options and default values in the editor's order. Secret options are not in
## export_presets.cfg (the editor writes them to .godot/export_credentials.cfg), so they are
## left out automatically. Usage: godot --headless --path <tmp> --script convert.gd -- <out>

func _initialize() -> void:
	var out_path: String = OS.get_cmdline_user_args()[0]
	var src := ConfigFile.new()
	if src.load("res://export_presets.cfg") != OK:
		push_error("convert: cannot read export_presets.cfg")
		quit(1)
		return
	var out := ConfigFile.new()
	var count: int = 0
	for section: String in src.get_sections():
		if not section.begins_with("preset.") or section.ends_with(".options"):
			continue
		var platform: String = src.get_value(section, "platform")
		var opts: String = section + ".options"
		for key: String in src.get_section_keys(opts):
			out.set_value(platform, key, src.get_value(opts, key))
		count += src.get_section_keys(opts).size()
		print("convert: %s: %d options" % [platform, src.get_section_keys(opts).size()])
	if count < 20:
		push_error("convert: only %d options; the editor did not fill the presets" % count)
		quit(1)
		return
	var err: int = out.save(out_path)
	if err != OK:
		push_error("convert: cannot write %s" % out_path)
	quit(err)
