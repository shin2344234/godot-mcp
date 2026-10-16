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

import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { OpError } from '../errors.js';
import { resolveProjectPathStrict } from '../project/paths.js';
import { resolveGame } from '../game/hub.js';
import { profileScripts } from '../game/scriptProfiler.js';
import { callGodot } from './backend.js';
import { defineOp, type OpResult, type Operation } from './types.js';

/** Screenshot replies carry the image; capture + encoding of a big viewport can take a moment. */
const SCREENSHOT_TIMEOUT_MS = 30_000;
/**
 * How many times the editor screenshot is re-requested after the editor switched its main
 * screen (each after the addon's retry_after_ms, 300 ms): about 1.8 s in total.
 */
const EDITOR_SCREEN_SWITCH_ATTEMPTS = 6;
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
    node: z.string().optional().describe('Node to frame (crop to its screen rect), or a viewport.'),
    region: z
      .object({ x: z.number().int(), y: z.number().int(), w: z.number().int().min(1), h: z.number().int().min(1) })
      .optional()
      .describe('Crop, in image px (window px with stretch).'),
    max_size: z.number().int().min(16).max(4096).default(768).describe('Longest side, px.'),
    format: z.enum(['png', 'jpg']).default('png'),
    quality: z.number().min(0.01).max(1).optional().describe('JPEG; default 0.85.'),
    save_to: z.string().optional().describe('user:// or res:// .png/.jpg (full size).'),
    compare_to: z.string().optional().describe('Saved image to diff with (full resolution; changed_rect in viewport px).'),
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
    // After a main-screen switch the 3D/2D viewport only becomes visible once the editor has
    // processed a few frames; under a slow software renderer (Xvfb + llvmpipe) a single
    // 300 ms wait was not always enough, and the call failed with CONFLICT although an
    // immediate manual retry worked. So poll a few times: the addon keeps answering
    // retry_after_ms while the viewport is still hidden, and only the LAST attempt carries
    // _retried (which makes the addon give up with its CONFLICT error instead of retrying).
    for (let attempt = 1; typeof result.retry_after_ms === 'number' && attempt <= EDITOR_SCREEN_SWITCH_ATTEMPTS; attempt++) {
      switched ??= result.switched_main_screen;
      await new Promise((r) => setTimeout(r, Number(result.retry_after_ms)));
      const last = attempt === EDITOR_SCREEN_SWITCH_ATTEMPTS;
      ({ result } = await callGodot<Record<string, unknown>>(ctx, 'editor.screenshot', { ...editorParams, ...(last ? { _retried: true } : {}) }, { editorOnly: true }));
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
    monitors: z.boolean().optional().describe('Full monitor snapshot. Default: only when no sample/profile is asked for.'),
  }),
  readOnly: true,
  async run({ run_id, sample_seconds, profile_scripts_seconds, top, monitors }, ctx) {
    const game = await resolveGame(ctx, run_id);
    if (profile_scripts_seconds && game.channel.kind !== 'process') {
      throw new OpError(
        'UNSUPPORTED',
        'profile_scripts_seconds needs a game started by the server (godot_run_start mode "process"): in an editor run the editor\'s own debugger receives the profiler data (its Debugger > Profiler tab shows it). Monitors and sample_seconds work here.',
      );
    }
    // The ~40-value monitor snapshot is what a plain call is for; a call that samples or
    // profiles wants those numbers, and repeating the snapshot each time only costs tokens.
    // The runtime then sends just "fps" in its place. monitors: true asks for both.
    const wantMonitors = monitors ?? !(sample_seconds || profile_scripts_seconds);
    // Script lines: the profiler reports a function's first body line; we move it to the
    // `func` line by reading the script (inside the project only, through the same
    // sandboxed path resolution as the file tools; never anything but .gd files).
    const readSource = async (res: string): Promise<string | undefined> => {
      if (!res.startsWith('res://') || !res.endsWith('.gd')) return undefined;
      try {
        const p = await resolveProjectPathStrict(ctx.config.projectPath, res);
        return await readFile(p.abs, 'utf8');
      } catch {
        return undefined;
      }
    };
    // Both run at the same time; the call takes as long as the longer of the two.
    const [perf, scripts] = await Promise.all([
      game.channel.request<Record<string, unknown>>(
        'game.perf',
        { sample_seconds, monitors: wantMonitors },
        { timeoutMs: (sample_seconds ?? 0) * 1000 + PERF_MARGIN_MS, signal: ctx.signal },
      ),
      profile_scripts_seconds ? profileScripts(game.channel, profile_scripts_seconds * 1000, top, ctx.signal, readSource) : undefined,
    ]);
    return { data: { run_id: game.runId, ...perf, ...(scripts ? { scripts } : {}) } };
  },
});

/** Operations in this area, in the order they should appear in tools/list. */
export const operations: Operation[] = [gameScreenshot, gamePerf] as Operation[];
