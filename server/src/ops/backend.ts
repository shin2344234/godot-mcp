/**
 * Routing a bridge-protocol method to the live editor or headless Godot.
 *
 * Rule of thumb: the live editor is always preferred when it's connected,
 * because edits made there go through Godot's undo history (the user can
 * Ctrl+Z anything the agent did) and show up immediately in the open scene.
 * Headless Godot is the fallback for methods that support it.
 *
 * Mixing the two would be dangerous: if the editor has a scene open with
 * unsaved changes and we edit the .tscn on disk headlessly, the editor would
 * later overwrite our change (or we'd clobber theirs). So when the editor is
 * connected, ALL scene work goes through it.
 */

import { EDITOR_NOT_CONNECTED_HINT } from '../bridge/editorBridge.js';
import { OpError } from '../errors.js';
import type { OpContext } from './types.js';

export interface CallOptions {
  /** The method only exists in the editor (no headless implementation). */
  editorOnly?: boolean;
}

export interface BackendResult<T> {
  result: T;
  backend: 'editor' | 'headless';
}

export async function callGodot<T = Record<string, unknown>>(
  ctx: OpContext,
  method: string,
  params: Record<string, unknown>,
  opts: CallOptions = {},
): Promise<BackendResult<T>> {
  // Drop undefined values so the GDScript side sees "missing" rather than null.
  const clean = Object.fromEntries(Object.entries(params).filter(([, v]) => v !== undefined));

  if (await ctx.bridge.ensureConnected()) {
    return { result: await ctx.bridge.request<T>(method, clean), backend: 'editor' };
  }
  if (opts.editorOnly) {
    throw new OpError('EDITOR_NOT_CONNECTED', `"${method}" needs the live editor. ${EDITOR_NOT_CONNECTED_HINT}`);
  }
  return { result: await ctx.headless.call<T>(method, clean), backend: 'headless' };
}

/**
 * Headless edits need to know which scene file to change, because there is no
 * "currently edited scene" without an editor. Call this before a headless
 * scene/node operation to give a clear error instead of a vague one.
 */
export async function requireSceneForHeadless(ctx: OpContext, scene: string | undefined): Promise<void> {
  if (scene) return;
  if (await ctx.bridge.ensureConnected()) return; // the editor knows its edited scene
  throw new OpError(
    'BAD_PARAMS',
    'The editor is not connected, so pass "scene" (a res:// path to a .tscn) to say which scene file to work on.',
  );
}

export interface ForwardOptions extends CallOptions {
  /**
   * The headless implementation works on one scene file and needs `scene`
   * (scene_mutation / scene_read methods). Checked up front so the model gets
   * a clear error instead of a slow generic failure from Godot.
   */
  needsScene?: boolean;
}

/**
 * Standard operation body: route `method` to the editor or headless Godot and
 * return its result tagged with the backend that ran it. Most step 2
 * operations are just `run: (args, ctx) => forwardOp(ctx, 'x.y', args, {...})`.
 */
export async function forwardOp(ctx: OpContext, method: string, args: Record<string, unknown>, opts: ForwardOptions = {}) {
  if (opts.needsScene && !opts.editorOnly) await requireSceneForHeadless(ctx, args.scene as string | undefined);
  const { result, backend } = await callGodot(ctx, method, args, opts);
  return { data: { ...(result as object), backend } };
}
