/**
 * Managed blocks inside user-owned files (AGENTS.md, CLAUDE.md).
 *
 * We only ever touch the text between our own markers, the same pattern
 * Next.js and Nx use for their agent rules:
 *
 *   <!-- BEGIN:godot-mcp -->
 *   ...generated...
 *   <!-- END:godot-mcp -->
 *
 * Re-running replaces just that block; everything the user wrote stays
 * byte-for-byte identical. If the markers aren't there yet, the block is
 * appended (or prepended, for CLAUDE.md imports that must come first).
 */

export const BEGIN = '<!-- BEGIN:godot-mcp -->';
export const END = '<!-- END:godot-mcp -->';

export function hasBlock(text: string): boolean {
  return text.includes(BEGIN) && text.includes(END);
}

/** Insert or replace our block. `position` applies only when inserting. */
export function upsertBlock(text: string, content: string, position: 'start' | 'end' = 'end'): string {
  const block = `${BEGIN}\n${content.trim()}\n${END}`;
  if (hasBlock(text)) {
    const start = text.indexOf(BEGIN);
    const end = text.indexOf(END, start) + END.length;
    return text.slice(0, start) + block + text.slice(end);
  }
  if (text.trim() === '') return block + '\n';
  if (position === 'start') return `${block}\n\n${text}`;
  return `${text.replace(/\s*$/, '')}\n\n${block}\n`;
}

/** Remove our block (and the blank lines we added around it). */
export function removeBlock(text: string): string {
  if (!hasBlock(text)) return text;
  const start = text.indexOf(BEGIN);
  const end = text.indexOf(END, start) + END.length;
  const before = text.slice(0, start).replace(/\n*$/, '');
  const after = text.slice(end).replace(/^\n*/, '');
  if (!before) return after;
  if (!after) return before + '\n';
  return `${before}\n\n${after}`;
}
