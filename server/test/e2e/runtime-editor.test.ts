/**
 * End-to-end: the runtime channel into a game started from the editor (the
 * plugin's EditorDebuggerPlugin relays "mcp:*" debugger messages over the bridge).
 *
 *   GODOT_BIN=/path/to/godot npx vitest run test/e2e/runtime-editor.test.ts
 */

import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EditorBridge } from '../../src/bridge/editorBridge.js';
import { resolveGame } from '../../src/game/hub.js';
import { RunManager } from '../../src/godot/runs.js';
import { copySampleProject, GODOT_BIN, killAndWait } from './helpers.js';

const enabled = Boolean(GODOT_BIN);

describe.skipIf(!enabled)('runtime channel (games started from the editor)', () => {
  const proj = copySampleProject();
  let editor: ChildProcess;
  let bridge: EditorBridge;
  const runs = new RunManager();

  beforeAll(async () => {
    // The editor here is headless, and so must be the games it starts (there is no display):
    // the project setting editor/run/main_run_args adds --headless to every editor run.
    appendFileSync(path.join(proj.dir, 'project.godot'), '\n[editor]\n\nrun/main_run_args="--headless"\n');
    spawnSync(GODOT_BIN!, ['--headless', '--path', proj.dir, '--import'], { timeout: 180_000, stdio: 'ignore' });
    editor = spawn(GODOT_BIN!, ['--headless', '--editor', '--path', proj.dir], { stdio: ['ignore', require('node:fs').openSync('/tmp/claude-0/-home-claude-godot-mcp/ffb8d209-78dc-5e53-819f-e027dd3c14bc/scratchpad/editor.log', 'w'), 'pipe'] });
    const session = path.join(proj.dir, '.godot', 'godot_mcp', 'session.json');
    const deadline = Date.now() + 90_000;
    while (!existsSync(session) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 250));
    bridge = new EditorBridge(proj.dir, 30_000);
    expect(await bridge.ensureConnected()).toBe(true);
  }, 240_000);

  afterAll(async () => {
    await bridge?.request('run.stop').catch(() => undefined);
    if (editor?.pid) await killAndWait(editor.pid);
    await proj.cleanup();
  });

  it('relays the runtime of a game the editor plays', async () => {
    await bridge.request('run.play', { scene: 'main' });
    const game = await resolveGame({ runs, bridge });
    expect(game.runId).toBe('editor');
    expect(game.channel.hello?.methods).toContain('rt.ping');
    const r = (await game.channel.request('rt.ping')) as { node_count: number };
    expect(r.node_count).toBeGreaterThan(0);
    // The temporary override.cfg is gone once the game is up.
    const override = path.join(proj.dir, 'override.cfg');
    expect(existsSync(override) ? readFileSync(override, 'utf8') : '').not.toContain('godot_mcp');
  }, 60_000);
});
