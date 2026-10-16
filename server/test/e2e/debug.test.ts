/**
 * End-to-end: breakpoint debugging of process runs (godot_debug_breakpoints /
 * godot_debug_control / godot_debug_state) and run.output's errors view, against a
 * real Godot (skipped when GODOT_BIN isn't set):
 *
 *   GODOT_BIN=/path/to/godot npx vitest run test/e2e/debug.test.ts
 *
 * Works on a temp copy of examples/sample_project with two small scripts added:
 *   - dbg.gd: a Timer calls _on_tick() every 0.2 s, which calls twice(); known line
 *     numbers, locals and members to inspect;
 *   - err.gd: raises a script error every 30 frames (from _process -> explode()).
 */

import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { copySampleProject, errorText, GODOT_BIN, json, startServer } from './helpers.js';

type Client = Awaited<ReturnType<typeof startServer>>;

const enabled = Boolean(GODOT_BIN);

// Line numbers matter: the tests below refer to them.
const DBG_GD = [
  'extends Node', //  1
  '', //  2
  'var counter := 0', //  3
  'var label_text := "hello"', //  4
  '', //  5
  '', //  6
  'func _on_tick() -> void:', //  7
  '\tcounter += 1', //  8
  '\tvar doubled := twice(counter)', //  9
  '\tif doubled < 0:', // 10
  '\t\tprint("never")', // 11
  '', // 12
  '', // 13
  'func twice(n: int) -> int:', // 14
  '\tvar result := n * 2', // 15
  '\treturn result', // 16
  '',
].join('\n');

const DBG_TSCN = `[gd_scene format=3]

[ext_resource type="Script" path="res://dbg.gd" id="1"]

[node name="Dbg" type="Node"]
script = ExtResource("1")

[node name="Timer" type="Timer" parent="."]
wait_time = 0.2
autostart = true

[connection signal="timeout" from="Timer" to="." method="_on_tick"]
`;

const ERR_GD = [
  'extends Node', //  1
  '', //  2
  'var ticks := 0', //  3
  '', //  4
  '', //  5
  'func _process(_delta: float) -> void:', //  6
  '\tticks += 1', //  7
  '\tif ticks % 30 == 0:', //  8
  '\t\texplode()', //  9
  '', // 10
  '', // 11
  'func explode() -> void:', // 12
  '\tvar d: Dictionary = {}', // 13
  '\tprint(d.missing.field)', // 14
  '',
].join('\n');

// Input handler for "input that hits a breakpoint": line 7 runs on every key press.
const INP_GD = [
  'extends Node', // 1
  '', // 2
  'var presses := 0', // 3
  '', // 4
  'func _unhandled_input(event: InputEvent) -> void:', // 5
  '\tif event is InputEventKey and event.pressed:', // 6
  '\t\tpresses += 1', // 7
  '',
].join('\n');

const INP_TSCN = `[gd_scene format=3]

[ext_resource type="Script" path="res://inp.gd" id="1"]

[node name="Inp" type="Node"]
script = ExtResource("1")
`;

const ERR_TSCN = `[gd_scene format=3]

[ext_resource type="Script" path="res://err.gd" id="1"]

[node name="Err" type="Node"]
script = ExtResource("1")
`;

describe.skipIf(!enabled)('debug: process runs', () => {
  const proj = copySampleProject();
  let client: Client;
  const runIds: string[] = [];
  const call = (name: string, args: Record<string, unknown> = {}) => client.callTool({ name, arguments: args });

  /** Start a headless process run and remember it for cleanup. */
  async function start(args: Record<string, unknown>) {
    const r = json(await call('godot_run_start', { mode: 'process', headless: true, ...args }));
    runIds.push(r.run_id);
    return r.run_id as string;
  }

  /** Poll godot_debug_state until the game is stopped. */
  async function waitStopped(run_id: string, timeoutMs = 15_000) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const s = json(await call('godot_debug_state', { run_id }));
      if (s.stopped || Date.now() > deadline) return s;
      await new Promise((r) => setTimeout(r, 200));
    }
  }

  beforeAll(async () => {
    writeFileSync(path.join(proj.dir, 'dbg.gd'), DBG_GD);
    writeFileSync(path.join(proj.dir, 'dbg.tscn'), DBG_TSCN);
    writeFileSync(path.join(proj.dir, 'err.gd'), ERR_GD);
    writeFileSync(path.join(proj.dir, 'err.tscn'), ERR_TSCN);
    writeFileSync(path.join(proj.dir, 'inp.gd'), INP_GD);
    writeFileSync(path.join(proj.dir, 'inp.tscn'), INP_TSCN);
    spawnSync(GODOT_BIN!, ['--headless', '--path', proj.dir, '--import'], { timeout: 180_000, stdio: 'ignore' });
    client = await startServer({ project: proj.dir, era: 'modern' });
  }, 240_000);

  afterAll(async () => {
    for (const run_id of runIds) await call('godot_run_stop', { run_id }).catch(() => undefined);
    await new Promise((r) => setTimeout(r, 500));
    await client?.close();
    await proj.cleanup();
  });

  describe('breakpoints and stepping', () => {
    let run_id: string;

    it('stops at a breakpoint passed to godot_run_start, with stack and variables', async () => {
      run_id = await start({ scene: 'res://dbg.tscn', breakpoints: ['res://dbg.gd:8'] });
      const s = await waitStopped(run_id);
      expect(s).toMatchObject({ stopped: true, reason: 'breakpoint', can_step: true, frame: 0 });
      expect(s.stack).toEqual([{ file: 'res://dbg.gd', line: 8, function: '_on_tick', code: 'counter += 1' }]);
      // `doubled` isn't assigned yet at line 8.
      expect(s.locals).toEqual({ doubled: null });
      expect(s.members).toMatchObject({ counter: 0, label_text: 'hello' });
      expect(s.members.self).toMatchObject({ class: 'Node' });
      expect(s.members.self.object_id).toMatch(/^\d+$/);
      expect(s.globals).toBeUndefined();
      // Object variables come as id + class; the note says how to open them, and expand does.
      expect(s.note).toMatch(/expand: \["<name>"\]/);
      const ex = json(await call('godot_debug_state', { run_id, variables: false, expand: ['self', 'counter', 'nope'] }));
      expect(ex.expanded.self).toEqual({ class: 'Node', counter: 0, label_text: 'hello', process_mode: 0 });
      expect(ex.expanded.counter.error).toMatch(/not an object/);
      expect(ex.expanded.nope.error).toBeTruthy();
      const g = json(await call('godot_debug_state', { run_id, globals: true }));
      expect(g.globals.GameState).toMatchObject({ class: 'Node' });
      // The breakpoint list is seeded from godot_run_start.
      expect(json(await call('godot_debug_breakpoints', {})).breakpoints).toEqual(['res://dbg.gd:8']);
    }, 60_000);

    it('steps over, into and out, returning the new location and locals', async () => {
      let r = json(await call('godot_debug_control', { action: 'step_over' }));
      expect(r).toMatchObject({ stopped: true, reason: 'step', at: { file: 'res://dbg.gd', line: 9, function: '_on_tick', code: 'var doubled := twice(counter)' }, depth: 1 });
      r = json(await call('godot_debug_control', { action: 'step_into' }));
      expect(r).toMatchObject({ stopped: true, reason: 'step', at: { line: 15, function: 'twice' }, depth: 2, locals: { n: 1, result: null } });
      const s = json(await call('godot_debug_state', {}));
      expect(s.stack.map((f: { line: number; function: string }) => `${f.function}:${f.line}`)).toEqual(['twice:15', '_on_tick:9']);
      // Variables of the caller's frame.
      const caller = json(await call('godot_debug_state', { frame: 1 }));
      expect(caller.locals).toEqual({ doubled: null });
      expect(caller.members.counter).toBe(1);
      expect(caller.stack[1].code).toBe('var doubled := twice(counter)');
      r = json(await call('godot_debug_control', { action: 'step_out' }));
      expect(r).toMatchObject({ stopped: true, reason: 'step', at: { line: 10, function: '_on_tick' }, depth: 1, locals: { doubled: 2 } });
      // It landed in the caller, so there is nothing to explain.
      expect(r.note).toBeUndefined();
    }, 60_000);

    it('evaluates expressions in a frame, and reports bad ones without resuming', async () => {
      // Move the breakpoint into twice() and continue to it (the next tick).
      const moved = json(await call('godot_debug_breakpoints', { action: 'remove', breakpoints: ['res://dbg.gd:8'] }));
      expect(moved).toMatchObject({ removed: ['res://dbg.gd:8'], breakpoints: [], stopped: true });
      json(await call('godot_debug_breakpoints', { action: 'add', breakpoints: ['res://dbg.gd:16'] }));
      const at = json(await call('godot_debug_control', { action: 'continue', wait: 5 }));
      expect(at).toMatchObject({ stopped: true, at: { line: 16, function: 'twice' } });
      const n = at.locals.n as number;
      expect(json(await call('godot_debug_control', { action: 'evaluate', expression: 'n * 10' }))).toMatchObject({ value: n * 10, frame: 0 });
      expect(json(await call('godot_debug_control', { action: 'evaluate', expression: 'label_text.length() + counter', frame: 1 })).value).toBe(5 + n);
      expect(json(await call('godot_debug_control', { action: 'evaluate', expression: 'get_child_count()' })).value).toBe(1);
      expect(json(await call('godot_debug_control', { action: 'evaluate', expression: 'Vector2(n, 2)' })).value).toBe(`Vector2(${n}, 2)`);
      expect(errorText(await call('godot_debug_control', { action: 'evaluate', expression: 'bogus(' }))).toMatch(/Evaluating "bogus\(" failed: .*parse error/);
      expect(errorText(await call('godot_debug_control', { action: 'evaluate', expression: 'no_such_name' }))).toMatch(/no_such_name/);
      expect(errorText(await call('godot_debug_control', { action: 'evaluate', expression: '1', frame: 5 }))).toMatch(/Frame 5 doesn't exist; the stack has 2/);
      // Godot's error text and our hint are separate sentences.
      expect(errorText(await call('godot_debug_control', { action: 'evaluate', expression: 'no_such_name' }))).toMatch(/[.!?:] Expressions use Godot's Expression class/);
      // Failed evaluations are not game errors: not in errors: true, not in the counts.
      await new Promise((r) => setTimeout(r, 500)); // let the game's stderr copies arrive
      const errs = json(await call('godot_run_output', { run_id, errors: true }));
      expect(errs.error_count, JSON.stringify(errs)).toBe(0);
      const lines = json(await call('godot_run_output', { run_id }));
      expect(lines.errors, JSON.stringify(lines.lines)).toBe(0);
      // Still stopped at the same place.
      expect(json(await call('godot_debug_state', { variables: false })).stack[0]).toMatchObject({ line: 16 });
      json(await call('godot_debug_breakpoints', { action: 'remove', breakpoints: ['res://dbg.gd:16'] }));
    }, 60_000);

    it('adds breakpoints while stopped, continues to them and clears them', async () => {
      const b = json(await call('godot_debug_breakpoints', { action: 'add', breakpoints: ['res://dbg.gd:15', { file: 'dbg.gd', line: 9 }] }));
      expect(b.added).toEqual(['res://dbg.gd:15', 'res://dbg.gd:9']);
      expect(b.warnings).toBeUndefined();
      expect(json(await call('godot_debug_breakpoints', { action: 'remove', breakpoints: ['res://dbg.gd:8'] })).warnings).toEqual(['res://dbg.gd:8 was not set.']);
      expect(json(await call('godot_debug_breakpoints', {})).breakpoints).toEqual(['res://dbg.gd:9', 'res://dbg.gd:15']);
      // Continue: the next tick stops at line 9, then at 15.
      let r = json(await call('godot_debug_control', { action: 'continue', wait: 5 }));
      expect(r).toMatchObject({ stopped: true, reason: 'breakpoint', at: { line: 9, function: '_on_tick' } });
      r = json(await call('godot_debug_control', { action: 'continue', wait: 5 }));
      expect(r).toMatchObject({ stopped: true, reason: 'breakpoint', at: { line: 15, function: 'twice' } });
      const cleared = json(await call('godot_debug_breakpoints', { action: 'clear' }));
      expect(cleared.removed).toEqual(['res://dbg.gd:9', 'res://dbg.gd:15']);
      expect(cleared.breakpoints).toEqual([]);
      // Plain continue reports running right away.
      expect(json(await call('godot_debug_control', { action: 'continue' }))).toEqual({ run_id, stopped: false, running: true });
      // No breakpoints left: several ticks pass without stopping.
      await new Promise((r) => setTimeout(r, 700));
      expect(json(await call('godot_debug_state', {}))).toMatchObject({ stopped: false, running: true, breakpoints: [] });
      expect(errorText(await call('godot_debug_control', { action: 'step_over' }))).toMatch(/running, not stopped/);
      // debug_state {wait} waits for the next stop instead of answering "running" at once.
      json(await call('godot_debug_breakpoints', { action: 'add', breakpoints: ['res://dbg.gd:8'] }));
      expect(json(await call('godot_debug_state', { wait: 5, variables: false }))).toMatchObject({ stopped: true, reason: 'breakpoint', stack: [{ line: 8 }] });
      json(await call('godot_debug_breakpoints', { action: 'clear' }));
      json(await call('godot_debug_control', { action: 'continue' }));
    }, 60_000);

    it('validates breakpoints against the project', async () => {
      expect(errorText(await call('godot_debug_breakpoints', { action: 'add', breakpoints: ['res://nope.gd:3'] }))).toMatch(/nope\.gd doesn't exist/);
      expect(errorText(await call('godot_debug_breakpoints', { action: 'add', breakpoints: ['res://dbg.gd:999'] }))).toMatch(/has 16 lines; line 999 is out of range/);
      expect(errorText(await call('godot_debug_breakpoints', { action: 'add', breakpoints: ['dbg.gd'] }))).toMatch(/not a breakpoint/);
      expect(errorText(await call('godot_debug_breakpoints', { action: 'add', breakpoints: ['res://dbg.tscn:3'] }))).toMatch(/\.gd\) files only/);
      expect(errorText(await call('godot_debug_breakpoints', { action: 'add', breakpoints: ['../outside.gd:1'] }))).toMatch(/escapes the project/);
      expect(errorText(await call('godot_debug_breakpoints', { action: 'add' }))).toMatch(/needs breakpoints/);
      // Lines that can never stop are added with a warning.
      const w = json(await call('godot_debug_breakpoints', { action: 'add', breakpoints: ['res://dbg.gd:12', 'res://dbg.gd:7', 'res://dbg.gd:1'] }));
      expect(w.warnings[0]).toMatch(/dbg\.gd:12 is blank or a comment; .* never trigger\. The next code line is 15\./);
      expect(w.warnings[1]).toMatch(/dbg\.gd:7 is a func declaration; .* The next code line is 8\./);
      expect(w.warnings[2]).toMatch(/dbg\.gd:1 is a declaration; .* never trigger/);
      json(await call('godot_debug_breakpoints', { action: 'clear' }));
    }, 60_000);

    it('pauses between frames, then step_into stops at the next GDScript line', async () => {
      const p = json(await call('godot_debug_control', { action: 'pause' }));
      expect(p).toMatchObject({ stopped: true, reason: 'pause' });
      expect(p.at).toBeUndefined();
      expect(p.note).toMatch(/step_into/);
      expect(json(await call('godot_debug_control', { action: 'pause' })).note).toMatch(/Already stopped/);
      const s = json(await call('godot_debug_state', {}));
      expect(s).toMatchObject({ stopped: true, reason: 'pause', stack: [] });
      expect(errorText(await call('godot_debug_control', { action: 'evaluate', expression: '1' }))).toMatch(/no script call stack/);
      // The only GDScript that runs in this scene is the Timer's tick.
      const r = json(await call('godot_debug_control', { action: 'step_over' }));
      expect(r).toMatchObject({ stopped: true, reason: 'step', at: { file: 'res://dbg.gd', line: 8, function: '_on_tick' } });
      expect(json(await call('godot_debug_control', { action: 'continue' })).running).toBe(true);
    }, 60_000);

    it('reports a game that exited', async () => {
      json(await call('godot_debug_breakpoints', { action: 'add', breakpoints: ['res://dbg.gd:8'] }));
      expect((await waitStopped(run_id)).stopped).toBe(true);
      json(await call('godot_run_stop', { run_id }));
      await new Promise((r) => setTimeout(r, 500));
      expect(errorText(await call('godot_debug_state', { run_id }))).toMatch(/has exited/);
      expect(errorText(await call('godot_debug_control', { action: 'continue' }))).toMatch(/No game started with godot_run_start/);
      expect(errorText(await call('godot_debug_state', { run_id: 'editor' }))).toMatch(/mode: "process"/);
    }, 60_000);
  });

  describe('runtime calls that hit a breakpoint', () => {
    it('game_input reports the stop at once instead of timing out', async () => {
      const run_id = await start({ scene: 'res://inp.tscn', breakpoints: ['res://inp.gd:7'] });
      const t0 = Date.now();
      const r = json(await call('godot_game_input', { run_id, steps: [{ type: 'key', key: 'Space' }] }));
      // Used to be a TIMEOUT after ~15 s; the debug_enter arrives within milliseconds.
      expect(Date.now() - t0).toBeLessThan(8_000);
      expect(r, JSON.stringify(r)).toMatchObject({
        run_id,
        completed: false,
        stopped: { reason: 'breakpoint', at: { file: 'res://inp.gd', line: 7, function: '_unhandled_input' } },
      });
      expect(r.note).toMatch(/godot_debug_state/);
      // While stopped, synchronous runtime calls still answer.
      expect(json(await call('godot_debug_state', { run_id }))).toMatchObject({ stopped: true, reason: 'breakpoint' });
      // Clear the breakpoint and continue: the interrupted handler finishes.
      json(await call('godot_debug_breakpoints', { run_id, action: 'clear' }));
      expect(json(await call('godot_debug_control', { run_id, action: 'continue' })).running).toBe(true);
      const got = json(await call('godot_game_get', { run_id, path: '/root/Inp', properties: ['presses'] }));
      expect(got.properties.presses).toBe(1);
      json(await call('godot_run_stop', { run_id }));
    }, 60_000);
  });

  describe('script errors', () => {
    it('break_on_errors stops at the error with its text; only continue is allowed', async () => {
      const run_id = await start({ scene: 'res://err.tscn', break_on_errors: true });
      const s = await waitStopped(run_id);
      expect(s).toMatchObject({ stopped: true, reason: 'error', can_step: false });
      expect(s.error).toMatch(/Invalid access to property or key 'missing'/);
      expect(s.stack.map((f: { line: number; function: string }) => `${f.function}:${f.line}`)).toEqual(['explode:14', '_process:9']);
      expect(s.note).toMatch(/only allows continue/);
      expect(errorText(await call('godot_debug_control', { action: 'step_over' }))).toMatch(/only allows "continue"/);
      // Continue: the error comes back 30 frames later and stops the game again.
      const again = json(await call('godot_debug_control', { action: 'continue', wait: 10 }));
      expect(again).toMatchObject({ stopped: true, reason: 'error', at: { line: 14, function: 'explode' } });
      json(await call('godot_run_stop', { run_id }));
    }, 60_000);

    it('without break_on_errors the game keeps running and run.output lists the errors with backtraces', async () => {
      const run_id = await start({ scene: 'res://err.tscn' });
      const deadline = Date.now() + 15_000;
      let out = json(await call('godot_run_output', { run_id, errors: true }));
      while (out.error_count < 3 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 300));
        out = json(await call('godot_run_output', { run_id, errors: true }));
      }
      const e = out.errors.find((x: { at?: string }) => x.at === 'res://err.gd:14 in explode()');
      expect(e, JSON.stringify(out)).toMatchObject({ message: expect.stringMatching(/Invalid access to property or key 'missing'/), callers: ['res://err.gd:9 in _process()'] });
      // Identical repeats are merged.
      expect(e.count).toBeGreaterThanOrEqual(2);
      expect(out.next).toBeGreaterThan(0);
      // Paging: nothing new past `next` right away... or only newer repeats.
      const later = json(await call('godot_run_output', { run_id, errors: true, since: out.next }));
      for (const x of later.errors) expect(x.seq).toBeGreaterThanOrEqual(out.next);
      // The game never stopped.
      expect(json(await call('godot_debug_state', { run_id }))).toMatchObject({ stopped: false, running: true });
      json(await call('godot_run_stop', { run_id }));
    }, 60_000);
  });
});
