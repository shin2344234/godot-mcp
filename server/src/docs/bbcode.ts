/**
 * Godot class-reference BBCode -> Markdown.
 *
 * Descriptions in extension_api.json, the doc XML and the language server's nativeSymbol
 * are written in Godot's documentation BBCode (doc/class.xsd + editor_help.cpp):
 *   [b] [i] [u] [s] [code] [kbd] [codeblock] [codeblocks][gdscript][csharp] [br] [lb] [rb]
 *   [url=...] [center] [color=...] [font=...] and cross-references
 *   [ClassName] [method X] [member X] [signal X] [constant X] [enum X] [param X]
 *   [annotation X] [operator X] [theme_item X]
 * We emit plain CommonMark that models (and humans) read well: cross-references become
 * `inline code`, code blocks become fenced blocks (GDScript only: C# examples are dropped
 * to save tokens), and unknown tags are stripped while keeping their text.
 */

/** Remove the common leading whitespace of all non-blank lines (XML indentation). */
export function dedent(text: string): string {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  let min = Infinity;
  for (const l of lines) {
    if (!l.trim()) continue;
    const m = /^[\t ]*/.exec(l)![0].length;
    if (m < min) min = m;
  }
  if (!Number.isFinite(min) || min === 0) return text.replace(/\r\n/g, '\n');
  return lines.map((l) => l.slice(Math.min(min, /^[\t ]*/.exec(l)![0].length))).join('\n');
}

const REF_TAGS = new Set(['method', 'member', 'signal', 'constant', 'enum', 'param', 'annotation', 'operator', 'theme_item', 'constructor']);

export function bbcodeToMarkdown(input: string): string {
  if (!input) return '';
  let text = dedent(input).trim();

  // Fenced code first, so nothing inside them is touched by the inline rules.
  const blocks: string[] = [];
  const stash = (lang: string, body: string) => {
    blocks.push('```' + lang + '\n' + dedent(body).replace(/^\n+|\s+$/g, '') + '\n```');
    return `\u0000${blocks.length - 1}\u0000`;
  };
  // [codeblocks] holds [gdscript] and [csharp] variants: keep GDScript.
  text = text.replace(/\[codeblocks\]([\s\S]*?)\[\/codeblocks\]/g, (_m, inner: string) => {
    const gd = /\[gdscript[^\]]*\]([\s\S]*?)\[\/gdscript\]/.exec(inner);
    return gd ? stash('gdscript', gd[1]!) : '';
  });
  text = text.replace(/\[codeblock(?:\s+lang=(\w+))?[^\]]*\]([\s\S]*?)\[\/codeblock\]/g, (_m, lang: string | undefined, body: string) => stash(lang ?? 'gdscript', body));
  // Stray language sections outside [codeblocks].
  text = text.replace(/\[csharp[^\]]*\][\s\S]*?\[\/csharp\]/g, '');
  text = text.replace(/\[gdscript[^\]]*\]([\s\S]*?)\[\/gdscript\]/g, (_m, body: string) => stash('gdscript', body));

  // Inline code: protect its content too ([code][b][/code] must stay literal).
  const inlines: string[] = [];
  const stashInline = (s: string) => {
    inlines.push('`' + s.replace(/`/g, "'") + '`');
    return `\u0001${inlines.length - 1}\u0001`;
  };
  text = text.replace(/\[(?:code|kbd)\]([\s\S]*?)\[\/(?:code|kbd)\]/g, (_m, s: string) => stashInline(s.replace(/\[lb\]/g, '[').replace(/\[rb\]/g, ']')));

  // Cross references: [method Node.get_node] -> `Node.get_node()`.
  text = text.replace(/\[(\w+) ([^\]\s]+)\]/g, (m, tag: string, target: string) => {
    if (!REF_TAGS.has(tag)) return m;
    return stashInline(tag === 'method' || tag === 'constructor' ? `${target}()` : target);
  });
  // [url=https://x]label[/url] and [url]https://x[/url]
  // (Stashed so the class-reference rule below doesn't see "[label]".)
  const stashRaw = (s: string) => {
    inlines.push(s);
    return `\u0001${inlines.length - 1}\u0001`;
  };
  text = text.replace(/\[url=([^\]]+)\]([\s\S]*?)\[\/url\]/g, (_m, href: string, label: string) => stashRaw(`[${label}](${href})`));
  text = text.replace(/\[url\]([\s\S]*?)\[\/url\]/g, (_m, href: string) => stashRaw(`<${href}>`));
  // Emphasis.
  text = text.replace(/\[b\]([\s\S]*?)\[\/b\]/g, '**$1**');
  text = text.replace(/\[i\]([\s\S]*?)\[\/i\]/g, '*$1*');
  text = text.replace(/\[s\]([\s\S]*?)\[\/s\]/g, '~~$1~~');
  text = text.replace(/\[br\]/g, '\n');
  // Class references: [Node2D], [@GDScript], [@GlobalScope], [int].
  text = text.replace(/\[(@?[A-Za-z_][A-Za-z0-9_]*)\]/g, (m, name: string) => {
    if (/^(b|i|u|s|center|code|kbd|br|lb|rb|url|codeblock|codeblocks|gdscript|csharp|color|font|img|indent)$/.test(name)) return m;
    return stashInline(name);
  });
  // Purely visual tags: drop the tag, keep the text.
  text = text.replace(/\[\/?(?:u|center|indent|color(?:=[^\]]*)?|font(?:=[^\]]*)?|font_size(?:=[^\]]*)?|img[^\]]*)\]/g, '');
  text = text.replace(/\[lb\]/g, '[').replace(/\[rb\]/g, ']');

  text = text.replace(/\u0001(\d+)\u0001/g, (_m, i: string) => inlines[Number(i)]!);
  // Block placeholders on their own lines so the fences render.
  text = text.replace(/\n?\u0000(\d+)\u0000\n?/g, (_m, i: string) => `\n${blocks[Number(i)]!}\n`);
  return text.replace(/\n{3,}/g, '\n\n').trim();
}

/** First sentence of a description as plain-ish one-line text (for briefs in lists). */
export function firstSentence(markdown: string, max = 120): string {
  const flat = markdown.split(/\n```/)[0]!.replace(/\s+/g, ' ').trim();
  const m = /^(.+?[.!?])(\s|$)/.exec(flat);
  let s = m ? m[1]! : flat;
  if (s.length > max) s = s.slice(0, max - 3).trimEnd() + '...';
  return s;
}
