/**
 * Game runs started by the server itself (not through the editor).
 *
 * The 2026-07-28 MCP spec removed sessions, so state that outlives one tool
 * call is addressed by an opaque handle the model passes back. Here that's a
 * `run_id`: `godot_run_start` returns it, and `godot_run_output` /
 * `godot_run_stop` take it.
 *
 * Output is kept in a bounded ring buffer (unbounded growth of captured
 * output is a known bug in another Godot MCP server), and Godot's error
 * lines are classified so the agent can ask for just errors.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { log } from '../log.js';

export type LineLevel = 'info' | 'warning' | 'error';

export interface OutputLine {
  seq: number;
  stream: 'stdout' | 'stderr';
  level: LineLevel;
  text: string;
}

const MAX_LINES = 5_000;

/**
 * Classify a Godot output line. Godot prefixes problems with
 * "ERROR:", "SCRIPT ERROR:", "USER ERROR:", "WARNING:", "USER WARNING:", and
 * continues them with indented "at:" lines, which inherit the previous level.
 */
export function classifyLine(text: string, previous: LineLevel): LineLevel {
  if (/^\s*(SCRIPT ERROR|USER ERROR|ERROR|Parse Error)\b/.test(text)) return 'error';
  if (/^\s*(USER WARNING|WARNING)\b/.test(text)) return 'warning';
  if (/^\s+at:\s/.test(text) || /^\s+GDScript backtrace/.test(text) || /^\s+\[\d+\]\s/.test(text)) return previous;
  return 'info';
}

export class GameRun {
  readonly id = randomUUID().slice(0, 8);
  readonly startedAt = new Date();
  private lines: OutputLine[] = [];
  private seq = 0;
  private dropped = 0;
  private lastLevel: LineLevel = 'info';
  exitCode: number | null = null;
  running = true;

  constructor(
    private readonly child: ChildProcess,
    readonly scene: string,
    readonly headless: boolean,
  ) {
    const attach = (stream: NodeJS.ReadableStream | null, name: 'stdout' | 'stderr') => {
      if (!stream) return;
      let buf = '';
      stream.on('data', (d: Buffer) => {
        buf += d.toString('utf8');
        const parts = buf.split(/\r?\n/);
        buf = parts.pop() ?? '';
        for (const text of parts) this.push(name, text);
      });
      stream.on('end', () => {
        if (buf) this.push(name, buf);
      });
    };
    attach(child.stdout, 'stdout');
    attach(child.stderr, 'stderr');
    child.on('exit', (code) => {
      this.running = false;
      this.exitCode = code;
    });
  }

  private push(stream: 'stdout' | 'stderr', text: string): void {
    const level = classifyLine(text, this.lastLevel);
    this.lastLevel = level;
    this.lines.push({ seq: this.seq++, stream, level, text });
    if (this.lines.length > MAX_LINES) {
      this.lines.shift();
      this.dropped++;
    }
  }

  /** Lines with seq >= since, optionally filtered by level. */
  read(since = 0, limit = 200, level: 'all' | 'error' | 'warning' = 'all') {
    let out = this.lines.filter((l) => l.seq >= since);
    if (level === 'error') out = out.filter((l) => l.level === 'error');
    else if (level === 'warning') out = out.filter((l) => l.level !== 'info');
    const page = out.slice(0, limit);
    return {
      lines: page,
      // Where the next call should continue from.
      next: page.length > 0 ? page[page.length - 1]!.seq + 1 : since,
      more: out.length > page.length,
      dropped: this.dropped,
    };
  }

  counts() {
    let errors = 0;
    let warnings = 0;
    for (const l of this.lines) {
      if (l.level === 'error') errors++;
      else if (l.level === 'warning') warnings++;
    }
    return { errors, warnings, lines: this.seq };
  }

  stop(): void {
    if (this.running) this.child.kill();
  }
}

export class RunManager {
  private runs = new Map<string, GameRun>();

  start(godotPath: string, projectPath: string, opts: { scene?: string; headless: boolean; extraArgs?: string[] }): GameRun {
    const args = ['--path', projectPath];
    if (opts.headless) args.unshift('--headless');
    if (opts.scene) args.push('--scene', opts.scene);
    if (opts.extraArgs) args.push(...opts.extraArgs);
    log.info(`Starting game: ${godotPath} ${args.join(' ')}`);
    const child = spawn(godotPath, args, { cwd: projectPath, windowsHide: false, stdio: ['ignore', 'pipe', 'pipe'] });
    const run = new GameRun(child, opts.scene ?? 'main', opts.headless);
    this.runs.set(run.id, run);
    return run;
  }

  get(id?: string): GameRun | undefined {
    if (id) return this.runs.get(id);
    // No id: the most recent run is almost always what the agent means.
    return [...this.runs.values()].pop();
  }

  list(): GameRun[] {
    return [...this.runs.values()];
  }

  stopAll(): void {
    for (const r of this.runs.values()) r.stop();
  }
}
