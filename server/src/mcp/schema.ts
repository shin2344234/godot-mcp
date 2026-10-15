/**
 * Compact JSON Schemas for tool inputs.
 *
 * Every tool definition is re-sent to the model on every turn, so bytes in
 * input schemas cost context for the whole session. zod's JSON Schema output
 * carries several things that tell the model nothing:
 *
 *   - "$schema": "https://json-schema.org/draft/2020-12/schema" on every tool
 *     (MCP already says tool schemas default to 2020-12);
 *   - "minimum": -9007199254740991 / "maximum": 9007199254740991 on every
 *     z.number().int() (JavaScript's safe-integer range, not a real limit);
 *   - "propertyNames": {"type": "string"} on records (JSON object keys are
 *     always strings);
 *   - "additionalProperties": {} on records (the JSON Schema default).
 *
 * Dropping them is lossless: validation still runs on the server with the
 * original zod schema. Measured on the step 2 catalog this saved about 10% of
 * the full-mode tools/list payload.
 *
 * The MCP SDK (v2) turns a tool's inputSchema into JSON Schema through the
 * Standard JSON Schema interface (`schema['~standard'].jsonSchema.input()`),
 * so `compactInput` wraps a zod schema in an object that keeps zod's
 * validator but returns the compacted JSON Schema.
 */

import { z } from 'zod';

const SAFE_MAX = Number.MAX_SAFE_INTEGER;

/** Recursively removes the noise listed above from a JSON Schema (returns a new object). */
export function compactJsonSchema(node: unknown, root = true): unknown {
  if (Array.isArray(node)) return node.map((n) => compactJsonSchema(n, false));
  if (node === null || typeof node !== 'object') return node;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    if (root && key === '$schema') continue;
    if (key === 'minimum' && value === -SAFE_MAX) continue;
    if (key === 'maximum' && value === SAFE_MAX) continue;
    if (key === 'propertyNames' && isPlainStringType(value)) continue;
    if (key === 'additionalProperties' && isEmptyObject(value)) continue;
    out[key] = compactJsonSchema(value, false);
  }
  return out;
}

function isPlainStringType(v: unknown): boolean {
  return v !== null && typeof v === 'object' && Object.keys(v).length === 1 && (v as { type?: unknown }).type === 'string';
}

function isEmptyObject(v: unknown): boolean {
  return v !== null && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length === 0;
}

/** The compacted JSON Schema of a zod schema, as listed to clients (input side: defaults are optional). */
export function toolJsonSchema(schema: z.ZodType): Record<string, unknown> {
  return compactJsonSchema(z.toJSONSchema(schema, { target: 'draft-2020-12', io: 'input' })) as Record<string, unknown>;
}

/**
 * A Standard Schema (validate + jsonSchema) around a zod schema: the SDK
 * validates tool arguments with zod as before, and lists the compacted JSON
 * Schema. The result is cached because tools/list may be called often.
 */
export function compactInput<T extends z.ZodType>(schema: T): T {
  let input: Record<string, unknown> | undefined;
  let output: Record<string, unknown> | undefined;
  const std = schema['~standard'];
  const wrapped = {
    '~standard': {
      version: 1 as const,
      vendor: 'godot-mcp',
      validate: (value: unknown) => std.validate(value),
      jsonSchema: {
        input: () => (input ??= toolJsonSchema(schema)),
        output: () => (output ??= compactJsonSchema(z.toJSONSchema(schema, { target: 'draft-2020-12', io: 'output' })) as Record<string, unknown>),
      },
    },
  };
  // Typed as the zod schema so registerTool still infers the handler's argument type.
  return wrapped as unknown as T;
}
