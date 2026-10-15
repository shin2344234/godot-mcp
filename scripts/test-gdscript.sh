#!/usr/bin/env bash
# Test-suite for the GDScript side (addons/godot_mcp):
#   1. sync the addon into examples/sample_project and import the project once,
#   2. lint: compile every addon script with Godot's default warnings promoted to errors,
#   3. headless runner: every (E/H) method on a temp copy (scripts/headless-smoke.mjs),
#   4. editor bridge end-to-end: start a headless editor on a temp copy, wait for
#      session.json, drive it over WebSocket (scripts/ws-smoke.mjs), then stop it.
#
# Requirements: bash, node >= 22 (built-in WebSocket), a Godot 4.7 editor binary.
# Usage: GODOT=/path/to/godot scripts/test-gdscript.sh     (default: `godot` on PATH)
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
sample="$repo_root/examples/sample_project"
GODOT="${GODOT:-godot}"

if ! command -v "$GODOT" >/dev/null 2>&1; then
	echo "test-gdscript: Godot binary '$GODOT' not found; set GODOT=/path/to/godot" >&2
	exit 2
fi
if ! command -v node >/dev/null 2>&1; then
	echo "test-gdscript: node (>= 22) is required" >&2
	exit 2
fi

work="$(mktemp -d "${TMPDIR:-/tmp}/godot-mcp-test.XXXXXX")"
editor_pid=""
cleanup() {
	if [[ -n "$editor_pid" ]] && kill -0 "$editor_pid" 2>/dev/null; then
		kill "$editor_pid" 2>/dev/null || true
		wait "$editor_pid" 2>/dev/null || true
	fi
	rm -rf "$work"
}
trap cleanup EXIT

section() { printf '\n== %s ==\n' "$1"; }

section "sync addon + import sample project"
"$repo_root/scripts/sync-addon.sh"
# The first import creates .godot/ (class cache, imported textures, uid cache); the temp
# copies below reuse it so each test starts fast.
"$GODOT" --headless --path "$sample" --import >"$work/import.log" 2>&1 || {
	cat "$work/import.log"
	echo "test-gdscript: import failed" >&2
	exit 1
}
echo "imported $sample"

section "lint (default GDScript warnings treated as errors)"
lint="$work/lint"
cp -R "$sample" "$lint"
# Promote every warning that is enabled by default ("warn" = 1) to "error" = 2 and
# include res://addons (excluded from warnings by default), then compile every addon
# script with the addon's own validator.
cat >"$lint/list_warnings.gd" <<'EOF'
extends SceneTree
func _initialize() -> void:
	var names: PackedStringArray = []
	for p: Dictionary in ProjectSettings.get_property_list():
		var n: String = p["name"]
		var v: Variant = ProjectSettings.get_setting(n)
		if n.begins_with("debug/gdscript/warnings/") and v is int and int(v) == 1:
			names.append(n.trim_prefix("debug/"))
	print("WARNINGS=" + ",".join(names))
	quit()
EOF
warnings="$("$GODOT" --headless --path "$lint" --script res://list_warnings.gd 2>/dev/null | sed -n 's/^WARNINGS=//p')"
{
	echo
	echo "[debug]"
	echo
	echo 'gdscript/warnings/directory_rules={"res://addons": 1}'
	IFS=',' read -ra names <<<"$warnings"
	for n in "${names[@]}"; do echo "$n=2"; done
} >>"$lint/project.godot"
cat >"$lint/lint.gd" <<'EOF'
extends SceneTree
const Validate := preload("res://addons/godot_mcp/core/script_validate.gd")
func _initialize() -> void:
	var files: PackedStringArray = []
	_walk("res://addons/godot_mcp", files)
	var bad: int = 0
	for f: String in files:
		var r: Dictionary = Validate.validate_source(FileAccess.get_file_as_string(f), f)
		if not r["valid"]:
			bad += 1
			for e: Dictionary in r["errors"]:
				print("LINT %s:%d: %s" % [e.get("file", f), e["line"], e["message"]])
	print("LINT_RESULT files=%d failing=%d" % [files.size(), bad])
	quit(1 if bad > 0 else 0)
func _walk(dir: String, out: PackedStringArray) -> void:
	for f: String in DirAccess.get_files_at(dir):
		if f.ends_with(".gd"):
			out.append(dir.path_join(f))
	for d: String in DirAccess.get_directories_at(dir):
		_walk(dir.path_join(d), out)
EOF
if ! "$GODOT" --headless --path "$lint" --script res://lint.gd >"$work/lint.log" 2>&1; then
	grep -E '^LINT' "$work/lint.log" || cat "$work/lint.log"
	echo "test-gdscript: lint failed" >&2
	exit 1
fi
grep -E '^LINT_RESULT' "$work/lint.log"

section "headless runner"
cp -R "$sample" "$work/headless"
node "$repo_root/scripts/headless-smoke.mjs" "$GODOT" "$work/headless"

section "editor bridge (headless editor + WebSocket)"
proj="$work/editor"
cp -R "$sample" "$proj"
rm -f "$proj/.godot/godot_mcp/session.json"
"$GODOT" --headless --editor --path "$proj" >"$work/editor.log" 2>&1 </dev/null &
editor_pid=$!
session="$proj/.godot/godot_mcp/session.json"
for _ in $(seq 1 120); do
	[[ -f "$session" ]] && break
	if ! kill -0 "$editor_pid" 2>/dev/null; then
		cat "$work/editor.log"
		echo "test-gdscript: editor exited before writing session.json" >&2
		exit 1
	fi
	sleep 0.5
done
if [[ ! -f "$session" ]]; then
	cat "$work/editor.log"
	echo "test-gdscript: timed out waiting for $session" >&2
	exit 1
fi
echo "session file written by editor pid $editor_pid"
# Security check: the bridge must only listen on loopback.
port="$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).port)' "$session")"
if command -v ss >/dev/null 2>&1; then
	listeners="$(ss -ltnH "sport = :$port" | awk '{print $4}')"
	echo "listeners on port $port: $listeners"
	if grep -qv '^127\.0\.0\.1:' <<<"$listeners"; then
		echo "test-gdscript: bridge listens on a non-loopback address" >&2
		exit 1
	fi
fi
smoke_status=0
node "$repo_root/scripts/ws-smoke.mjs" "$proj" || smoke_status=$?
kill "$editor_pid" 2>/dev/null || true
wait "$editor_pid" 2>/dev/null || true
editor_pid=""
# Runtime script errors raised by the addon inside the editor are bugs even if the smoke
# test passed. (Compile errors reported by script.validate are expected; their "at:" line
# names GDScript::reload and the validated file, not an addon function.)
if grep -A1 'SCRIPT ERROR' "$work/editor.log" | grep -qE '^ *at: .*\(res://addons/godot_mcp/'; then
	grep -A3 'SCRIPT ERROR' "$work/editor.log"
	echo "test-gdscript: the addon raised script errors in the editor" >&2
	exit 1
fi
if [[ $smoke_status -ne 0 ]]; then
	echo "--- editor log ---"
	cat "$work/editor.log"
	exit "$smoke_status"
fi

section "all GDScript tests passed"
