/**
 * Asking the user before irreversible operations (MCP elicitation).
 *
 * In the 2026-07-28 protocol a server can't send requests to the client
 * mid-call. Instead the tool returns an "input required" result; the client
 * shows the question, then retries the same call with the answer attached
 * (multi round-trip requests, MRTR). The TypeScript SDK v2 runs the same
 * handler for 2025-era clients through its legacy shim, which sends a real
 * `elicitation/create` request and re-runs the handler with the answer.
 *
 * Clients that didn't declare the elicitation capability must not get an
 * input request at all: on a 2026-era connection that fails the whole call
 * with JSON-RPC error -32021, which the model can't act on. For those
 * clients we simply proceed; their own permission prompt (driven by the
 * tool's destructiveHint) is the guard. We deliberately do NOT fall back to
 * a `confirm: true` argument: the model can set it by itself, so it would
 * add friction without adding real human consent.
 */

import { acceptedContent, inputRequired, inputResponse, type ClientCapabilities, type McpServer, type ServerContext } from '@modelcontextprotocol/server';
import { z } from 'zod';

const CLIENT_CAPS_KEY = 'io.modelcontextprotocol/clientCapabilities';

/** The form shown to the user: a single yes/no checkbox. */
const confirmSchema = z.object({ confirm: z.boolean().describe('Go ahead?') });

/**
 * Does the client that sent *this request* support form elicitation?
 * 2026 era: capabilities travel with each request in the envelope.
 * 2025 era: they were declared once in `initialize`.
 */
export function clientCanElicit(server: McpServer, ctx: ServerContext): boolean {
  // RequestMetaEnvelope is typed `{}` in SDK 2.3.1, hence the cast.
  const envelope = ctx.mcpReq.envelope as Record<string, unknown> | undefined;
  const caps = (envelope?.[CLIENT_CAPS_KEY] as ClientCapabilities | undefined) ?? server.server.getClientCapabilities();
  return caps?.elicitation !== undefined;
}

export type ConfirmOutcome =
  /** Run the operation (user agreed, or no dialog was possible/needed). */
  | { kind: 'proceed'; asked: boolean }
  /** Return this to the client: it shows the question and retries the call. */
  | { kind: 'ask'; result: ReturnType<typeof inputRequired> }
  /** The user said no (or dismissed the dialog). */
  | { kind: 'declined' };

/**
 * Decide what to do about a confirmation `question` for the current request.
 * Call it on every (re-)entry of the tool handler: the first time it returns
 * "ask"; on the retry it reads the user's answer.
 */
export function confirmStep(server: McpServer, ctx: ServerContext, question: string): ConfirmOutcome {
  if (!clientCanElicit(server, ctx)) return { kind: 'proceed', asked: false };
  const view = inputResponse(ctx.mcpReq.inputResponses, 'confirm');
  if (view.kind === 'elicit' && view.action !== 'accept') return { kind: 'declined' };
  const answer = acceptedContent(ctx.mcpReq.inputResponses, 'confirm', confirmSchema);
  if (answer === undefined) {
    return { kind: 'ask', result: inputRequired({ inputRequests: { confirm: inputRequired.elicit({ message: question, requestedSchema: confirmSchema }) } }) };
  }
  return answer.confirm ? { kind: 'proceed', asked: true } : { kind: 'declined' };
}
