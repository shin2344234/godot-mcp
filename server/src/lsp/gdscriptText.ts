/**
 * Small GDScript text helpers for the code.* tools (no Godot needed).
 *
 * The main job: tell which character ranges of a script are comments or string literals.
 * Godot 4.7's language server finds references and rename targets by TEXT-searching every
 * .gd file for the identifier and then resolving each hit, and a hit inside a comment (or
 * string) can resolve to the symbol too (verified: `class_name Enemy` returned a hit inside
 * a `##` doc comment). code.rename drops such edits by default and code.lookup marks such
 * references, using this scanner.
 *
 * Lexing rules covered (enough for masking, not a full tokenizer):
 *   - `#` starts a comment to the end of the line (includes `##` doc comments and `#region`)
 *     unless it is inside a string;
 *   - strings: "..." '...' and triple-quoted """...""" '''...''' (may span lines); prefixes
 *     r (raw), & (StringName), ^ (NodePath), $ / % (node shorthand) don't change where the
 *     literal ends; a backslash always protects the next character from ending the
 *     literal (also in raw strings, where `r"\""` is one string).
 * Columns are JavaScript string indexes, which equal Godot's LSP character offsets for
 * every character outside the astral planes (emoji in a line before the symbol would shift
 * them).
 */

export type MaskKind = 'comment' | 'string';

interface Span {
  start: number;
  end: number; // exclusive
  kind: MaskKind;
}

/** Per-line spans of comments and strings, for quick position lookups. */
export class GdMask {
  private constructor(private readonly lines: Span[][]) {}

  static build(text: string): GdMask {
    const src = text.split(/\r?\n/);
    const lines: Span[][] = src.map(() => []);
    // State carried across lines for triple-quoted strings.
    let openTriple: string | undefined;
    for (let ln = 0; ln < src.length; ln++) {
      const line = src[ln]!;
      let i = 0;
      if (openTriple) {
        const end = findStringEnd(line, 0, openTriple);
        if (end === -1) {
          lines[ln]!.push({ start: 0, end: line.length, kind: 'string' });
          continue;
        }
        lines[ln]!.push({ start: 0, end, kind: 'string' });
        openTriple = undefined;
        i = end;
      }
      while (i < line.length) {
        const c = line[i]!;
        if (c === '#') {
          lines[ln]!.push({ start: i, end: line.length, kind: 'comment' });
          break;
        }
        if (c === '"' || c === "'") {
          const triple = line.startsWith(c.repeat(3), i);
          const quote = triple ? c.repeat(3) : c;
          const end = findStringEnd(line, i + quote.length, quote);
          if (end === -1) {
            lines[ln]!.push({ start: i, end: line.length, kind: 'string' });
            if (triple) openTriple = quote;
            break; // an unterminated single-quoted string ends at the line end
          }
          lines[ln]!.push({ start: i, end, kind: 'string' });
          i = end;
          continue;
        }
        i++;
      }
    }
    return new GdMask(lines);
  }

  /** 'comment' / 'string' when (0-based line, character) is inside one, else undefined. */
  kindAt(line: number, character: number): MaskKind | undefined {
    for (const s of this.lines[line] ?? []) if (character >= s.start && character < s.end) return s.kind;
    return undefined;
  }
}

/** Index just after the closing `quote` starting the search at `from`, or -1. */
function findStringEnd(line: string, from: number, quote: string): number {
  for (let i = from; i < line.length; i++) {
    if (line[i] === '\\') {
      i++;
      continue;
    }
    if (line.startsWith(quote, i)) return i + quote.length;
  }
  return -1;
}

const IDENT = /[A-Za-z0-9_]/;

/**
 * Start columns of `word` occurring as a whole identifier in `line` (or, with `prefix`,
 * as the start of an identifier).
 */
export function findIdentifier(line: string, word: string, prefix = false): number[] {
  const out: number[] = [];
  if (!word) return out;
  let i = line.indexOf(word);
  while (i !== -1) {
    const before = i > 0 ? line[i - 1]! : '';
    const after = line[i + word.length] ?? '';
    if (!IDENT.test(before) && (prefix || !IDENT.test(after))) out.push(i);
    i = line.indexOf(word, i + 1);
  }
  return out;
}

/** True for a valid GDScript identifier (ASCII subset; what rename targets need). */
export function isIdentifier(name: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name);
}

/**
 * Why code.lookup completion came back empty, as a hint for the model (MCP_TEST_LOG: line
 * 24, column 1 gave 0 items and no explanation). `total` is what Godot returned before
 * prefix filtering, `matching` what is left after it; `line`/`character` are 0-based.
 */
export function completionHint(text: string, line: number, character: number, total: number, matching: number, prefix: string): string | undefined {
  if (matching > 0) return undefined;
  if (total > 0) return `None of the ${total} items Godot offers here starts with or contains "${prefix}". Check the spelling, or point before it to see everything in scope.`;
  const mask = GdMask.build(text);
  // At the end of a comment the cursor sits just past its last character.
  const kind = mask.kindAt(line, character) ?? (character > 0 ? mask.kindAt(line, character - 1) : undefined);
  if (kind) return `The position is inside a ${kind}; Godot offers no completion there.`;
  const lineText = text.split(/\r?\n/)[line] ?? '';
  // Script level (no indentation): Godot completes inside function bodies and after a "."
  // or a partial identifier; between declarations it has nothing to offer.
  if (!/^\s/.test(lineText) && lineText.slice(0, character).trim() === '') {
    return 'No completion context: the position is at script level, outside any function. Point inside a function body, after a partial identifier or a "." (e.g. symbol "velocity" or "position.").';
  }
  return 'Godot offered no completion here. Point right after a partial identifier or a "." inside a function; a parse error earlier in the file also stops completion (see godot_code_diagnostics).';
}
