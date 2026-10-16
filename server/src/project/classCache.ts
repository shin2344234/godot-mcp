/**
 * Is Godot's global script class cache behind the scripts on disk?
 *
 * Global classes (`class_name Foo`) are not discovered by a plain
 * `godot --headless --script` run: ScriptServer loads them from
 * `res://.godot/global_script_class_cache.cfg` at startup, and only the
 * editor's EditorFileSystem rewrites that file (EditorFileSystem::
 * _update_script_classes -> ScriptServer::save_global_classes, Godot 4.7.2
 * editor/file_system/editor_file_system.cpp). So a script written by
 * files.write a moment ago is unknown to headless operations
 * ("Unknown Resource class 'FloorTileLibrary'", MCP_TEST_LOG Phase A) until
 * something runs the editor's scan, e.g. `godot --headless --import`.
 *
 * This module compares the cache with the `class_name` lines of the
 * project's .gd files, cheaply (file contents are cached by mtime and size),
 * so the headless runner can refresh the cache only when it is really stale.
 */

import { existsSync } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';

export interface ScriptClass {
  /** The global class name. */
  name: string;
  /** res:// path of the script. */
  path: string;
  /** What the script extends when it names a class (`extends Node2D` / `extends Foo`); undefined for `extends "res://..."` or none. */
  base?: string;
  /** A cache entry whose script no longer exists at `path` (moved or deleted). */
  gone?: true;
}

/** Parse global_script_class_cache.cfg (a ConfigFile with `list=[{...}, ...]`). */
export function parseClassCache(text: string): ScriptClass[] {
  const out: ScriptClass[] = [];
  // Each entry is one `{ ... }` dictionary; values are StringNames (&"x") or strings.
  for (const m of text.matchAll(/\{([^{}]*)\}/g)) {
    const body = m[1]!;
    const field = (key: string) => body.match(new RegExp(`"${key}":\\s*&?"([^"]*)"`))?.[1];
    const name = field('class');
    const p = field('path');
    if (name && p) out.push({ name, path: p, base: field('base') || undefined });
  }
  return out;
}

// Optional annotations before the keyword, e.g. `@tool class_name Foo` or `@abstract class_name Foo`.
const ANNOTATIONS = String.raw`(?:@\w+(?:\([^)\n]*\))?\s+)*`;
const CLASS_NAME_RE = new RegExp(String.raw`^${ANNOTATIONS}class_name\s+([A-Za-z_]\w*)`, 'm');
// `extends Foo` on its own line or after `class_name X` on the same line (GDScript 2.0 allows both).
const EXTENDS_RE = new RegExp(String.raw`^${ANNOTATIONS}(?:class_name\s+\w+\s+)?extends\s+([A-Za-z_][\w.]*|"[^"]*"|'[^']*')`, 'm');

/** Read `class_name` (and an identifier `extends`) from GDScript source. */
export function parseScriptClass(source: string): { name: string; base?: string } | undefined {
  const name = source.match(CLASS_NAME_RE)?.[1];
  if (!name) return undefined;
  const ext = source.match(EXTENDS_RE)?.[1];
  // A path (`extends "res://x.gd"`) makes the cache store the native base; we can't know it here.
  const base = ext && !/^["']/.test(ext) ? ext : undefined;
  return { name, base };
}

interface CachedFile {
  mtimeMs: number;
  size: number;
  cls: { name: string; base?: string } | undefined;
}

/** Project .gd files: skips hidden folders (.godot, .git, ...) and folders with a .gdignore, like Godot does. */
async function listScripts(root: string, dir = root, out: string[] = []): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  if (dir !== root && entries.some((e) => e.name === '.gdignore')) return out;
  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) await listScripts(root, full, out);
    else if (e.isFile() && e.name.endsWith('.gd')) out.push(full);
  }
  return out;
}

export class ClassCacheWatcher {
  private readonly files = new Map<string, CachedFile>();
  /** Mismatch signature we already tried to fix with an import; don't retry the same one. */
  private lastAttempt = '';

  constructor(private readonly projectPath: string) {}

  /**
   * Scripts whose class_name the cache is missing or has wrong (other path or
   * other base), and that changed after the cache was last written, plus cache entries
   * whose script no longer exists (moved or deleted). Empty when
   * the cache is current, or when there is no cache at all (the runner's
   * never-opened-project import handles that).
   */
  async staleClasses(): Promise<ScriptClass[]> {
    const cacheFile = path.join(this.projectPath, '.godot', 'global_script_class_cache.cfg');
    const cacheStat = await stat(cacheFile).catch(() => undefined);
    if (!cacheStat) return [];
    const cached = parseClassCache(await readFile(cacheFile, 'utf8').catch(() => ''));
    const byName = new Map(cached.map((c) => [c.name, c]));
    const stale: ScriptClass[] = [];
    for (const file of await listScripts(this.projectPath)) {
      const st = await stat(file).catch(() => undefined);
      // Only scripts edited after the cache was written: an import rewrites the cache
      // every time, so a mismatch Godot itself keeps (a duplicate class_name, a parse
      // error) doesn't trigger an import on every call, and old files aren't even read.
      if (!st || st.mtimeMs <= cacheStat.mtimeMs) continue;
      let entry = this.files.get(file);
      if (!entry || entry.mtimeMs !== st.mtimeMs || entry.size !== st.size) {
        const source = await readFile(file, 'utf8').catch(() => '');
        entry = { mtimeMs: st.mtimeMs, size: st.size, cls: parseScriptClass(source) };
        this.files.set(file, entry);
      }
      if (!entry.cls) continue;
      const res = 'res://' + path.relative(this.projectPath, file).split(path.sep).join('/');
      const hit = byName.get(entry.cls.name);
      const baseDiffers = entry.cls.base !== undefined && hit?.base !== undefined && hit.base !== entry.cls.base;
      if (!hit || hit.path !== res || baseDiffers) stale.push({ name: entry.cls.name, path: res, base: entry.cls.base });
    }
    // Entries whose script is gone. A move (files.move, a rename on disk) keeps the file's
    // mtime, so the moved script is older than the cache and the loop above never looks
    // at it; the cache then still maps the class to the old path, and every headless
    // compile of the moved script fails with 'Class "X" hides a global script class'
    // (MCP_TEST_LOG Phase A, files_move). A deleted class_name script leaves the same
    // dangling entry. Godot drops such entries on its next scan, so --import fixes both.
    for (const c of cached) {
      if (!c.path.startsWith('res://') || stale.some((s) => s.name === c.name)) continue;
      if (!existsSync(path.join(this.projectPath, ...c.path.slice('res://'.length).split('/')))) stale.push({ ...c, gone: true });
    }
    return stale;
  }

  /**
   * True when the cache should be refreshed now. Remembers what it reported,
   * so the same unresolvable mismatch is reported only once per process.
   */
  async needsRefresh(): Promise<ScriptClass[]> {
    const stale = await this.staleClasses();
    if (!stale.length) return [];
    // `gone` is part of it: a class just written at a path, then moved away from it, has
    // the same name, path and base both times, and must still trigger the second refresh.
    const sig = stale.map((s) => `${s.gone ? '!' : ''}${s.name}@${s.path}:${s.base ?? ''}`).sort().join('|');
    if (sig === this.lastAttempt) return [];
    this.lastAttempt = sig;
    return stale;
  }
}
