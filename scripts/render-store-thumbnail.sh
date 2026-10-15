#!/usr/bin/env bash
# Renders the Godot Asset Store listing thumbnail:
#   docs/asset-store/thumbnail.svg  ->  docs/asset-store/thumbnail.png  (1280x720, 16:9)
#
# The store requires the thumbnail to be 16:9 (https://store.godotengine.org/guidelines/);
# it does not publish a pixel size, so we use 1280x720, which stays sharp when scaled down
# on the store's asset grid. The SVG is the source of truth: edit it, then re-run this.
#
# Needs one SVG renderer: rsvg-convert (librsvg), Inkscape or ImageMagick (`magick`/`convert`).
# Usage: scripts/render-store-thumbnail.sh
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
src="$repo_root/docs/asset-store/thumbnail.svg"
dst="$repo_root/docs/asset-store/thumbnail.png"
w=1280
h=720

if command -v rsvg-convert >/dev/null 2>&1; then
	rsvg-convert -w "$w" -h "$h" -o "$dst" "$src"
elif command -v inkscape >/dev/null 2>&1; then
	inkscape "$src" --export-type=png --export-filename="$dst" -w "$w" -h "$h"
elif command -v python3 >/dev/null 2>&1 && python3 -c 'import cairosvg' 2>/dev/null; then
	# `pip install cairosvg`; this is what rendered the committed PNG.
	python3 -c 'import sys, cairosvg; cairosvg.svg2png(url=sys.argv[1], write_to=sys.argv[2], output_width=int(sys.argv[3]), output_height=int(sys.argv[4]))' \
		"$src" "$dst" "$w" "$h"
elif command -v magick >/dev/null 2>&1; then
	# ImageMagick often hands SVG to rsvg-convert anyway, so this may fail without librsvg.
	magick -background none -density 96 "$src" -resize "${w}x${h}!" "$dst"
else
	echo "render-store-thumbnail: install rsvg-convert (librsvg), inkscape, cairosvg (pip) or ImageMagick 7" >&2
	exit 2
fi
echo "render-store-thumbnail: wrote $dst (${w}x${h})"
