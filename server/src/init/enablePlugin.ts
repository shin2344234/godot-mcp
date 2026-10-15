/**
 * Enabling (or disabling) the editor plugin in project.godot.
 *
 * Godot stores enabled plugins as
 *
 *   [editor_plugins]
 *   enabled=PackedStringArray("res://addons/a/plugin.cfg", "res://addons/godot_mcp/plugin.cfg")
 *
 * This is the one place we edit project.godot as text, because it happens
 * before Godot is involved at all (the user may not have opened the editor
 * yet). The edit is minimal: only that one line/section changes.
 */

export const PLUGIN_CFG = 'res://addons/godot_mcp/plugin.cfg';

function readList(line: string): string[] {
  return [...line.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1]!);
}

function writeList(items: string[]): string {
  return `enabled=PackedStringArray(${items.map((i) => `"${i}"`).join(', ')})`;
}

/** Return project.godot text with our plugin enabled (unchanged if already enabled). */
export function enablePlugin(text: string): string {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  const sectionIdx = lines.findIndex((l) => l.trim() === '[editor_plugins]');

  if (sectionIdx === -1) {
    // No section yet: append one at the end (Godot sorts sections when it next saves).
    const trimmed = text.replace(/\s*$/, '');
    return `${trimmed}${eol}${eol}[editor_plugins]${eol}${eol}${writeList([PLUGIN_CFG])}${eol}`;
  }

  // Find the `enabled=` line within this section.
  for (let i = sectionIdx + 1; i < lines.length; i++) {
    const l = lines[i]!;
    if (/^\[.+\]$/.test(l.trim())) break; // next section
    if (l.startsWith('enabled=')) {
      const items = readList(l);
      if (items.includes(PLUGIN_CFG)) return text;
      lines[i] = writeList([...items, PLUGIN_CFG]);
      return lines.join(eol);
    }
  }
  // Section exists without an enabled= line.
  lines.splice(sectionIdx + 1, 0, '', writeList([PLUGIN_CFG]));
  return lines.join(eol);
}

/** Return project.godot text with our plugin removed from the enabled list. */
export function disablePlugin(text: string): string {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]!;
    if (l.startsWith('enabled=') && l.includes(PLUGIN_CFG)) {
      lines[i] = writeList(readList(l).filter((p) => p !== PLUGIN_CFG));
    }
  }
  return lines.join(eol);
}
