/**
 * Listing project files by extension, for MCP resource lists and argument
 * completion (scene paths, script paths).
 *
 * Skips dot-folders (.godot/ cache, .git/, .import/) and stops after `limit`
 * matches so huge projects can't stall a resources/list call. Results are
 * res:// paths sorted alphabetically, so lists are stable between calls.
 */

import { readdir } from 'node:fs/promises';
import path from 'node:path';

export async function listProjectFiles(root: string, extensions: string[], limit = 500): Promise<string[]> {
  const exts = new Set(extensions.map((e) => e.toLowerCase()));
  const out: string[] = [];
  // Breadth-first so shallow (usually more important) files come first when we hit the cap.
  const queue: string[] = [''];
  while (queue.length > 0 && out.length < limit) {
    const rel = queue.shift()!;
    const entries = await readdir(path.join(root, rel), { withFileTypes: true }).catch(() => []);
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) queue.push(childRel);
      else if (exts.has(path.extname(entry.name).toLowerCase())) {
        out.push(`res://${childRel}`);
        if (out.length >= limit) break;
      }
    }
  }
  return out.sort();
}

/** Completion helper: case-insensitive substring match, prefix matches first, max 100 (spec limit). */
export function completeFrom(values: string[], typed: string): string[] {
  const needle = typed.toLowerCase().replace(/^res:\/\//, '');
  const scored = values
    .map((v) => ({ v, i: v.toLowerCase().replace(/^res:\/\//, '').indexOf(needle) }))
    .filter((x) => x.i >= 0)
    .sort((a, b) => a.i - b.i || a.v.localeCompare(b.v));
  return scored.slice(0, 100).map((x) => x.v);
}
