#!/usr/bin/env node
// Builds the Godot Asset Store upload: dist-addon/godot_mcp-<version>.zip
//
// Usage (from anywhere; paths are resolved from this file's location):
//   node scripts/build-addon-zip.mjs            # writes dist-addon/godot_mcp-<version>.zip
//   node scripts/build-addon-zip.mjs --out DIR  # writes DIR/godot_mcp-<version>.zip instead
//   SOURCE_DATE_EPOCH=1767225600 node scripts/build-addon-zip.mjs   # reproducible timestamps
//
// Why this layout: the zip contains exactly one top-level folder, `addons/`, holding
// `addons/godot_mcp/...`. That is the "addons/asset_name/" structure the Asset Store
// guidelines require (https://store.godotengine.org/guidelines/). Godot's asset installer
// (editor/asset_library/editor_asset_installer.cpp) never strips a top-level folder named
// `addons/`, so the files land in res://addons/godot_mcp/ whether the user installs from
// the editor's Asset Store tab or with its "Import" button. Nothing is placed at the zip
// root, so the installer won't offer to drop a README or LICENSE into the user's res://.
//
// What goes in: every file under addons/godot_mcp/ (scripts, .uid files, plugin.cfg,
// LICENSE, README.md), minus OS junk the guidelines ask us to leave out (.DS_Store,
// Thumbs.db, __MACOSX) and anything else in SKIP below.
//
// Why a hand-written zip writer: Node (>= 22, already required by the server) has
// zlib.deflateRawSync and zlib.crc32 built in, so this runs the same on Windows, macOS and
// Linux without `zip`, Python or any npm dependency. It writes a plain ZIP (no ZIP64; the
// addon is far below 4 GB) with entries sorted by path, so the same input and the same
// SOURCE_DATE_EPOCH always give a byte-identical file.

import { readFileSync, readdirSync, statSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const addonDir = path.join(repoRoot, 'addons', 'godot_mcp');
// Path prefix of every entry inside the zip. Must stay "addons/godot_mcp/" (see header).
const zipPrefix = 'addons/godot_mcp/';

// File and folder names never shipped. The guidelines list .gitignore, .gitattributes,
// .github, Thumbs.db, .DS_Store and __MACOSX; .godot/ and *.import would only appear if
// someone opened the addon folder itself as a project by mistake.
const SKIP_NAMES = new Set(['.DS_Store', 'Thumbs.db', 'desktop.ini', '__MACOSX', '.git', '.github', '.gitignore', '.gitattributes', '.godot']);
const SKIP_SUFFIXES = ['.import', '.tmp', '~', '.orig', '.rej'];

// --- command line ----------------------------------------------------------------------
const args = process.argv.slice(2);
let outDir = path.join(repoRoot, 'dist-addon');
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--out' && args[i + 1]) outDir = path.resolve(args[++i]);
  else if (args[i] === '-h' || args[i] === '--help') {
    console.log('Usage: node scripts/build-addon-zip.mjs [--out DIR]');
    process.exit(0);
  } else {
    console.error(`build-addon-zip: unknown argument '${args[i]}' (try --help)`);
    process.exit(2);
  }
}

// --- version from plugin.cfg -----------------------------------------------------------
// plugin.cfg is the single source of truth for the addon version (core/constants.gd and
// the server's package.json are checked against it by the test suites).
const cfgPath = path.join(addonDir, 'plugin.cfg');
let cfg;
try {
  cfg = readFileSync(cfgPath, 'utf8');
} catch {
  console.error(`build-addon-zip: ${cfgPath} not found; run from a full checkout.`);
  process.exit(1);
}
const version = /^version="([^"]+)"/m.exec(cfg)?.[1];
if (!version || !/^[0-9A-Za-z.+-]+$/.test(version)) {
  console.error(`build-addon-zip: no usable version="..." line in ${cfgPath}`);
  process.exit(1);
}
// Guard against shipping a zip whose files disagree on the version.
const constants = readFileSync(path.join(addonDir, 'core', 'constants.gd'), 'utf8');
const constVersion = /PLUGIN_VERSION: String = "([^"]+)"/.exec(constants)?.[1];
if (constVersion !== version) {
  console.error(`build-addon-zip: plugin.cfg version ${version} != core/constants.gd PLUGIN_VERSION ${constVersion}`);
  process.exit(1);
}
for (const required of ['plugin.gd', 'LICENSE', 'README.md']) {
  try {
    statSync(path.join(addonDir, required));
  } catch {
    console.error(`build-addon-zip: addons/godot_mcp/${required} is missing (the store wants the license inside the addon).`);
    process.exit(1);
  }
}

// --- collect files ---------------------------------------------------------------------
/** Returns zip entries ({name, data|null}) for `dir`, folders first so each folder entry
 *  precedes its contents. Folder entries (name ending in "/") have data = null. */
function collect(dir, rel) {
  const entries = [];
  const names = readdirSync(dir).sort();
  for (const name of names) {
    if (SKIP_NAMES.has(name) || SKIP_SUFFIXES.some((s) => name.endsWith(s))) continue;
    const abs = path.join(dir, name);
    const st = statSync(abs);
    const relName = rel + name; // always "/"-separated inside the zip, also on Windows
    if (st.isDirectory()) {
      entries.push({ name: relName + '/', data: null });
      entries.push(...collect(abs, relName + '/'));
    } else if (st.isFile()) {
      entries.push({ name: relName, data: readFileSync(abs) });
    }
  }
  return entries;
}
// The two parent folder entries come first: Godot's installer looks at the first entry to
// detect a shared top-level folder, and explicit folder entries keep that check simple.
const entries = [
  { name: 'addons/', data: null },
  { name: zipPrefix, data: null },
  ...collect(addonDir, zipPrefix),
];

// --- write the zip ---------------------------------------------------------------------
// MS-DOS date/time used by the ZIP format (local time fields, 2-second resolution).
const epoch = process.env.SOURCE_DATE_EPOCH ? Number(process.env.SOURCE_DATE_EPOCH) * 1000 : Date.now();
const when = new Date(Math.max(epoch, Date.UTC(1980, 0, 1)));
const dosTime = (when.getUTCHours() << 11) | (when.getUTCMinutes() << 5) | Math.floor(when.getUTCSeconds() / 2);
const dosDate = ((when.getUTCFullYear() - 1980) << 9) | ((when.getUTCMonth() + 1) << 5) | when.getUTCDate();

const chunks = []; // local headers + data, in order
const central = []; // central directory records
let offset = 0;
for (const e of entries) {
  const nameBuf = Buffer.from(e.name, 'utf8');
  const isDir = e.data === null;
  const raw = isDir ? Buffer.alloc(0) : e.data;
  // Deflate unless it doesn't help (tiny files); method 0 = stored, 8 = deflate.
  let method = 0;
  let body = raw;
  if (!isDir && raw.length > 0) {
    const deflated = zlib.deflateRawSync(raw, { level: 9 });
    if (deflated.length < raw.length) {
      method = 8;
      body = deflated;
    }
  }
  const crc = isDir ? 0 : zlib.crc32(raw);
  // General purpose flag bit 11 = file names are UTF-8.
  const flags = 0x0800;

  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0); // local file header signature
  local.writeUInt16LE(20, 4); // version needed to extract (2.0)
  local.writeUInt16LE(flags, 6);
  local.writeUInt16LE(method, 8);
  local.writeUInt16LE(dosTime, 10);
  local.writeUInt16LE(dosDate, 12);
  local.writeUInt32LE(crc >>> 0, 14);
  local.writeUInt32LE(body.length, 18); // compressed size
  local.writeUInt32LE(raw.length, 22); // uncompressed size
  local.writeUInt16LE(nameBuf.length, 26);
  local.writeUInt16LE(0, 28); // extra field length
  chunks.push(local, nameBuf, body);

  const cen = Buffer.alloc(46);
  cen.writeUInt32LE(0x02014b50, 0); // central directory header signature
  cen.writeUInt16LE((3 << 8) | 20, 4); // made by: Unix (3), spec 2.0, so permissions below apply
  cen.writeUInt16LE(20, 6); // version needed to extract
  cen.writeUInt16LE(flags, 8);
  cen.writeUInt16LE(method, 10);
  cen.writeUInt16LE(dosTime, 12);
  cen.writeUInt16LE(dosDate, 14);
  cen.writeUInt32LE(crc >>> 0, 16);
  cen.writeUInt32LE(body.length, 20);
  cen.writeUInt32LE(raw.length, 24);
  cen.writeUInt16LE(nameBuf.length, 28);
  cen.writeUInt16LE(0, 30); // extra field length
  cen.writeUInt16LE(0, 32); // comment length
  cen.writeUInt16LE(0, 34); // disk number start
  cen.writeUInt16LE(0, 36); // internal attributes
  // External attributes: Unix mode in the high 16 bits (drwxr-xr-x / -rw-r--r--), plus the
  // MS-DOS directory bit (0x10) for folders so Windows tools recognise them too.
  const mode = isDir ? 0o40755 : 0o100644;
  cen.writeUInt32LE(((mode << 16) | (isDir ? 0x10 : 0)) >>> 0, 38);
  cen.writeUInt32LE(offset, 42); // offset of the local header
  central.push(cen, nameBuf);

  offset += local.length + nameBuf.length + body.length;
}
const centralSize = central.reduce((n, b) => n + b.length, 0);
const end = Buffer.alloc(22);
end.writeUInt32LE(0x06054b50, 0); // end of central directory signature
end.writeUInt16LE(0, 4); // this disk
end.writeUInt16LE(0, 6); // disk with the central directory
end.writeUInt16LE(entries.length, 8); // entries on this disk
end.writeUInt16LE(entries.length, 10); // total entries
end.writeUInt32LE(centralSize, 12);
end.writeUInt32LE(offset, 16); // central directory offset
end.writeUInt16LE(0, 20); // comment length

mkdirSync(outDir, { recursive: true });
const outFile = path.join(outDir, `godot_mcp-${version}.zip`);
const zip = Buffer.concat([...chunks, ...central, end]);
writeFileSync(outFile, zip);

const fileCount = entries.filter((e) => e.data !== null).length;
const rawBytes = entries.reduce((n, e) => n + (e.data ? e.data.length : 0), 0);
console.log(`build-addon-zip: wrote ${path.relative(process.cwd(), outFile) || outFile}`);
console.log(`  version ${version}, ${fileCount} files (${(rawBytes / 1024).toFixed(1)} KiB unpacked), zip ${(zip.length / 1024).toFixed(1)} KiB`);
