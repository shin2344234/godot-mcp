/**
 * One error type for everything an operation can fail with.
 *
 * Operations throw `OpError`; the MCP layer turns it into a tool result with
 * `isError: true` (NOT a JSON-RPC protocol error). That distinction matters:
 * the spec lets clients hide protocol errors from the model, while `isError`
 * results are always shown to it, so the model can read the message and
 * retry with corrected arguments.
 *
 * Codes mirror the bridge protocol (docs/bridge-protocol.md) so errors coming
 * back from Godot pass through unchanged.
 */

export type ErrorCode =
  | 'BAD_PARAMS'
  | 'NOT_FOUND'
  | 'NO_SCENE'
  | 'CONFLICT'
  | 'UNSUPPORTED'
  | 'GODOT_ERROR'
  | 'INTERNAL'
  | 'UNKNOWN_METHOD'
  /** The live editor is needed but isn't connected. */
  | 'EDITOR_NOT_CONNECTED'
  /** No Godot executable could be found for headless work. */
  | 'GODOT_NOT_FOUND'
  /** The project doesn't have the godot_mcp addon installed. */
  | 'ADDON_MISSING'
  | 'TIMEOUT'
  /** A runtime tool was called but no game is running (or it exited). */
  | 'GAME_NOT_RUNNING'
  /** The client cancelled the request. */
  | 'CANCELLED'
  /** The feature is turned off by configuration (e.g. code eval without --allow-eval). */
  | 'DISABLED';

export class OpError extends Error {
  constructor(
    public readonly code: ErrorCode,
    message: string,
    public readonly data?: unknown,
  ) {
    super(message);
    this.name = 'OpError';
  }
}

/** Normalise anything thrown into an OpError (keeps the message readable). */
export function toOpError(err: unknown): OpError {
  if (err instanceof OpError) return err;
  if (err instanceof Error) return new OpError('INTERNAL', err.message);
  return new OpError('INTERNAL', String(err));
}
