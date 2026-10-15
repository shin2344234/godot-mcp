/**
 * Docs for the project's own classes: `class_name` scripts and autoloads, from their `##`
 * documentation comments.
 *
 * We parse the scripts in TypeScript instead of running
 * `godot --doctool <dir> --gdscript-docs res://`: no Godot process (instant, works without
 * an import), and the result is cached per file by mtime. The parser follows Godot's doc
 * comment rules closely enough for reference use:
 *   - class docs: the `##` block at the top of the script, before the first member (it
 *     may sit before or after `class_name` / `extends`); the first paragraph is the brief;
 *   - member docs: the `##` lines directly above a top-level `func`, `signal`, `var`,
 *     `const` or `enum` (annotation lines like `@export` may sit in between), or a trailing
 *     `## ...` on the declaration line;
 *   - `@tutorial`, `@deprecated`, `@experimental` lines are kept as text.
 * Only top-level members are listed (inner classes are skipped).
 */

import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { decodeString, readProjectSettings } from '../project/projectFile.js';
import type { DocClass, DocMember } from './model.js';

const SKIP_DIRS = new Set(['.godot', '.git', 'node_modules', '.import', '.mono', '.vs', '.idea']);
const MAX_SCRIPTS = 2000;

/** Parse one script's docs. `name` is the class_name, or the autoload name. */
export function parseScriptDocs(text: string, resPath: string, nameOverride?: string): DocClass | undefined {
  const lines = text.split(/\r?\n/);
  let className: string | undefined;
  let extendsName: string | undefined;
  const classDoc: string[] = [];
  let classDocDone = false;
  let pending: string[] = [];
  const members: DocMember[] = [];

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]!;
    // Top level only: indented lines belong to function bodies or inner classes.
    if (/^\s/.test(raw) && raw.trim() !== '') {
      pending = [];
      continue;
    }
    const line = raw.trim();
    const doc = /^##(?!#)\s?(.*)$/.exec(line);
    if (doc) {
      pending.push(doc[1]!);
      continue;
    }
    if (line === '' || line.startsWith('#')) {
      // A blank line ends a member doc block; at the top it may separate class doc paragraphs.
      if (line === '' && !classDocDone && pending.length) {
        classDoc.push(...pending, '');
        pending = [];
      }
      if (line === '' && classDocDone) pending = [];
      continue;
    }
    const cn = /^class_name\s+([A-Za-z_]\w*)(?:\s+extends\s+([\w."/:]+))?/.exec(line);
    if (cn) {
      className = cn[1];
      if (cn[2]) extendsName = cn[2];
      classDoc.push(...pending);
      pending = [];
      continue;
    }
    const ex = /^extends\s+([\w."/:]+)/.exec(line);
    if (ex) {
      extendsName = ex[1];
      classDoc.push(...pending);
      pending = [];
      continue;
    }
    if (/^@\w+(\(.*\))?\s*$/.test(line) && !/^@(export|onready)/.test(line) && !classDocDone) {
      // @tool, @icon(...), @abstract before the class header.
      continue;
    }
    // A member declaration (possibly after annotations on the same line).
    const decl = /^(?:@[\w]+(?:\([^)]*\))?\s+)*(static\s+)?(func|signal|var|const|enum|class)\s+([A-Za-z_]\w*)/.exec(line);
    if (decl) {
      if (!classDocDone) {
        classDocDone = true;
        // A doc block directly above the first member belongs to that member, not the class.
      }
      const kind = decl[2]!;
      const name = decl[3]!;
      const trailing = /(?:^|\s)##\s?(.*)$/.exec(line.replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g, '""'));
      const docText = [...pending, ...(trailing ? [trailing[1]!] : [])].join('\n').trim();
      pending = [];
      if (kind === 'class') continue;
      let sig = line.replace(/\s*##.*$/, '');
      if (kind === 'func') {
        // Signature may continue over several lines until the parentheses close.
        let j = i;
        let s = sig;
        while ((s.match(/\(/g)?.length ?? 0) > (s.match(/\)/g)?.length ?? 0) && j + 1 < lines.length) s += ' ' + lines[++j]!.trim();
        // Keep "func name(params) -> Ret", drop the ":" and any same-line body.
        const open = s.indexOf('(');
        let depth = 0;
        let close = -1;
        for (let c = open; c >= 0 && c < s.length; c++) {
          if (s[c] === '(') depth++;
          else if (s[c] === ')' && --depth === 0) {
            close = c;
            break;
          }
        }
        if (close !== -1) {
          const ret = /^\s*->\s*[^:]+/.exec(s.slice(close + 1))?.[0] ?? '';
          sig = (s.slice(0, close + 1) + ret).trim();
        }
      } else if (kind === 'enum') {
        let j = i;
        let s = sig;
        while (!s.includes('}') && j + 1 < lines.length) s += ' ' + lines[++j]!.trim();
        sig = s.replace(/\s+/g, ' ');
      }
      const k = kind === 'func' ? 'method' : kind === 'var' ? 'property' : kind === 'const' ? 'constant' : (kind as 'signal' | 'enum');
      members.push({ k, n: name, s: sig, ...(docText ? { d: docText } : {}) });
      continue;
    }
    // Anything else at top level (e.g. a stray statement) ends doc collection.
    pending = [];
  }

  const name = nameOverride ?? className;
  if (!name) return undefined;
  const docLines = trimBlank(classDoc);
  const blank = docLines.indexOf('');
  const brief = (blank === -1 ? docLines : docLines.slice(0, blank)).join('\n').trim();
  const desc = blank === -1 ? '' : docLines.slice(blank + 1).join('\n').trim();
  return {
    n: name,
    ...(extendsName ? { i: extendsName.replace(/^"|"$/g, '') } : { i: 'RefCounted' }),
    t: 'project',
    b: brief,
    d: desc,
    m: members,
    p: resPath,
  };
}

function trimBlank(lines: string[]): string[] {
  let a = 0;
  let b = lines.length;
  while (a < b && lines[a]!.trim() === '') a++;
  while (b > a && lines[b - 1]!.trim() === '') b--;
  return lines.slice(a, b);
}

const cache = new Map<string, { stamp: string; cls: DocClass | undefined }>();

/**
 * Docs of every class_name script and .gd autoload in the project (autoloads under their
 * autoload name when the script has no class_name).
 */
export async function loadProjectClasses(projectPath: string): Promise<DocClass[]> {
  const autoloads = new Map<string, string>(); // res path -> autoload name
  try {
    // Keys look like "autoload/GameState" -> "\"*res://game_state.gd\"" ("*" = singleton).
    for (const [key, raw] of await readProjectSettings(projectPath)) {
      if (!key.startsWith('autoload/')) continue;
      const p = (decodeString(raw) ?? raw).replace(/^\*/, '');
      if (p.endsWith('.gd')) autoloads.set(p, key.slice('autoload/'.length));
    }
  } catch {
    // No/invalid project.godot: just scan class_name scripts.
  }

  const out: DocClass[] = [];
  let scanned = 0;
  const walk = async (abs: string, rel: string): Promise<void> => {
    const entries = await readdir(abs, { withFileTypes: true }).catch(() => []);
    for (const e of entries) {
      if (scanned >= MAX_SCRIPTS) return;
      if (SKIP_DIRS.has(e.name)) continue;
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      const childAbs = path.join(abs, e.name);
      if (e.isDirectory()) {
        await walk(childAbs, childRel);
        continue;
      }
      if (!e.name.endsWith('.gd')) continue;
      scanned++;
      const res = `res://${childRel}`;
      const st = await stat(childAbs).catch(() => undefined);
      if (!st) continue;
      const stamp = `${st.mtimeMs}:${st.size}:${autoloads.get(res) ?? ''}`;
      let entry = cache.get(childAbs);
      if (!entry || entry.stamp !== stamp) {
        const text = await readFile(childAbs, 'utf8').catch(() => '');
        // Cheap pre-check: most scripts have neither class_name nor an autoload entry.
        const isAutoload = autoloads.has(res);
        const cls = /^class_name\s/m.test(text) || isAutoload ? parseScriptDocs(text, res) : undefined;
        entry = { stamp, cls: cls ?? (isAutoload ? parseScriptDocs(text, res, autoloads.get(res)) : undefined) };
        cache.set(childAbs, entry);
      }
      if (entry.cls) out.push(entry.cls);
    }
  };
  await walk(projectPath, '');
  return out;
}
