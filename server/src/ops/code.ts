/**
 * Code intelligence for GDScript, backed by Godot's own language server (LSP).
 *
 * The language server lives inside a Godot editor: the user's editor when it is connected
 * through the bridge, otherwise a private headless editor started on demand. See
 * src/lsp/manager.ts for how that is chosen and managed, and src/lsp/client.ts for the
 * wire protocol and Godot's quirks.
 *
 * Tool conventions: paths in and out are res:// (only project paths are accepted), lines
 * and columns are 1-based (the LSP is 0-based; we convert at the edges), results are kept
 * compact because every byte goes back into the model's context.
 *
 * Known language server limitations handled here:
 *   - no workspace/symbol: `code.symbols` with `query` searches documentSymbol outlines of
 *     the project's scripts itself (cached by mtime);
 *   - references/rename text-search identifiers and can match inside comments/strings:
 *     lookups flag those hits, rename drops them unless `include_comments`;
 *   - `definition` returns [] for engine (native) symbols: we return the hover docs instead;
 *   - diagnostics only arrive for opened documents: we didOpen the on-disk text, wait for
 *     publishDiagnostics, then didClose.
 */

import { readdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { OpError } from '../errors.js';
import type { LspDiagnostic, LspDocumentSymbol, LspLocation, LspRange } from '../lsp/client.js';
import { findIdentifier, GdMask, isIdentifier } from '../lsp/gdscriptText.js';
import { lspManagerFor, type LspSession } from '../lsp/manager.js';
import { pathToFileUri, uriToProjectRel } from '../lsp/uri.js';
import { isInGodotCache, PathError, resolveProjectPathStrict, type ProjectPath } from '../project/paths.js';
import { callGodot } from './backend.js';
import { defineOp, type OpContext } from './types.js';

const MAX_DIAG_FILES = 50;
/** Headless validation spawns one Godot process per file, so the fallback checks fewer. */
const MAX_FALLBACK_FILES = 20;
const MAX_SEARCH_FILES = 500;
const MAX_LOCATIONS = 100;
const SKIP_DIRS = new Set(['.godot', '.git', 'node_modules', '.import', '.mono', '.vs', '.idea']);

/** LSP SymbolKind -> short GDScript-flavoured name. */
const SYMBOL_KIND: Record<number, string> = {
  2: 'module', 5: 'class', 6: 'func', 7: 'var', 8: 'var', 9: 'func', 10: 'enum', 12: 'func', 13: 'var', 14: 'const', 22: 'enum_value', 23: 'class', 24: 'signal', 26: 'param',
};
/** LSP CompletionItemKind -> short name. */
const COMPLETION_KIND: Record<number, string> = {
  1: 'text', 2: 'method', 3: 'func', 4: 'constructor', 5: 'field', 6: 'var', 7: 'class', 8: 'interface', 9: 'module', 10: 'property', 12: 'value', 13: 'enum', 14: 'keyword', 15: 'snippet', 17: 'file', 19: 'folder', 20: 'enum_member', 21: 'const', 22: 'struct', 23: 'event', 25: 'type',
};
const SEVERITY = ['', 'error', 'warning', 'info', 'hint'] as const;

async function resolve(ctx: OpContext, p: string): Promise<ProjectPath> {
  try {
    return await resolveProjectPathStrict(ctx.config.projectPath, p);
  } catch (err) {
    if (err instanceof PathError) throw new OpError('BAD_PARAMS', err.message);
    throw err;
  }
}

async function readScript(file: ProjectPath): Promise<string> {
  if (!file.rel.endsWith('.gd')) throw new OpError('BAD_PARAMS', `"${file.res}" is not a GDScript (.gd) file.`);
  return readFile(file.abs, 'utf8').catch(() => {
    throw new OpError('NOT_FOUND', `Script "${file.res}" does not exist. Use godot_files_list to find scripts.`);
  });
}

/** Map a language-server URI to res://, or undefined outside the project. */
function toRes(session: LspSession, uri: string): string | undefined {
  const rel = uriToProjectRel(uri, session.roots);
  return rel === undefined ? undefined : `res://${rel}`;
}

/** Replace file:// links in LSP markdown with res:// paths (shorter, and what tools take). */
function cleanMarkdown(session: LspSession, md: string): string {
  return md
    .replace(/\[([^\]]*)\]\((file:\/\/[^)\s]+)\)/g, (m, label: string, uri: string) => toRes(session, uri) ?? (label || m))
    .replace(/^\t/, '')
    .trim();
}

/** All .gd files under a folder (skipping caches, and addons/ unless the folder is inside addons). */
async function listScripts(root: ProjectPath, max: number): Promise<{ files: ProjectPath[]; truncated: boolean; skippedAddons: boolean }> {
  const files: ProjectPath[] = [];
  let truncated = false;
  let skippedAddons = false;
  const inAddons = root.rel === 'addons' || root.rel.startsWith('addons/');
  const walk = async (abs: string, rel: string): Promise<void> => {
    const entries = (await readdir(abs, { withFileTypes: true }).catch(() => [])).sort((a, b) => a.name.localeCompare(b.name));
    for (const e of entries) {
      if (files.length >= max) {
        truncated = true;
        return;
      }
      if (SKIP_DIRS.has(e.name)) continue;
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (!inAddons && childRel === 'addons') {
          skippedAddons = true;
          continue;
        }
        await walk(path.join(abs, e.name), childRel);
      } else if (e.name.endsWith('.gd')) {
        files.push({ abs: path.join(abs, e.name), rel: childRel, res: `res://${childRel}` });
      }
    }
  };
  await walk(root.abs, root.rel);
  return { files, truncated, skippedAddons };
}

function sourceLabel(session: LspSession): string {
  return session.source === 'editor' ? 'lsp (connected editor)' : 'lsp (private headless editor)';
}

// ---------------------------------------------------------------------------------------
// code.diagnostics

export const codeDiagnostics = defineOp({
  name: 'code.diagnostics',
  group: 'code',
  title: 'GDScript diagnostics',
  description: 'Godot code: GDScript errors and warnings for .gd files or a folder, from the language server.',
  input: z.object({
    paths: z.array(z.string()).min(1).describe('.gd files or folders (res://).'),
  }),
  readOnly: true,
  idempotent: true,
  async run({ paths }, ctx) {
    // Expand folders, keep order, dedupe.
    const seen = new Set<string>();
    const files: ProjectPath[] = [];
    let truncated = false;
    let skippedAddons = false;
    for (const p of paths) {
      const target = await resolve(ctx, p);
      const st = await stat(target.abs).catch(() => undefined);
      if (!st) throw new OpError('NOT_FOUND', `"${target.res}" does not exist.`);
      const found = st.isDirectory() ? await listScripts(target, MAX_DIAG_FILES + 1) : { files: [target], truncated: false, skippedAddons: false };
      if (!st.isDirectory() && !target.rel.endsWith('.gd')) throw new OpError('BAD_PARAMS', `"${target.res}" is not a .gd file or folder.`);
      skippedAddons ||= found.skippedAddons;
      for (const f of found.files) {
        if (seen.has(f.res)) continue;
        if (files.length >= MAX_DIAG_FILES) {
          truncated = true;
          break;
        }
        seen.add(f.res);
        files.push(f);
      }
      truncated ||= found.truncated;
    }

    const extra = { ...(truncated ? { truncated: `only the first ${MAX_DIAG_FILES} files were checked` } : {}), ...(skippedAddons ? { note: 'addons/ was skipped; pass it explicitly to check it' } : {}) };

    // Don't start an editor just to report that a folder has no scripts.
    if (files.length === 0) return { data: { checked: 0, errors: 0, warnings: 0, files: [], clean: [], ...extra } };

    let session: LspSession | undefined;
    let lspError: string | undefined;
    try {
      session = await lspManagerFor(ctx.config).acquire(ctx);
    } catch (err) {
      lspError = (err as Error).message;
    }

    const results: { path: string; diagnostics: { line: number; column?: number; severity: string; message: string }[] }[] = [];
    const unchecked: string[] = [];
    let source: string;
    if (session) {
      source = sourceLabel(session);
      const s = session;
      // A few at a time: each one is a didOpen + analysis in the editor.
      for (let i = 0; i < files.length; i += 8) {
        const batch = files.slice(i, i + 8);
        const diags = await Promise.all(
          batch.map(async (f) => {
            const text = await readFile(f.abs, 'utf8');
            return s.client.diagnose(pathToFileUri(f.abs), text);
          }),
        );
        batch.forEach((f, j) => {
          const d = diags[j];
          // No answer within the settle window (editor busy?): say so instead of "clean".
          if (d === undefined) unchecked.push(f.res);
          else results.push({ path: f.res, diagnostics: d.map(formatDiagnostic) });
        });
      }
    } else {
      // Fallback: compile each file with script.validate (editor bridge or headless).
      source = `script.validate (language server unavailable: ${lspError})`;
      for (const f of files.slice(0, MAX_FALLBACK_FILES)) {
        const { result } = await callGodot<{ valid?: boolean; errors?: { line?: number; message: string }[] }>(ctx, 'script.validate', { path: f.res });
        results.push({ path: f.res, diagnostics: (result.errors ?? []).map((e) => ({ line: e.line ?? 0, severity: 'error', message: e.message })) });
      }
      if (files.length > MAX_FALLBACK_FILES) Object.assign(extra, { truncated: `fallback checked only the first ${MAX_FALLBACK_FILES} files` });
    }

    const withIssues = results.filter((r) => r.diagnostics.length > 0);
    const count = (sev: string) => results.reduce((n, r) => n + r.diagnostics.filter((d) => d.severity === sev).length, 0);
    return {
      data: {
        source,
        checked: results.length,
        errors: count('error'),
        warnings: count('warning'),
        files: withIssues,
        clean: results.filter((r) => r.diagnostics.length === 0).map((r) => r.path),
        ...(unchecked.length ? { unchecked, hint: 'No diagnostics arrived for these files in time; retry.' } : {}),
        ...extra,
      },
    };
  },
});

function formatDiagnostic(d: LspDiagnostic) {
  return { line: d.range.start.line + 1, column: d.range.start.character + 1, severity: SEVERITY[d.severity ?? 1] ?? 'error', message: d.message };
}

// ---------------------------------------------------------------------------------------
// code.symbols

/** One outline line: "12: func jump(force: float) -> void". */
function outline(symbols: LspDocumentSymbol[], indent = ''): string[] {
  const out: string[] = [];
  for (const s of symbols) {
    const kind = SYMBOL_KIND[s.kind] ?? 'symbol';
    if (kind === 'enum_value' || kind === 'param') continue; // shown inside the enum/func detail
    const decl = s.detail && s.detail.includes(s.name) ? s.detail : `${kind} ${s.name}${s.detail ? ` ${s.detail}` : ''}`;
    const doc = s.documentation ? `  ## ${s.documentation.split('\n')[0]!.slice(0, 120)}` : '';
    out.push(`${indent}${s.selectionRange.start.line + 1}: ${decl}${doc}`);
    if (kind === 'class' && s.children?.length) out.push(...outline(s.children, indent + '  '));
  }
  return out;
}

interface FlatSymbol {
  name: string;
  kind: string;
  line: number;
  decl: string;
  container?: string;
}

function flatten(symbols: LspDocumentSymbol[], container: string | undefined, out: FlatSymbol[]): FlatSymbol[] {
  for (const s of symbols) {
    const kind = SYMBOL_KIND[s.kind] ?? 'symbol';
    if (kind === 'param') continue;
    out.push({ name: s.name, kind, line: s.selectionRange.start.line + 1, decl: s.detail || s.name, ...(container ? { container } : {}) });
    if (s.children?.length) flatten(s.children, s.name, out);
  }
  return out;
}

/** documentSymbol outlines for project-wide search, cached by file stamp. */
const symbolCache = new Map<string, { stamp: string; symbols: FlatSymbol[] }>();

async function documentSymbols(session: LspSession, abs: string): Promise<LspDocumentSymbol[]> {
  const r = await session.client.request<LspDocumentSymbol[] | null>('textDocument/documentSymbol', { textDocument: { uri: pathToFileUri(abs) } });
  return r ?? [];
}

export const codeSymbols = defineOp({
  name: 'code.symbols',
  group: 'code',
  title: 'GDScript symbols',
  description: 'Godot code: outline of a .gd file (funcs, signals, vars, consts, classes with lines), or find symbols by name with query.',
  input: z.object({
    path: z.string().default('res://').describe('.gd file to outline, or folder to search with query.'),
    query: z.string().optional().describe('Name substring to search for across scripts.'),
  }),
  readOnly: true,
  idempotent: true,
  async run({ path: p, query }, ctx) {
    const target = await resolve(ctx, p);
    const st = await stat(target.abs).catch(() => undefined);
    if (!st) throw new OpError('NOT_FOUND', `"${target.res}" does not exist.`);

    if (!query) {
      if (st.isDirectory()) throw new OpError('BAD_PARAMS', `"${target.res}" is a folder. Pass a .gd file to outline it, or add "query" to search symbol names in the folder.`);
      await readScript(target);
      const session = await lspManagerFor(ctx.config).acquire(ctx);
      const roots = await documentSymbols(session, target.abs);
      const root = roots[0];
      if (!root) throw new OpError('GODOT_ERROR', `The language server returned no symbols for ${target.res} (does it parse? try godot_code_diagnostics).`);
      return {
        data: {
          path: target.res,
          class: root.name,
          ...(root.documentation ? { doc: root.documentation.slice(0, 400) } : {}),
          symbols: outline(root.children ?? []),
        },
      };
    }

    const folder = st.isDirectory() ? target : undefined;
    const { files, truncated } = folder ? await listScripts(folder, MAX_SEARCH_FILES) : { files: [target], truncated: false };
    const session = await lspManagerFor(ctx.config).acquire(ctx);
    const q = query.toLowerCase();
    const hits: (FlatSymbol & { path: string; score: number })[] = [];
    for (const f of files) {
      const fst = await stat(f.abs).catch(() => undefined);
      if (!fst) continue;
      const stamp = `${fst.mtimeMs}:${fst.size}`;
      let entry = symbolCache.get(f.abs);
      if (!entry || entry.stamp !== stamp) {
        const roots = await documentSymbols(session, f.abs).catch(() => []);
        entry = { stamp, symbols: flatten(roots, undefined, []) };
        symbolCache.set(f.abs, entry);
      }
      for (const s of entry.symbols) {
        const n = s.name.toLowerCase();
        if (!n.includes(q)) continue;
        hits.push({ ...s, path: f.res, score: n === q ? 0 : n.startsWith(q) ? 1 : 2 });
      }
    }
    hits.sort((a, b) => a.score - b.score || a.name.length - b.name.length);
    return {
      data: {
        query,
        searched: files.length,
        ...(truncated ? { truncated: `only the first ${MAX_SEARCH_FILES} scripts were searched` } : {}),
        count: hits.length,
        matches: hits.slice(0, 50).map(({ score: _s, ...h }) => h),
      },
    };
  },
});

// ---------------------------------------------------------------------------------------
// Position helpers shared by lookup and rename

interface Located {
  file: ProjectPath;
  text: string;
  lines: string[];
  /** 0-based LSP position. */
  line: number;
  character: number;
  /** The identifier the position points into, when known. */
  word?: string;
}

async function locate(ctx: OpContext, args: { path: string; line: number; column?: number; symbol?: string }, mode: 'start' | 'end' | 'call' = 'start'): Promise<Located> {
  const file = await resolve(ctx, args.path);
  const text = await readScript(file);
  const lines = text.split(/\r?\n/);
  const idx = args.line - 1;
  if (idx < 0 || idx >= lines.length) throw new OpError('BAD_PARAMS', `Line ${args.line} is outside ${file.res} (1-${lines.length}).`);
  const lineText = lines[idx]!;
  if (args.symbol) {
    // For completion the symbol may be a prefix of what is typed ("move_and").
    const cols = findIdentifier(lineText, args.symbol, mode === 'end');
    if (cols.length === 0) {
      throw new OpError('NOT_FOUND', `"${args.symbol}" is not on line ${args.line} of ${file.res}. That line is: ${JSON.stringify(lineText.trim())}. Check the line number (godot_files_read shows them).`);
    }
    // With a column too, take the occurrence closest to it.
    const want = args.column !== undefined ? args.column - 1 : cols[0]!;
    const start = cols.reduce((best, c) => (Math.abs(c - want) < Math.abs(best - want) ? c : best), cols[0]!);
    let character = start;
    if (mode === 'end') character = start + args.symbol.length;
    if (mode === 'call') {
      const paren = lineText.indexOf('(', start + args.symbol.length);
      character = paren === -1 ? start + args.symbol.length : paren + 1;
    }
    return { file, text, lines, line: idx, character, word: args.symbol };
  }
  if (args.column === undefined) throw new OpError('BAD_PARAMS', 'Pass "column" (1-based) or "symbol" (the identifier text on that line).');
  const character = Math.min(args.column - 1, lineText.length);
  // The identifier under the cursor, for completion filtering and rename checks.
  let a = character;
  let b = character;
  while (a > 0 && /\w/.test(lineText[a - 1]!)) a--;
  while (b < lineText.length && /\w/.test(lineText[b]!)) b++;
  return { file, text, lines, line: idx, character, word: lineText.slice(a, b) || undefined };
}

/** Compact location with a snippet of the target line (reads files once each). */
async function describeLocations(session: LspSession, locs: LspLocation[], max = MAX_LOCATIONS) {
  const cache = new Map<string, { lines: string[]; mask: GdMask } | null>();
  const out: { path: string; line: number; column: number; text: string; in_comment?: true; in_string?: true }[] = [];
  for (const l of locs.slice(0, max)) {
    const res = toRes(session, l.uri);
    if (!res) continue;
    if (!cache.has(res)) {
      const abs = path.join(session.roots[0]!, res.slice('res://'.length));
      const text = await readFile(abs, 'utf8').catch(() => undefined);
      cache.set(res, text === undefined ? null : { lines: text.split(/\r?\n/), mask: GdMask.build(text) });
    }
    const f = cache.get(res);
    const line = l.range.start.line;
    const kind = f?.mask.kindAt(line, l.range.start.character);
    out.push({
      path: res,
      line: line + 1,
      column: l.range.start.character + 1,
      text: (f?.lines[line] ?? '').trim().slice(0, 160),
      ...(kind === 'comment' ? { in_comment: true as const } : {}),
      ...(kind === 'string' ? { in_string: true as const } : {}),
    });
  }
  return out;
}

// ---------------------------------------------------------------------------------------
// code.lookup

const positionFields = {
  path: z.string().describe('.gd file (res://).'),
  line: z.number().int().min(1).describe('1-based line.'),
  column: z.number().int().min(1).optional().describe('1-based column; or give symbol.'),
  symbol: z.string().optional().describe('Identifier text on that line (instead of column).'),
};

export const codeLookup = defineOp({
  name: 'code.lookup',
  group: 'code',
  title: 'GDScript lookup',
  description: 'Godot code: hover docs, definition, references, signature, completion or highlights at a position in a .gd file.',
  input: z.object({
    ...positionFields,
    kind: z.enum(['hover', 'definition', 'references', 'signature', 'completion', 'highlight']).default('hover'),
    limit: z.number().int().min(1).max(200).default(30).describe('Max completion items.'),
  }),
  readOnly: true,
  idempotent: true,
  async run(args, ctx) {
    const mode = args.kind === 'completion' ? 'end' : args.kind === 'signature' ? 'call' : 'start';
    const at = await locate(ctx, args, mode);
    const session = await lspManagerFor(ctx.config).acquire(ctx);
    const client = session.client;
    const doc = { textDocument: { uri: pathToFileUri(at.file.abs) }, position: { line: at.line, character: at.character } };
    const where = { path: at.file.res, line: at.line + 1, column: at.character + 1 };

    const hover = async () => {
      const h = await client.request<{ contents?: { value?: string } | string | unknown[] } | null>('textDocument/hover', doc);
      const c = h?.contents;
      const md = typeof c === 'string' ? c : Array.isArray(c) ? '' : (c?.value ?? '');
      return md ? cleanMarkdown(session, md) : '';
    };

    switch (args.kind) {
      case 'hover': {
        const md = await hover();
        if (!md) return { data: { ...where, found: false, hint: 'Nothing known at this position. Point at an identifier (use "symbol").' } };
        return { data: { ...where, markdown: truncate(md, 3000) } };
      }
      case 'definition': {
        const locs = await client.request<LspLocation[] | LspLocation | null>('textDocument/definition', doc);
        const list = Array.isArray(locs) ? locs : locs ? [locs] : [];
        if (list.length > 0) return { data: { ...where, locations: await describeLocations(session, list) } };
        // Engine symbols have no file; Godot returns []. Give their docs instead (hover is
        // the side-effect-free way: declaration/show_native_symbol can open the editor help).
        const md = await hover();
        if (!md) return { data: { ...where, locations: [], hint: 'No definition found at this position.' } };
        const sig = md.split('\n')[0]!.trim();
        const owner = /^(?:func|var|const|signal|enum|class)\s+([@\w]+)\./.exec(sig)?.[1];
        return { data: { ...where, native: true, signature: sig, docs: truncate(md.slice(sig.length).trim(), 2000), ...(owner ? { hint: `Engine symbol of ${owner}; godot_docs_class "${owner}" has the full reference.` } : {}) } };
      }
      case 'references': {
        const locs = (await client.request<LspLocation[] | null>('textDocument/references', { ...doc, context: { includeDeclaration: true } })) ?? [];
        const described = await describeLocations(session, locs);
        return {
          data: {
            ...where,
            count: locs.length,
            ...(locs.length > MAX_LOCATIONS ? { truncated: true } : {}),
            locations: described,
            ...(described.some((d) => d.in_comment || d.in_string) ? { note: 'Godot also matches the name inside comments/strings (marked in_comment/in_string).' } : {}),
          },
        };
      }
      case 'highlight': {
        const hl = (await client.request<{ range: LspRange }[] | null>('textDocument/documentHighlight', doc)) ?? [];
        return { data: { ...where, count: hl.length, positions: hl.map((h) => ({ line: h.range.start.line + 1, column: h.range.start.character + 1 })) } };
      }
      case 'signature': {
        const sh = await client.request<{ signatures?: { label: string; documentation?: { value?: string } | string }[]; activeSignature?: number; activeParameter?: number } | null>('textDocument/signatureHelp', doc);
        if (!sh?.signatures?.length) return { data: { ...where, signatures: [], hint: 'No call here. Point inside the parentheses of a call, or give the called function as "symbol".' } };
        return {
          data: {
            ...where,
            active_parameter: sh.activeParameter ?? 0,
            signatures: sh.signatures.map((s) => {
              const d = typeof s.documentation === 'string' ? s.documentation : (s.documentation?.value ?? '');
              return { label: s.label, ...(d ? { doc: truncate(cleanMarkdown(session, d), 600) } : {}) };
            }),
          },
        };
      }
      case 'completion': {
        const r = await client.request<{ items?: { label: string; kind?: number }[] } | { label: string; kind?: number }[] | null>('textDocument/completion', { ...doc, context: { triggerKind: 1 } });
        let items = Array.isArray(r) ? r : (r?.items ?? []);
        const total = items.length;
        // Godot returns everything in scope (2000+ items on a blank line); filter by the
        // identifier prefix before the cursor like an editor would.
        const lineText = at.lines[at.line] ?? '';
        let a = at.character;
        while (a > 0 && /\w/.test(lineText[a - 1]!)) a--;
        const prefix = lineText.slice(a, at.character).toLowerCase();
        if (prefix) {
          const starts = items.filter((i) => i.label.toLowerCase().startsWith(prefix));
          items = starts.length ? starts : items.filter((i) => i.label.toLowerCase().includes(prefix));
        }
        return {
          data: {
            ...where,
            ...(prefix ? { prefix } : {}),
            total,
            matching: items.length,
            items: items.slice(0, args.limit).map((i) => ({ label: i.label, kind: COMPLETION_KIND[i.kind ?? 0] ?? String(i.kind ?? '') })),
          },
        };
      }
    }
  },
});

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + ' ...' : s;
}

// ---------------------------------------------------------------------------------------
// code.rename

interface TextEdit {
  range: LspRange;
  newText: string;
}

export const codeRename = defineOp({
  name: 'code.rename',
  group: 'code',
  title: 'Rename GDScript symbol',
  description: 'Godot code: rename a GDScript symbol across the project via the language server (skips comments/strings). dry_run previews.',
  input: z.object({
    ...positionFields,
    new_name: z.string().describe('New identifier.'),
    dry_run: z.boolean().default(false),
    include_comments: z.boolean().default(false).describe('Also rename matches in comments/strings.'),
  }),
  readOnly: false,
  destructive: false,
  idempotent: false,
  async run(args, ctx) {
    if (!isIdentifier(args.new_name)) throw new OpError('BAD_PARAMS', `"${args.new_name}" is not a valid GDScript identifier (letters, digits, _; not starting with a digit).`);
    const at = await locate(ctx, args, 'start');
    const session = await lspManagerFor(ctx.config).acquire(ctx);
    const doc = { textDocument: { uri: pathToFileUri(at.file.abs) }, position: { line: at.line, character: at.character } };

    const range = await session.client.request<LspRange | { range: LspRange } | null>('textDocument/prepareRename', doc);
    const r = range && 'range' in range ? range.range : range;
    if (!r) throw new OpError('BAD_PARAMS', `Nothing renameable at ${at.file.res}:${at.line + 1}:${at.character + 1}. Point at a symbol declared in the project (engine symbols can't be renamed); use "symbol" to give the identifier.`);
    const oldName = (at.lines[r.start.line] ?? '').slice(r.start.character, r.end.character);
    if (oldName === args.new_name) throw new OpError('BAD_PARAMS', `The symbol is already called "${oldName}".`);

    const edit = await session.client.request<{ changes?: Record<string, TextEdit[]>; documentChanges?: { textDocument: { uri: string }; edits: TextEdit[] }[] } | null>('textDocument/rename', { ...doc, newName: args.new_name });
    const byUri = new Map<string, TextEdit[]>();
    for (const [uri, edits] of Object.entries(edit?.changes ?? {})) byUri.set(uri, edits);
    for (const dc of edit?.documentChanges ?? []) byUri.set(dc.textDocument.uri, [...(byUri.get(dc.textDocument.uri) ?? []), ...dc.edits]);
    if (byUri.size === 0) throw new OpError('NOT_FOUND', `The language server found nothing to rename for "${oldName}".`);

    const skipped: { path: string; line: number; reason: string; text: string }[] = [];
    const planned: { file: ProjectPath; text: string; updated: string; lines: number[]; previews: { line: number; after: string }[] }[] = [];
    for (const [uri, edits] of byUri) {
      const res = toRes(session, uri);
      if (!res) {
        skipped.push({ path: uri, line: 0, reason: 'outside the project', text: '' });
        continue;
      }
      const file = await resolve(ctx, res);
      if (isInGodotCache(file)) continue;
      const text = await readFile(file.abs, 'utf8');
      const lines = text.split(/\r?\n/);
      const mask = GdMask.build(text);
      const keep: TextEdit[] = [];
      for (const e of edits) {
        const ln = e.range.start.line;
        const lineText = lines[ln] ?? '';
        const current = e.range.start.line === e.range.end.line ? lineText.slice(e.range.start.character, e.range.end.character) : undefined;
        if (current !== oldName) {
          // The file changed since the server parsed it, or an unexpected multi-line edit.
          skipped.push({ path: res, line: ln + 1, reason: 'text at the edit does not match the old name', text: lineText.trim() });
          continue;
        }
        const kind = mask.kindAt(ln, e.range.start.character);
        if (kind && !args.include_comments) {
          skipped.push({ path: res, line: ln + 1, reason: `inside a ${kind}`, text: lineText.trim().slice(0, 160) });
          continue;
        }
        keep.push(e);
      }
      if (keep.length === 0) continue;
      // Apply from the end so earlier offsets stay valid.
      keep.sort((a, b) => b.range.start.line - a.range.start.line || b.range.start.character - a.range.start.character);
      const out = [...lines];
      for (const e of keep) {
        const l = out[e.range.start.line]!;
        out[e.range.start.line] = l.slice(0, e.range.start.character) + e.newText + l.slice(e.range.end.character);
      }
      const eol = text.includes('\r\n') ? '\r\n' : '\n';
      const touched = [...new Set(keep.map((e) => e.range.start.line))].sort((a, b) => a - b);
      planned.push({ file, text, updated: out.join(eol), lines: touched.map((l) => l + 1), previews: touched.map((l) => ({ line: l + 1, after: out[l]!.trim().slice(0, 160) })) });
    }

    const files = planned.map((p) => ({ path: p.file.res, edits: p.lines.length, lines: p.lines, ...(args.dry_run ? { preview: p.previews.slice(0, 20) } : {}) }));
    const base = { old_name: oldName, new_name: args.new_name, files, ...(skipped.length ? { skipped } : {}) };
    if (args.dry_run) return { data: { dry_run: true, ...base } };

    for (const p of planned) await writeFile(p.file.abs, p.updated, 'utf8');
    // Tell whichever editor is involved about the new text (same as the files tools do).
    let editorRefreshed = false;
    if (ctx.bridge.isOpen()) {
      try {
        await ctx.bridge.request('filesystem.refresh', { paths: planned.map((p) => p.file.res) });
        editorRefreshed = true;
      } catch {
        // best effort
      }
    }
    await lspManagerFor(ctx.config).filesChanged(session, planned.map((p) => p.file.abs));
    return { data: { applied: true, ...base, editor_refreshed: editorRefreshed } };
  },
});

/** Operations in this area, in the order they should appear in tools/list. */
export const operations = [codeDiagnostics, codeSymbols, codeLookup, codeRename];
