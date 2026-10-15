/**
 * Builds the MCP server: turns operations into native tools and adds the
 * router tools.
 *
 * Tool exposure (decided at startup, never changed mid-session):
 *   - mode "full":    every enabled operation is a native tool, plus
 *                     godot_tools for discovery. Best for clients that do
 *                     their own tool search (Claude Code, Cursor, Codex).
 *   - mode "compact": only `core` operations are native; everything else is
 *                     reached with godot_tools (search/describe) and the
 *                     godot_call_read / godot_call_write routers. Best for
 *                     clients without tool search (Claude Desktop, Windsurf,
 *                     Zed, Cline) or tight context budgets.
 *
 * The routers are split read/write so client permission prompts and the
 * readOnly/destructive hints stay meaningful (one "call anything" tool
 * would have to be marked destructive and prompt for every read).
 */

import { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { Config } from '../config.js';
import { OpError, toOpError } from '../errors.js';
import { log } from '../log.js';
import { enabledOperations } from '../ops/catalog.js';
import { toolName, type OpContext, type OpResult, type Operation } from '../ops/types.js';
import { SERVER_VERSION } from '../version.js';
import { buildInstructions } from './instructions.js';

type ToolResult = {
  content: ({ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string })[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
};

/** Convert an operation result into an MCP tool result. */
function toToolResult(result: OpResult): ToolResult {
  const content: ToolResult['content'] = [{ type: 'text', text: JSON.stringify(result.data, null, 1) }];
  for (const img of result.images ?? []) content.push({ type: 'image', data: img.data, mimeType: img.mimeType });
  const structured = result.data && typeof result.data === 'object' && !Array.isArray(result.data) ? (result.data as Record<string, unknown>) : { value: result.data };
  return { content, structuredContent: structured };
}

/** Convert a failure into an `isError` result the model can act on. */
function toErrorResult(err: unknown): ToolResult {
  const e = toOpError(err);
  if (e.code === 'INTERNAL') log.error('Operation failed', err);
  const text = `${e.code}: ${e.message}` + (e.data !== undefined ? `\n${JSON.stringify(e.data)}` : '');
  return { content: [{ type: 'text', text }], isError: true };
}

async function execute(op: Operation, args: unknown, ctx: OpContext): Promise<ToolResult> {
  try {
    return toToolResult(await op.run(args as never, ctx));
  } catch (err) {
    return toErrorResult(err);
  }
}

function annotations(op: Operation) {
  return {
    title: op.title,
    readOnlyHint: op.readOnly,
    destructiveHint: op.readOnly ? false : (op.destructive ?? false),
    idempotentHint: op.idempotent ?? false,
    // Everything stays on the user's machine; nothing reaches the internet.
    openWorldHint: false,
  };
}

/** Short catalog line used by godot_tools search. */
function catalogEntry(op: Operation) {
  return { operation: op.name, tool: toolName(op), group: op.group, read_only: op.readOnly, description: op.description };
}

export function buildServer(config: Config, services: Omit<OpContext, 'signal'>): McpServer {
  const ops = enabledOperations(config);
  const byName = new Map(ops.map((op) => [op.name, op]));

  const server = new McpServer(
    { name: 'godot-mcp', version: SERVER_VERSION },
    {
      instructions: buildInstructions(config.mode),
      // The tool list never changes during a session, so clients may cache it.
      cacheHints: { 'tools/list': { ttlMs: 60 * 60 * 1000, cacheScope: 'private' }, 'server/discover': { ttlMs: 60 * 60 * 1000, cacheScope: 'private' } },
    },
  );

  // --- Native tools -------------------------------------------------------
  const native = config.mode === 'full' ? ops : ops.filter((op) => op.core);
  for (const op of native) {
    server.registerTool(
      toolName(op),
      {
        title: op.title,
        description: op.description,
        inputSchema: op.input,
        annotations: annotations(op),
        // Claude Code: load these up front even when it defers MCP tools.
        ...(op.alwaysLoad ? { _meta: { 'anthropic/alwaysLoad': true } } : {}),
      },
      (async (args: unknown, reqCtx: { mcpReq: { signal: AbortSignal } }) => execute(op, args, { ...services, signal: reqCtx.mcpReq.signal })) as never,
    );
  }

  // --- Discovery ----------------------------------------------------------
  server.registerTool(
    'godot_tools',
    {
      title: 'Find Godot operations',
      description:
        'Godot tool catalog: search all available Godot operations by keyword ("search"), or get full parameter schemas for some ("describe").' +
        (config.mode === 'compact' ? ' Run them with godot_call_read / godot_call_write.' : ''),
      inputSchema: z.object({
        action: z.enum(['search', 'describe']),
        query: z.string().optional().describe('search: keywords, e.g. "animation" or "delete node". Empty lists everything.'),
        operations: z.array(z.string()).optional().describe('describe: operation names from search, e.g. ["node.reparent"].'),
      }),
      annotations: { title: 'Find Godot operations', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    (async ({ action, query, operations }: { action: 'search' | 'describe'; query?: string; operations?: string[] }) => {
      if (action === 'search') {
        const words = (query ?? '').toLowerCase().split(/\s+/).filter(Boolean);
        const hits = ops.filter((op) => {
          const hay = `${op.name} ${op.group} ${op.title} ${op.description}`.toLowerCase();
          return words.every((w) => hay.includes(w));
        });
        return toToolResult({ data: { count: hits.length, operations: hits.map(catalogEntry) } });
      }
      const names = operations ?? [];
      if (names.length === 0) return toErrorResult(new OpError('BAD_PARAMS', 'describe needs "operations", e.g. ["node.add"]. Use action "search" first.'));
      const found = names.map((n) => byName.get(n) ?? ops.find((op) => toolName(op) === n));
      const missing = names.filter((_, i) => !found[i]);
      return toToolResult({
        data: {
          operations: found.filter(Boolean).map((op) => ({ ...catalogEntry(op!), input_schema: z.toJSONSchema(op!.input) })),
          ...(missing.length ? { unknown: missing } : {}),
        },
      });
    }) as never,
  );

  // --- Routers (compact mode) ---------------------------------------------
  if (config.mode === 'compact') {
    const routerInput = z.object({
      operation: z.string().describe('Operation name from godot_tools, e.g. "node.reparent".'),
      args: z.record(z.string(), z.unknown()).default({}).describe('Arguments matching the operation\'s input_schema from godot_tools describe.'),
    });

    const route = (wantReadOnly: boolean) =>
      (async ({ operation, args }: { operation: string; args: Record<string, unknown> }, reqCtx: { mcpReq: { signal: AbortSignal } }) => {
        const op = byName.get(operation) ?? ops.find((o) => toolName(o) === operation);
        if (!op) {
          return toErrorResult(new OpError('UNKNOWN_METHOD', `Unknown operation "${operation}". Use godot_tools with action "search" to list operations.`));
        }
        if (op.readOnly !== wantReadOnly) {
          const other = op.readOnly ? 'godot_call_read' : 'godot_call_write';
          return toErrorResult(new OpError('BAD_PARAMS', `"${operation}" ${op.readOnly ? 'is read-only' : 'changes things'}; call it with ${other}.`));
        }
        // Validate here: router arguments bypass the client's schema checks.
        const parsed = op.input.safeParse(args);
        if (!parsed.success) {
          return toErrorResult(
            new OpError('BAD_PARAMS', `Invalid args for "${operation}": ${z.prettifyError(parsed.error)}`, { input_schema: z.toJSONSchema(op.input) }),
          );
        }
        return execute(op, parsed.data, { ...services, signal: reqCtx.mcpReq.signal });
      }) as never;

    server.registerTool(
      'godot_call_read',
      {
        title: 'Run a read-only Godot operation',
        description: 'Godot router: run any read-only operation found with godot_tools (inspect scenes, nodes, files, output).',
        inputSchema: routerInput,
        annotations: { title: 'Run a read-only Godot operation', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      },
      route(true),
    );
    if (!config.readOnly) {
      server.registerTool(
        'godot_call_write',
        {
          title: 'Run a Godot operation that changes things',
          description: 'Godot router: run any operation found with godot_tools that changes the project, scenes, files or editor state.',
          inputSchema: routerInput,
          annotations: { title: 'Run a Godot operation that changes things', readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
        },
        route(false),
      );
    }
  }

  return server;
}
