/**
 * file:// URI <-> path conversion for the GDScript language server.
 *
 * The Godot LSP only accepts `file:` URIs (res:// is rejected) and only local ones (empty
 * host or "localhost"). We produce URIs exactly the way Godot itself does in
 * GDScriptWorkspace::get_file_uri (4.7.2):
 *
 *     "file:///" + each path segment run through String::uri_encode(), joined by "/"
 *
 * uri_encode keeps `A-Z a-z 0-9 _ . - ~` and percent-encodes every other UTF-8 byte with
 * UPPERCASE hex. Uppercase matters: Godot's uri_file_decode() only decodes `%XX` when both
 * hex digits are digits or uppercase letters, so `%3a` would arrive undecoded. On Windows
 * the drive colon is encoded too (`file:///C%3A/Users/...`), matching what Godot emits.
 *
 * Decoding accepts both Godot's form and the common `file:///C:/...` form, and maps URIs
 * back to project-relative paths so tool results can show `res://` paths. The `platform`
 * parameter exists so the Windows behaviour can be unit-tested on any OS.
 */

import path from 'node:path';

type Platform = NodeJS.Platform;

/** Godot's String::uri_encode for one path segment. */
export function godotUriEncode(segment: string): string {
  let out = '';
  for (const byte of Buffer.from(segment, 'utf8')) {
    const c = String.fromCharCode(byte);
    if (/[A-Za-z0-9_.~-]/.test(c)) out += c;
    else out += '%' + byte.toString(16).toUpperCase().padStart(2, '0');
  }
  return out;
}

/** Absolute OS path -> file URI in Godot's own format. */
export function pathToFileUri(absPath: string, platform: Platform = process.platform): string {
  let p = absPath;
  if (platform === 'win32') p = p.replace(/\\/g, '/');
  p = p.replace(/^\/+/, '');
  return 'file:///' + p.split('/').map(godotUriEncode).join('/');
}

export class UriError extends Error {}

/** file URI -> absolute OS path. Throws UriError for non-file or non-local URIs. */
export function fileUriToPath(uri: string, platform: Platform = process.platform): string {
  const m = /^file:\/\/([^/]*)(\/.*)?$/i.exec(uri);
  if (!m) throw new UriError(`Not a file:// URI: ${uri}`);
  const host = (m[1] ?? '').toLowerCase();
  if (host !== '' && host !== 'localhost') throw new UriError(`Non-local file URI: ${uri}`);
  let p: string;
  try {
    p = decodeURIComponent(m[2] ?? '/');
  } catch {
    throw new UriError(`Malformed percent-encoding in URI: ${uri}`);
  }
  if (platform === 'win32') {
    // "/C:/Users/x" -> "C:\Users\x"
    if (/^\/[A-Za-z]:(\/|$)/.test(p)) p = p.slice(1);
    return p.replace(/\//g, '\\');
  }
  return p;
}

/**
 * Map a file URI to a project-relative path ("scenes/a.gd"), or undefined when it lies
 * outside every given project root. Several roots are accepted because the editor may
 * know the project under a different spelling than our config (symlinks, macOS
 * /var -> /private/var, Windows drive-letter case).
 */
export function uriToProjectRel(uri: string, roots: string[], platform: Platform = process.platform): string | undefined {
  let abs: string;
  try {
    abs = fileUriToPath(uri, platform);
  } catch {
    return undefined;
  }
  const p = platform === 'win32' ? path.win32 : path.posix;
  const fold = (s: string) => (platform === 'win32' ? s.toLowerCase() : s);
  const absNorm = p.normalize(abs);
  for (const root of roots) {
    const rootNorm = p.normalize(root).replace(/[\\/]+$/, '');
    const rel = p.relative(fold(rootNorm), fold(absNorm));
    if (rel === '' || rel.startsWith('..') || p.isAbsolute(rel)) continue;
    // Take the relative part from the original (un-folded) path to keep the file's case.
    const relOriginal = absNorm.slice(absNorm.length - rel.length);
    return relOriginal.split(p.sep).join('/');
  }
  return undefined;
}
