/**
 * Compact tool schemas (src/mcp/schema.ts): the noise is gone, the meaning
 * stays, and validation still runs through zod.
 */

import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { compactInput, compactJsonSchema, toolJsonSchema } from '../../src/mcp/schema.js';
import { inputEdit } from '../../src/ops/projectEdit.js';

const sample = z.object({
  path: z.string().describe('Node path.'),
  index: z.number().int().optional(),
  small: z.number().int().min(0).max(10).optional(),
  props: z.record(z.string(), z.unknown()).optional(),
  strict: z.object({ a: z.string() }).strict().optional(),
  mode: z.enum(['a', 'b']).default('a'),
});

describe('compact tool schemas', () => {
  it('drops $schema, safe-integer bounds and default record keywords', () => {
    const json = JSON.stringify(toolJsonSchema(sample));
    expect(json).not.toContain('$schema');
    expect(json).not.toContain('9007199254740991');
    expect(json).not.toContain('propertyNames');
    expect(json).not.toContain('"additionalProperties":{}');
  });

  it('keeps real constraints, descriptions, defaults and strict objects', () => {
    const json = toolJsonSchema(sample) as any;
    expect(json.properties.path.description).toBe('Node path.');
    expect(json.properties.small).toMatchObject({ minimum: 0, maximum: 10 });
    expect(json.properties.mode.default).toBe('a');
    expect(json.properties.strict.additionalProperties).toBe(false);
    expect(json.required).toEqual(['path']);
  });

  it('only strips $schema at the root', () => {
    expect(compactJsonSchema({ properties: { $schema: { type: 'string' } } })).toEqual({ properties: { $schema: { type: 'string' } } });
  });

  it('validates with zod through the Standard Schema interface', async () => {
    const std = compactInput(sample)['~standard'] as any;
    const ok = await std.validate({ path: 'Player' });
    expect(ok.value).toEqual({ path: 'Player', mode: 'a' });
    const bad = await std.validate({ index: 'x' });
    expect(bad.issues?.length).toBeGreaterThan(0);
    expect(std.jsonSchema.input({ target: 'draft-2020-12' })).toEqual(toolJsonSchema(sample));
  });
});

describe('documented tool parameters', () => {
  it('input.edit says string keys bind physical keys and how to bind by keycode', () => {
    // MCP_TEST_LOG: "R" was stored as a physical key without the schema saying so.
    const json = JSON.stringify(toolJsonSchema(inputEdit.input));
    expect(json).toMatch(/physical key/);
    expect(json).toMatch(/physical \(false: by keycode\)/);
  });
});
