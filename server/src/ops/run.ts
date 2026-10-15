/**
 * Running the game, reading its output, and launching the editor.
 *
 * Two ways to run:
 *   - "editor": ask the open editor to play (same as pressing F5/F6). The
 *     user sees the game; output appears in the editor's Output panel. The
 *     runtime tools reach it through the plugin's debugger relay.
 *   - "process": the server starts Godot itself and captures stdout/stderr,
 *     so the agent can read errors with godot_run_output. Can be headless
 *     (no window; good for smoke tests) or windowed.
 * "auto" picks "editor" when it's connected, otherwise "process" (always
 * "process" when debug or movie options are given). Process runs are debug
 * sessions with the server as the debugger (src/game/debugSession.ts).
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { z } from 'zod';
import { OpError } from '../errors.js';
import { findGodot, GODOT_NOT_FOUND_HINT } from '../godot/binary.js';
import { log } from '../log.js';
import { defineOp } from './types.js';

/** How long run.start waits for the runtime's hello before returning. */
const RUNTIME_WAIT_MS = 10_000;

/** Can we open a window? On Linux without a display server, no. */
function canShowWindow(): boolean {
  if (process.platform !== 'linux') return true;
  return Boolean(process.env.DISPLAY || process.env.WAYLAND_DISPLAY);
}

export const runStart = defineOp({
  name: 'run.start',
  group: 'run',
  title: 'Run game',
  description:
    'Godot run: start the game (main scene, the current scene, or a given scene). Returns a run_id; read errors and prints with godot_run_output, stop with godot_run_stop.',
  input: z.object({
    scene: z.string().optional().describe('"main" (default), "current" (editor only), or a scene path like "res://levels/test.tscn".'),
    mode: z.enum(['auto', 'editor', 'process']).default('auto'),
    headless: z.boolean().optional().describe('Process mode only: no window. Defaults to true when no display is available.'),
    quit_after_frames: z.number().int().min(1).optional().describe('Process mode only: quit automatically after N frames (handy for smoke tests).'),
    breakpoints: z.array(z.string()).optional().describe('Process mode: breakpoints set before the first frame, e.g. ["res://player.gd:42"]. Inspect with godot_debug_state.'),
    break_on_errors: z.boolean().optional().describe('Process mode: stop at script errors like the editor does (default false: errors are recorded, the game keeps running).'),
    write_movie: z.string().optional().describe('Process mode: record frames to this file with Godot\'s Movie Maker (.avi, or .png for an image sequence), e.g. "user://capture.avi". Needs a window.'),
  }),
  readOnly: false,
  destructive: false,
  core: true,
  async run({ scene, mode, headless, quit_after_frames, breakpoints, break_on_errors, write_movie }, ctx) {
    // Debug and movie options need a process run (the server is that game's debugger).
    const needsProcess = Boolean(breakpoints?.length || break_on_errors || write_movie);
    if (mode === 'editor' && needsProcess) throw new OpError('BAD_PARAMS', 'breakpoints, break_on_errors and write_movie work with mode "process" (the server launches and debugs the game itself).');
    const useEditor = mode === 'editor' || (mode === 'auto' && !needsProcess && (await ctx.bridge.ensureConnected()));
    if (useEditor) {
      const result = await ctx.bridge.request('run.play', { scene: scene ?? 'main' });
      return {
        data: {
          ...(result as object),
          mode: 'editor',
          note: 'Started in the editor. godot_game_* tools work on it once its runtime loads; its output shows in the editor Output panel (godot_editor_logs).',
        },
      };
    }
    if (scene === 'current') throw new OpError('BAD_PARAMS', '"current" needs the editor. Pass a scene path, or "main".');

    const godot = await findGodot(ctx.config.godotPath);
    if (!godot) throw new OpError('GODOT_NOT_FOUND', GODOT_NOT_FOUND_HINT);
    const extraArgs = quit_after_frames ? ['--quit-after', String(quit_after_frames)] : [];
    if (write_movie) extraArgs.push('--write-movie', write_movie);
    if (write_movie && (headless ?? !canShowWindow())) throw new OpError('BAD_PARAMS', 'write_movie needs a window (headless: false and a display); headless runs render nothing.');
    const run = await ctx.runs.start(godot.path, ctx.config.projectPath, {
      scene: scene && scene !== 'main' ? scene : undefined,
      headless: headless ?? !canShowWindow(),
      extraArgs,
      breakpoints,
      breakOnErrors: break_on_errors,
    });
    // Wait until the runtime says hello (the game is up and runtime tools work), the game
    // exits, or a few seconds pass. Startup errors are captured either way.
    const exited = new Promise<void>((r) => {
      const poll = setInterval(() => {
        if (!run.running) {
          clearInterval(poll);
          r();
        }
      }, 100);
      setTimeout(() => clearInterval(poll), RUNTIME_WAIT_MS + 100);
    });
    const ready = await Promise.race([
      run.channel!.ready.then(() => true),
      exited.then(() => false),
      new Promise<boolean>((r) => setTimeout(() => r(false), RUNTIME_WAIT_MS)),
    ]);
    return {
      data: {
        run_id: run.id,
        mode: 'process',
        headless: run.headless,
        running: run.running,
        exit_code: run.exitCode,
        // true: godot_game_* tools can inspect and control this run.
        runtime: ready,
        ...run.counts(),
      },
    };
  },
});

export const runStop = defineOp({
  name: 'run.stop',
  group: 'run',
  title: 'Stop game',
  description: 'Godot run: stop a running game (the given run_id, the latest process run, or the game playing in the editor).',
  input: z.object({ run_id: z.string().optional() }),
  readOnly: false,
  destructive: false,
  idempotent: true,
  core: true,
  async run({ run_id }, ctx) {
    const run = ctx.runs.get(run_id);
    if (run && run.running) {
      run.stop();
      return { data: { run_id: run.id, stopped: true } };
    }
    if (!run_id && (await ctx.bridge.ensureConnected())) {
      const result = await ctx.bridge.request('run.stop');
      return { data: { ...(result as object), mode: 'editor' } };
    }
    if (run_id && !run) throw new OpError('NOT_FOUND', `No run with id "${run_id}". Known runs: ${ctx.runs.list().map((r) => r.id).join(', ') || 'none'}.`);
    return { data: { stopped: false, note: 'Nothing was running.' } };
  },
});

export const runOutput = defineOp({
  name: 'run.output',
  group: 'run',
  title: 'Game output',
  description:
    'Godot run: read output and errors from a game started with godot_run_start (process mode). Use level "error" to see only errors, and "since" (the "next" value from the last call) to page.',
  input: z.object({
    run_id: z.string().optional().describe('Defaults to the latest run.'),
    since: z.number().int().min(0).default(0),
    limit: z.number().int().min(1).max(2000).default(200),
    level: z.enum(['all', 'warning', 'error']).default('all'),
  }),
  readOnly: true,
  idempotent: true,
  core: true,
  async run({ run_id, since, limit, level }, ctx) {
    const run = ctx.runs.get(run_id);
    if (!run) {
      throw new OpError('NOT_FOUND', run_id ? `No run with id "${run_id}".` : 'No game has been started by this server yet. Use godot_run_start (mode "process" to capture output).');
    }
    const page = run.read(since, limit, level);
    return {
      data: {
        run_id: run.id,
        running: run.running,
        exit_code: run.exitCode,
        ...run.counts(),
        next: page.next,
        more: page.more,
        dropped: page.dropped,
        lines: page.lines.map((l) => `${l.seq} ${l.level === 'info' ? '' : l.level.toUpperCase() + ' '}${l.text}`),
      },
    };
  },
});

export const editorLogs = defineOp({
  name: 'editor.logs',
  group: 'editor',
  title: 'Editor log',
  description: 'Godot editor: read messages, warnings and errors printed by the editor process (plugin and tool scripts, import errors). Page with "since".',
  input: z.object({
    since: z.number().int().min(0).default(0),
    limit: z.number().int().min(1).max(2000).default(200),
    level: z.enum(['all', 'warning', 'error']).default('all'),
  }),
  readOnly: true,
  idempotent: true,
  async run(args, ctx) {
    const result = await ctx.bridge.request('logs.read', args);
    return { data: result };
  },
});

export const editorLaunch = defineOp({
  name: 'editor.launch',
  group: 'editor',
  title: 'Launch editor',
  description: 'Godot editor: open this project in the Godot editor and wait until the MCP plugin connects (the plugin must be enabled in the project).',
  input: z.object({
    wait_seconds: z.number().int().min(0).max(300).default(60),
    headless: z.boolean().default(false).describe('Run the editor without a window (automation, CI).'),
  }),
  readOnly: false,
  destructive: false,
  async run({ wait_seconds, headless }, ctx) {
    if (await ctx.bridge.ensureConnected()) return { data: { already_running: true, editor: ctx.bridge.info } };
    const godot = await findGodot(ctx.config.godotPath);
    if (!godot) throw new OpError('GODOT_NOT_FOUND', GODOT_NOT_FOUND_HINT);
    if (!existsSync(`${ctx.config.projectPath}/addons/godot_mcp/plugin.cfg`)) {
      throw new OpError('ADDON_MISSING', 'The godot_mcp addon is not installed in this project, so the editor would start without the bridge. Copy addons/godot_mcp into the project first.');
    }
    const args = ['--editor', '--path', ctx.config.projectPath];
    if (headless || !canShowWindow()) args.unshift('--headless');
    // Detached: the editor should outlive this server process.
    const child = spawn(godot.path, args, { detached: true, stdio: 'ignore', windowsHide: false });
    child.unref();
    log.info(`Launched editor pid ${child.pid}`);

    const deadline = Date.now() + wait_seconds * 1000;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 1000));
      if (await ctx.bridge.ensureConnected()) return { data: { launched: true, pid: child.pid, editor: ctx.bridge.info } };
    }
    return {
      data: {
        launched: true,
        pid: child.pid,
        connected: false,
        note: `The editor started but the plugin hasn't connected within ${wait_seconds}s. First-time imports can take a while; call godot_status again shortly. Check the plugin is enabled in Project Settings > Plugins.`,
      },
    };
  },
});
