/**
 * File operations, done directly by the server (no Godot needed).
 *
 * After any write we tell the editor (if connected) to rescan the changed
 * files and reload open script tabs; otherwise the editor would keep showing
 * stale content and could even overwrite our change on its next save.
 *
 * Godot keeps sidecar files next to resources: `foo.gd.uid` (4.4+ UIDs) and
 * `foo.png.import` (import settings). Moves and deletes carry those along,
 * because orphaned or missing sidecars break references in subtle ways.
 */

import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { OpError } from '../errors.js';
import { isInGodotCache, isSecretPath, PathError, resolveProjectPathStrict, type ProjectPath } from '../project/paths.js';
import { callGodot } from './backend.js';
import { defineOp, type OpContext } from './types.js';

/** Folders never worth listing or searching. */
const SKIP_DIRS = new Set(['.godot', '.git', 'node_modules', '.import', '.mono', '.vs', '.idea']);
/** Extensions we treat as text for search. */
const TEXT_EXT = new Set([
  '.gd', '.tscn', '.tres', '.godot', '.cfg', '.gdshader', '.gdshaderinc', '.cs', '.json', '.md', '.txt', '.csv', '.import', '.uid', '.gdextension', '.xml', '.yaml', '.yml', '.ini', '.shader',
]);
const MAX_READ_BYTES = 256 * 1024;

async function resolve(ctx: OpContext, p: string): Promise<ProjectPath> {
  try {
    return await resolveProjectPathStrict(ctx.config.projectPath, p);
  } catch (err) {
    if (err instanceof PathError) throw new OpError('BAD_PARAMS', err.message);
    throw err;
  }
}

/** Refuse writes into Godot's generated cache; it's rebuilt by the editor. */
function assertWritable(p: ProjectPath): void {
  if (isInGodotCache(p)) throw new OpError('BAD_PARAMS', `"${p.res}" is inside .godot/, Godot's generated cache. Don't edit it; change the source files instead.`);
  if (p.rel === 'project.godot') {
    // Hand-editing project.godot works but is error-prone; settings tools come in step 2.
  }
}

/** Ask the live editor to pick up files we changed on disk (best effort). */
async function refreshEditor(ctx: OpContext, paths: string[], fullScan = false): Promise<boolean> {
  if (!ctx.bridge.isOpen()) return false;
  try {
    // Updating single files doesn't register files inside a folder the editor has never
    // seen (e.g. a new class_name script in a new folder stays "not declared"); a full
    // scan does. Scans are asynchronous and cheap enough when only done for new folders.
    await ctx.bridge.request('filesystem.refresh', fullScan ? {} : { paths });
    return true;
  } catch {
    return false;
  }
}

/** Validate a GDScript file after writing it, if any Godot backend is available. */
async function maybeValidate(ctx: OpContext, p: ProjectPath): Promise<unknown> {
  if (!p.rel.endsWith('.gd')) return undefined;
  try {
    const { result } = await callGodot(ctx, 'script.validate', { path: p.res });
    return result;
  } catch (err) {
    return { skipped: (err as Error).message };
  }
}

function sidecars(p: ProjectPath): string[] {
  return [p.abs + '.uid', p.abs + '.import'].filter((f) => existsSync(f));
}

export const filesList = defineOp({
  name: 'files.list',
  group: 'files',
  title: 'List files',
  description: 'Godot files: list a project folder (res://...). Skips .godot/ and .git/. Use recursive with a glob-like "pattern" (e.g. "*.tscn") to find files by type.',
  input: z.object({
    path: z.string().default('res://').describe('Folder to list, e.g. "res://scenes".'),
    recursive: z.boolean().default(false),
    pattern: z.string().optional().describe('Filter file names, e.g. "*.gd" or "*player*".'),
    max: z.number().int().min(1).max(5000).default(500),
  }),
  readOnly: true,
  idempotent: true,
  core: true,
  async run({ path: dir, recursive, pattern, max }, ctx) {
    const root = await resolve(ctx, dir);
    const re = pattern ? globToRegExp(pattern) : undefined;
    const entries: { path: string; type: 'file' | 'dir'; size?: number }[] = [];
    let truncated = false;

    const walk = async (abs: string, rel: string): Promise<void> => {
      let names: string[];
      try {
        names = (await readdir(abs)).sort();
      } catch {
        throw new OpError('NOT_FOUND', `Folder "${root.res}" does not exist.`);
      }
      for (const name of names) {
        if (entries.length >= max) {
          truncated = true;
          return;
        }
        if (SKIP_DIRS.has(name)) continue;
        const childAbs = path.join(abs, name);
        const childRel = rel ? `${rel}/${name}` : name;
        const st = await stat(childAbs).catch(() => undefined);
        if (!st) continue;
        if (st.isDirectory()) {
          if (!re) entries.push({ path: `res://${childRel}`, type: 'dir' });
          if (recursive) await walk(childAbs, childRel);
        } else if (!re || re.test(name)) {
          entries.push({ path: `res://${childRel}`, type: 'file', size: st.size });
        }
      }
    };
    await walk(root.abs, root.rel);
    return { data: { path: root.res, count: entries.length, truncated, entries } };
  },
});

export const filesRead = defineOp({
  name: 'files.read',
  group: 'files',
  title: 'Read file',
  description: 'Godot files: read a text file (script, scene .tscn, resource .tres, shader, config) with line numbers. Use offset/limit for long files.',
  input: z.object({
    path: z.string().describe('File path, e.g. "res://player.gd".'),
    offset: z.number().int().min(1).default(1).describe('First line to return (1-based).'),
    limit: z.number().int().min(1).max(5000).default(1000).describe('Maximum number of lines.'),
  }),
  readOnly: true,
  idempotent: true,
  core: true,
  alwaysLoad: true,
  async run({ path: p, offset, limit }, ctx) {
    const file = await resolve(ctx, p);
    const st = await stat(file.abs).catch(() => undefined);
    if (!st) throw new OpError('NOT_FOUND', `File "${file.res}" does not exist. Use godot_files_list to see what's there.`);
    if (st.isDirectory()) throw new OpError('BAD_PARAMS', `"${file.res}" is a folder; use godot_files_list.`);
    if (st.size > 10 * MAX_READ_BYTES) throw new OpError('BAD_PARAMS', `"${file.res}" is ${st.size} bytes, too large to read as text.`);
    const buf = await readFile(file.abs);
    if (buf.subarray(0, 8000).includes(0)) {
      throw new OpError('BAD_PARAMS', `"${file.res}" looks binary (an image, audio or compiled file), so it can't be read as text.`);
    }
    const text = buf.toString('utf8');
    const lines = text.split(/\r?\n/);
    // A final newline ends the last line; it doesn't start an extra empty one. Without this
    // a 49-line script (saved with a trailing newline, as Godot does) read as 50 lines here
    // while godot_debug_breakpoints said "has 49 lines", which looked like an off-by-one.
    if (lines.length > 1 && /\r?\n$/.test(text)) lines.pop();
    const slice = lines.slice(offset - 1, offset - 1 + limit);
    const width = String(offset + slice.length).length;
    const numbered = slice.map((l, i) => `${String(offset + i).padStart(width)}\t${l}`).join('\n');
    return {
      data: {
        path: file.res,
        total_lines: lines.length,
        from: offset,
        to: offset + slice.length - 1,
        truncated: offset - 1 + limit < lines.length,
        content: numbered,
      },
    };
  },
});

export const filesSearch = defineOp({
  name: 'files.search',
  group: 'files',
  title: 'Search files',
  description: 'Godot files: search text across project files (scripts, scenes, resources, shaders). Literal by default; set regex for a regular expression.',
  input: z.object({
    query: z.string().min(1),
    regex: z.boolean().default(false),
    case_sensitive: z.boolean().default(false),
    path: z.string().default('res://').describe('Folder to search in.'),
    pattern: z.string().optional().describe('Only files whose name matches, e.g. "*.gd".'),
    max_results: z.number().int().min(1).max(1000).default(100),
  }),
  readOnly: true,
  idempotent: true,
  async run({ query, regex, case_sensitive, path: dir, pattern, max_results }, ctx) {
    const root = await resolve(ctx, dir);
    let re: RegExp;
    try {
      re = new RegExp(regex ? query : escapeRegExp(query), case_sensitive ? '' : 'i');
    } catch (err) {
      throw new OpError('BAD_PARAMS', `Invalid regular expression: ${(err as Error).message}`);
    }
    const nameRe = pattern ? globToRegExp(pattern) : undefined;
    const matches: { path: string; line: number; text: string }[] = [];
    let filesScanned = 0;

    const walk = async (abs: string, rel: string): Promise<void> => {
      const names = (await readdir(abs).catch(() => [])).sort();
      for (const name of names) {
        if (matches.length >= max_results) return;
        if (SKIP_DIRS.has(name)) continue;
        const childAbs = path.join(abs, name);
        const childRel = rel ? `${rel}/${name}` : name;
        const st = await stat(childAbs).catch(() => undefined);
        if (!st) continue;
        if (st.isDirectory()) {
          await walk(childAbs, childRel);
          continue;
        }
        if (!TEXT_EXT.has(path.extname(name).toLowerCase()) && name !== 'project.godot') continue;
        // Searching from res://.godot would otherwise read the bridge token / export secrets.
        if (isSecretPath(childRel)) continue;
        if (nameRe && !nameRe.test(name)) continue;
        if (st.size > MAX_READ_BYTES * 4) continue;
        filesScanned++;
        const lines = (await readFile(childAbs, 'utf8')).split(/\r?\n/);
        for (let i = 0; i < lines.length && matches.length < max_results; i++) {
          if (re.test(lines[i]!)) matches.push({ path: `res://${childRel}`, line: i + 1, text: lines[i]!.trim().slice(0, 300) });
        }
      }
    };
    await walk(root.abs, root.rel);
    return { data: { query, files_scanned: filesScanned, count: matches.length, truncated: matches.length >= max_results, matches } };
  },
});

export const filesWrite = defineOp({
  name: 'files.write',
  group: 'files',
  title: 'Write file',
  description:
    'Godot files: create or overwrite a text file (e.g. a .gd script or .gdshader). GDScript files are syntax-checked after writing. Prefer godot_files_edit for small changes to existing files.',
  input: z.object({
    path: z.string().describe('File path, e.g. "res://scripts/enemy.gd".'),
    content: z.string(),
    overwrite: z.boolean().default(true).describe('Set false to fail instead of replacing an existing file.'),
  }),
  readOnly: false,
  destructive: true,
  idempotent: true,
  core: true,
  async run({ path: p, content, overwrite }, ctx) {
    const file = await resolve(ctx, p);
    assertWritable(file);
    const existed = existsSync(file.abs);
    if (existed && !overwrite) throw new OpError('CONFLICT', `"${file.res}" already exists. Pass overwrite: true to replace it, or use godot_files_edit.`);
    const newFolder = !existsSync(path.dirname(file.abs));
    await mkdir(path.dirname(file.abs), { recursive: true });
    await writeFile(file.abs, content, 'utf8');
    const refreshed = await refreshEditor(ctx, [file.res], newFolder);
    const validation = await maybeValidate(ctx, file);
    return { data: { path: file.res, created: !existed, bytes: Buffer.byteLength(content), editor_refreshed: refreshed, validation } };
  },
});

export const filesEdit = defineOp({
  name: 'files.edit',
  group: 'files',
  title: 'Edit file',
  description:
    'Godot files: replace an exact snippet in a text file (old_text -> new_text). old_text must match exactly once unless replace_all. GDScript files are syntax-checked after editing.',
  input: z.object({
    path: z.string(),
    old_text: z.string().min(1).describe('Exact text to find, including indentation (tabs vs spaces matter in GDScript).'),
    new_text: z.string(),
    replace_all: z.boolean().default(false),
  }),
  readOnly: false,
  destructive: false,
  core: true,
  async run({ path: p, old_text, new_text, replace_all }, ctx) {
    const file = await resolve(ctx, p);
    assertWritable(file);
    const text = await readFile(file.abs, 'utf8').catch(() => {
      throw new OpError('NOT_FOUND', `File "${file.res}" does not exist. Use godot_files_write to create it.`);
    });
    const count = text.split(old_text).length - 1;
    if (count === 0) {
      throw new OpError('NOT_FOUND', `old_text was not found in "${file.res}". Read the file again (godot_files_read) and copy the text exactly, including indentation.`);
    }
    if (count > 1 && !replace_all) {
      throw new OpError('CONFLICT', `old_text occurs ${count} times in "${file.res}". Include more surrounding lines to make it unique, or pass replace_all: true.`);
    }
    const updated = replace_all ? text.split(old_text).join(new_text) : text.replace(old_text, () => new_text);
    await writeFile(file.abs, updated, 'utf8');
    const refreshed = await refreshEditor(ctx, [file.res]);
    const validation = await maybeValidate(ctx, file);
    return { data: { path: file.res, replacements: replace_all ? count : 1, editor_refreshed: refreshed, validation } };
  },
});

export const filesMove = defineOp({
  name: 'files.move',
  group: 'files',
  title: 'Move or rename file',
  description:
    'Godot files: move or rename a file or folder, carrying its .uid/.import sidecar files. References by uid:// keep working; plain res:// references in other files are NOT updated.',
  input: z.object({ from: z.string(), to: z.string() }),
  readOnly: false,
  destructive: false,
  async run({ from, to }, ctx) {
    const src = await resolve(ctx, from);
    const dst = await resolve(ctx, to);
    assertWritable(src);
    assertWritable(dst);
    if (!existsSync(src.abs)) throw new OpError('NOT_FOUND', `"${src.res}" does not exist.`);
    if (existsSync(dst.abs)) throw new OpError('CONFLICT', `"${dst.res}" already exists.`);
    const newFolder = !existsSync(path.dirname(dst.abs));
    await mkdir(path.dirname(dst.abs), { recursive: true });
    const moved = sidecars(src);
    await rename(src.abs, dst.abs);
    for (const side of moved) await rename(side, dst.abs + side.slice(src.abs.length));
    const refreshed = await refreshEditor(ctx, [src.res, dst.res], newFolder);
    return { data: { from: src.res, to: dst.res, sidecars_moved: moved.length, editor_refreshed: refreshed } };
  },
});

export const filesDelete = defineOp({
  name: 'files.delete',
  group: 'files',
  title: 'Delete file',
  description: 'Godot files: delete a file (and its .uid/.import sidecars). Deleting a folder requires recursive: true. This cannot be undone.',
  input: z.object({ path: z.string(), recursive: z.boolean().default(false) }),
  readOnly: false,
  destructive: true,
  // Deleting is the one file operation nothing can undo (no editor history,
  // no trash), so ask the user when the client can show a dialog.
  confirm: ({ path: p, recursive }) => `Delete ${p}${recursive ? ' and everything inside it' : ''}? This cannot be undone.`,
  async run({ path: p, recursive }, ctx) {
    const file = await resolve(ctx, p);
    assertWritable(file);
    if (file.rel === '' || file.rel === 'project.godot') throw new OpError('BAD_PARAMS', 'Refusing to delete the project root or project.godot.');
    const st = await stat(file.abs).catch(() => undefined);
    if (!st) throw new OpError('NOT_FOUND', `"${file.res}" does not exist.`);
    if (st.isDirectory() && !recursive) throw new OpError('BAD_PARAMS', `"${file.res}" is a folder. Pass recursive: true to delete it and everything inside.`);
    const side = st.isDirectory() ? [] : sidecars(file);
    await rm(file.abs, { recursive, force: false });
    for (const s of side) await rm(s, { force: true });
    const refreshed = await refreshEditor(ctx, [file.res]);
    return { data: { deleted: file.res, sidecars_deleted: side.length, editor_refreshed: refreshed } };
  },
});

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Minimal glob: * and ? on file names (case-insensitive). */
export function globToRegExp(glob: string): RegExp {
  const body = glob.split('').map((c) => (c === '*' ? '.*' : c === '?' ? '.' : escapeRegExp(c))).join('');
  return new RegExp(`^${body}$`, 'i');
}
