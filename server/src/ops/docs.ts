/**
 * Offline Godot class reference (docs.search / docs.class).
 *
 * Engine docs come from the index built from the user's own Godot binary
 * (src/docs/docIndex.ts: `--dump-extension-api-with-docs`, cached per version, plus the
 * bundled @GDScript reference); the project's own `class_name` scripts and autoloads come
 * from their `##` doc comments (src/docs/projectDocs.ts). Neither needs the editor, a
 * project import, or the network: only the Godot binary.
 */

import { z } from 'zod';
import { bbcodeToMarkdown, firstSentence } from '../docs/bbcode.js';
import { loadDocIndex } from '../docs/docIndex.js';
import type { DocClass, DocIndex, DocMember } from '../docs/model.js';
import { loadProjectClasses } from '../docs/projectDocs.js';
import { DocSearcher, type SearchHit, type SearchKind } from '../docs/search.js';
import { OpError } from '../errors.js';
import { defineOp, type OpContext } from './types.js';

const engineSearchers = new WeakMap<DocIndex, DocSearcher>();

/** Engine + project searchers (the project one falls back to the engine for lookups). */
async function searchers(ctx: OpContext): Promise<{ engine: DocSearcher; project: DocSearcher; version: string }> {
  const index = await loadDocIndex({ godotPath: ctx.config.godotPath, progress: ctx.progress });
  let engine = engineSearchers.get(index);
  if (!engine) {
    engine = new DocSearcher(index.classes);
    engineSearchers.set(index, engine);
  }
  const project = new DocSearcher(await loadProjectClasses(ctx.config.projectPath), engine);
  return { engine, project, version: index.version };
}

/** "Node2D.position" -> class + member when the prefix is a known class. */
function splitClassQuery(project: DocSearcher, q: string): { cls: DocClass; member: string } | undefined {
  const m = /^(@?[A-Za-z_]\w*)\.(\w*)$/.exec(q.trim());
  if (!m) return undefined;
  const cls = project.getClass(m[1]!);
  return cls ? { cls, member: m[2]! } : undefined;
}

const KINDS = ['class', 'method', 'property', 'signal', 'constant', 'enum', 'annotation', 'utility'] as const;

export const docsSearch = defineOp({
  name: 'docs.search',
  group: 'docs',
  title: 'Search Godot docs',
  description: 'Godot docs: search the offline class reference (engine + project classes) by class/member name or words.',
  input: z.object({
    query: z.string().min(1).describe('e.g. "move_and_slide", "Timer", "Node2D.rot", "play sound".'),
    kind: z.enum(KINDS).optional(),
    limit: z.number().int().min(1).max(100).default(20),
  }),
  readOnly: true,
  idempotent: true,
  async run({ query, kind, limit }, ctx) {
    const { engine, project, version } = await searchers(ctx);
    const split = splitClassQuery(project, query);
    let hits: SearchHit[];
    if (split) {
      const names = new Set(project.chain(split.cls).map((c) => c.n));
      hits = [...project.search(split.member, kind as SearchKind, limit, names), ...engine.search(split.member, kind as SearchKind, limit, names)];
    } else {
      hits = [...project.search(query, kind as SearchKind, limit), ...engine.search(query, kind as SearchKind, limit)];
    }
    hits.sort((a, b) => b.score - a.score);
    // Same rule as inside each searcher, across both: name matches beat brief mentions.
    if (hits.length && hits[0]!.score >= 55) hits = hits.filter((h) => h.score >= 30);
    const out = hits.slice(0, limit).map(({ score: _s, ...h }) => h);
    return {
      data: {
        godot_version: version,
        count: out.length,
        hits: out,
        ...(out.length === 0 ? { hint: 'No match. Try a shorter name fragment, other words, or drop "kind".' } : {}),
      },
    };
  },
});

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max).trimEnd()} ... (truncated; raise max_chars for more)` : s;
}

/** "func get_node(path: NodePath) -> Node" -> "get_node(path: NodePath) -> Node" */
function shortSig(m: DocMember): string {
  return (m.s ?? m.n).replace(/^(?:static\s+)?func\s+/, (x) => (x.startsWith('static') ? 'static ' : ''));
}

const GROUP: Record<DocMember['k'], string> = {
  constructor: 'constructors',
  property: 'properties',
  method: 'methods',
  signal: 'signals',
  enum: 'enums',
  constant: 'constants',
  annotation: 'annotations',
  utility: 'functions',
};

export const docsClass = defineOp({
  name: 'docs.class',
  group: 'docs',
  title: 'Godot class docs',
  description: 'Godot docs: class reference for an engine or project class, or one member ("Class.member"), as markdown.',
  input: z.object({
    name: z.string().min(1).describe('e.g. "CharacterBody2D", "Node.add_child", "@GDScript.preload", a project class_name.'),
    members: z.boolean().default(false).describe('List members with one-line briefs.'),
    inherited: z.boolean().default(false).describe('Also list inherited member names.'),
    max_chars: z.number().int().min(200).max(50_000).default(4000),
  }),
  readOnly: true,
  idempotent: true,
  async run({ name, members, inherited, max_chars }, ctx) {
    const { engine, project, version } = await searchers(ctx);
    const q = name.trim();
    let cls = project.getClass(q);
    let memberName: string | undefined;
    if (!cls) {
      const split = splitClassQuery(project, q);
      if (split) {
        cls = split.cls;
        memberName = split.member;
      } else {
        // Dotted global enum names like "Variant.Type" live in @GlobalScope.
        const g = engine.getClass('@GlobalScope');
        if (g && g.m.some((m) => m.n === q)) {
          cls = g;
          memberName = q;
        }
      }
    }
    if (!cls) {
      const asMember = engine.search(q, undefined, 50).filter((h) => h.member && h.member.toLowerCase() === q.toLowerCase());
      const owners = [...new Set(asMember.map((h) => h.class))].slice(0, 6);
      const suggestions = project.suggestClasses(q);
      throw new OpError(
        'NOT_FOUND',
        `No class "${q}" in the Godot ${version} reference or the project.` +
          (owners.length ? ` "${q}" is a member of: ${owners.join(', ')}; ask for e.g. "${owners[0]}.${asMember[0]!.member}".` : '') +
          (suggestions.length ? ` Did you mean: ${suggestions.join(', ')}?` : ' Use godot_docs_search to find it.'),
      );
    }

    const chain = project.chain(cls);
    if (memberName !== undefined) {
      const found = project.findMember(cls, memberName);
      if (!found) {
        const names = new Set(chain.map((c) => c.n));
        const near = [...project.search(memberName, undefined, 5, names), ...engine.search(memberName, undefined, 5, names)]
          .sort((a, b) => b.score - a.score)
          .slice(0, 5)
          .map((h) => h.member);
        throw new OpError('NOT_FOUND', `${cls.n} has no member "${memberName}" (searched its ancestors too).${near.length ? ` Close matches: ${near.join(', ')}.` : ''}`);
      }
      const { owner } = found;
      const items = found.members.map((m) => {
        const values = m.k === 'enum' ? owner.m.filter((v) => v.e === m.n).map((v) => `${v.n} = ${(v.s ?? '').split('= ')[1] ?? ''}${v.d ? `: ${firstSentence(bbcodeToMarkdown(v.d), 100)}` : ''}`) : undefined;
        return {
          kind: m.k,
          signature: m.s ?? m.n,
          description: truncate(bbcodeToMarkdown(m.d ?? ''), max_chars) || '(no description)',
          ...(m.e ? { enum: m.e } : {}),
          ...(values ? { values } : {}),
        };
      });
      return {
        data: {
          class: owner.n,
          member: found.members[0]!.n,
          ...(owner !== cls ? { declared_in: owner.n, requested: cls.n } : {}),
          ...(owner.p ? { path: owner.p } : {}),
          ...(items.length === 1 ? items[0] : { matches: items }),
        },
      };
    }

    const data: Record<string, unknown> = {
      name: cls.n,
      kind: cls.t,
      ...(cls.p ? { path: cls.p } : {}),
      ...(chain.length > 1 ? { inherits: chain.slice(1).map((c) => c.n) } : cls.i ? { inherits: [cls.i] } : {}),
      ...(cls.a ? { editor_only: true } : {}),
      brief: bbcodeToMarkdown(cls.b),
      description: truncate(bbcodeToMarkdown(cls.d), max_chars),
      godot_version: version,
    };
    if (members) {
      // Own members with briefs, grouped by kind; capped so a huge class (@GlobalScope,
      // Control) can't flood the context.
      const budget = max_chars * 4;
      let used = 0;
      let truncated = false;
      const groups: Record<string, string[]> = {};
      for (const m of cls.m) {
        if (m.k === 'constant' && m.e) continue; // listed inside its enum
        const brief = m.d ? firstSentence(bbcodeToMarkdown(m.d), 90) : '';
        let line = m.k === 'enum' ? (m.s ?? m.n) : shortSig(m);
        if (line.length > 300) line = line.slice(0, 297) + '...';
        if (brief) line += ` -- ${brief}`;
        if (used + line.length > budget) {
          truncated = true;
          break;
        }
        used += line.length;
        (groups[GROUP[m.k]] ??= []).push(line);
      }
      data.members = groups;
      if (truncated) data.members_truncated = 'raise max_chars, or ask for single members with "Class.member"';
    } else {
      data.member_counts = Object.fromEntries(Object.entries(countKinds(cls.m)).filter(([, n]) => n > 0));
    }
    if (inherited && chain.length > 1) {
      const inh: Record<string, string> = {};
      for (const anc of chain.slice(1)) {
        // Property accessors (set_x/get_x/is_x for property x) only repeat the property.
        const props = new Set(anc.m.filter((m) => m.k === 'property').map((m) => m.n));
        const accessor = (n: string) => /^(?:set|get|is)_(.+)$/.exec(n)?.[1];
        const names = anc.m
          .filter((m) => m.k === 'property' || m.k === 'signal' || (m.k === 'method' && !props.has(accessor(m.n) ?? '')))
          .map((m) => (m.k === 'method' ? `${m.n}()` : m.k === 'signal' ? `signal ${m.n}` : m.n));
        if (names.length) inh[anc.n] = names.join(', ');
      }
      data.inherited = inh;
    }
    return { data };
  },
});

function countKinds(ms: DocMember[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const m of ms) {
    if (m.k === 'constant' && m.e) continue;
    out[GROUP[m.k]] = (out[GROUP[m.k]] ?? 0) + 1;
  }
  return out;
}

/** Operations in this area, in the order they should appear in tools/list. */
export const operations = [docsSearch, docsClass];
