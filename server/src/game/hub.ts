/**
 * Finding "the game" for a runtime tool call.
 *
 * Runtime tools (godot_game_*, godot_debug_*, ...) take an optional run_id.
 * Resolution order:
 *   1. run_id given: that process run (started by godot_run_start in
 *      process mode). "editor" means the game started from the editor.
 *   2. no run_id: the newest process run that is still running;
 *   3. otherwise the game currently running from the editor, if the editor
 *      is connected and that game loaded the runtime.
 *
 * The editor case goes through the plugin's relay (editor/game_relay.gd):
 * messages from the game arrive as bridge "game.message" events, commands go
 * out with the bridge method "game.send". One EditorTransport per bridge
 * follows the newest editor debugger session.
 */

import { EventEmitter } from 'node:events';
import type { EditorBridge } from '../bridge/editorBridge.js';
import { OpError } from '../errors.js';
import type { GameRun, RunManager } from '../godot/runs.js';
import type { GameMessage } from './debugSession.js';
import { RuntimeChannel, type GameTransport, type RuntimeHello } from './runtime.js';
import { GodotFloat, type Encodable } from './variant.js';

/** How long a tool waits for a just-started game's runtime to say hello. */
const READY_TIMEOUT_MS = 10_000;

export const NO_GAME_HINT =
  'No game is running. Start one with godot_run_start (mode "process" works without the editor; headless: false shows a window), then retry.';

/** A game the runtime tools can talk to. */
export interface GameTarget {
  channel: RuntimeChannel;
  /** The process run, when the server launched the game. */
  run?: GameRun;
  /** "process" run id, or "editor". */
  runId: string;
}

class EditorTransport extends EventEmitter implements GameTransport {
  readonly kind = 'editor' as const;
  session = -1;
  open = false;

  constructor(private readonly bridge: EditorBridge) {
    super();
    bridge.on('event', (event: string, data: unknown) => {
      const d = (data ?? {}) as { session?: number; message?: string; data?: unknown[] };
      if (event === 'game.started') {
        this.session = Number(d.session);
        this.open = true;
      } else if (event === 'game.stopped' && Number(d.session) === this.session) {
        this.open = false;
        this.emit('close');
      } else if (event === 'game.message' && typeof d.message === 'string') {
        this.session = Number(d.session);
        this.open = true;
        const msg: GameMessage = { message: d.message, thread: 0, data: Array.isArray(d.data) ? d.data : [] };
        this.emit('message', msg);
      }
    });
    bridge.on('close', () => {
      if (this.open) {
        this.open = false;
        this.emit('close');
      }
    });
  }

  get isOpen(): boolean {
    return this.open && this.bridge.isOpen();
  }

  async send(command: string, data: (Encodable | GodotFloat)[]): Promise<void> {
    // GodotFloat isn't JSON; the plugin receives JSON numbers (always floats in Godot) anyway.
    const plain = data.map((v) => (v instanceof GodotFloat ? v.value : v));
    await this.bridge.request('game.send', { session: this.session, command, data: plain });
  }
}

/** One editor channel per bridge (the bridge object lives as long as the server). */
const editorChannels = new WeakMap<EditorBridge, RuntimeChannel>();

function editorChannel(bridge: EditorBridge): RuntimeChannel {
  let ch = editorChannels.get(bridge);
  if (!ch) {
    ch = new RuntimeChannel(new EditorTransport(bridge));
    editorChannels.set(bridge, ch);
  }
  return ch;
}

/**
 * Prepare a fresh editor channel: if the game started before this server
 * connected, the relay remembers its hello (game.status), which we replay.
 */
async function connectEditorGame(bridge: EditorBridge): Promise<RuntimeChannel | undefined> {
  if (!(await bridge.ensureConnected())) return undefined;
  const ch = editorChannel(bridge);
  const transport = ch.transport as EditorTransport;
  if (ch.isOpen && ch.hello) return ch;
  type Status = { sessions: { session: number; hello: string }[] };
  const fetchStatus = async () => (await bridge.request('game.status').catch(() => ({ sessions: [] }))) as Status;
  let status = await fetchStatus();
  if (status.sessions.length === 0) {
    // Just after run.play the editor is "playing" but the game hasn't connected yet:
    // wait for its hello (or session start) instead of failing.
    const editorStatus = (await bridge.request('editor.status').catch(() => ({}))) as { is_playing?: boolean };
    if (!editorStatus.is_playing) return undefined;
    await Promise.race([
      new Promise<void>((resolve) => ch.once('hello', () => resolve())),
      new Promise<void>((resolve) => setTimeout(resolve, READY_TIMEOUT_MS)),
    ]);
    if (ch.isOpen && ch.hello) return ch;
    status = await fetchStatus();
  }
  const newest = status.sessions[0];
  if (!newest) return undefined;
  transport.session = newest.session;
  transport.open = true;
  if (newest.hello) transport.emit('message', { message: 'mcp:hello', thread: 0, data: [newest.hello] } satisfies GameMessage);
  return ch;
}

/** Resolve the game for a runtime tool, waiting briefly for a just-started runtime. */
export async function resolveGame(ctx: { runs: RunManager; bridge: EditorBridge; signal?: AbortSignal }, runId?: string): Promise<GameTarget> {
  if (runId && runId !== 'editor') {
    const run = ctx.runs.get(runId);
    if (!run) throw new OpError('NOT_FOUND', `No run with id "${runId}". Known runs: ${ctx.runs.list().map((r) => r.id).join(', ') || 'none'}.`);
    if (!run.running) throw new OpError('GAME_NOT_RUNNING', `Run "${runId}" has exited (code ${run.exitCode}). Read what happened with godot_run_output, or start it again.`);
    return { channel: await ready(run.channel!, run), run, runId: run.id };
  }
  if (!runId) {
    const live = ctx.runs.list().filter((r) => r.running && r.channel).pop();
    if (live) return { channel: await ready(live.channel!, live), run: live, runId: live.id };
  }
  const ch = await connectEditorGame(ctx.bridge);
  if (ch && ch.isOpen) return { channel: await ready(ch), runId: 'editor' };
  throw new OpError('GAME_NOT_RUNNING', NO_GAME_HINT);
}

async function ready(ch: RuntimeChannel, run?: GameRun): Promise<RuntimeChannel> {
  if (ch.hello) return ch;
  const hello = await Promise.race([ch.ready, new Promise<undefined>((r) => setTimeout(() => r(undefined), READY_TIMEOUT_MS))]);
  if (hello) return ch;
  throw new OpError(
    'GAME_NOT_RUNNING',
    run && !run.running
      ? `The game exited before its runtime started. See godot_run_output for errors.`
      : 'The game is running but the Godot MCP runtime did not load in it. Make sure addons/godot_mcp is up to date (it contains runtime/mcp_runtime.gd), then restart the game.',
  );
}

export type { RuntimeHello };

/**
 * Convenience for runtime tools: resolve the game, call a runtime method and
 * return its result with the run id added, as an OpResult-style `data`.
 */
export async function runtimeCall(
  ctx: { runs: RunManager; bridge: EditorBridge; signal?: AbortSignal },
  runId: string | undefined,
  method: string,
  params: Record<string, unknown> = {},
  timeoutMs?: number,
): Promise<{ data: Record<string, unknown> }> {
  const game = await resolveGame(ctx, runId);
  const result = (await game.channel.request(method, params, { timeoutMs, signal: ctx.signal })) as Record<string, unknown>;
  return { data: { run_id: game.runId, ...result } };
}
