/**
 * Context budget guard. Every tool definition is re-sent to the model on
 * every turn, so we cap how big the tool list may get per mode. GitHub
 * Actions is off for this repo, so this runs as part of `npm test` locally.
 *
 * Tokens are estimated as characters / 4 (a common rule of thumb for
 * English + JSON); the budgets leave headroom for that imprecision. Schemas
 * are measured exactly as tools/list sends them (compacted, see
 * src/mcp/schema.ts).
 */

import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config.js';
import { enabledOperations } from '../../src/ops/catalog.js';
import { toolName } from '../../src/ops/types.js';
import { buildInstructions } from '../../src/mcp/instructions.js';
import { toolJsonSchema } from '../../src/mcp/schema.js';

function estimateTokens(mode: 'full' | 'compact'): number {
  const config = loadConfig(['--mode', mode, '--project', '/tmp'], {});
  const ops = enabledOperations(config).filter((op) => mode === 'full' || op.core);
  const defs = ops.map((op) => ({ name: toolName(op), title: op.title, description: op.description, inputSchema: toolJsonSchema(op.input) }));
  return Math.ceil(JSON.stringify(defs).length / 4);
}

describe('tool definition budget', () => {
  it('compact mode stays under ~5k tokens', () => {
    expect(estimateTokens('compact')).toBeLessThan(5_000);
  });
  it('full mode stays under ~15k tokens', () => {
    expect(estimateTokens('full')).toBeLessThan(15_000);
  });
  it('instructions stay under 2 KB', () => {
    expect(buildInstructions('compact').length).toBeLessThan(2_048);
  });
  it('every description starts with a "Godot" search word', () => {
    const config = loadConfig(['--project', '/tmp'], {});
    for (const op of enabledOperations(config)) expect(op.description, op.name).toMatch(/^Godot /);
  });
});
