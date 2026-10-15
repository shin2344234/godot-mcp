/**
 * Godot's script function profiler, driven over the native debugger
 * protocol (process runs only).
 *
 * Verified against Godot 4.7.2 (servers/debugger/servers_debugger.cpp,
 * core/debugger/remote_debugger.cpp, modules/gdscript/gdscript.cpp):
 *
 *   - The script profiler is part of the "servers" EngineProfiler. The
 *     debugger turns it on with `profiler:servers [true, [max_functions:int,
 *     save_native_calls:bool]]` (what the editor's Profiler tab sends) and off
 *     with `profiler:servers [false]`. Enabling resets every language's
 *     counters (ScriptLanguage::profiling_start).
 *   - While on, the game sends `servers:profile_frame` every frame and
 *     `servers:function_signature [name, id]` the first time a function shows
 *     up. Turning it off sends one `servers:profile_total` with the counters
 *     accumulated since it was turned on: the top `max_functions` functions by
 *     total time. Frames are ServersProfilerFrame::serialize():
 *       [frame_number, frame_time, process_time, physics_time,
 *        physics_frame_time, script_time, servers_count,
 *        (server_name, n*2, (fn_name, time)*n)*servers_count,
 *        functions*5, (sig_id, call_count, self_time, total_time, internal_time)*]
 *     with times in seconds.
 *   - GDScript signatures look like "res://player.gd::42::_process"
 *     (path, first line of the function's body, name; "Class.method" for
 *     inner classes). Checked with a real 4.7.2 game: a `func` on line 9
 *     reports line 10.
 *
 * Why process runs only: in an editor run the game talks to the editor's own
 * debugger, whose ScriptEditorDebugger consumes `servers:*` messages; the
 * plugin relay only forwards our `mcp:*` messages, and GDScript has no API
 * to read the profiler counters from inside the game. So the runtime can't
 * measure script functions itself, and an editor run's data never reaches us
 * (the editor's Profiler tab shows it to the user instead).
 */

import { OpError } from '../errors.js';
import type { GameMessage } from './debugSession.js';
import type { RuntimeChannel } from './runtime.js';

/** Functions the game reports per frame and in the total (re-sorted by self time here). */
const MAX_FUNCTIONS = 128;
/** Scripts of the addon itself (left out of the results). */
const ADDON_PREFIX = 'res://addons/godot_mcp/';
/** How long to wait for `servers:profile_total` after turning the profiler off. */
const TOTAL_WAIT_MS = 5_000;

export interface ScriptFunctionStat {
  function: string;
  file: string;
  /** First line of the function's body (what Godot puts in the signature). */
  line: number;
  calls: number;
  /** Time spent in the function itself, in ms, over the whole profile. */
  self_ms: number;
  /** Time including callees, in ms. */
  total_ms: number;
}

export interface ScriptProfile {
  seconds: number;
  frames: number;
  /** Average script time per frame (sum of function self times), in ms. */
  script_ms_per_frame: number;
  /** Top functions by self time. */
  functions: ScriptFunctionStat[];
}

interface ParsedFrame {
  frameNumber: number;
  scriptTime: number;
  functions: { sig: number; calls: number; self: number; total: number }[];
}

/** Parses a ServersProfilerFrame array (see the header). Returns undefined if malformed. */
export function parseServersFrame(data: unknown[]): ParsedFrame | undefined {
  if (data.length < 7) return undefined;
  const num = (i: number) => Number(data[i]);
  let idx = 7;
  for (let s = num(6); s > 0; s--) {
    // Skip one server block: name, item count, then (name, time) pairs.
    if (idx + 1 >= data.length) return undefined;
    idx += 2 + num(idx + 1);
  }
  if (idx >= data.length) return undefined;
  const count = num(idx) / 5;
  idx += 1;
  const functions: ParsedFrame['functions'] = [];
  for (let i = 0; i < count && idx + 4 < data.length; i++, idx += 5) {
    functions.push({ sig: num(idx), calls: num(idx + 1), self: num(idx + 2), total: num(idx + 3) });
  }
  return { frameNumber: num(0), scriptTime: num(5), functions };
}

/** "res://player.gd::42::_process" -> file, line, function. */
export function parseSignature(sig: string): { file: string; line: number; function: string } {
  const parts = sig.split('::');
  if (parts.length < 3) return { file: '', line: 0, function: sig };
  return { file: parts[0]!, line: Number(parts[1]) || 0, function: parts.slice(2).join('::') };
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(done, ms);
    function done() {
      clearTimeout(t);
      signal?.removeEventListener('abort', done);
      resolve();
    }
    signal?.addEventListener('abort', done, { once: true });
  });
}

/**
 * Profile script functions for `durationMs` and return the `top` functions by
 * self time. The profiler is always turned off again, also on cancellation.
 */
export async function profileScripts(channel: RuntimeChannel, durationMs: number, top: number, signal?: AbortSignal): Promise<ScriptProfile> {
  const signatures = new Map<number, string>();
  let frames = 0;
  let scriptSeconds = 0;
  let total: ParsedFrame | undefined;
  let gotTotal!: () => void;
  const totalArrived = new Promise<void>((r) => (gotTotal = r));

  const onNative = (m: GameMessage) => {
    if (m.message === 'servers:function_signature') {
      signatures.set(Number(m.data[1]), String(m.data[0]));
    } else if (m.message === 'servers:profile_frame') {
      frames++;
      scriptSeconds += Number(m.data[5]) || 0;
    } else if (m.message === 'servers:profile_total') {
      total = parseServersFrame(m.data);
      gotTotal();
    }
  };

  channel.on('native', onNative);
  const started = Date.now();
  let elapsed = 0;
  try {
    await channel.native('profiler:servers', [true, [MAX_FUNCTIONS, false]]);
    await sleep(durationMs, signal);
  } finally {
    elapsed = Date.now() - started;
    // Turning it off makes the game send the accumulated totals.
    await channel.native('profiler:servers', [false]).catch(() => undefined);
    await Promise.race([totalArrived, sleep(TOTAL_WAIT_MS)]);
    channel.off('native', onNative);
  }
  if (signal?.aborted) throw new OpError('CANCELLED', 'Script profiling was cancelled (the profiler was turned off again).');
  if (!total) {
    throw new OpError(
      'GODOT_ERROR',
      'The game sent no script profile. It may be stopped at a breakpoint or frozen; check godot_run_output, then retry.',
    );
  }

  const functions = total.functions
    .map((f) => {
      const where = parseSignature(signatures.get(f.sig) ?? `?${f.sig}`);
      return { ...where, calls: f.calls, self_ms: round(f.self * 1000), total_ms: round(f.total * 1000) };
    })
    // The totals list every compiled function, also ones never called while profiling; and
    // the addon's own functions (the runtime answering us) are measurement overhead.
    .filter((f) => f.calls > 0 && !f.file.startsWith(ADDON_PREFIX))
    .sort((a, b) => b.self_ms - a.self_ms || b.total_ms - a.total_ms)
    .slice(0, top);
  return {
    seconds: round(elapsed / 1000),
    frames,
    script_ms_per_frame: frames ? round((scriptSeconds * 1000) / frames) : 0,
    functions,
  };
}

function round(v: number): number {
  return Math.round(v * 1000) / 1000;
}
