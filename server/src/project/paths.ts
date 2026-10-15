/**
 * Path handling and sandboxing.
 *
 * Every file path an agent gives us is resolved INSIDE the Godot project and
 * nowhere else. Agents may pass `res://player.gd`, `player.gd`, or
 * `./scenes/main.tscn`; all of them map to the same project-relative file.
 * Absolute paths, `..` escapes, and symlinks that point outside the project
 * are rejected, so a confused (or prompt-injected) model can't read
 * ~/.ssh or overwrite system files through this server.
 */

import { realpath } from 'node:fs/promises';
import path from 'node:path';

export class PathError extends Error {}

/** A path that has been checked to live inside the project. */
export interface ProjectPath {
  /** Absolute OS path. */
  abs: string;
  /** Godot-style path, e.g. `res://scenes/main.tscn` (always forward slashes). */
  res: string;
  /** Project-relative path with forward slashes, e.g. `scenes/main.tscn` ("" for the root). */
  rel: string;
}

/**
 * Files no tool may read, search, write or list the contents of, whatever the
 * path spelling: secrets Godot or this project keep inside the project folder.
 *   - export_credentials.cfg: export passwords/keystore secrets (Godot keeps them
 *     out of export_presets.cfg precisely so they're never shared);
 *   - godot_mcp/session.json, lsp_session.json: the editor bridge's per-session
 *     token. Anyone holding it can drive the editor.
 * Compared case-insensitively (Windows and macOS file systems usually are).
 */
const SECRET_FILES = ['.godot/export_credentials.cfg', '.godot/godot_mcp/session.json', '.godot/godot_mcp/lsp_session.json'];

/** True when a project-relative path ("a/b.cfg", forward slashes) is one of SECRET_FILES. */
export function isSecretPath(rel: string): boolean {
  const r = rel.replace(/\\/g, '/').toLowerCase();
  return SECRET_FILES.includes(r);
}

function secretError(input: string): PathError {
  return new PathError(`"${input}" holds secrets (export credentials or the editor bridge token) and can't be accessed through the MCP tools.`);
}

/**
 * Resolve an agent-supplied path against the project root.
 * Does NOT require the file to exist (callers creating files need that).
 */
export function resolveProjectPath(projectRoot: string, input: string): ProjectPath {
  let p = input.trim();
  if (p === '') p = 'res://';

  if (p.startsWith('user://')) {
    throw new PathError(
      `user:// paths point at the per-user app data folder, outside the project, and aren't supported here. Use a res:// path.`,
    );
  }
  if (p.startsWith('res://')) p = p.slice('res://'.length);

  // Treat backslashes as separators so Windows-style input works everywhere.
  p = p.replace(/\\/g, '/');

  if (path.isAbsolute(p) || /^[A-Za-z]:\//.test(p)) {
    throw new PathError(`Absolute paths are not allowed: "${input}". Use a res:// path relative to the project root.`);
  }

  const abs = path.resolve(projectRoot, p);
  const relOs = path.relative(projectRoot, abs);
  if (relOs.startsWith('..') || path.isAbsolute(relOs)) {
    throw new PathError(`Path "${input}" escapes the project folder. Use a res:// path inside the project.`);
  }

  const rel = relOs.split(path.sep).join('/');
  if (isSecretPath(rel)) throw secretError(input);
  return { abs, rel, res: `res://${rel}` };
}

/**
 * Like resolveProjectPath, but also follows symlinks of the existing part of
 * the path and re-checks containment. Use before reading or writing.
 */
export async function resolveProjectPathStrict(projectRoot: string, input: string): Promise<ProjectPath> {
  const resolved = resolveProjectPath(projectRoot, input);
  const rootReal = await realpath(projectRoot);

  // Walk up until we find a part of the path that exists, then realpath it.
  let probe = resolved.abs;
  for (;;) {
    try {
      const real = await realpath(probe);
      const rel = path.relative(rootReal, real);
      if (rel.startsWith('..') || path.isAbsolute(rel)) {
        throw new PathError(`Path "${input}" resolves (through a symlink) outside the project folder.`);
      }
      // A symlink elsewhere in the project pointing at a secret file is refused too.
      if (probe === resolved.abs && isSecretPath(rel.split(path.sep).join('/'))) throw secretError(input);
      break;
    } catch (err) {
      if (err instanceof PathError) throw err;
      const parent = path.dirname(probe);
      if (parent === probe) break;
      probe = parent;
    }
  }
  return resolved;
}

/** True for files inside Godot's generated cache folder (`.godot/`). */
export function isInGodotCache(p: ProjectPath): boolean {
  return p.rel === '.godot' || p.rel.startsWith('.godot/');
}
