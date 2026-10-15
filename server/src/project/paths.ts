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
