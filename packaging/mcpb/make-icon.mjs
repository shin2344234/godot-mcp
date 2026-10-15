#!/usr/bin/env node
/**
 * Draws packaging/mcpb/icon.png, the icon Claude Desktop shows for the .mcpb bundle.
 *
 *   node packaging/mcpb/make-icon.mjs
 *
 * The PNG is committed, so this only needs re-running when the design changes.
 * It has no dependencies on purpose: the shapes are signed-distance functions,
 * rendered with 4x4 supersampling for anti-aliasing, and the PNG is encoded by
 * hand with node:zlib (a PNG is just a signature, an IHDR chunk, zlib-compressed
 * scanlines in IDAT chunks, and IEND).
 *
 * Size: 512x512 RGBA. The Claude docs recommend 512x512 (256x256 minimum) PNG with
 * transparency (https://claude.com/docs/connectors/building/mcpb#add-an-icon), and
 * `mcpb validate` prints the same 512x512 recommendation.
 *
 * Design: a blue rounded square (a generic "game engine blue", not any project's
 * logo) with a white power plug, i.e. "a connector for your game project".
 */

import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';

const SIZE = 512;
const SUPERSAMPLE = 4; // 4x4 samples per pixel

const BLUE = [0x47, 0x8c, 0xbf];
const DARK_BLUE = [0x2f, 0x6a, 0x99];
const WHITE = [0xff, 0xff, 0xff];

/** Signed distance from (px, py) to a rounded rectangle (negative = inside). */
function roundedRect(px, py, x0, y0, x1, y1, r) {
  const cx = (x0 + x1) / 2;
  const cy = (y0 + y1) / 2;
  const hx = (x1 - x0) / 2 - r;
  const hy = (y1 - y0) / 2 - r;
  const dx = Math.abs(px - cx) - hx;
  const dy = Math.abs(py - cy) - hy;
  const outside = Math.hypot(Math.max(dx, 0), Math.max(dy, 0));
  const inside = Math.min(Math.max(dx, dy), 0);
  return outside + inside - r;
}

/**
 * Colour of one sample point, or null where the icon is transparent.
 * Later shapes paint over earlier ones.
 */
function sample(x, y) {
  let color = null;
  // Background tile with a slightly darker lower band for a bit of depth.
  if (roundedRect(x, y, 24, 24, 488, 488, 104) <= 0) color = y > 380 ? DARK_BLUE : BLUE;
  // Plug: two prongs, the body, and the cable.
  const plug =
    roundedRect(x, y, 196, 104, 232, 214, 14) <= 0 || // left prong
    roundedRect(x, y, 280, 104, 316, 214, 14) <= 0 || // right prong
    roundedRect(x, y, 156, 196, 356, 316, 40) <= 0 || // body
    roundedRect(x, y, 226, 300, 286, 360, 12) <= 0 || // neck
    roundedRect(x, y, 240, 340, 272, 432, 16) <= 0; // cable
  if (plug && color) color = WHITE;
  return color;
}

/** Render to raw RGBA bytes, averaging SUPERSAMPLE^2 samples per pixel. */
function render() {
  const rgba = Buffer.alloc(SIZE * SIZE * 4);
  const n = SUPERSAMPLE * SUPERSAMPLE;
  for (let py = 0; py < SIZE; py++) {
    for (let px = 0; px < SIZE; px++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < SUPERSAMPLE; sy++) {
        for (let sx = 0; sx < SUPERSAMPLE; sx++) {
          const c = sample(px + (sx + 0.5) / SUPERSAMPLE, py + (sy + 0.5) / SUPERSAMPLE);
          if (!c) continue;
          // Average the colour of covered samples only; coverage becomes alpha, so
          // edges against transparency stay clean (no dark fringe).
          r += c[0]; g += c[1]; b += c[2]; a += 1;
        }
      }
      const o = (py * SIZE + px) * 4;
      if (a > 0) {
        rgba[o] = Math.round(r / a);
        rgba[o + 1] = Math.round(g / a);
        rgba[o + 2] = Math.round(b / a);
        rgba[o + 3] = Math.round((a / n) * 255);
      }
    }
  }
  return rgba;
}

// --- Minimal PNG encoder ----------------------------------------------------

/** CRC-32 as used by PNG chunks (polynomial 0xEDB88320). */
const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** One PNG chunk: length, type, data, CRC(type + data). */
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const typeAndData = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typeAndData));
  return Buffer.concat([len, typeAndData, crc]);
}

function encodePng(rgba, width, height) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  ihdr[10] = 0; // compression: deflate
  ihdr[11] = 0; // filter method
  ihdr[12] = 0; // no interlace
  // Each scanline is prefixed with a filter-type byte (0 = None).
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), // PNG signature
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const out = path.join(path.dirname(fileURLToPath(import.meta.url)), 'icon.png');
writeFileSync(out, encodePng(render(), SIZE, SIZE));
console.error(`wrote ${out}`);
