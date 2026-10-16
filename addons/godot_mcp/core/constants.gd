@tool
extends RefCounted
## Shared constants for the Godot MCP addon (editor bridge, headless runner and core).
##
## Everything here is static so any script can `preload()` this file and read the values
## without instantiating anything. We deliberately avoid `class_name` throughout the addon:
## global class names pollute the user's project namespace and are only registered after
## an editor import, which would break the headless runner on a fresh checkout.

## Version of the wire protocol described in docs/bridge-protocol.md. Bump on breaking changes.
const PROTOCOL_VERSION: int = 1

## Must match plugin.cfg's `version`. Reported in the session file, `welcome` and `editor.status`.
const PLUGIN_VERSION: String = "0.1.2"

## Project setting holding the preferred bridge port, and its default.
const PORT_SETTING: String = "godot_mcp/bridge/port"
const DEFAULT_PORT: int = 6520
## If the preferred port is busy we try this many following ports.
const PORT_FALLBACK_COUNT: int = 10

## The session file is written under `.godot/` because Godot's default .gitignore already
## excludes that folder, so the secret token never ends up in version control.
const SESSION_DIR: String = "res://.godot/godot_mcp"
const SESSION_FILE: String = "res://.godot/godot_mcp/session.json"

## Prefix of the single result line printed by the headless runner.
const RESULT_MARKER: String = "@@GODOT_MCP_RESULT@@"


## Returns the Godot version in the same format as `godot --version`, e.g.
## "4.7.2.stable.official.ed1daf0bf". The server compares this string against the
## binary it launches for headless runs, so the formats must match exactly.
static func godot_version_string() -> String:
	var info: Dictionary = Engine.get_version_info()
	var parts: PackedStringArray = [str(info.get("major", 0)), str(info.get("minor", 0))]
	# `godot --version` omits the patch component when it is zero (e.g. "4.7.stable...").
	if int(info.get("patch", 0)) > 0:
		parts.append(str(info.get("patch", 0)))
	parts.append(str(info.get("status", "")))
	parts.append(str(info.get("build", "")))
	var hash_str: String = str(info.get("hash", ""))
	if not hash_str.is_empty():
		parts.append(hash_str.left(9))
	return ".".join(parts)


## Absolute filesystem path of the project folder, without a trailing slash.
static func project_path() -> String:
	var p: String = ProjectSettings.globalize_path("res://")
	if p.length() > 1 and p.ends_with("/"):
		p = p.left(p.length() - 1)
	return p


static func project_name() -> String:
	return str(ProjectSettings.get_setting("application/config/name", ""))


## Current UTC time as an ISO-8601 string with a trailing "Z" (e.g. "2026-10-14T23:59:59Z").
static func utc_now_iso() -> String:
	return Time.get_datetime_string_from_system(true) + "Z"
