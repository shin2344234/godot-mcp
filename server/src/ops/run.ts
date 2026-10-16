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
import { resolveGame } from '../game/hub.js';
import { findGodot, GODOT_NOT_FOUND_HINT } from '../godot/binary.js';
import type { GameRun } from '../godot/runs.js';
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
          // The game is its own process: its print()/errors reach the editor's Output panel
          // over the debugger connection, not the editor process's log that
          // godot_editor_logs reads. The old note pointed at editor_logs, where the game's
          // prints never showed up.
          note:
            'Started in the editor. godot_game_* tools work on it once its runtime loads. Read its print() and error output with godot_run_output (run_id "editor"); godot_editor_logs is the editor\'s own log.',
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
      // Give the process a moment to exit so the result can carry its exit code.
      const deadline = Date.now() + 2_000;
      while (run.running && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
      return { data: { run_id: run.id, stopped: true, exit_code: run.exitCode } };
    }
    if (!run_id && (await ctx.bridge.ensureConnected())) {
      const status = (await ctx.bridge.request('editor.status').catch(() => ({}))) as { is_playing?: boolean };
      if (status.is_playing || !run) {
        const result = await ctx.bridge.request('run.stop');
        return { data: { ...(result as object), mode: 'editor', ...(status.is_playing ? { stopped: true } : { stopped: false, note: 'Nothing was running.' }) } };
      }
    }
    if (run_id && !run) throw new OpError('NOT_FOUND', `No run with id "${run_id}". Known runs: ${ctx.runs.list().map((r) => r.id).join(', ') || 'none'}.`);
    // The run ended on its own (quit(), a crash, quit_after_frames): say so with its exit code,
    // instead of a bare "stopped" that reads as if this call had stopped it.
    if (run) return { data: { run_id: run.id, stopped: false, exit_code: run.exitCode, note: `Run ${run.id} had already exited (code ${run.exitCode}).` } };
    return { data: { stopped: false, note: 'Nothing was running.' } };
  },
});

/**
 * run.output's errors view: the structured errors and warnings the game reported through
 * the debugger (`run.errors`, each with its script backtrace), paged by error seq.
 * Identical entries in a page (same text and stack, e.g. an error raised every frame) are
 * merged into one with a `count`, so one noisy error can't fill the page.
 */
function errorPage(run: GameRun, since: number, limit: number, level: 'all' | 'warning' | 'error') {
  const where = (f: { file: string; function: string; line: number }) => `${f.file}:${f.line} in ${f.function}()`;
  // Start-up noise from the machine's drivers (runs.ts isEnvSource) is left out here and
  // in the counts; the lines view still shows it, tagged ENV.
  const real = run.errors.filter((e) => !e.env);
  let list = real.filter((e) => e.seq >= since);
  if (level === 'error') list = list.filter((e) => e.level === 'error');
  const page = list.slice(0, limit);
  const merged = new Map<string, Record<string, unknown>>();
  for (const e of page) {
    const stack = e.stack.map(where);
    const key = JSON.stringify([e.level, e.message, e.detail, stack, stack.length ? '' : where(e.source)]);
    const seen = merged.get(key);
    if (seen) {
      seen.count = Number(seen.count ?? 1) + 1;
      continue;
    }
    merged.set(key, {
      seq: e.seq,
      ...(e.level === 'warning' ? { warning: true } : {}),
      message: e.message,
      ...(e.detail ? { detail: e.detail } : {}),
      // The script line that raised it, then its callers (innermost first). The engine's
      // C++ location only helps when no script was on the stack.
      ...(stack.length ? { at: stack[0], ...(stack.length > 1 ? { callers: stack.slice(1) } : {}) } : { source: where(e.source) }),
    });
  }
  return {
    error_count: real.filter((e) => e.level === 'error').length,
    warning_count: real.filter((e) => e.level === 'warning').length,
    ...(real.length < run.errors.length ? { environment: run.errors.length - real.length } : {}),
    next: page.length > 0 ? page[page.length - 1]!.seq + 1 : since,
    more: list.length > page.length,
    errors: [...merged.values()],
  };
}

export const runOutput = defineOp({
  name: 'run.output',
  group: 'run',
  title: 'Game output',
  description:
    'Godot run: read output and errors of a game started with godot_run_start (process or editor mode). Use level "error" to see only errors, and "since" (the "next" value from the last call) to page.',
  input: z.object({
    run_id: z.string().optional().describe('Default: the running game (latest run). "editor" for the editor\'s.'),
    since: z.number().int().min(0).default(0),
    limit: z.number().int().min(1).max(2000).default(200),
    level: z.enum(['all', 'warning', 'error']).default('all'),
    errors: z.boolean().optional().describe('Script errors with backtraces instead of lines (repeats merged).'),
  }),
  readOnly: true,
  idempotent: true,
  core: true,
  async run({ run_id, since, limit, level, errors }, ctx) {
    const run = run_id === 'editor' ? undefined : ctx.runs.get(run_id);
    // A game started from the editor writes to the editor's Output panel, which plugins
    // can't read, so its runtime keeps a copy (runtime/ops/rt_output.gd). Use it when asked
    // for run_id "editor", or by default when no process run of ours is running.
    if (run_id === 'editor' || (!run_id && !run?.running)) {
      const editorGame = await resolveGame(ctx, 'editor').catch(() => undefined);
      if (editorGame) {
        const page = (await editorGame.channel.request('rt.output', { since, limit, level, errors: errors ?? false })) as Record<string, unknown>;
        return { data: { run_id: 'editor', running: true, ...page } };
      }
      if (run_id === 'editor') throw new OpError('GAME_NOT_RUNNING', 'No game started from the editor is running (or its runtime has not loaded yet).');
    }
    if (!run) {
      throw new OpError('NOT_FOUND', run_id ? `No run with id "${run_id}".` : 'No game has been started by this server yet. Use godot_run_start (mode "process" to capture output).');
    }
    if (errors) return { data: { run_id: run.id, running: run.running, exit_code: run.exitCode, ...errorPage(run, since, limit, level) } };
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
        // "EVAL" marks the output of a failed godot_debug_control evaluate: Godot prints it
        // like a game error, but it isn't one (not counted, not in errors: true).
        // "ENV" marks start-up noise from the machine's drivers (not counted, see runs.ts).
        lines: page.lines.map((l) => `${l.seq} ${l.evaluate ? 'EVAL ' : l.env ? 'ENV ' : l.level === 'info' ? '' : l.level.toUpperCase() + ' '}${l.text}`),
      },
    };
  },
});

export const editorLogs = defineOp({
  name: 'editor.logs',
  group: 'editor',
  title: 'Editor log',
  description:
    'Godot editor: read messages, warnings and errors printed by the editor process (plugin and tool scripts, import errors; not a running game\'s prints). Repeats are merged with a count. Page with "since".',
  input: z.object({
    since: z.number().int().min(0).default(0),
    limit: z.number().int().min(1).max(2000).default(200),
    level: z.enum(['all', 'warning', 'error']).default('all'),
  }),
  readOnly: true,
  idempotent: true,
  async run(args, ctx) {
    const result = (await ctx.bridge.request('logs.read', args)) as { entries?: LogEntry[] };
    // Collapse repeats in the page (see mergeLogEntries); paging (next/dropped) is unchanged.
    if (Array.isArray(result.entries)) result.entries = mergeLogEntries(result.entries);
    return { data: result };
  },
});

/** One editor log entry as core/log_buffer.gd returns it. */
export interface LogEntry {
  seq: number;
  level: string;
  message: string;
  kind?: string;
  file?: string;
  line?: number;
  function?: string;
  time?: string;
  [key: string]: unknown;
}

/**
 * Merges repeated entries of one editor_logs page into the first occurrence, with
 * `count` and the `last_seq` / `last_time` of the final repeat (order otherwise kept).
 *
 * Why: a windowed game run from the editor under Xvfb (no window manager) makes the editor
 * log "Unhandled XServer error: BadWindow ..." about every 150 ms, and one page held
 * nothing else. run_output errors: true already merges repeats; this does the same here.
 *
 * Errors and warnings also merge when they differ only in numbers: Godot puts serial
 * numbers, ids and counters into such messages (the BadWindow text carries three serial
 * numbers that change every time), so exact matching would merge nothing. The first
 * message is kept verbatim. Plain messages (print output) merge only when identical, so
 * "score 1", "score 2" stay separate lines.
 */
export function mergeLogEntries(entries: LogEntry[]): LogEntry[] {
  const out: LogEntry[] = [];
  const byKey = new Map<string, LogEntry>();
  for (const e of entries) {
    const text = String(e.message ?? '');
    const msgKey = e.level === 'info' ? text : text.replace(/\d+/g, '#');
    const key = JSON.stringify([e.level, e.kind ?? '', e.file ?? '', e.line ?? 0, e.function ?? '', msgKey]);
    const first = byKey.get(key);
    if (first) {
      first.count = Number(first.count ?? 1) + 1;
      first.last_seq = e.seq;
      if (e.time !== undefined) first.last_time = e.time;
      continue;
    }
    const copy = { ...e };
    byKey.set(key, copy);
    out.push(copy);
  }
  return out;
}

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
      throw new OpError('ADDON_MISSING', 'The godot_mcp addon is not installed in this project, so the editor would start without the bridge. Install it first with godot_addon_install.');
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
