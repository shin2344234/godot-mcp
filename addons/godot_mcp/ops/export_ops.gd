@tool
extends RefCounted
## Export presets: read (secrets redacted) and edit export_presets.cfg.
##
## Registered in core/methods.gd (MODULES). `methods()` maps each bridge-protocol method
## this module implements to a descriptor (see the comment on Methods.MODULES for kinds).
##
## File format (Godot 4.7, EditorExport::_save/load_config):
##   [runnable_presets]          Platform name -> name of its runnable preset
##   [preset.N]                  name, platform, export_filter, export_path, filters, ...
##   [preset.N.options]          platform options (binary_format/embed_pck, ...)
## Options flagged PROPERTY_USAGE_SECRET (keystore passwords, codesign identities,
## notarization credentials) and the script encryption key are NOT in that file: Godot
## keeps them in res://.godot/export_credentials.cfg (same section names), so they never
## end up in version control. This module never reads or writes that file; those keys
## must be set in the editor (Project > Export) or through Godot's environment variables.
## Older files may still have `runnable=true` in [preset.N] and secrets inline; both are
## understood (inline secrets are redacted).
##
## export_presets.cfg is read and written with ConfigFile, the class EditorExport itself
## uses, so the output is the exact format the editor writes. No script API exposes the
## editor's in-memory presets; after writing, the editor is made to reload the file by
## registering and immediately removing an empty export platform (EditorExport reloads
## export_presets.cfg whenever its platform list changes; see _reload_editor_presets).
##
## Secrets are never returned: values of options whose names look secret are replaced by
## "<redacted>" (an empty value stays empty, so "not configured" is still visible).

const R := preload("../core/mcp_result.gd")
const Params := preload("../core/params.gd")
const Codec := preload("../core/variant_codec.gd")
const Fuzzy := preload("../core/fuzzy.gd")

const PRESETS_PATH: String = "res://export_presets.cfg"
const RUNNABLE_SECTION: String = "runnable_presets"
const REDACTED: String = "<redacted>"

## Option names (lower-case substrings) treated as secrets for redaction and writes.
const SECRET_MARKERS: PackedStringArray = [
	"key", "password", "passwd", "pass", "secret", "token", "keystore", "identity", "certificate",
	"apple_id", "ssh", "provisioning_profile", "api_uuid", "_user",
]

## Options Godot 4.7 stores in export_credentials.cfg (PROPERTY_USAGE_SECRET in platform/*).
const CREDENTIAL_OPTIONS: PackedStringArray = [
	"keystore/debug", "keystore/debug_user", "keystore/debug_password",
	"keystore/release", "keystore/release_user", "keystore/release_password",
	"codesign/identity", "codesign/identity_type", "codesign/password",
	"codesign/certificate_file", "codesign/certificate_password", "codesign/provisioning_profile",
	"application/provisioning_profile_uuid_debug", "application/provisioning_profile_uuid_release",
	"notarization/api_key", "notarization/api_key_id", "notarization/api_uuid",
	"notarization/apple_id_name", "notarization/apple_id_password",
]

## Keys of the [preset.N] section (everything else is a platform option).
const PRESET_FIELDS: PackedStringArray = [
	"name", "platform", "runnable", "dedicated_server", "custom_features", "export_filter",
	"export_files", "customized_files", "include_filter", "exclude_filter", "export_path", "patches",
	"patch_delta_encoding", "patch_delta_compression_level_zstd", "patch_delta_min_reduction",
	"patch_delta_include_filters", "patch_delta_exclude_filters", "encryption_include_filters",
	"encryption_exclude_filters", "seed", "encrypt_pck", "encrypt_directory", "script_export_mode",
	"script_encryption_key",
]

const EXPORT_FILTERS: PackedStringArray = ["all_resources", "scenes", "resources", "exclude", "customized"]

## Options worth showing in the preset list (when present).
const KEY_OPTIONS: PackedStringArray = [
	"binary_format/architecture", "binary_format/embed_pck", "custom_template/debug", "custom_template/release",
	"variant/thread_support", "gradle_build/use_gradle_build", "package/unique_name", "application/bundle_identifier",
	"ssh_remote_deploy/enabled",
]

## Platform names as the editor registers them (EditorExportPlatform::get_name) + aliases.
const PLATFORMS: Dictionary = {
	"linux": "Linux", "linux/x11": "Linux", "windows": "Windows Desktop", "windows desktop": "Windows Desktop",
	"macos": "macOS", "mac": "macOS", "osx": "macOS", "android": "Android", "ios": "iOS",
	"visionos": "visionOS", "web": "Web", "html5": "Web",
}


static func methods() -> Dictionary:
	return {
		"export.presets": {"kind": "project", "fn": list_presets},
		"export.preset_set": {"kind": "project", "fn": set_preset},
	}


static func is_secret(key: String) -> bool:
	var k: String = key.to_lower()
	if k in CREDENTIAL_OPTIONS or k == "script_encryption_key":
		return true
	for m: String in SECRET_MARKERS:
		if k.contains(m):
			return true
	return false


## Secret-looking keys keep booleans/numbers (e.g. ssh_remote_deploy/enabled, a port) and
## empty strings; anything else is replaced.
static func redact(key: String, value: Variant) -> Variant:
	if not is_secret(key):
		return Codec.encode(value)
	if value == null or value is bool or value is int or value is float:
		return value
	if value is String and (value as String).is_empty():
		return ""
	return REDACTED


## [{"index", "section", "name", "platform"}] for every [preset.N] section, in order.
static func _preset_sections(cfg: ConfigFile) -> Array:
	var out: Array = []
	var i: int = 0
	while cfg.has_section("preset.%d" % i):
		var section: String = "preset.%d" % i
		out.append({"index": i, "section": section, "name": str(cfg.get_value(section, "name", "")),
			"platform": str(cfg.get_value(section, "platform", ""))})
		i += 1
	return out


## Resolves params.preset (a name or an index) to an entry of _preset_sections.
static func _find_preset(presets: Array, raw: Variant, method: String) -> Dictionary:
	var names: Array[String] = []
	for e: Dictionary in presets:
		names.append(str(e["name"]))
	if raw is String:
		for e: Dictionary in presets:
			if e["name"] == raw:
				return R.value(e)
		if (raw as String).is_valid_int():
			raw = (raw as String).to_int()
		else:
			var similar: Array[String] = Fuzzy.suggest(raw, names, 3)
			return R.err(R.NOT_FOUND, "%s: no export preset named '%s'.%s Presets: %s." % [method, raw, Fuzzy.did_you_mean(similar), _names_text(names)])
	if raw is float or raw is int:
		var idx: int = int(raw)
		if idx >= 0 and idx < presets.size():
			return R.value(presets[idx])
		return R.err(R.NOT_FOUND, "%s: preset index %d is out of range (there are %d presets: %s)." % [method, idx, presets.size(), _names_text(names)])
	return R.err(R.BAD_PARAMS, "%s: 'preset' must be a preset name or index. Presets: %s." % [method, _names_text(names)])


static func _names_text(names: Array[String]) -> String:
	return ", ".join(names) if not names.is_empty() else "(none; create one with export.preset_set {\"create\": {\"name\": \"Linux\", \"platform\": \"Linux\"}})"


static func _runnable(cfg: ConfigFile, entry: Dictionary) -> bool:
	if cfg.has_section_key(RUNNABLE_SECTION, entry["platform"]):
		return str(cfg.get_value(RUNNABLE_SECTION, entry["platform"])) == entry["name"]
	return bool(cfg.get_value(entry["section"], "runnable", false))


## Summary (default) or full detail of one preset, secrets redacted.
static func describe(cfg: ConfigFile, entry: Dictionary, full: bool) -> Dictionary:
	var section: String = entry["section"]
	var opt_section: String = section + ".options"
	var out: Dictionary = {"index": entry["index"], "name": entry["name"], "platform": entry["platform"], "runnable": _runnable(cfg, entry)}
	var redacted: Array = []
	if full:
		for k: String in cfg.get_section_keys(section):
			if k in ["name", "platform", "runnable"]:
				continue
			out[k] = redact(k, cfg.get_value(section, k))
			if out[k] is String and out[k] == REDACTED:
				redacted.append(k)
	else:
		for k: String in ["export_path", "export_filter", "include_filter", "exclude_filter", "dedicated_server", "custom_features", "encrypt_pck", "patches"]:
			if cfg.has_section_key(section, k):
				out[k] = Codec.encode(cfg.get_value(section, k))
	var options: Dictionary = {}
	var keys: PackedStringArray = cfg.get_section_keys(opt_section) if cfg.has_section(opt_section) else PackedStringArray()
	for k: String in keys:
		if full or k in KEY_OPTIONS:
			options[k] = redact(k, cfg.get_value(opt_section, k))
			if options[k] is String and options[k] == REDACTED:
				redacted.append("options/" + k)
	out["options"] = options
	out["option_count"] = keys.size()
	if not redacted.is_empty():
		out["redacted"] = redacted
	return out


# ---------------------------------------------------------------------------------------
# export.presets
# ---------------------------------------------------------------------------------------

static func list_presets(params: Dictionary, _env: Dictionary) -> Dictionary:
	var p := Params.new(params, "export.presets")
	var which: Variant = p.raw("preset", null)
	if p.failed():
		return p.error
	if not FileAccess.file_exists(PRESETS_PATH):
		return R.ok({"exists": false, "presets": [],
			"hint": "The project has no export_presets.cfg. Create a preset with export.preset_set {\"create\": {\"name\": \"Linux\", \"platform\": \"Linux\"}} or in the editor (Project > Export)."})
	var cfg := ConfigFile.new()
	var err: int = cfg.load(PRESETS_PATH)
	if err != OK:
		return R.godot_err("Parsing export_presets.cfg", err)
	var presets: Array = _preset_sections(cfg)
	if which != null:
		var found: Dictionary = _find_preset(presets, which, "export.presets")
		if R.is_err(found):
			return found
		return R.ok({"exists": true, "preset": describe(cfg, found["value"], true)})
	var out: Array = []
	for e: Dictionary in presets:
		out.append(describe(cfg, e, false))
	return R.ok({"exists": true, "presets": out})


# ---------------------------------------------------------------------------------------
# export.preset_set
# ---------------------------------------------------------------------------------------

static func set_preset(params: Dictionary, env: Dictionary) -> Dictionary:
	var p := Params.new(params, "export.preset_set")
	var which: Variant = p.raw("preset", null)
	var set_values: Dictionary = p.opt_dict("set", {})
	var create: Dictionary = p.opt_dict("create", {})
	var allow_secrets: bool = p.opt_bool("allow_secrets", false)
	var allow_new_keys: bool = p.opt_bool("allow_new_keys", false)
	if p.failed():
		return p.error
	if set_values.is_empty() and create.is_empty():
		return R.err(R.BAD_PARAMS, "export.preset_set: pass 'set' (e.g. {\"preset\": \"Linux\", \"set\": {\"export_path\": \"build/game.x86_64\", \"binary_format/embed_pck\": true}}) and/or 'create' ({\"name\": \"Linux\", \"platform\": \"Linux\"}).")

	var cfg := ConfigFile.new()
	if FileAccess.file_exists(PRESETS_PATH):
		var err: int = cfg.load(PRESETS_PATH)
		if err != OK:
			return R.godot_err("Parsing export_presets.cfg", err)
	elif create.is_empty():
		return R.err(R.NOT_FOUND, "export.preset_set: the project has no export_presets.cfg yet. Create a preset first: {\"create\": {\"name\": \"Linux\", \"platform\": \"Linux\"}}.")
	var presets: Array = _preset_sections(cfg)

	var entry: Dictionary
	var created: bool = false
	if not create.is_empty():
		var made: Dictionary = _create_preset(cfg, presets, create)
		if R.is_err(made):
			return made
		entry = made["value"]
		created = true
	else:
		if which == null:
			var names: Array[String] = []
			for e: Dictionary in presets:
				names.append(str(e["name"]))
			return R.err(R.BAD_PARAMS, "export.preset_set: pass 'preset' (name or index) to say which preset to change. Presets: %s." % _names_text(names))
		var found: Dictionary = _find_preset(presets, which, "export.preset_set")
		if R.is_err(found):
			return found
		entry = found["value"]

	var section: String = entry["section"]
	var opt_section: String = section + ".options"
	var changed: Dictionary = {}
	for raw_key: Variant in set_values:
		var key: String = str(raw_key).strip_edges()
		var value: Variant = set_values[raw_key]
		var is_option: bool = true
		if key.begins_with("options/"):
			key = key.trim_prefix("options/")
		elif key in PRESET_FIELDS:
			is_option = false
		var label: String = ("options/" + key) if is_option else key
		if not is_option and key == "platform":
			return R.err(R.BAD_PARAMS, "export.preset_set: a preset's platform cannot be changed; create a new preset with {\"create\": {\"name\": ..., \"platform\": ...}}.")
		if key in CREDENTIAL_OPTIONS or key == "script_encryption_key":
			return R.err(R.BAD_PARAMS, ("export.preset_set: '%s' is a credential. Godot 4.7 keeps credentials in .godot/export_credentials.cfg, which this server never reads or writes. " +
				"Set it in the editor (Project > Export), or via Godot's environment variables for CI (e.g. GODOT_ANDROID_KEYSTORE_RELEASE_PATH/_USER/_PASSWORD).") % label)
		var secret_err: String = ("export.preset_set: '%s' looks like a secret (signing, password or remote-deploy setting) and export_presets.cfg is usually committed to version control. " +
			"Pass \"allow_secrets\": true to write it anyway; the value is never shown back.") % label
		if not is_option:
			if is_secret(key) and not allow_secrets:
				return R.err(R.BAD_PARAMS, secret_err)
			var field_err: Dictionary = _set_field(cfg, entry, key, value)
			if R.is_err(field_err):
				return field_err
			changed[label] = redact(key, value)
			continue
		# Unknown option first, secret second: the secret check matches substrings ("key",
		# "pass", ...), so a typo or made-up name like "bogus_key" used to be refused as a
		# secret, hiding the real problem and its did-you-mean (MCP_TEST_LOG Phase A).
		var exists: bool = cfg.has_section_key(opt_section, key)
		if not exists and not allow_new_keys:
			var existing: PackedStringArray = cfg.get_section_keys(opt_section) if cfg.has_section(opt_section) else PackedStringArray()
			if not existing.is_empty() or not created:
				var similar: Array[String] = Fuzzy.suggest(key, existing, 5)
				return R.err(R.NOT_FOUND, ("export.preset_set: preset '%s' has no option '%s'.%s Godot writes every option of the platform to the file, so this is probably a typo. " +
					"Pass \"allow_new_keys\": true to add it anyway (e.g. for a hand-written preset); use export.presets {\"preset\": \"%s\"} to list options.") %
					[entry["name"], key, Fuzzy.did_you_mean(similar), entry["name"]], {"similar": similar})
		if is_secret(key) and not allow_secrets:
			return R.err(R.BAD_PARAMS, secret_err)
		var decoded: Dictionary = _decode_like(key, value, cfg.get_value(opt_section, key) if exists else null)
		if R.is_err(decoded):
			return decoded
		cfg.set_value(opt_section, key, decoded["value"])
		changed[label] = redact(key, decoded["value"])

	var save_err: int = cfg.save(PRESETS_PATH)
	if save_err != OK:
		return R.godot_err("Writing export_presets.cfg", save_err)
	var reloaded: bool = _reload_editor_presets(env)
	# Re-read the entry: a rename changed its name.
	var final_entry: Dictionary = _preset_sections(cfg)[int(entry["index"])]
	var result: Dictionary = {"preset": describe(cfg, final_entry, false), "changed": changed, "created": created, "saved": true}
	if bool(env.get("editor", false)):
		result["editor_reloaded"] = reloaded
	if created:
		result["note"] = "New preset written with the platform's default options (export.presets lists them). Set export_path before exporting."
	return R.ok(result)


## Adds a [preset.N] section with the defaults EditorExport writes for a new preset.
static func _create_preset(cfg: ConfigFile, presets: Array, create: Dictionary) -> Dictionary:
	var c := Params.new(create, "export.preset_set create")
	var name: String = c.req_string("name")
	var platform_raw: String = c.req_string("platform")
	if c.failed():
		return c.error
	var platform: String = str(PLATFORMS.get(platform_raw.strip_edges().to_lower(), ""))
	if platform.is_empty():
		var known: PackedStringArray = ["Linux", "Windows Desktop", "macOS", "Android", "iOS", "visionOS", "Web"]
		return R.err(R.BAD_PARAMS, "export.preset_set: unknown platform '%s'. Valid platforms: %s." % [platform_raw, ", ".join(known)])
	for e: Dictionary in presets:
		if e["name"] == name:
			return R.err(R.CONFLICT, "export.preset_set: a preset named '%s' already exists (index %d). Use {\"preset\": \"%s\", \"set\": {...}} to change it." % [name, e["index"], name])
	var index: int = presets.size()
	var section: String = "preset.%d" % index
	# Same keys and defaults as EditorExport::_save for a fresh EditorExportPreset.
	cfg.set_value(section, "name", name)
	cfg.set_value(section, "platform", platform)
	cfg.set_value(section, "dedicated_server", false)
	cfg.set_value(section, "custom_features", "")
	cfg.set_value(section, "export_filter", "all_resources")
	cfg.set_value(section, "include_filter", "")
	cfg.set_value(section, "exclude_filter", "")
	cfg.set_value(section, "export_path", "")
	cfg.set_value(section, "patches", PackedStringArray())
	cfg.set_value(section, "encryption_include_filters", "")
	cfg.set_value(section, "encryption_exclude_filters", "")
	cfg.set_value(section, "seed", 0)
	cfg.set_value(section, "encrypt_pck", false)
	cfg.set_value(section, "encrypt_directory", false)
	cfg.set_value(section, "script_export_mode", 2)
	# [preset.N.options] gets every option of the platform with its default value, which
	# is what the editor writes for a new preset (EditorExportPlatform::create_preset fills
	# values from get_export_options; EditorExport::_save writes them all). No script API
	# exposes a platform's options outside the editor, so they come from export_defaults.cfg,
	# generated from the editor by scripts/gen-export-defaults.sh. Without that file only the
	# custom template options (which every platform has) are written: ConfigFile cannot hold
	# an empty section, and Godot fills in the rest with defaults when it loads the preset.
	var defaults: ConfigFile = _platform_defaults()
	if defaults != null and defaults.has_section(platform):
		for key: String in defaults.get_section_keys(platform):
			cfg.set_value(section + ".options", key, defaults.get_value(platform, key))
	else:
		cfg.set_value(section + ".options", "custom_template/debug", "")
		cfg.set_value(section + ".options", "custom_template/release", "")
	var entry: Dictionary = {"index": index, "section": section, "name": name, "platform": platform}
	presets.append(entry)
	return R.value(entry)


## core/export_defaults.cfg: platform name -> every export option and its default (see
## scripts/gen-export-defaults.sh). Loaded on demand; null if the file is missing.
static func _platform_defaults() -> ConfigFile:
	var file: String = (R as Script).resource_path.get_base_dir().path_join("export_defaults.cfg")
	var cf := ConfigFile.new()
	if cf.load(file) != OK:
		return null
	return cf


## Sets a [preset.N] field, with the checks and side tables the editor applies.
static func _set_field(cfg: ConfigFile, entry: Dictionary, key: String, value: Variant) -> Dictionary:
	var section: String = entry["section"]
	match key:
		"name":
			if not value is String or (value as String).strip_edges().is_empty():
				return R.err(R.BAD_PARAMS, "export.preset_set: 'name' must be a non-empty string.")
			for e: Dictionary in _preset_sections(cfg):
				if e["name"] == value and e["index"] != entry["index"]:
					return R.err(R.CONFLICT, "export.preset_set: another preset is already named '%s'." % value)
			if cfg.has_section_key(RUNNABLE_SECTION, entry["platform"]) and str(cfg.get_value(RUNNABLE_SECTION, entry["platform"])) == entry["name"]:
				cfg.set_value(RUNNABLE_SECTION, entry["platform"], value)
			cfg.set_value(section, "name", value)
			return {}
		"runnable":
			if not value is bool:
				return R.err(R.BAD_PARAMS, "export.preset_set: 'runnable' must be true or false.")
			# 4.7 keeps one runnable preset per platform in [runnable_presets].
			if bool(value):
				cfg.set_value(RUNNABLE_SECTION, entry["platform"], entry["name"])
			elif cfg.has_section_key(RUNNABLE_SECTION, entry["platform"]) and str(cfg.get_value(RUNNABLE_SECTION, entry["platform"])) == entry["name"]:
				cfg.erase_section_key(RUNNABLE_SECTION, entry["platform"])
			if cfg.has_section_key(section, "runnable"):
				cfg.erase_section_key(section, "runnable")
			return {}
		"export_filter":
			if not value is String or not (value as String) in EXPORT_FILTERS:
				return R.err(R.BAD_PARAMS, "export.preset_set: 'export_filter' must be one of %s." % ", ".join(EXPORT_FILTERS))
	var current: Variant = cfg.get_value(section, key) if cfg.has_section_key(section, key) else _field_default(key)
	var decoded: Dictionary = _decode_like(key, value, current)
	if R.is_err(decoded):
		return decoded
	cfg.set_value(section, key, decoded["value"])
	return {}


## Type template for preset fields that may be absent from a file.
static func _field_default(key: String) -> Variant:
	match key:
		"dedicated_server", "encrypt_pck", "encrypt_directory", "patch_delta_encoding":
			return false
		"seed", "script_export_mode", "patch_delta_compression_level_zstd":
			return 0
		"patch_delta_min_reduction":
			return 0.0
		"patches", "export_files":
			return PackedStringArray()
		"customized_files":
			return {}
	return ""


## Decodes a JSON value to the type of the value currently stored (untyped if none).
static func _decode_like(key: String, value: Variant, current: Variant) -> Dictionary:
	var t: int = typeof(current) if current != null else TYPE_NIL
	var decoded: Dictionary = Codec.decode_typed(value, {"name": key, "type": t}, null)
	if R.is_err(decoded):
		var e: Dictionary = decoded["error"]
		e["message"] = "export.preset_set: " + str(e["message"])
	return decoded


## Makes the running editor re-read export_presets.cfg. EditorExport has no script API,
## but adding or removing an export platform sets its "reload presets" flag, and the next
## frame it clears its presets and calls load_config() (editor/export/editor_export.cpp).
## An EditorExportPlatformExtension without overrides has an empty name, so no preset
## binds to it. Returns true if the reload was requested.
static func _reload_editor_presets(env: Dictionary) -> bool:
	var plugin: Object = env.get("plugin")
	if not bool(env.get("editor", false)) or plugin == null or not ClassDB.class_exists("EditorExportPlatformExtension"):
		return false
	var dummy: Object = ClassDB.instantiate("EditorExportPlatformExtension")
	if dummy == null:
		return false
	plugin.call("add_export_platform", dummy)
	plugin.call("remove_export_platform", dummy)
	return true
