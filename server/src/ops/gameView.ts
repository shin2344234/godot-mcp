/**
 * Step 3: screenshots and performance (game.screenshot / game.perf).
 * See docs/runtime-protocol.md for the runtime channel these tools use and
 * docs/methods/game-view.md for the details.
 *
 *   - game.screenshot: the game side is addons/godot_mcp/runtime/ops/rt_view.gd
 *     (runtime method "game.screenshot"); the editor 2D/3D viewports go through
 *     the bridge to addons/godot_mcp/ops/editor_view_ops.gd ("editor.screenshot").
 *     Both return the encoded image as base64 in the JSON reply; here it moves
 *     into an MCP image content block and the rest stays as a small JSON summary.
 *   - game.perf: Performance monitors and frame sampling are measured inside
 *     the game by the runtime (works for process and editor runs alike);
 *     script function profiling uses Godot's own profiler over the native
 *     debugger protocol (process runs only; see src/game/scriptProfiler.ts).
 */

import { z } from 'zod';
import { OpError } from '../errors.js';
import { resolveGame } from '../game/hub.js';
import { profileScripts } from '../game/scriptProfiler.js';
import { callGodot } from './backend.js';
import { defineOp, type OpResult, type Operation } from './types.js';

/** Screenshot replies carry the image; capture + encoding of a big viewport can take a moment. */
const SCREENSHOT_TIMEOUT_MS = 30_000;
/** Extra time on top of sample_seconds for game.perf (snapshot + reply). */
const PERF_MARGIN_MS = 15_000;

const runId = z.string().optional().describe('Default: newest run, else the editor\'s game.');

/** Moves the base64 image of a screenshot reply into an MCP image block. */
function imageResult(raw: Record<string, unknown>, extra: Record<string, unknown>): OpResult {
  const { image, mime_type, ...summary } = raw;
  if (typeof image !== 'string') throw new OpError('INTERNAL', 'The screenshot reply had no image (addon bug).');
  return { data: { ...extra, ...summary }, images: [{ data: image, mimeType: String(mime_type ?? 'image/png') }] };
}

export const gameScreenshot = defineOp({
  name: 'game.screenshot',
  group: 'game',
  title: 'Game screenshot',
  description:
    'Godot game: screenshot the running game (window, a node\'s viewport, or a region) or the editor\'s 2D/3D view, scaled down. Can save it and diff against a saved image.',
  input: z.object({
    run_id: runId,
    source: z.enum(['game', 'editor_2d', 'editor_3d']).default('game'),
    node: z.string().optional().describe('Viewport, SubViewportContainer, or a node inside a viewport.'),
    region: z
      .object({ x: z.number().int(), y: z.number().int(), w: z.number().int().min(1), h: z.number().int().min(1) })
      .optional()
      .describe('Crop, in viewport pixels.'),
    max_size: z.number().int().min(16).max(4096).default(768).describe('Longest side, px.'),
    format: z.enum(['png', 'jpg']).default('png'),
    quality: z.number().min(0.01).max(1).optional().describe('JPEG; default 0.85.'),
    save_to: z.string().optional().describe('user:// or res:// .png/.jpg (full size).'),
    compare_to: z.string().optional().describe('Saved image to diff with.'),
    tolerance: z.number().int().min(0).max(255).default(16).describe('Per-channel diff threshold.'),
  }),
  readOnly: true,
  async run({ run_id, source, ...params }, ctx) {
    if (source === 'game') {
      const game = await resolveGame(ctx, run_id);
      const raw = await game.channel.request<Record<string, unknown>>('game.screenshot', params, { timeoutMs: SCREENSHOT_TIMEOUT_MS, signal: ctx.signal });
      return imageResult(raw, { run_id: game.runId });
    }
    // Editor viewports: the editor answers synchronously, so when the requested view
    // isn't on screen it switches the main screen and asks us to come back shortly.
    if (params.node) throw new OpError('BAD_PARAMS', '"node" only applies to source "game". For the editor, use source "editor_2d" or "editor_3d" (optionally with region).');
    const editorParams = { ...params, view: source === 'editor_2d' ? '2d' : '3d' };
    let { result } = await callGodot<Record<string, unknown>>(ctx, 'editor.screenshot', editorParams, { editorOnly: true });
    let switched: unknown;
    if (typeof result.retry_after_ms === 'number') {
      switched = result.switched_main_screen;
      await new Promise((r) => setTimeout(r, Number(result.retry_after_ms)));
      ({ result } = await callGodot<Record<string, unknown>>(ctx, 'editor.screenshot', { ...editorParams, _retried: true }, { editorOnly: true }));
    }
    return imageResult(result, { source, ...(switched ? { switched_main_screen: switched } : {}) });
  },
});

export const gamePerf = defineOp({
  name: 'game.perf',
  group: 'game',
  title: 'Game performance',
  description:
    'Godot game: performance monitors of the running game (fps, frame times, memory, objects, draw calls...); optionally sample frames (stats, spikes) and profile script functions.',
  input: z.object({
    run_id: runId,
    sample_seconds: z.number().min(0.1).max(30).optional().describe('Record every frame: min/avg/p95/max, spikes.'),
    profile_scripts_seconds: z.number().min(0.5).max(30).optional().describe('Top script functions by self time (process runs).'),
    top: z.number().int().min(1).max(50).default(15).describe('Functions to list.'),
  }),
  readOnly: true,
  async run({ run_id, sample_seconds, profile_scripts_seconds, top }, ctx) {
    const game = await resolveGame(ctx, run_id);
    if (profile_scripts_seconds && game.channel.kind !== 'process') {
      throw new OpError(
        'UNSUPPORTED',
        'profile_scripts_seconds needs a game started by the server (godot_run_start mode "process"): in an editor run the editor\'s own debugger receives the profiler data (its Debugger > Profiler tab shows it). Monitors and sample_seconds work here.',
      );
    }
    // Both run at the same time; the call takes as long as the longer of the two.
    const [perf, scripts] = await Promise.all([
      game.channel.request<Record<string, unknown>>('game.perf', { sample_seconds }, { timeoutMs: (sample_seconds ?? 0) * 1000 + PERF_MARGIN_MS, signal: ctx.signal }),
      profile_scripts_seconds ? profileScripts(game.channel, profile_scripts_seconds * 1000, top, ctx.signal) : undefined,
    ]);
    return { data: { run_id: game.runId, ...perf, ...(scripts ? { scripts } : {}) } };
  },
});

/** Operations in this area, in the order they should appear in tools/list. */
export const operations: Operation[] = [gameScreenshot, gamePerf] as Operation[];
