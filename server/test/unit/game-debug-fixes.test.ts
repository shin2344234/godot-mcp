/**
 * Unit tests for fixes found by building a test game through the MCP (the shooting
 * gallery log, Phases B/C):
 *   - runtime requests fail fast when the game stops at a breakpoint (GameStoppedError),
 *     and runtimeCall's stop description;
 *   - debugger evaluate errors stay out of a run's error list and error counts;
 *   - error counts count one error once (head lines only) in the lines view;
 *   - editor_logs merges repeated entries;
 *   - the script profiler reports the `func` line;
 *   - evaluate error text gets a sentence separator.
 */

import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcess } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { OpError } from '../../src/errors.js';
import { describeStop } from '../../src/game/hub.js';
import type { DebugSession, GameMessage } from '../../src/game/debugSession.js';
import { GameStoppedError, RuntimeChannel, type GameTransport } from '../../src/game/runtime.js';
import { declarationLine } from '../../src/game/scriptProfiler.js';
import { GameRun, isContinuationLine, isHeadLine } from '../../src/godot/runs.js';
import { withPeriod } from '../../src/ops/debug.js';
import { mergeLogEntries } from '../../src/ops/run.js';

// --- fakes -----------------------------------------------------------------------------

/** A transport that records what was sent and lets the test inject game messages. */
class FakeTransport extends EventEmitter implements GameTransport {
  readonly kind = 'process' as const;
  sent: { command: string; data: unknown[] }[] = [];
  get isOpen(): boolean {
    return true;
  }
  async send(command: string, data: unknown[]): Promise<void> {
    this.sent.push({ command, data });
  }
  game(message: string, data: unknown[] = []): void {
    this.emit('message', { message, thread: 1, data } satisfies GameMessage);
  }
}

/** A child process with stdout/stderr streams the test can write Godot output into. */
function fakeChild(): ChildProcess & { stderr: PassThrough; stdout: PassThrough } {
  const child = new EventEmitter() as ChildProcess & { stderr: PassThrough; stdout: PassThrough };
  Object.assign(child, { stdout: new PassThrough(), stderr: new PassThrough(), pid: 1, kill: () => true });
  return child;
}

/** A debug session stand-in: GameRun only listens for events and asks isConnected. */
function fakeSession(): DebugSession {
  const s = new EventEmitter() as unknown as DebugSession;
  Object.defineProperty(s, 'isConnected', { get: () => true });
  (s as unknown as { send: () => boolean }).send = () => true;
  (s as unknown as { close: () => void }).close = () => undefined;
  return s;
}

/** An OutputError payload (DebuggerMarshalls::OutputError, 4.7.2 layout). */
function outputError(error: string, descr: string, stack: [string, string, number][] = []): unknown[] {
  return [0, 0, 1, 0, 'core/math/expression.cpp', 'execute', 1600, error, descr, false, stack.length * 3, ...stack.flat()];
}

const flush = () => new Promise((r) => setImmediate(r));

// --- runtime channel: breakpoint stops --------------------------------------------------

describe('RuntimeChannel and debugger stops', () => {
  it('rejects pending requests at once when the game enters its debug loop', async () => {
    const t = new FakeTransport();
    const ch = new RuntimeChannel(t);
    const started = Date.now();
    const pending = ch.request('input.run', { steps: [] }, { timeoutMs: 15_000 });
    await flush();
    t.game('debug_enter', [true, 'Breakpoint', true, 1]);
    const err = await pending.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GameStoppedError);
    expect((err as GameStoppedError).method).toBe('input.run');
    expect((err as OpError).message).toMatch(/stopped in the debugger.*godot_debug_state/);
    expect(Date.now() - started).toBeLessThan(1000); // not the 15 s timeout
    expect(ch.stopped).toBe(true);
    t.game('debug_exit');
    expect(ch.stopped).toBe(false);
  });

  it('ignores the late reply of an interrupted request', async () => {
    const t = new FakeTransport();
    const ch = new RuntimeChannel(t);
    const pending = ch.request('game.tree').catch(() => 'stopped');
    await flush();
    t.game('debug_enter', [true, 'Breakpoint', true, 1]);
    expect(await pending).toBe('stopped');
    // The runtime finishes the call after "continue" and replies; nothing breaks.
    t.game('mcp:reply', [JSON.stringify({ id: 1, result: { ok: true } })]);
  });

  it('times out quickly, with a hint to continue, for requests sent while stopped', async () => {
    const t = new FakeTransport();
    const ch = new RuntimeChannel(t);
    t.game('debug_enter', [true, 'Breakpoint', true, 1]);
    const err = await ch.request('time.wait_for', {}, { timeoutMs: 50 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OpError);
    expect((err as OpError).code).toBe('TIMEOUT');
    expect((err as OpError).message).toMatch(/stopped in the debugger.*continue/);
  });

  it('describes an editor-debugger stop without a process debug state', async () => {
    const ch = new RuntimeChannel(new FakeTransport());
    const out = await describeStop({ channel: ch, runId: 'editor' }, new GameStoppedError('input.run', [true, '', true, 0]));
    expect(out).toMatchObject({ completed: false, stopped: { reason: 'debugger', can_continue: true } });
    expect(String(out.note)).toMatch(/editor's debugger/);
  });
});

// --- game runs: evaluate errors and counts ------------------------------------------------

describe('GameRun error bookkeeping', () => {
  it('counts one error once in the lines view (continuation lines are not errors of their own)', async () => {
    const child = fakeChild();
    const run = new GameRun(child, 'main', true);
    child.stderr.write('ERROR: Something broke.\n   at: _ready (res://main.gd:3)\n   GDScript backtrace (most recent call first):\n       [0] _ready (res://main.gd:3)\n');
    child.stderr.write('WARNING: deprecated thing\n   at: foo (res://a.gd:1)\nplain print\n');
    await flush();
    expect(run.counts()).toMatchObject({ errors: 1, warnings: 1, lines: 7 });
    // The level filter still shows the whole report, continuation lines included.
    expect(run.read(0, 100, 'error').lines.map((l) => l.text.trim().slice(0, 6))).toEqual(['ERROR:', 'at: _r', 'GDScri', '[0] _r']);
  });

  it('keeps debugger evaluate errors out of run.errors and the counts', async () => {
    const child = fakeChild();
    const session = fakeSession();
    const run = new GameRun(child, 'main', true, session);
    const emitError = (data: unknown[]) => (session as unknown as EventEmitter).emit('message:error', { message: 'error', thread: 1, data });

    // A real game error is recorded.
    emitError(outputError('', 'Real bug', [['res://duck.gd', '_physics_process', 23]]));
    expect(run.errors.map((e) => e.message)).toEqual(['Real bug']);

    // An evaluate's failure (with the stopped frame's backtrace) is not.
    run.beginEvaluate();
    emitError(outputError('Method/function failed.', "Invalid named index 'undefined_thing' for base type Object", [['res://duck.gd', '_physics_process', 23]]));
    run.endEvaluate();
    expect(run.errors).toHaveLength(1);

    // Its stderr copy arrives late through the pipe: recognised by text, shown as EVAL info.
    child.stderr.write("ERROR: Invalid named index 'undefined_thing' for base type Object\n   at: execute (core/math/expression.cpp:1600)\n");
    await flush();
    const page = run.read(0, 100, 'all').lines;
    expect(page.map((l) => [l.level, Boolean(l.evaluate)])).toEqual([
      ['info', true],
      ['info', true],
    ]);
    expect(run.counts()).toMatchObject({ errors: 0, warnings: 0 });

    // The same text later, from the game itself, counts again (the match is used up).
    child.stderr.write("ERROR: Invalid named index 'undefined_thing' for base type Object\n");
    await flush();
    expect(run.counts().errors).toBe(1);
  });

  it('tags driver start-up noise as ENV and leaves it out of the counts', async () => {
    // What every windowed run printed under Xvfb in the 2D dogfood test (Godot 4.7.2):
    // run_start said errors: 3, warnings: 3 for a game without a bug.
    const child = fakeChild();
    const session = fakeSession();
    const run = new GameRun(child, 'main', false, session);
    const emitError = (data: unknown[], file: string) => {
      const d = outputError('Method/function failed. Returning: ERR_BUG', 'Required Vulkan instance extension VK_KHR_surface not found.');
      d[4] = file;
      (session as unknown as EventEmitter).emit('message:error', { message: 'error', thread: 1, data: d });
    };
    emitError([], 'drivers/vulkan/rendering_context_driver_vulkan.cpp');
    child.stderr.write('ERROR: Required Vulkan instance extension VK_KHR_surface not found.\n   at: _initialize_instance_extensions (drivers/vulkan/rendering_context_driver_vulkan.cpp:494)\n');
    child.stderr.write('WARNING: All audio drivers failed, falling back to the dummy driver.\n   at: initialize (servers/audio/audio_server.cpp:258)\n');
    child.stderr.write("ALSA lib pcm.c:2721:(snd_pcm_open_noupdate) Unknown PCM default\n");
    child.stderr.write('ERROR: A real one.\n   at: _ready (res://main.gd:3)\n');
    await flush();
    expect(run.counts()).toMatchObject({ errors: 1, warnings: 0, environment: 2 });
    expect(run.read(0, 100, 'all').lines.map((l) => Boolean(l.env))).toEqual([true, true, true, true, true, false, false]);
    expect(run.read(0, 100, 'error').lines.map((l) => l.text)).toEqual(['ERROR: A real one.', '   at: _ready (res://main.gd:3)']);
    expect(run.errors[0]?.env).toBe(true);
    // After the runtime's hello the engine has started: driver errors count again.
    (run.channel as unknown as { helloResolve: (h: unknown) => void }).helloResolve({});
    await flush();
    child.stderr.write('ERROR: Late driver error.\n   at: f (drivers/gles3/rasterizer_gles3.cpp:10)\n');
    await flush();
    expect(run.counts()).toMatchObject({ errors: 2, environment: 2 });
  });

  it('splits head and continuation lines', () => {
    expect(isHeadLine('SCRIPT ERROR: x')).toBe('error');
    expect(isHeadLine('USER WARNING: y')).toBe('warning');
    expect(isHeadLine('   at: f (a.gd:1)')).toBeUndefined();
    expect(isContinuationLine('   at: f (a.gd:1)')).toBe(true);
    expect(isContinuationLine('       [0] _ready (res://main.gd:3)')).toBe(true);
    expect(isContinuationLine('hello')).toBe(false);
  });
});

// --- editor_logs merging ---------------------------------------------------------------------

describe('mergeLogEntries', () => {
  const bad = (seq: number, serial: number) => ({
    seq,
    level: 'error',
    kind: 'error',
    message: `Unhandled XServer error: BadWindow (invalid Window parameter)\n   Major opcode of failed request: 20\n   Serial number of failed request: ${serial}`,
    file: 'platform/linuxbsd/x11/display_server_x11.cpp',
    line: 120,
    function: 'bad_window_error_handler',
    time: `t${seq}`,
  });

  it('merges errors that differ only in numbers, keeping the first text and order', () => {
    const merged = mergeLogEntries([bad(1, 100), { seq: 2, level: 'info', message: 'hello' }, bad(3, 101), bad(4, 102)]);
    expect(merged).toHaveLength(2);
    expect(merged[0]).toMatchObject({ seq: 1, count: 3, last_seq: 4, last_time: 't4' });
    expect(String(merged[0]!.message)).toContain('Serial number of failed request: 100');
    expect(merged[1]).toMatchObject({ seq: 2, message: 'hello' });
    expect(merged[1]!.count).toBeUndefined();
  });

  it('merges plain messages only when identical', () => {
    const merged = mergeLogEntries([
      { seq: 1, level: 'info', message: 'score 1' },
      { seq: 2, level: 'info', message: 'score 2' },
      { seq: 3, level: 'info', message: 'score 2' },
    ]);
    expect(merged.map((e) => [e.message, e.count ?? 1])).toEqual([
      ['score 1', 1],
      ['score 2', 2],
    ]);
  });
});

// --- script profiler lines ---------------------------------------------------------------------

describe('declarationLine', () => {
  const src = [
    'extends Node', // 1
    '', // 2
    'func _process(delta: float) -> void:', // 3
    '\tpass', // 4
    '', // 5
    'static func helper(', // 6
    '\t\ta: int,', // 7
    '\t\tb: int) -> int:', // 8
    '\t# comment', // 9
    '\treturn a + b', // 10
    '', // 11
    'class Inner:', // 12
    '\tfunc run() -> void:', // 13
    '\t\tprint(1)', // 14
  ].join('\n');

  it('moves the profiler\'s first body line to the func line', () => {
    expect(declarationLine(src, 4, '_process')).toBe(3);
    expect(declarationLine(src, 10, 'helper')).toBe(6); // multi-line signature, comment between
    expect(declarationLine(src, 14, 'Inner.run')).toBe(13); // inner class: "Class.method"
  });

  it('gives up when it cannot find the declaration', () => {
    expect(declarationLine(src, 4, 'missing')).toBeUndefined();
    expect(declarationLine(src, 4, '<anonymous lambda>')).toBeUndefined();
  });
});

describe('withPeriod', () => {
  it('adds a period only when the sentence has no final punctuation', () => {
    expect(withPeriod("Invalid named index 'x' for base type Object")).toBe("Invalid named index 'x' for base type Object.");
    expect(withPeriod('Already done.')).toBe('Already done.');
    expect(withPeriod('Expected one of: ')).toBe('Expected one of:');
  });
});
