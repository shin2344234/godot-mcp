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

// ---------------------------------------------------------------------------------------
// Declaration details for code.symbols

/**
 * Repairs the `detail` Godot 4.7's language server gives a func, signal, var or const
 * (textDocument/documentSymbol), using the script's own text. Two gaps, verified on 4.7.2
 * (MCP_TEST_LOG Phase A, godot_code_symbols):
 *   - a default value that is not a String is written as a quoted string of the Variant's
 *     text form: `func take_hit(knockback: Vector2 = "(0.0, -180.0)")`,
 *     `var tint: Color = "(1.0, 0.0, 0.0, 1.0)"` (for `Color.RED`). Such a default is
 *     replaced by the expression written in the source (`Vector2(0, -180)`, `Color.RED`);
 *   - signal parameters lose their types: `signal damaged(lives_left)` for
 *     `signal damaged(lives_left: int)`, and the symbol has no parameter children to
 *     recover them from. The parameter list is taken from the source.
 * Everything else Godot reports is kept (inferred types such as `b := 2` -> `b: int = 2`,
 * the return type). When the source doesn't line up with the detail (an unsaved edit, an
 * odd layout), the detail comes back unchanged. `line` is the 0-based line of the name.
 */
export function fixDeclDetail(detail: string, kind: string, name: string, lines: string[], line: number): string {
  if (!['func', 'signal', 'var', 'const'].includes(kind)) return detail;
  const first = lines[line];
  if (first === undefined) return detail;
  const col = findIdentifier(first, name)[0];
  if (col === undefined) return detail;
  // The declaration from its name on, comments removed (a signature may span lines).
  const src = stripComments([first.slice(col), ...lines.slice(line + 1, line + 40)].join('\n'));
  let at = name.length;
  while (at < src.length && /[ \t]/.test(src[at]!)) at++;

  if (kind === 'signal' || kind === 'func') {
    if (src[at] !== '(') return detail;
    const srcParams = splitParams(src, at + 1, false);
    if (!srcParams) return detail;
    if (kind === 'signal') return `signal ${name}(${srcParams.parts.join(', ')})`;
    const open = detail.indexOf('(', detail.indexOf(name));
    const lspParams = open === -1 ? undefined : splitParams(detail, open + 1, true);
    if (!lspParams || lspParams.parts.length !== srcParams.parts.length) return detail;
    const fixed = lspParams.parts.map((p, i) => fixDefault(p, sourceDefault(srcParams.parts[i]!, true)));
    return detail.slice(0, open + 1) + fixed.join(', ') + detail.slice(lspParams.end);
  }
  // var / const: `name [: Type] (= | :=) expr [: property block]`.
  return fixDefault(detail, sourceDefault(src.slice(name.length), false));
}

/** Text with `#` comments removed (strings and line breaks kept). */
function stripComments(text: string): string {
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (c === '#') {
      while (i + 1 < text.length && text[i + 1] !== '\n') i++;
      continue;
    }
    if (c === '"' || c === "'") {
      const end = stringEnd(text, i);
      out += text.slice(i, end);
      i = end - 1;
      continue;
    }
    out += c;
  }
  return out;
}

/** Index just after the string literal starting at `i` (triple quotes, escapes). */
function stringEnd(text: string, i: number): number {
  const c = text[i]!;
  const quote = text.startsWith(c.repeat(3), i) ? c.repeat(3) : c;
  for (let j = i + quote.length; j < text.length; j++) {
    if (text[j] === '\\') {
      j++;
      continue;
    }
    if (text.startsWith(quote, j)) return j + quote.length;
    // An unterminated one-quote string ends at the line end, as in GdMask.
    if (quote.length === 1 && text[j] === '\n') return j;
  }
  return text.length;
}

/**
 * Comma-separated items from just after an opening "(" up to its closing ")" (at `end`),
 * whitespace collapsed, a trailing comma dropped. `detailText`: the text is a language
 * server detail, where only "..." is a string (Godot writes every string default with
 * double quotes, so an apostrophe there is just a character). Undefined when the
 * parenthesis is never closed.
 */
function splitParams(text: string, from: number, detailText: boolean): { parts: string[]; end: number } | undefined {
  const parts: string[] = [];
  let depth = 0;
  let start = from;
  const push = (end: number) => {
    const p = text.slice(start, end).replace(/\s+/g, ' ').trim();
    if (p) parts.push(p);
  };
  for (let i = from; i < text.length; i++) {
    const c = text[i]!;
    if (c === '"' || (c === "'" && !detailText)) {
      i = stringEnd(text, i) - 1;
    } else if (c === '(' || c === '[' || c === '{') {
      depth++;
    } else if (c === ')' || c === ']' || c === '}') {
      if (depth === 0) {
        push(i);
        return { parts, end: i };
      }
      depth--;
    } else if (c === ',' && depth === 0) {
      push(i);
      start = i + 1;
    }
  }
  return undefined;
}

/**
 * The default expression of a parameter (`a: int = 3`, `b := 2`), or of a var/const from
 * just after its name, where it ends at a top-level ":" (a property block: `= 3:` or
 * `= 3: set = f`) or the line end. Undefined when there is none.
 */
function sourceDefault(decl: string, param: boolean): string | undefined {
  let depth = 0;
  let eq = -1;
  let end = decl.length;
  for (let i = 0; i < decl.length; i++) {
    const c = decl[i]!;
    if (c === '"' || c === "'") {
      i = stringEnd(decl, i) - 1;
    } else if (c === '(' || c === '[' || c === '{') {
      depth++;
    } else if (c === ')' || c === ']' || c === '}') {
      depth--;
    } else if (depth === 0 && eq === -1 && c === '=') {
      eq = i;
    } else if (depth === 0 && !param && (c === '\n' || (c === ':' && eq !== -1))) {
      // A var/const ends at the line end (outside brackets) or at its property block.
      // Before the "=", a ":" is the type annotation (`x: int = 3`, `x := 3`).
      end = i;
      break;
    }
  }
  if (eq === -1 || eq > end) return undefined;
  return decl.slice(eq + 1, end).replace(/\s+/g, ' ').trim() || undefined;
}

/**
 * When `lsp` ends in `= "..."` (Godot quoting a non-String default), use the source
 * expression instead, unless that is itself a string literal ("x", 'x', &"x", ^"x", r"x"):
 * then the quoted text is right.
 */
function fixDefault(lsp: string, source: string | undefined): string {
  if (!source || /^[&^r]?["']/.test(source)) return lsp;
  const m = /^([\s\S]*?\s=\s)"(?:[^"\\]|\\.)*"$/.exec(lsp);
  return m ? m[1] + source : lsp;
}
