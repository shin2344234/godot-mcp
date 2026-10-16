/**
 * Step 3: input, timing and input recording/replay in the running game
 * (godot_game_input, godot_game_time, godot_game_record).
 *
 * The Godot side is addons/godot_mcp/runtime/ops/rt_input.gd (runtime methods
 * input.run, time.*, record.*); docs/methods/game-input.md is the reference.
 * See docs/runtime-protocol.md for the runtime channel these tools use.
 *
 * Pausing, frame stepping and the speed control are NOT runtime methods: they
 * use the commands Godot's own SceneDebugger accepts in every debug build
 * (scene/debugger/scene_debugger.cpp, 4.7.2), the same ones the editor's
 * Pause / Next Frame / speed buttons send:
 *   scene:suspend_changed [bool]  -> SceneTree::set_suspend (freezes every node,
 *                                    physics and time; not exposed to GDScript)
 *   scene:next_frame []           -> un-suspend, re-suspend on frame_post_draw
 *   scene:speed_changed [float]   -> Engine::set_user_time_scale (multiplies the
 *                                    game's own Engine.time_scale)
 */

import { z } from 'zod';
import { OpError } from '../errors.js';
import { resolveGame, runtimeCall, type GameTarget } from '../game/hub.js';
import type { RuntimeHello } from '../game/runtime.js';
import { GodotFloat } from '../game/variant.js';
import { defineOp, type OpContext, type Operation } from './types.js';

const runId = z.string().optional().describe('Default: newest game.');

/** Most frames one "step" call may advance (each frame is a round trip). */
const MAX_STEP_FRAMES = 300;
/** Extra time on top of a runtime wait before the server gives up on the reply. */
const REPLY_MARGIN_MS = 5_000;

/**
 * The user time scale each game was last given through scene:speed_changed.
 * GDScript can't read Engine's user time scale, so we remember it. Keyed by the
 * game's hello object, which is new for every game session (the editor channel
 * is reused across editor runs, the hello is not).
 */
const speeds = new WeakMap<RuntimeHello, number>();

// ---------------------------------------------------------------------------
// godot_game_input
// ---------------------------------------------------------------------------

const pos = z.union([z.array(z.number()).length(2), z.string()]);

const step = z.object({
  type: z.enum(['key', 'action', 'move', 'click', 'drag', 'scroll', 'text', 'joy_button', 'joy_axis', 'touch', 'wait']),
  key: z.string().optional().describe('"Space", "A", "Left", "Escape", "Ctrl+S"'),
  action: z.string().optional().describe('InputMap action.'),
  phase: z.enum(['tap', 'press', 'release']).optional(),
  at: pos.optional().describe('[x,y] game (viewport) px, or node path (its center).'),
  to: pos.optional().describe('drag/touch end.'),
  button: z.union([z.string(), z.number()]).optional().describe('Mouse left/right/middle; scroll up/down/left/right; joypad a/b/x/y/start/dpad_up...'),
  double: z.boolean().optional(),
  axis: z.string().optional().describe('left_x/left_y/right_x/right_y/trigger_left/trigger_right'),
  value: z.number().optional().describe('Action strength, axis value, scroll clicks.'),
  text: z.string().optional().describe('Typed into the focused control.'),
  ms: z.number().min(0).optional().describe('Hold, drag or wait time.'),
  frames: z.number().int().min(0).optional(),
  steps: z.number().int().min(1).optional().describe('Drag moves.'),
  device: z.number().int().optional().describe('Joypad / touch index.'),
});

/** Rough upper bound of how long a step list takes, for the reply timeout. */
function stepsDurationMs(steps: z.infer<typeof step>[]): number {
  let ms = 0;
  for (const s of steps) {
    ms += 200 + (s.ms ?? (s.type === 'drag' || (s.type === 'touch' && s.to) ? 300 : 0)) + (s.frames ?? 0) * 50;
    if (s.type === 'text') ms += (s.text?.length ?? 0) * 5;
  }
  return ms;
}

export const gameInput = defineOp({
  name: 'game.input',
  group: 'game',
  title: 'Send input to game',
  description:
    'Godot game: send input steps in order (keys, actions, clicks on positions or nodes, drags, scroll, typing, joypad, touch, waits). Reports the Control and physics object under each click.',
  input: z.object({ steps: z.array(step).min(1).max(200), run_id: runId }),
  readOnly: false,
  destructive: false,
  run: ({ steps, run_id }, ctx) => runtimeCall(ctx, run_id, 'input.run', { steps }, 15_000 + stepsDurationMs(steps)),
});

// ---------------------------------------------------------------------------
// godot_game_time
// ---------------------------------------------------------------------------

/**
 * Suspend or resume the whole game: what the editor's Game view "Suspend" toggle (F9)
 * sends (editor/run/game_view_plugin.cpp). SceneTree::set_suspend stops every node
 * (Node::can_process() is false while suspended, whatever its process_mode), deactivates
 * the physics servers and freezes Engine.time_scale (reads 0). It does NOT set
 * SceneTree.paused (the game's own pause state) and does not stop the main loop: the
 * engine keeps iterating, so Engine.get_process_frames()/get_physics_frames() keep
 * counting while nothing in the game moves.
 *
 * SceneDebugger's suspend handler also recomputes the game's input state:
 * input is disabled while suspended OR while RuntimeNodeSelect's "node select
 * type" is not NONE (scene/debugger/runtime_node_select.cpp). That type
 * defaults to NODE_TYPE_2D and only the editor's Game view sets it (to NONE in
 * its "Input" mode), so in a game we launched, the first resume would leave the
 * root viewport's input disabled for good (verified with 4.7.2: clicks stop
 * reaching Controls). For process runs we therefore select NONE first. Editor
 * runs keep whatever mode the user picked in the Game view.
 */
async function setSuspended(game: GameTarget, on: boolean): Promise<void> {
  if (game.channel.kind === 'process') await game.channel.native('scene:runtime_node_select_set_type', [0]);
  await game.channel.native('scene:suspend_changed', [on]);
}

/** Runtime time.state plus what the server knows (the user speed). */
async function timeState(game: GameTarget, ctx: OpContext): Promise<Record<string, unknown>> {
  const s = (await game.channel.request('time.state', {}, { signal: ctx.signal })) as {
    suspended: boolean;
    paused: boolean;
    time_scale: number;
    frames: number;
    physics_frames: number;
  };
  const speed = (game.channel.hello && speeds.get(game.channel.hello)) ?? 1;
  return {
    run_id: game.runId,
    // Editor-style whole-game pause (game.time pause).
    suspended: s.suspended,
    // The game's own SceneTree.paused (its pause menu), untouched by these tools.
    tree_paused: s.paused,
    speed,
    // Engine.time_scale reads 0 while suspended, so the game's own scale is unknown then.
    ...(s.suspended ? {} : { game_time_scale: s.time_scale }),
    effective_time_scale: s.suspended ? 0 : Math.round(s.time_scale * speed * 1000) / 1000,
    frames: s.frames,
    physics_frames: s.physics_frames,
  };
}

export const gameTime = defineOp({
  name: 'game.time',
  group: 'game',
  title: 'Game time control',
  description:
    'Godot game: pause/resume the whole game (Godot\'s suspend: no node processes; SceneTree.paused untouched), step frames or physics ticks, set speed, or wait for a node, signal, condition, frames or seconds.',
  input: z.object({
    action: z.enum(['state', 'pause', 'resume', 'step', 'speed', 'wait_for']),
    frames: z.number().int().min(1).max(10_000).optional().describe('step: frames to advance (default 1); wait_for: frames.'),
    physics_ticks: z.number().int().min(1).max(MAX_STEP_FRAMES).optional().describe('step: exactly N physics ticks instead.'),
    scale: z.number().min(0.01).max(100).optional().describe('speed: 1 = normal.'),
    node: z.string().optional().describe('wait_for: node to appear; signal emitter; condition base.'),
    signal: z.string().optional(),
    condition: z.string().optional().describe('Expression on node, e.g. "position.x > 300".'),
    seconds: z.number().min(0).optional().describe('wait_for: game seconds.'),
    timeout_ms: z.number().int().min(0).max(300_000).default(10_000),
    run_id: runId,
  }),
  readOnly: false,
  destructive: false,
  async run(args, ctx) {
    const game = await resolveGame(ctx, args.run_id);
    const ch = game.channel;
    switch (args.action) {
      case 'state':
        return { data: await timeState(game, ctx) };
      case 'pause':
      case 'resume':
        await setSuspended(game, args.action === 'pause');
        return { data: await timeState(game, ctx) };
      case 'speed': {
        if (args.scale === undefined) throw new OpError('BAD_PARAMS', 'speed needs "scale" (e.g. 0.25 for slow motion, 2 for double speed, 1 to reset).');
        await ch.native('scene:speed_changed', [new GodotFloat(args.scale)]);
        if (ch.hello) speeds.set(ch.hello, args.scale);
        return { data: await timeState(game, ctx) };
      }
      case 'step': {
        // Two units: `frames` = main-loop iterations (each runs 0..n physics ticks, then
        // one process frame and a draw), `physics_ticks` = exactly that many physics ticks.
        // One frame is NOT one tick: at ~30 fps (software rendering) and 60 ticks/s a frame
        // runs ~2 ticks, so frame stepping could never advance a single physics tick.
        const ticks = args.physics_ticks;
        const count = ticks ?? args.frames ?? 1;
        if (count > MAX_STEP_FRAMES) {
          throw new OpError('BAD_PARAMS', `step advances at most ${MAX_STEP_FRAMES} ${ticks ? 'physics ticks' : 'frames'} per call (got ${count}). For longer spans resume and use wait_for frames/seconds, then pause again.`);
        }
        // Stepping needs the suspended state; pause first if the game is running.
        const before = await timeState(game, ctx);
        if (!before.suspended) await setSuspended(game, true);
        const stepped = { frames: 0, physics_ticks: 0 };
        // Tick mode: each iteration runs at most one tick (the runtime caps it), but may run
        // none when frames are faster than ticks, so iterate until enough ticks have run.
        // The bound only guards against a game whose physics never ticks.
        const maxIterations = ticks ? ticks * 4 + 20 : count;
        for (let i = 0; i < maxIterations && (ticks ? stepped.physics_ticks < ticks : i < count); i++) {
          // The runtime request goes first, so it is normally already waiting when Godot's
          // scene:next_frame un-suspends the game for one iteration (time.step_wait copes
          // with the other order too); it answers once SceneDebugger has suspended the
          // game again, with what that iteration actually ran.
          const wait = ch.request('time.step_wait', ticks ? { ticks: true } : {}, { timeoutMs: 10_000, signal: ctx.signal });
          wait.catch(() => undefined); // awaited below; avoids an unhandled rejection if native() throws first
          await ch.native('scene:next_frame');
          const r = (await wait) as { frames: number; physics_ticks: number };
          stepped.frames += r.frames;
          stepped.physics_ticks += r.physics_ticks;
        }
        const state = await timeState(game, ctx);
        // The engine's total frame counters keep counting while suspended (the main loop
        // runs on, only the nodes stop), so they say nothing about the step; `stepped` does.
        delete state.frames;
        delete state.physics_frames;
        return { data: { stepped, ...(before.suspended ? {} : { paused_first: true }), ...state } };
      }
      case 'wait_for': {
        const { node, signal, condition, frames, seconds, timeout_ms } = args;
        if (node === undefined && signal === undefined && condition === undefined && frames === undefined && seconds === undefined) {
          throw new OpError('BAD_PARAMS', 'wait_for needs one of: node (wait until it exists), signal (+ node = emitter), condition (+ node = base node), frames, seconds.');
        }
        const params = Object.fromEntries(Object.entries({ node, signal, condition, frames, seconds, timeout_ms }).filter(([, v]) => v !== undefined));
        // The runtime enforces timeout_ms itself; the channel timeout is only a backstop.
        const result = (await ch.request('time.wait_for', params, { timeoutMs: timeout_ms + REPLY_MARGIN_MS, signal: ctx.signal })) as Record<string, unknown>;
        return { data: { run_id: game.runId, ...result } };
      }
    }
  },
});

// ---------------------------------------------------------------------------
// godot_game_record
// ---------------------------------------------------------------------------

export const gameRecord = defineOp({
  name: 'game.record',
  group: 'game',
  title: 'Record/replay game input',
  description:
    'Godot game: record the game\'s input events (real and injected) with timestamps, stop to get them as compact JSON (or save to a file), and replay them with the original timing.',
  input: z.object({
    action: z.enum(['start', 'stop', 'replay']),
    path: z.string().optional().describe('stop: save JSON here (user:// or res://); replay: load from here.'),
    recording: z.record(z.string(), z.unknown()).optional().describe('replay: the object stop returned.'),
    speed: z.number().min(0.01).max(100).optional().describe('replay speed (default 1).'),
    run_id: runId,
  }),
  readOnly: false,
  destructive: false,
  async run({ action, path, recording, speed, run_id }, ctx) {
    if (action === 'start') return runtimeCall(ctx, run_id, 'record.start');
    if (action === 'stop') return runtimeCall(ctx, run_id, 'record.stop', path ? { path } : {});
    if (!recording && !path) throw new OpError('BAD_PARAMS', 'replay needs "recording" (the object returned by action "stop") or "path" to a recording saved with stop.');
    // The runtime answers when the replay is over: allow its duration plus a margin.
    // A file's duration is unknown here, so allow up to 10 minutes for those.
    const events = (recording?.events ?? []) as { t?: number }[];
    const durationMs = recording ? Math.max(0, ...events.map((e) => Number(e?.t ?? 0))) : 600_000;
    const timeoutMs = durationMs / (speed ?? 1) + 15_000;
    return runtimeCall(ctx, run_id, 'record.replay', { ...(recording ? { recording } : { path }), ...(speed ? { speed } : {}) }, timeoutMs);
  },
});

/** Operations in this area, in the order they should appear in tools/list. */
export const operations: Operation[] = [gameInput, gameTime, gameRecord] as Operation[];
