#!/usr/bin/env bash
# Copy the addon (source of truth: <repo>/addons/godot_mcp) into the sample project so
# Godot can load it. We copy instead of symlinking because symlinks are unreliable on
# Windows checkouts. The copy is git-ignored (see examples/sample_project/.gitignore).
#
# Usage: scripts/sync-addon.sh [target_project_dir]   (default: examples/sample_project)
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
target_project="${1:-$repo_root/examples/sample_project}"
src="$repo_root/addons/godot_mcp"
dst="$target_project/addons/godot_mcp"

if [[ ! -f "$src/plugin.cfg" ]]; then
	echo "sync-addon: $src/plugin.cfg not found; run from a full checkout." >&2
	exit 1
fi
if [[ ! -f "$target_project/project.godot" ]]; then
	echo "sync-addon: $target_project is not a Godot project (no project.godot)." >&2
	exit 1
fi

# Remove the old copy first so files deleted from the source don't linger.
rm -rf "$dst"
mkdir -p "$target_project/addons"
cp -R "$src" "$dst"
echo "sync-addon: copied $src -> $dst"
