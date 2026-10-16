/**
 * Breakpoint debugging state for one process run (the server is the game's
 * remote debugger, see debugSession.ts and docs/runtime-protocol.md section 2).
 *
 * Everything here speaks Godot's own debugger protocol; there is no DAP. The
 * message names and layouts below were checked against Godot 4.7.2
 * (core/debugger/remote_debugger.cpp, core/debugger/debugger_marshalls.cpp,
 * editor/debugger/script_editor_debugger.cpp, modules/gdscript/gdscript_editor.cpp)
 * and against a real 4.7.2 game:
 *
 *   debugger -> game, any time (routed to the "core" capture):
 *     core:breakpoint [source: String, line: int, set: bool]
 *         NOTE the order: source first. RemoteDebugger calls
 *         insert_breakpoint(data[1], data[0]) and the editor sends
 *         [path, line, enabled]. `source` must equal the script's path
 *         exactly ("res://player.gd").
 *     core:break []            pause: the game enters its debug loop at the
 *                              next poll (between frames, or every 2048
 *                              GDScript lines), with NO script stack.
 *   game -> debugger:
 *     debug_enter [can_continue: bool, error: String, has_stack: bool, thread_id: int]
 *         error is "Breakpoint" for breakpoints and finished steps,
 *         "Breakpoint Statement" for the `breakpoint` keyword, "" for a pause,
 *         and the error text for script errors (can_continue is false then;
 *         the editor only allows Continue).
 *     debug_exit []            sent when the loop is left (continue/step).
 *   debugger -> game, only while stopped (bare names; sent to the stopped thread):
 *     step / next / out / continue []
 *     get_stack_dump []        -> stack_dump [3*n, file, line, function, ...]
 *                                 (innermost frame first; note file/LINE/function,
 *                                 unlike the error message's file/function/line)
 *     get_stack_frame_vars [frame]
 *                              -> stack_frame_vars [count], then `count` messages
 *                                 stack_frame_var [name, scope, variant_type, value, type_hint]
 *                                 (DebuggerMarshalls::ScriptStackVariable; scope
 *                                 0 local, 1 member, 2 global; members start with
 *                                 "self" when the frame has an instance; objects
 *                                 come as ids, values over 1 MiB as null)
 *     evaluate [expression, frame]
 *                              -> evaluation_return [expression, 3, variant_type, value, type_hint]
 *                                 Godot's Expression runs with the frame's locals
 *                                 and globals as inputs and `self` as the base.
 *                                 Parse/runtime failures return null and send an
 *                                 "error" message (its description has the text).
 *
 * Hazards found in the 4.7.2 source and avoided here:
 *   - get_stack_frame_vars must carry exactly one element and evaluate two
 *     (ERR_FAIL_COND leaves the debug loop otherwise);
 *   - evaluate on a frame without an instance (a static function, an index out
 *     of range) executes `break` in the loop, which RESUMES the game; and with
 *     no stack (after a pause) it dereferences a null language: so evaluate
 *     only runs on a frame whose variables include "self";
 *   - core:break while already stopped nests a second debug loop: pause is a
 *     no-op when the game is already stopped;
 *   - a bare debugger command sent while the game runs is silently ignored
 *     (poll_events hands it to the core capture, which doesn't know it); the
 *     probe below relies on that.
 */

import { EventEmitter } from 'node:events';
import { OpError } from '../errors.js';
import type { GameRun } from '../godot/runs.js';
import type { DebugSession, GameMessage } from './debugSession.js';

/** Why the game is stopped. */
export type StopReason = 'breakpoint' | 'step' | 'pause' | 'error' | 'breakpoint_statement';

export interface StopInfo {
  reason: StopReason;
  /** Error text for reason "error" (from debug_enter). */
  error?: string;
  /** False after a script error: Godot only allows continue then (the failing function is aborted). */
  canStep: boolean;
  /** False after a pause: no GDScript was running, so there is no call stack. */
  hasStack: boolean;
  /** The thread that stopped (commands while stopped go to it). */
  thread: number;
  /** Increments with every stop; caches are keyed on it. */
  id: number;
}

export interface StackFrame {
  file: string;
  line: number;
  function: string;
}

/** One variable from stack_frame_var (DebuggerMarshalls::ScriptStackVariable). */
export interface StackVariable {
  name: string;
  /** 0 local, 1 member, 2 global (3 = an evaluate result). */
  scope: number;
  /** Godot Variant::Type of the value (24 = OBJECT). */
  type: number;
  /** Decoded value (variant.ts conventions; objects as { object_id }). */
  value: unknown;
  /** Class (or script class_name) for objects, else "". */
  typeHint: string;
}

/** Variant::Type values the formatting needs. */
export const VARIANT_NIL = 0;
export const VARIANT_OBJECT = 24;

/** How long to wait for a reply to a query while the game is stopped (it answers in ~10 ms). */
const QUERY_TIMEOUT_MS = 5_000;
/** How long the start-up probe waits for a stack_dump before deciding the game is running. */
const PROBE_TIMEOUT_MS = 500;
/** After an evaluate returns null, how long to wait for the "error" message Godot flushes next. */
const EVAL_ERROR_GRACE_MS = 250;

/** "res://a.gd:12" -> { file, line } (split at the last colon, like Godot's --breakpoints parser). */
export function splitBreakpoint(spec: string): { file: string; line: number } | undefined {
  const i = spec.lastIndexOf(':');
  if (i <= 0) return undefined;
  const line = Number(spec.slice(i + 1));
  if (!Number.isInteger(line)) return undefined;
  return { file: spec.slice(0, i), line };
}

/** Parse a stack_dump payload: [3*n, file, line, function, ...]. */
export function parseStackDump(data: unknown[]): StackFrame[] {
  const n = Math.floor(Number(data[0] ?? 0) / 3);
  const frames: StackFrame[] = [];
  for (let i = 0; i < n; i++) {
    const b = 1 + i * 3;
    if (b + 2 >= data.length) break; // truncated payload: keep what's complete
    frames.push({ file: String(data[b]), line: Number(data[b + 1]), function: String(data[b + 2]) });
  }
  return frames;
}

/** Parse a stack_frame_var / evaluation_return payload: [name, scope, type, value, type_hint]. */
export function parseStackVariable(data: unknown[]): StackVariable {
  return { name: String(data[0]), scope: Number(data[1]), type: Number(data[2]), value: data[3] ?? null, typeHint: String(data[4] ?? '') };
}

export class DebugState extends EventEmitter {
  /** Breakpoints this server set in the game: file -> lines. Seeded from run.start's --breakpoints. */
  readonly breakpoints = new Map<string, Set<number>>();
  /** Set while the game sits in Godot's debug loop. */
  stop: StopInfo | undefined;
  private stops = 0;
  /** A step was sent: the next "Breakpoint" stop is reported as reason "step". */
  private stepping = false;
  /** Serializes request/reply exchanges so concurrent tool calls don't take each other's replies. */
  private lock: Promise<unknown> = Promise.resolve();
  private stackCache: { stopId: number; frames: StackFrame[] } | undefined;
  private varsCache = new Map<string, StackVariable[]>();
  /** Resolves once we know whether the game was already stopped when this state was created. */
  readonly ready: Promise<void>;

  constructor(
    readonly run: GameRun,
    readonly session: DebugSession,
  ) {
    super();
    session.on('message:debug_enter', (m: GameMessage) => this.onEnter(m));
    session.on('message:debug_exit', () => this.onExit());
    session.on('close', () => {
      this.stop = undefined;
      this.emit('closed');
    });
    this.seedBreakpoints();
    // Created after the game connected (states are made lazily, on the first debug tool
    // call), so a debug_enter may already have gone by: ask for a stack dump to find out.
    this.ready = session.isConnected ? this.probe() : Promise.resolve();
  }

  /** Breakpoints passed to godot_run_start (Godot's --breakpoints), kept on the run. */
  private seedBreakpoints(): void {
    for (const spec of this.run.initialBreakpoints) {
      const bp = splitBreakpoint(spec);
      if (bp) this.remember(bp.file, bp.line, true);
    }
  }

  private remember(file: string, line: number, set: boolean): void {
    if (set) {
      if (!this.breakpoints.has(file)) this.breakpoints.set(file, new Set());
      this.breakpoints.get(file)!.add(line);
    } else {
      this.breakpoints.get(file)?.delete(line);
      if (this.breakpoints.get(file)?.size === 0) this.breakpoints.delete(file);
    }
  }

  /** Breakpoints as sorted "res://a.gd:12" strings. */
  list(): string[] {
    const out: string[] = [];
    for (const [file, lines] of [...this.breakpoints].sort(([a], [b]) => a.localeCompare(b))) {
      for (const line of [...lines].sort((a, b) => a - b)) out.push(`${file}:${line}`);
    }
    return out;
  }

  hasBreakpoint(file: string, line: number): boolean {
    return this.breakpoints.get(file)?.has(line) ?? false;
  }

  /** Set or clear a breakpoint in the game (works while running and while stopped). */
  setBreakpoint(file: string, line: number, set: boolean): void {
    // Always to the main thread: it either polls this between frames or, when it is the
    // stopped thread, hands "core:" commands to the core capture from inside the debug loop.
    if (!this.session.send('core:breakpoint', [file, line, set])) throw gone();
    this.remember(file, line, set);
  }

  private onEnter(m: GameMessage): void {
    const [canContinue, error, hasStack, thread] = m.data as [boolean, string, boolean, number];
    const text = String(error ?? '');
    let reason: StopReason;
    if (text === 'Breakpoint') reason = this.stepping ? 'step' : 'breakpoint';
    else if (text === 'Breakpoint Statement') reason = 'breakpoint_statement';
    else if (text === '') reason = 'pause';
    else reason = 'error';
    this.stepping = false;
    this.varsCache.clear(); // keyed by stop id: entries of earlier stops are dead
    this.stop = {
      reason,
      ...(reason === 'error' ? { error: text } : {}),
      canStep: Boolean(canContinue),
      hasStack: Boolean(hasStack),
      thread: Number.isSafeInteger(Number(thread)) && Number(thread) > 0 ? Number(thread) : m.thread,
      id: ++this.stops,
    };
    this.emit('stopped', this.stop);
  }

  private onExit(): void {
    this.stop = undefined;
    this.emit('resumed');
  }

  /** See the constructor: find out whether the game is already stopped. */
  private async probe(): Promise<void> {
    let frames: StackFrame[];
    try {
      const reply = this.session.waitFor('stack_dump', PROBE_TIMEOUT_MS);
      this.session.send('get_stack_dump', []);
      frames = parseStackDump((await reply).data);
    } catch {
      return; // No answer: running (a running game ignores bare commands).
    }
    if (this.stop) return; // A debug_enter arrived meanwhile; it knows better.
    // Reconstruct why it stopped from what we can see.
    const top = frames[0];
    let reason: StopReason = 'pause';
    let error: string | undefined;
    if (top) {
      // An error stop sends debug_enter first and the "error" message (kept in run.errors)
      // on the loop's next flush, so give a just-stopped game a moment to deliver it.
      const errorAtTop = () => {
        const last = this.run.errors.at(-1);
        const e = last?.stack[0];
        return last && last.level === 'error' && e && e.file === top.file && e.line === top.line ? last : undefined;
      };
      if (!this.hasBreakpoint(top.file, top.line) && !errorAtTop()) await new Promise((r) => setTimeout(r, 150));
      const err = this.hasBreakpoint(top.file, top.line) ? undefined : errorAtTop();
      if (err) {
        reason = 'error';
        error = err.message;
      } else reason = 'breakpoint'; // a breakpoint we don't know of, or a `breakpoint` statement
      if (this.stop) return;
    }
    this.stop = { reason, ...(error ? { error } : {}), canStep: reason !== 'error', hasStack: frames.length > 0, thread: 0, id: ++this.stops };
    // thread 0 = "the main thread" (DebugSession's default) for commands.
    this.stackCache = { stopId: this.stop.id, frames };
  }

  /** Run `fn` after every earlier exchange finished (one request/reply at a time). */
  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.lock.then(fn, fn);
    this.lock = next.catch(() => undefined);
    return next;
  }

  /** The stop we're in, or a clear error when the game is running. */
  requireStopped(): StopInfo {
    if (!this.stop) {
      throw new OpError('CONFLICT', 'The game is running, not stopped at a breakpoint. Use godot_debug_control action "pause", or set a breakpoint with godot_debug_breakpoints and wait for it.');
    }
    return this.stop;
  }

  /** Send a command to the stopped thread. */
  private sendStopped(command: string, data: (string | number)[] = []): void {
    const thread = this.stop?.thread;
    const ok = thread ? this.session.send(command, data, thread) : this.session.send(command, data);
    if (!ok) throw gone();
  }

  /** The call stack of the current stop (innermost first), from a fresh stack dump (cached per stop). */
  stack(): Promise<StackFrame[]> {
    return this.exclusive(async () => {
      const stop = this.requireStopped();
      if (!stop.hasStack) return [];
      if (this.stackCache?.stopId === stop.id) return this.stackCache.frames;
      const reply = this.session.waitFor('stack_dump', QUERY_TIMEOUT_MS);
      this.sendStopped('get_stack_dump');
      const frames = parseStackDump((await reply.catch(wrapWait)).data);
      if (this.stop?.id === stop.id) this.stackCache = { stopId: stop.id, frames };
      return frames;
    });
  }

  /** Locals, members and globals of one frame (cached per stop and frame). */
  variables(frame: number): Promise<StackVariable[]> {
    return this.exclusive(async () => {
      const stop = this.requireStopped();
      // Without a stack Godot would print index errors and send only the globals.
      if (!stop.hasStack) return [];
      const key = `${stop.id}:${frame}`;
      const cached = this.varsCache.get(key);
      if (cached) return cached;
      // The count and all variables can arrive in one TCP chunk (emitted synchronously),
      // so the collector listens before the request goes out.
      const vars = await new Promise<StackVariable[]>((resolve, reject) => {
        const out: StackVariable[] = [];
        let expected = -1;
        const finish = (err?: Error) => {
          clearTimeout(timer);
          this.session.off('message', onMsg);
          this.session.off('close', onClose);
          if (err) reject(err);
          else resolve(out);
        };
        const onMsg = (m: GameMessage) => {
          if (m.message === 'stack_frame_vars') {
            expected = Number(m.data[0] ?? 0);
            if (expected <= 0) finish();
          } else if (m.message === 'stack_frame_var' && expected >= 0) {
            out.push(parseStackVariable(m.data));
            if (out.length >= expected) finish();
          }
        };
        const onClose = () => finish(gone());
        const timer = setTimeout(() => finish(new OpError('TIMEOUT', `The game did not send the variables of frame ${frame} within ${QUERY_TIMEOUT_MS} ms.`)), QUERY_TIMEOUT_MS);
        this.session.on('message', onMsg);
        this.session.once('close', onClose);
        try {
          this.sendStopped('get_stack_frame_vars', [frame]);
        } catch (err) {
          finish(err as Error);
        }
      });
      if (this.stop?.id === stop.id) this.varsCache.set(key, vars);
      return vars;
    });
  }

  /**
   * Evaluate a GDScript expression (Godot's Expression class, not full GDScript) in a frame:
   * the frame's locals and the globals are inputs, `self` is the base object, so members
   * and methods resolve too. Can have side effects (method calls).
   */
  async evaluate(expression: string, frame: number): Promise<{ value: unknown; type: number; typeHint: string; error?: string }> {
    const stop = this.requireStopped();
    if (!stop.hasStack) {
      throw new OpError('CONFLICT', 'There is no script call stack to evaluate in (the game was paused between frames). Use godot_debug_control action "step_into" to stop at the next GDScript line first.');
    }
    const frames = await this.stack();
    if (frame >= frames.length) throw new OpError('BAD_PARAMS', `Frame ${frame} doesn't exist; the stack has ${frames.length} frame(s) (0 = innermost).`);
    // Godot resumes the game if the frame has no instance (see the header), so check first.
    const vars = await this.variables(frame);
    if (!vars.some((v) => v.scope === 1 && v.name === 'self')) {
      throw new OpError(
        'UNSUPPORTED',
        `Frame ${frame} (${frames[frame]!.function}) has no object instance (a static function?), and Godot can only evaluate in frames with one. Pick another frame, or read its locals with godot_debug_state.`,
      );
    }
    return this.exclusive(async () => {
      if (this.stop?.id !== stop.id) throw new OpError('CONFLICT', 'The game resumed before the expression could be evaluated.');
      const errors: GameMessage[] = [];
      const onError = (m: GameMessage) => errors.push(m);
      this.session.on('message:error', onError);
      // Keep the evaluation's own error out of the game's error list (see GameRun.beginEvaluate).
      this.run.beginEvaluate();
      try {
        const reply = this.session.waitFor('evaluation_return', QUERY_TIMEOUT_MS);
        this.sendStopped('evaluate', [expression, frame]);
        const result = parseStackVariable((await reply.catch(wrapWait)).data);
        // A failed parse/execution returns null; the reason follows as an "error" message
        // on the next loop iteration (~10 ms later).
        if (result.value === null && result.type === VARIANT_NIL) {
          const deadline = Date.now() + EVAL_ERROR_GRACE_MS;
          while (errors.length === 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
        }
        const err = errors[0];
        // OutputError: [.., 7: error (often the failed C++ condition), 8: description (the useful text), ..].
        const text = err ? String(err.data[8] || err.data[7] || '') : '';
        // Only a null result can be a failure; an error next to a real value came from elsewhere.
        return { value: result.value, type: result.type, typeHint: result.typeHint, ...(text && result.value === null ? { error: text } : {}) };
      } finally {
        this.session.off('message:error', onError);
        this.run.endEvaluate();
      }
    });
  }

  /**
   * Wait up to `waitMs` for the game to stop (breakpoint, error, pause) without sending
   * anything: for debug.state {wait}, right after an action that is about to hit a
   * breakpoint (the stop arrives a moment after the action's own reply).
   */
  async waitForStop(waitMs: number, signal?: AbortSignal): Promise<StopInfo | 'exited' | 'timeout'> {
    if (this.stop) return this.stop;
    return this.nextStop(waitMs, signal);
  }

  /** Resolves with the next stop, "exited" when the game disconnects, or "timeout". */
  private nextStop(timeoutMs: number, signal?: AbortSignal): Promise<StopInfo | 'exited' | 'timeout'> {
    return new Promise((resolve) => {
      const done = (v: StopInfo | 'exited' | 'timeout') => {
        clearTimeout(timer);
        this.off('stopped', onStop);
        this.off('closed', onClosed);
        signal?.removeEventListener('abort', onAbort);
        resolve(v);
      };
      const onStop = (s: StopInfo) => done(s);
      const onClosed = () => done('exited');
      const onAbort = () => done('timeout');
      const timer = setTimeout(() => done('timeout'), timeoutMs);
      this.on('stopped', onStop);
      this.once('closed', onClosed);
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }

  /**
   * Resume ("continue") or step ("step" = into, "next" = over, "out"), then wait up to
   * `waitMs` for the game to stop again. Returns the new stop, "exited" or "timeout"
   * (still running).
   */
  async resume(command: 'continue' | 'step' | 'next' | 'out', waitMs: number, signal?: AbortSignal): Promise<StopInfo | 'exited' | 'timeout'> {
    const stop = this.requireStopped();
    if (command !== 'continue' && !stop.canStep) {
      throw new OpError('CONFLICT', 'The game stopped on a script error, and Godot only allows "continue" from there (the failing function is aborted). Fix the error, or continue.');
    }
    return this.exclusive(async () => {
      // Listen before sending: debug_exit and the next debug_enter can arrive together.
      const next = this.nextStop(waitMs, signal);
      this.stepping = command !== 'continue';
      this.sendStopped(command);
      // The game leaves its loop for sure; don't report a stale stop if debug_exit lags.
      this.stop = undefined;
      return next;
    });
  }

  /** Break into the debugger (no-op when already stopped). Waits up to `waitMs` for the stop. */
  async pause(waitMs: number, signal?: AbortSignal): Promise<StopInfo | 'exited' | 'timeout'> {
    if (this.stop) return this.stop;
    return this.exclusive(async () => {
      if (this.stop) return this.stop;
      const next = this.nextStop(waitMs, signal);
      if (!this.session.send('core:break', [])) throw gone();
      return next;
    });
  }
}

function gone(): OpError {
  return new OpError('GAME_NOT_RUNNING', 'The game is no longer connected (it exited or was stopped). Read what happened with godot_run_output.');
}

/** DebugSession.waitFor rejects with plain Errors; give them our codes. */
function wrapWait(err: Error): never {
  if (/disconnected/i.test(err.message)) throw gone();
  throw new OpError('TIMEOUT', `${err.message} The game may be busy or frozen.`);
}

const states = new WeakMap<GameRun, DebugState>();

/** The debug state of a process run, created on first use. */
export function debugStateFor(run: GameRun): DebugState {
  let s = states.get(run);
  if (!s) {
    if (!run.session) throw new OpError('UNSUPPORTED', 'This run has no debugger connection.');
    s = new DebugState(run, run.session);
    states.set(run, s);
  }
  return s;
}
