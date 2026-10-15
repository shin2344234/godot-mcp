/**
 * Unit tests for breakpoint debugging (src/game/debugState.ts, src/ops/debug.ts) against a
 * fake game: a TCP client speaking the debugger wire format to a real DebugSession, with
 * payloads shaped like Godot 4.7.2's (recorded from a real game, see debugState.ts).
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { DebugSession } from '../../src/game/debugSession.js';
import { DebugState, parseStackDump, parseStackVariable, splitBreakpoint } from '../../src/game/debugState.js';
import { framePacket, PacketReader, type Encodable } from '../../src/game/variant.js';
import type { GameRun } from '../../src/godot/runs.js';
import { resolveBreakpoint } from '../../src/ops/debug.js';

type Cmd = [string, number, unknown[]];

/** A fake game connected to a DebugSession. `reply` answers commands the debugger sends. */
async function fakeGame(reply: (cmd: Cmd, game: { send: (msg: string, data: Encodable[]) => void; sendMany: (msgs: [string, Encodable[]][]) => void }) => void = () => {}) {
  const session = new DebugSession();
  await session.listen();
  const sock = net.connect(session.port, '127.0.0.1');
  await session.connected;
  const reader = new PacketReader();
  const received: Cmd[] = [];
  const game = {
    send: (msg: string, data: Encodable[]) => sock.write(framePacket([msg, 1, data])),
    // Several messages in ONE write, as Godot's peer thread often does.
    sendMany: (msgs: [string, Encodable[]][]) => sock.write(Buffer.concat(msgs.map(([m, d]) => framePacket([m, 1, d])))),
  };
  sock.on('data', (d) => {
    for (const p of reader.push(d)) {
      received.push(p as Cmd);
      reply(p as Cmd, game);
    }
  });
  const close = () => {
    sock.destroy();
    session.close();
  };
  return { session, received, ...game, close };
}

/** A stand-in GameRun: only the fields DebugState reads. */
function fakeRun(initialBreakpoints: string[] = []): GameRun {
  // beginEvaluate/endEvaluate: GameRun's hooks that keep evaluate errors out of run.errors.
  return { errors: [], initialBreakpoints, beginEvaluate: () => undefined, endEvaluate: () => undefined } as unknown as GameRun;
}

const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));

const STACK: Encodable[] = [6, 'res://a.gd', 15, 'twice', 'res://a.gd', 9, '_on_tick'];
const VARS: [string, Encodable[]][] = [
  ['stack_frame_vars', [4]],
  ['stack_frame_var', ['n', 0, 2, 1, '']],
  ['stack_frame_var', ['self', 1, 24, null, 'Node']],
  ['stack_frame_var', ['counter', 1, 2, 1, '']],
  ['stack_frame_var', ['GameState', 2, 24, null, 'Node']],
];

describe('debugger payload parsing', () => {
  it('splits breakpoint specs at the last colon', () => {
    expect(splitBreakpoint('res://a/b.gd:12')).toEqual({ file: 'res://a/b.gd', line: 12 });
    expect(splitBreakpoint('res://a.gd')).toBeUndefined();
    expect(splitBreakpoint('res://a.gd:x')).toBeUndefined();
  });
  it('parses stack_dump (file, LINE, function per frame) and stack variables', () => {
    expect(parseStackDump(STACK as unknown[])).toEqual([
      { file: 'res://a.gd', line: 15, function: 'twice' },
      { file: 'res://a.gd', line: 9, function: '_on_tick' },
    ]);
    expect(parseStackDump([0])).toEqual([]);
    expect(parseStackDump([6, 'res://a.gd', 15])).toEqual([]); // truncated
    expect(parseStackVariable(['n*10', 3, 2, 10, ''])).toEqual({ name: 'n*10', scope: 3, type: 2, value: 10, typeHint: '' });
  });
});

describe('DebugState', () => {
  let cleanup: (() => void)[] = [];
  afterEach(() => {
    for (const c of cleanup) c();
    cleanup = [];
  });

  it('seeds breakpoints from the run.start list and sends core:breakpoint as [source, line, set]', async () => {
    const g = await fakeGame();
    cleanup.push(g.close);
    const s = new DebugState(fakeRun(['res://b.gd:10', 'res://a.gd:3']), g.session);
    await s.ready;
    expect(s.list()).toEqual(['res://a.gd:3', 'res://b.gd:10']);
    s.setBreakpoint('res://a.gd', 12, true);
    s.setBreakpoint('res://b.gd', 10, false);
    await tick();
    expect(g.received.filter((c) => c[0] === 'core:breakpoint')).toEqual([
      ['core:breakpoint', 1, ['res://a.gd', 12, true]],
      ['core:breakpoint', 1, ['res://b.gd', 10, false]],
    ]);
    expect(s.list()).toEqual(['res://a.gd:3', 'res://a.gd:12']);
  });

  it('tracks debug_enter / debug_exit and classifies why the game stopped', async () => {
    const g = await fakeGame((cmd, game) => {
      // A step leaves the loop and stops again on the next line, in one write.
      if (cmd[0] === 'next') game.sendMany([['debug_exit', []], ['debug_enter', [true, 'Breakpoint', true, 1]]]);
      if (cmd[0] === 'continue') game.send('debug_exit', []);
    });
    cleanup.push(g.close);
    const s = new DebugState(fakeRun(), g.session);
    await s.ready;
    expect(s.stop).toBeUndefined();
    g.send('debug_enter', [true, 'Breakpoint', true, 1]);
    await tick();
    expect(s.stop).toMatchObject({ reason: 'breakpoint', canStep: true, hasStack: true, thread: 1 });
    const stepped = await s.resume('next', 2000);
    expect(stepped).toMatchObject({ reason: 'step' });
    expect(await s.resume('continue', 0)).toBe('timeout'); // = still running
    await tick();
    expect(s.stop).toBeUndefined();
    g.send('debug_enter', [false, "Invalid access to property or key 'missing'.", true, 1]);
    await tick();
    expect(s.stop).toMatchObject({ reason: 'error', error: "Invalid access to property or key 'missing'.", canStep: false });
    await expect(s.resume('step', 100)).rejects.toThrow(/only allows "continue"/);
    g.send('debug_exit', []);
    g.send('debug_enter', [true, '', false, 1]);
    await tick();
    expect(s.stop).toMatchObject({ reason: 'pause', hasStack: false });
    expect(await s.stack()).toEqual([]);
    expect(await s.variables(0)).toEqual([]);
    g.send('debug_exit', []);
    g.send('debug_enter', [true, 'Breakpoint Statement', true, 1]);
    await tick();
    expect(s.stop?.reason).toBe('breakpoint_statement');
  });

  it('pause sends core:break once and is a no-op when already stopped', async () => {
    const g = await fakeGame((cmd, game) => {
      if (cmd[0] === 'core:break') game.send('debug_enter', [true, '', false, 1]);
    });
    cleanup.push(g.close);
    const s = new DebugState(fakeRun(), g.session);
    await s.ready;
    expect(await s.pause(2000)).toMatchObject({ reason: 'pause' });
    await s.pause(2000);
    await tick();
    expect(g.received.filter((c) => c[0] === 'core:break')).toHaveLength(1);
  });

  it('probes a game that was already stopped before the state existed', async () => {
    const g = await fakeGame((cmd, game) => {
      if (cmd[0] === 'get_stack_dump') game.send('stack_dump', STACK);
    });
    cleanup.push(g.close);
    const s = new DebugState(fakeRun(['res://a.gd:15']), g.session);
    await s.ready;
    expect(s.stop).toMatchObject({ reason: 'breakpoint', hasStack: true, canStep: true });
    expect((await s.stack()).map((f) => f.line)).toEqual([15, 9]);
    // Cached for this stop: one stack_dump request only (the probe's).
    expect(g.received.filter((c) => c[0] === 'get_stack_dump')).toHaveLength(1);
  });

  it('infers an error stop from run.errors when probing', async () => {
    const g = await fakeGame((cmd, game) => {
      if (cmd[0] === 'get_stack_dump') game.send('stack_dump', STACK);
    });
    cleanup.push(g.close);
    const run = fakeRun();
    run.errors.push({ seq: 0, level: 'error', message: 'Boom.', detail: '', source: { file: 'res://a.gd', function: 'twice', line: 15 }, stack: [{ file: 'res://a.gd', function: 'twice', line: 15 }], time_ms: 0 });
    const s = new DebugState(run, g.session);
    await s.ready;
    expect(s.stop).toMatchObject({ reason: 'error', error: 'Boom.', canStep: false });
  });

  it('treats a game that ignores the probe as running', async () => {
    const g = await fakeGame();
    cleanup.push(g.close);
    const s = new DebugState(fakeRun(), g.session);
    await s.ready;
    expect(s.stop).toBeUndefined();
    await expect(s.stack()).rejects.toThrow(/running, not stopped/);
  });

  it('collects frame variables even when they arrive in the same chunk as the count', async () => {
    const g = await fakeGame((cmd, game) => {
      if (cmd[0] === 'get_stack_frame_vars') {
        expect(cmd[2]).toEqual([0]); // exactly one element, or Godot leaves its loop
        game.sendMany(VARS);
      }
    });
    cleanup.push(g.close);
    const s = new DebugState(fakeRun(), g.session);
    await s.ready;
    g.send('debug_enter', [true, 'Breakpoint', true, 1]);
    await tick();
    const vars = await s.variables(0);
    expect(vars.map((v) => `${v.scope}:${v.name}`)).toEqual(['0:n', '1:self', '1:counter', '2:GameState']);
  });

  it('evaluates only in frames with an instance, and returns the error Godot sends after a null', async () => {
    const g = await fakeGame((cmd, game) => {
      if (cmd[0] === 'get_stack_dump') game.send('stack_dump', STACK);
      if (cmd[0] === 'get_stack_frame_vars') {
        // Frame 1 is "static": no self among its members.
        game.sendMany(cmd[2][0] === 0 ? VARS : [['stack_frame_vars', [1]], ['stack_frame_var', ['x', 0, 2, 3, '']]]);
      }
      if (cmd[0] === 'evaluate') {
        expect(cmd[2]).toHaveLength(2);
        if (cmd[2][0] === 'n*10') game.send('evaluation_return', ['n*10', 3, 2, 10, '']);
        else {
          game.send('evaluation_return', [cmd[2][0] as string, 3, 0, null, '']);
          setTimeout(() => game.send('error', [0, 0, 1, 0, 'core/math/expression.cpp', 'execute', 1504, 'Condition "p_show_error" is true. Returning: Variant()', "Invalid named index 'nope' for base type Object", false, 0]), 20);
        }
      }
    });
    cleanup.push(g.close);
    const s = new DebugState(fakeRun(), g.session);
    await s.ready;
    g.send('debug_enter', [true, 'Breakpoint', true, 1]);
    await tick();
    expect(await s.evaluate('n*10', 0)).toMatchObject({ value: 10 });
    expect(await s.evaluate('nope', 0)).toMatchObject({ value: null, error: "Invalid named index 'nope' for base type Object" });
    await expect(s.evaluate('1', 1)).rejects.toThrow(/no object instance/);
    await expect(s.evaluate('1', 2)).rejects.toThrow(/Frame 2 doesn't exist/);
    // The refused evaluations never reached the game (they would have resumed it).
    expect(g.received.filter((c) => c[0] === 'evaluate').map((c) => c[2][0])).toEqual(['n*10', 'nope']);
  });

  it('reports a disconnect while waiting for a stop as "exited"', async () => {
    const g = await fakeGame((cmd) => {
      if (cmd[0] === 'step') setTimeout(() => g.close(), 20);
    });
    const s = new DebugState(fakeRun(), g.session);
    await s.ready;
    g.send('debug_enter', [true, 'Breakpoint', true, 1]);
    await tick();
    expect(await s.resume('step', 5000)).toBe('exited');
    expect(s.stop).toBeUndefined();
  });
});

describe('resolveBreakpoint', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'godot-mcp-bp-'));
  writeFileSync(path.join(dir, 'p.gd'), 'extends Node\n\n# comment\nfunc f() -> void:\n\tprint(1)\n');
  writeFileSync(path.join(dir, 'p.tscn'), '[gd_scene format=3]\n');
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('canonicalizes paths and accepts {file, line}', async () => {
    expect(await resolveBreakpoint(dir, 'p.gd:5')).toEqual({ file: 'res://p.gd', line: 5 });
    expect(await resolveBreakpoint(dir, { file: 'res://p.gd', line: 1 })).toEqual({ file: 'res://p.gd', line: 1 });
  });
  it('warns about lines that never stop', async () => {
    expect((await resolveBreakpoint(dir, 'res://p.gd:3')).warning).toMatch(/blank or a comment.*next code line is 5/);
    expect((await resolveBreakpoint(dir, 'res://p.gd:4')).warning).toMatch(/func declaration.*next code line is 5/);
  });
  it('rejects bad specs with actionable messages', async () => {
    await expect(resolveBreakpoint(dir, 'res://p.gd:6')).rejects.toThrow(/has 5 lines; line 6 is out of range/);
    await expect(resolveBreakpoint(dir, 'res://p.gd:0')).rejects.toThrow(/out of range/);
    await expect(resolveBreakpoint(dir, 'res://q.gd:1')).rejects.toThrow(/doesn't exist/);
    await expect(resolveBreakpoint(dir, 'res://p.tscn:1')).rejects.toThrow(/\.gd\) files only/);
    await expect(resolveBreakpoint(dir, '/etc/passwd.gd:1')).rejects.toThrow(/Absolute paths/);
    await expect(resolveBreakpoint(dir, 'p.gd')).rejects.toThrow(/not a breakpoint/);
  });
});
