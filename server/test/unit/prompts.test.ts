/**
 * The prompts (src/mcp/prompts.ts) and server instructions name tools in
 * plain text; a renamed or removed tool would silently send the model to a
 * tool that doesn't exist. Check every godot_* name they mention.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ALL_OPERATIONS } from '../../src/ops/catalog.js';
import { toolName } from '../../src/ops/types.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const known = new Set([...ALL_OPERATIONS.map(toolName), 'godot_tools', 'godot_call_read', 'godot_call_write']);

describe.each(['src/mcp/prompts.ts', 'src/mcp/instructions.ts'])('tool names in %s', (file) => {
  it('all exist', () => {
    const text = readFileSync(path.join(here, '..', '..', file), 'utf8');
    const named = [...new Set(text.match(/\bgodot_[a-z0-9_]+/g) ?? [])].filter((n) => !n.endsWith('_')); // skip wildcards like godot_call_*
    expect(named.length).toBeGreaterThan(0);
    expect(named.filter((n) => !known.has(n))).toEqual([]);
  });
});
