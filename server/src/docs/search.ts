/**
 * Search and lookup over the docs index (engine classes + project classes).
 *
 * Ranking (higher is better), per class or member entry:
 *   exact name 100 > name prefix 80 > name substring 60 > all query words found in the
 *   name/brief 20-40; then small nudges: classes over members for equal scores, project
 *   classes up (+8, they're what the user is working on), editor-only classes down (-10),
 *   shorter names first. "Class.member" queries search that class's members only.
 * The query is matched case-insensitively; underscores and spaces are interchangeable in
 * word matching ("move and slide" finds move_and_slide).
 */

import { bbcodeToMarkdown, firstSentence } from './bbcode.js';
import type { DocClass, DocMember, MemberKind } from './model.js';

export type SearchKind = 'class' | MemberKind;

export interface SearchHit {
  class: string;
  member?: string;
  kind: SearchKind;
  brief: string;
  score: number;
}

interface Entry {
  cls: DocClass;
  member?: DocMember;
  kind: SearchKind;
  name: string; // lowercased
  text: string; // lowercased name + brief, for word queries
}

/** A searchable view of a set of classes (build once per index, reuse). */
export class DocSearcher {
  private entries: Entry[] = [];
  readonly byName = new Map<string, DocClass>();
  private byLower = new Map<string, DocClass>();

  /**
   * @param fallback another searcher consulted for class lookups (the engine index, when
   *   this one holds the project's classes), so inheritance chains cross from project
   *   scripts into engine classes.
   */
  constructor(
    classes: DocClass[],
    private readonly fallback?: DocSearcher,
  ) {
    for (const c of classes) {
      // Project classes shadow nothing: an engine class with the same name wins lookups,
      // because Godot itself refuses a class_name that hides a native class.
      if (!this.byName.has(c.n)) this.byName.set(c.n, c);
      if (!this.byLower.has(c.n.toLowerCase())) this.byLower.set(c.n.toLowerCase(), c);
      this.entries.push({ cls: c, kind: 'class', name: c.n.toLowerCase(), text: `${c.n} ${plainBrief(c.b)}`.toLowerCase() });
      for (const m of c.m) {
        this.entries.push({ cls: c, member: m, kind: m.k, name: m.n.toLowerCase(), text: `${m.n} ${m.e ?? ''} ${plainBrief(m.d ?? '')}`.toLowerCase() });
      }
    }
  }

  /** Case-insensitive class lookup. */
  getClass(name: string): DocClass | undefined {
    return this.fallback?.byName.get(name) ?? this.byName.get(name) ?? this.fallback?.getClass(name) ?? this.byLower.get(name.toLowerCase());
  }

  /** The class and its ancestors, nearest first (stops at unknown parents). */
  chain(cls: DocClass): DocClass[] {
    const out: DocClass[] = [cls];
    const seen = new Set([cls.n]);
    let cur = cls;
    while (cur.i) {
      // Project scripts may extend a path ("res://base.gd") or another class_name.
      const parentName = cur.i;
      const parent = this.getClass(parentName) ?? [...this.byName.values()].find((c) => c.p === parentName);
      if (!parent || seen.has(parent.n)) break;
      seen.add(parent.n);
      out.push(parent);
      cur = parent;
    }
    return out;
  }

  /** Find `member` in the class or (when `inherited`) its ancestors. */
  findMember(cls: DocClass, member: string, inherited = true): { owner: DocClass; members: DocMember[] } | undefined {
    const lower = member.toLowerCase();
    for (const c of inherited ? this.chain(cls) : [cls]) {
      let ms = c.m.filter((m) => m.n === member);
      if (ms.length === 0) ms = c.m.filter((m) => m.n.toLowerCase() === lower);
      if (ms.length) return { owner: c, members: ms };
    }
    return undefined;
  }

  /**
   * Ranked hits for `query`. `onlyClasses` restricts the search to members of those
   * classes (used for "Class.member" queries, see splitClassQuery).
   */
  search(query: string, kind: SearchKind | undefined, limit: number, onlyClasses?: Set<string>): SearchHit[] {
    const needle = query.trim().toLowerCase();
    if (!needle && !onlyClasses) return [];
    const pool = onlyClasses ? this.entries.filter((e) => e.member && onlyClasses.has(e.cls.n)) : this.entries;
    // Word matching only for multi-word queries ("play sound", "move and slide");
    // a single identifier like "move_and_slide" must match names.
    const words = /\s/.test(needle) ? needle.split(/\s+/).filter(Boolean) : [needle];
    const compact = needle.replace(/\s+/g, '_');
    let hits: SearchHit[] = [];
    for (const e of pool) {
      if (kind && !kindMatches(e.kind, kind)) continue;
      let score = 0;
      if (!needle) score = 50;
      else if (e.name === compact) score = 100;
      else if (e.name.startsWith(compact)) score = 80;
      else if (e.name.includes(compact)) score = 60;
      else if (words.length > 1 && words.every((w) => e.text.includes(w))) {
        score = 20 + 5 * words.filter((w) => e.name.includes(w)).length;
      } else if (words.length === 1 && needle.length >= 4 && e.text.includes(` ${needle}`)) {
        score = 15; // mentioned in the brief
      }
      if (score === 0) continue;
      if (e.kind === 'class') score += 2;
      if (e.cls.t === 'project') score += 8;
      if (e.cls.a === 'editor') score -= 10;
      score -= Math.min(e.name.length, 40) / 100;
      hits.push({ class: e.cls.n, ...(e.member ? { member: e.member.n } : {}), kind: e.kind, brief: '', score, entry: e } as SearchHit & { entry: Entry });
    }
    hits.sort((a, b) => b.score - a.score || a.class.length - b.class.length || a.class.localeCompare(b.class));
    // With real name matches, brief-only mentions are noise.
    if (hits.length && hits[0]!.score >= 55) hits = hits.filter((h) => h.score >= 30);
    // Briefs only for what we return (conversion is the expensive part).
    return hits.slice(0, limit).map((h) => {
      const e = (h as SearchHit & { entry: Entry }).entry;
      const raw = e.member ? (e.member.d ?? e.member.s ?? '') : e.cls.b || e.cls.d;
      return { class: h.class, ...(h.member ? { member: h.member } : {}), kind: h.kind, brief: firstSentence(bbcodeToMarkdown(raw)), score: Math.round(h.score) };
    });
  }

  /** Did-you-mean suggestions for an unknown class name. */
  suggestClasses(name: string, max = 5): string[] {
    const lower = name.toLowerCase();
    const scored: [string, number][] = [];
    const all = [...this.byName.values(), ...(this.fallback ? this.fallback.byName.values() : [])];
    for (const c of all) {
      const n = c.n.toLowerCase();
      const d = n.includes(lower) || lower.includes(n) ? 0 : levenshtein(lower, n);
      if (d <= Math.max(2, Math.floor(lower.length / 3))) scored.push([c.n, d + Math.abs(n.length - lower.length) / 100]);
    }
    return scored.sort((a, b) => a[1] - b[1]).slice(0, max).map(([n]) => n);
  }
}

function kindMatches(entryKind: SearchKind, wanted: SearchKind): boolean {
  if (entryKind === wanted) return true;
  // Builtin constructors are methods for filtering purposes.
  return wanted === 'method' && entryKind === 'constructor';
}

/** Strip BBCode for word matching (cheap: no Markdown conversion). */
function plainBrief(bb: string): string {
  const first = bb.split('\n')[0] ?? '';
  return first.replace(/\[\/?[a-z_]+(?:[= ][^\]]*)?\]/g, ' ').replace(/[[\]]/g, ' ').slice(0, 200);
}

function levenshtein(a: string, b: string): number {
  if (Math.abs(a.length - b.length) > 6) return 99;
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0]!;
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j]!;
      prev[j] = Math.min(prev[j]! + 1, prev[j - 1]! + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = tmp;
    }
  }
  return prev[b.length]!;
}
