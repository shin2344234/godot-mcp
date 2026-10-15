/**
 * End-to-end: the runtime channel into a game the server launches.
 *
 *   GODOT_BIN=/path/to/godot npx vitest run test/e2e/runtime.test.ts
 *
 * Covers the plumbing every runtime tool builds on: the server as the game's
 * remote debugger (--remote-debug), the temporary override.cfg that loads the
 * runtime autoload, JSON requests to it, structured errors with backtraces,
 * and the override.cfg being restored afterwards.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { OVERRIDE_MARKER } from '../../src/game/override.js';
import { RunManager, type GameRun } from '../../src/godot/runs.js';
import { copySampleProject, GODOT_BIN } from './helpers.js';

const enabled = Boolean(GODOT_BIN);

describe.skipIf(!enabled)('runtime channel (process runs)', () => {
  const proj = copySampleProject();
  const runs = new RunManager();
  let run: GameRun;

  beforeAll(async () => {
    spawnSync(GODOT_BIN!, ['--headless', '--path', proj.dir, '--import'], { timeout: 180_000, stdio: 'ignore' });
    // The user's own override.cfg must survive the injection untouched.
    writeFileSync(path.join(proj.dir, 'override.cfg'), '[application]\nconfig/description="user override"\n');
    // A script that errors once, to check structured errors with a backtrace.
    writeFileSync(path.join(proj.dir, 'boom.gd'), 'extends Node\n\nfunc _ready() -> void:\n\tcall_deferred("explode")\n\nfunc explode() -> void:\n\tvar d: Dictionary = {}\n\tprint(d.missing.field)\n');
    run = await runs.start(GODOT_BIN!, proj.dir, { headless: true });
  }, 240_000);

  afterAll(async () => {
    runs.stopAll();
    await new Promise((r) => setTimeout(r, 500));
    await proj.cleanup();
  });

  it('loads the runtime, which says hello over the debugger connection', async () => {
    const hello = await run.channel!.ready;
    expect(hello.protocol).toBe(1);
    expect(hello.pid).toBeGreaterThan(0);
    expect(hello.methods).toContain('rt.ping');
  });

  it('answers requests', async () => {
    const r = (await run.channel!.request('rt.ping')) as { node_count: number; paused: boolean };
    expect(r.node_count).toBeGreaterThan(0);
    expect(r.paused).toBe(false);
  });

  it('reports unknown methods as errors that list the available ones', async () => {
    await expect(run.channel!.request('rt.nope')).rejects.toThrow(/rt\.ping/);
  });

  it('restores the user override.cfg once the game is up', async () => {
    const text = readFileSync(path.join(proj.dir, 'override.cfg'), 'utf8');
    expect(text).toContain('user override');
    expect(text).not.toContain(OVERRIDE_MARKER);
    expect(existsSync(path.join(proj.dir, '.godot', 'godot_mcp', 'override.cfg.user-backup'))).toBe(false);
  });

  it('records script errors with their backtrace, without freezing the game', async () => {
    writeFileSync(
      path.join(proj.dir, 'boom_scene.tscn'),
      '[gd_scene format=3]\n\n[ext_resource type="Script" path="res://boom.gd" id="1"]\n\n[node name="Boom" type="Node"]\nscript = ExtResource("1")\n',
    );
    const second = await runs.start(GODOT_BIN!, proj.dir, { headless: true, scene: 'res://boom_scene.tscn' });
    await second.channel!.ready;
    const deadline = Date.now() + 10_000;
    while (second.errors.length === 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 200));
    const err = second.errors.find((e) => e.stack.some((f) => f.file.endsWith('boom.gd')));
    expect(err, JSON.stringify(second.errors)).toBeDefined();
    expect(err!.stack[0]).toMatchObject({ file: 'res://boom.gd', function: 'explode', line: 8 });
    // Error breaks are ignored for unattended runs, so the game still answers.
    expect(((await second.channel!.request('rt.ping')) as { node_count: number }).node_count).toBeGreaterThan(0);
    second.stop();
  });
});
