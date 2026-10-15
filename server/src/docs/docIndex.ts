/**
 * Offline Godot class reference: build, cache and load the docs index.
 *
 * Source: `godot --headless --dump-extension-api-with-docs`, run with the user's own Godot
 * binary in a temp folder (no project needed, ~2-3 s, writes extension_api.json with every
 * class, builtin type, utility function and global enum, descriptions in BBCode). Using
 * the user's binary means the docs always match their Godot version, and nothing is
 * downloaded: "nothing talks to the internet" is a product promise.
 *
 * Not in that dump: @GDScript (preload, range, annotations...). We add the bundled copy
 * generated at build time from the engine's MIT-licensed @GDScript.xml
 * (gdscriptBuiltin.generated.ts). @GlobalScope is synthesised from the dump's
 * utility_functions / global_enums / global_constants / singletons sections.
 *
 * Cache: <OS cache dir>/godot-mcp/docs/<godot version>/index-v<INDEX_FORMAT>.json.gz
 * (~1.3 MB), written atomically (temp file + rename) so concurrent servers never read a
 * half-written file. OS cache dir: $XDG_CACHE_HOME or ~/.cache (Linux), ~/Library/Caches
 * (macOS), %LOCALAPPDATA% (Windows). GODOT_MCP_CACHE_DIR overrides it (tests).
 */

import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { gunzip, gzip } from 'node:zlib';
import { OpError } from '../errors.js';
import { findGodot, GODOT_NOT_FOUND_HINT } from '../godot/binary.js';
import { runProcess } from '../godot/headless.js';
import { log } from '../log.js';
import { GDSCRIPT_DOCS } from './gdscriptBuiltin.generated.js';
import { INDEX_FORMAT, type DocClass, type DocIndex, type DocMember } from './model.js';

const gzipAsync = promisify(gzip);
const gunzipAsync = promisify(gunzip);

/** Per-user cache folder for godot-mcp. */
export function cacheRoot(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string {
  if (env.GODOT_MCP_CACHE_DIR) return env.GODOT_MCP_CACHE_DIR;
  const home = os.homedir();
  if (platform === 'win32') return path.join(env.LOCALAPPDATA ?? path.join(home, 'AppData', 'Local'), 'godot-mcp');
  if (platform === 'darwin') return path.join(home, 'Library', 'Caches', 'godot-mcp');
  return path.join(env.XDG_CACHE_HOME || path.join(home, '.cache'), 'godot-mcp');
}

function indexFile(version: string): string {
  const safe = version.replace(/[^A-Za-z0-9._-]/g, '_');
  return path.join(cacheRoot(), 'docs', safe, `index-v${INDEX_FORMAT}.json.gz`);
}

// ---------------------------------------------------------------------------------------
// extension_api.json -> DocIndex

interface ApiArg {
  name: string;
  type: string;
  default_value?: string;
}
interface ApiMethod {
  name: string;
  is_static?: boolean;
  is_const?: boolean;
  is_vararg?: boolean;
  is_virtual?: boolean;
  return_value?: { type: string };
  return_type?: string;
  arguments?: ApiArg[];
  description?: string;
}
interface ApiEnum {
  name: string;
  is_bitfield?: boolean;
  values: { name: string; value: number; description?: string }[];
}
interface ApiClass {
  name: string;
  inherits?: string;
  api_type?: string;
  brief_description?: string;
  description?: string;
  methods?: ApiMethod[];
  properties?: { name: string; type: string; description?: string }[];
  members?: { name: string; type: string; description?: string }[];
  signals?: { name: string; arguments?: ApiArg[]; description?: string }[];
  constants?: { name: string; value: number | string; type?: string; description?: string }[];
  enums?: ApiEnum[];
  constructors?: { arguments?: ApiArg[]; description?: string }[];
}
interface ExtensionApi {
  header: { version_full_name?: string };
  classes: ApiClass[];
  builtin_classes: ApiClass[];
  utility_functions: ApiMethod[];
  global_enums: ApiEnum[];
  global_constants: { name: string; value: number; description?: string }[];
  singletons: { name: string; type: string }[];
}

/** "enum::Node.ProcessMode" -> "Node.ProcessMode", "typedarray::Node" -> "Array[Node]". */
export function prettyType(t: string | undefined): string {
  if (!t) return 'void';
  const [kind, rest] = t.includes('::') ? (t.split('::', 2) as [string, string]) : ['', t];
  switch (kind) {
    case 'enum':
    case 'bitfield':
      return rest;
    case 'typedarray':
      return `Array[${rest}]`;
    case 'typeddictionary':
      return `Dictionary[${rest.split(';').join(', ')}]`;
    default:
      return rest;
  }
}

function args(list: ApiArg[] | undefined, vararg?: boolean): string {
  const parts = (list ?? []).map((a) => `${a.name}: ${prettyType(a.type)}${a.default_value !== undefined ? ` = ${a.default_value}` : ''}`);
  if (vararg) parts.push('...');
  return parts.join(', ');
}

function methodSig(m: ApiMethod): string {
  const ret = prettyType(m.return_value?.type ?? m.return_type);
  const quals = [m.is_const ? 'const' : '', m.is_virtual ? 'virtual' : ''].filter(Boolean).join(' ');
  return `${m.is_static ? 'static ' : ''}func ${m.name}(${args(m.arguments, m.is_vararg)}) -> ${ret}${quals ? ` ${quals}` : ''}`;
}

function enumMembers(e: ApiEnum): DocMember[] {
  const values = e.values.map((v) => `${v.name} = ${v.value}`).join(', ');
  const out: DocMember[] = [{ k: 'enum', n: e.name, s: `${e.is_bitfield ? 'flags ' : ''}enum ${e.name} { ${values} }` }];
  for (const v of e.values) out.push({ k: 'constant', n: v.name, s: `${v.name} = ${v.value}`, e: e.name, ...(v.description ? { d: v.description } : {}) });
  return out;
}

function convertClass(c: ApiClass, kind: 'class' | 'builtin'): DocClass {
  const m: DocMember[] = [];
  if (kind === 'builtin') {
    for (const ctor of c.constructors ?? []) m.push({ k: 'constructor', n: c.name, s: `${c.name}(${args(ctor.arguments)})`, ...(ctor.description ? { d: ctor.description } : {}) });
  }
  for (const p of c.properties ?? c.members ?? []) m.push({ k: 'property', n: p.name, s: `var ${p.name}: ${prettyType(p.type)}`, ...(p.description ? { d: p.description } : {}) });
  for (const meth of c.methods ?? []) m.push({ k: 'method', n: meth.name, s: methodSig(meth), ...(meth.description ? { d: meth.description } : {}) });
  for (const s of c.signals ?? []) m.push({ k: 'signal', n: s.name, s: `signal ${s.name}(${args(s.arguments)})`, ...(s.description ? { d: s.description } : {}) });
  for (const e of c.enums ?? []) m.push(...enumMembers(e));
  // Constants not already listed as enum values.
  const enumValues = new Set(m.filter((x) => x.e).map((x) => x.n));
  for (const k of c.constants ?? []) {
    if (enumValues.has(k.name)) continue;
    m.push({ k: 'constant', n: k.name, s: `const ${k.name} = ${k.value}`, ...(k.description ? { d: k.description } : {}) });
  }
  return {
    n: c.name,
    ...(c.inherits ? { i: c.inherits } : {}),
    t: kind,
    ...(c.api_type === 'editor' ? { a: 'editor' as const } : {}),
    b: c.brief_description ?? '',
    d: c.description ?? '',
    m,
  };
}

/** Turn a parsed extension_api.json (with docs) into the compact index. */
export function buildIndexFromApi(api: ExtensionApi, version: string): DocIndex {
  const classes: DocClass[] = [];
  const global: DocClass = {
    n: '@GlobalScope',
    t: 'global',
    b: 'Global scope constants and functions.',
    d: 'Global utility functions, enums, constants and singletons, available from any script.',
    m: [],
  };
  for (const f of api.utility_functions ?? []) global.m.push({ k: 'utility', n: f.name, s: `func ${f.name}(${args(f.arguments, f.is_vararg)}) -> ${prettyType(f.return_type)}`, ...(f.description ? { d: f.description } : {}) });
  for (const s of api.singletons ?? []) global.m.push({ k: 'property', n: s.name, s: `var ${s.name}: ${s.type}`, d: `The [${s.type}] singleton.` });
  for (const e of api.global_enums ?? []) global.m.push(...enumMembers(e));
  for (const k of api.global_constants ?? []) global.m.push({ k: 'constant', n: k.name, s: `const ${k.name} = ${k.value}`, ...(k.description ? { d: k.description } : {}) });
  classes.push(global, GDSCRIPT_DOCS);
  for (const b of api.builtin_classes ?? []) classes.push(convertClass(b, 'builtin'));
  for (const c of api.classes ?? []) classes.push(convertClass(c, 'class'));
  return { format: INDEX_FORMAT, version, classes };
}

// ---------------------------------------------------------------------------------------
// Build / cache / load

const loaded = new Map<string, Promise<DocIndex>>();

export interface LoadOptions {
  godotPath?: string;
  progress?: (progress: number, total?: number, message?: string) => void;
}

/**
 * The docs index for the configured Godot binary: from memory, the disk cache, or built
 * now (first use only, ~3-5 s).
 */
export async function loadDocIndex(opts: LoadOptions = {}): Promise<DocIndex> {
  const godot = await findGodot(opts.godotPath);
  if (!godot) throw new OpError('GODOT_NOT_FOUND', `The docs index is built from your Godot binary. ${GODOT_NOT_FOUND_HINT}`);
  let p = loaded.get(godot.version);
  if (!p) {
    p = loadOrBuild(godot.path, godot.version, opts.progress);
    loaded.set(godot.version, p);
    p.catch(() => loaded.delete(godot.version)); // allow a retry after a failure
  }
  return p;
}

async function loadOrBuild(godotPath: string, version: string, progress?: LoadOptions['progress']): Promise<DocIndex> {
  const file = indexFile(version);
  if (existsSync(file)) {
    try {
      const idx = JSON.parse((await gunzipAsync(await readFile(file))).toString('utf8')) as DocIndex;
      if (idx.format === INDEX_FORMAT && idx.version === version) return idx;
    } catch (err) {
      log.warn(`Ignoring unreadable docs cache ${file}: ${(err as Error).message}`);
    }
  }
  progress?.(0, 3, `Building the Godot ${version} docs index (first use only)`);
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'godot-mcp-docs-'));
  try {
    // The dump is written to the CURRENT directory; no project is needed.
    const res = await runProcess(godotPath, ['--headless', '--dump-extension-api-with-docs'], { cwd: tmp, timeoutMs: 180_000 });
    const apiFile = path.join(tmp, 'extension_api.json');
    if (!existsSync(apiFile)) {
      throw new OpError('GODOT_ERROR', `Godot did not write extension_api.json (exit code ${res.code}${res.timedOut ? ', timed out' : ''}). Output:\n${(res.stdout + res.stderr).trim().split(/\r?\n/).slice(-10).join('\n')}`);
    }
    progress?.(1, 3, 'Indexing the class reference');
    const api = JSON.parse(await readFile(apiFile, 'utf8')) as ExtensionApi;
    const idx = buildIndexFromApi(api, version);
    progress?.(2, 3, 'Saving the docs index cache');
    try {
      await mkdir(path.dirname(file), { recursive: true });
      const part = `${file}.${process.pid}.tmp`;
      await writeFile(part, await gzipAsync(Buffer.from(JSON.stringify(idx), 'utf8')));
      await rename(part, file);
    } catch (err) {
      // A read-only cache dir only costs a rebuild next time.
      log.warn(`Could not cache the docs index at ${file}: ${(err as Error).message}`);
    }
    progress?.(3, 3, 'Docs index ready');
    return idx;
  } finally {
    await rm(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}
