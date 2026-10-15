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
 *
 * Step 3: every process run is also a debug session. The server listens on
 * 127.0.0.1 and starts the game with `--remote-debug tcp://127.0.0.1:<port>`
 * (see src/game/debugSession.ts), and a temporary override.cfg loads the
 * runtime autoload for the moment the game boots (src/game/override.ts).
 * That gives the runtime tools a channel into the game (`run.channel`) and
 * the run structured errors with script backtraces (`run.errors`).
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { DebugSession, type GameMessage } from '../game/debugSession.js';
import { injectRuntime, runtimeInstalled } from '../game/override.js';
import { ProcessTransport, RuntimeChannel } from '../game/runtime.js';
import { log } from '../log.js';
import { debugStateFor } from '../game/debugState.js';

export type LineLevel = 'info' | 'warning' | 'error';

export interface OutputLine {
  seq: number;
  stream: 'stdout' | 'stderr';
  level: LineLevel;
  text: string;
}

const MAX_LINES = 5_000;
const MAX_ERRORS = 500;
/** How long the temporary override.cfg may stay if the game never says hello. */
const INJECT_TIMEOUT_MS = 20_000;

/** One error or warning reported through the debugger, with its script backtrace. */
export interface RunError {
  seq: number;
  /** "error" or "warning". */
  level: 'error' | 'warning';
  /** The error text, e.g. "Invalid access to property or key 'x' on a base object of type 'Nil'." */
  message: string;
  /** Extra description Godot attaches (often the condition that failed). */
  detail: string;
  /** Where Godot raised it (C++ or GDScript function/file/line). */
  source: { file: string; function: string; line: number };
  /** Script call stack, innermost first. */
  stack: { file: string; function: string; line: number }[];
  /** Milliseconds since the game started, from Godot's timestamp. */
  time_ms: number;
}

/** Parses an "error" debugger message (DebuggerMarshalls::OutputError in Godot 4.7.2). */
export function parseOutputError(data: unknown[]): Omit<RunError, 'seq'> | undefined {
  if (data.length < 11) return undefined;
  const [hr, min, sec, msec, file, func, line, error, descr, warning, stackSize] = data as [number, number, number, number, string, string, number, string, string, boolean, number];
  const stack: RunError['stack'] = [];
  for (let i = 0; i < Number(stackSize) / 3; i++) {
    const base = 11 + i * 3;
    stack.push({ file: String(data[base]), function: String(data[base + 1]), line: Number(data[base + 2]) });
  }
  return {
    level: warning ? 'warning' : 'error',
    message: String(error || descr),
    detail: error ? String(descr ?? '') : '',
    source: { file: String(file), function: String(func), line: Number(line) },
    stack,
    time_ms: ((Number(hr) * 60 + Number(min)) * 60 + Number(sec)) * 1000 + Number(msec),
  };
}

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
  /** Errors and warnings reported through the debugger (bounded). */
  readonly errors: RunError[] = [];
  private errorSeq = 0;
  /** Channel to the runtime autoload; `channel.ready` resolves when it said hello. */
  readonly channel: RuntimeChannel | undefined;
  /** Breakpoints passed at launch ("res://a.gd:12"), seeding the debug state's list. */
  initialBreakpoints: string[] = [];

  constructor(
    private readonly child: ChildProcess,
    readonly scene: string,
    readonly headless: boolean,
    readonly session?: DebugSession,
  ) {
    if (session) {
      this.channel = new RuntimeChannel(new ProcessTransport(session));
      session.on('message:error', (m: GameMessage) => {
        const e = parseOutputError(m.data);
        if (!e) return;
        this.errors.push({ seq: this.errorSeq++, ...e });
        if (this.errors.length > MAX_ERRORS) this.errors.shift();
      });
    }
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
      session?.close();
    });
  }

  /** Process id of the game (as spawned). */
  get pid(): number | undefined {
    return this.child.pid;
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
    this.session?.close();
  }
}

export class RunManager {
  private runs = new Map<string, GameRun>();

  /**
   * Start a game process with a debug session attached.
   * `breakpoints` ("res://player.gd:12") are set before the first line runs (Godot's --breakpoints).
   * `breakOnErrors` keeps Godot's default of stopping on script errors; otherwise the game
   * is told to ignore error breaks so an error never freezes an unattended run.
   */
  async start(
    godotPath: string,
    projectPath: string,
    opts: { scene?: string; headless: boolean; extraArgs?: string[]; breakpoints?: string[]; breakOnErrors?: boolean },
  ): Promise<GameRun> {
    const session = new DebugSession();
    await session.listen();
    const args = ['--path', projectPath, '--remote-debug', session.uri];
    if (opts.headless) args.unshift('--headless');
    if (opts.breakpoints?.length) args.push('--breakpoints', opts.breakpoints.join(','));
    if (opts.scene) args.push('--scene', opts.scene);
    if (opts.extraArgs) args.push(...opts.extraArgs);

    // Runtime autoload for this boot only (see src/game/override.ts).
    const release = runtimeInstalled(projectPath) ? await injectRuntime(projectPath) : undefined;
    session.once('connected', () => {
      if (!opts.breakOnErrors) session.send('core:set_ignore_error_breaks', [true]);
    });

    log.info(`Starting game: ${godotPath} ${args.join(' ')}`);
    let child: ChildProcess;
    try {
      child = spawn(godotPath, args, { cwd: projectPath, windowsHide: false, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      session.close();
      await release?.();
      throw err;
    }
    const run = new GameRun(child, opts.scene ?? 'main', opts.headless, session);
    run.initialBreakpoints = [...(opts.breakpoints ?? [])];
    // Track debugger stops from the very first message, so a breakpoint hit before
    // any debug tool is called is reported with its exact reason (not inferred later).
    debugStateFor(run);
    if (release) {
      const timer = setTimeout(() => void release(), INJECT_TIMEOUT_MS);
      const done = () => {
        clearTimeout(timer);
        void release();
      };
      void run.channel!.ready.then(done);
      child.once('exit', done);
      child.once('error', done);
    }
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
