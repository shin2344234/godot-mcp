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
  /**
   * True for the first line of an error or warning ("ERROR: ...", "WARNING: ..."), false
   * for its continuation lines ("   at: ...", "   GDScript backtrace...", "   [0] ...").
   * Counts use only head lines, so one error is one error in every view.
   */
  head?: boolean;
  /**
   * The line belongs to an error the debugger's "evaluate" caused (godot_debug_control
   * evaluate), not to the game's own code; it is shown as info and never counted.
   */
  evaluate?: boolean;
  /**
   * Engine start-up noise from the machine's drivers, not from the game (see isEnvSource):
   * shown with an "ENV" tag and never counted as an error or warning.
   */
  env?: boolean;
}

/**
 * Where Godot's own start-up complaints about the machine come from: graphics and audio
 * drivers and the platform layer (e.g. "Required Vulkan instance extension VK_KHR_surface
 * not found" from drivers/vulkan, ALSA's "status < 0" from drivers/alsa, "All audio drivers
 * failed, falling back to the dummy driver" from servers/audio/audio_server.cpp). On a
 * headless server or under Xvfb these appear on EVERY run, so the dogfood test saw
 * run_start report errors: 3, warnings: 3 for a game without a single bug, and could never
 * use "errors: 0" as a signal. Only reports raised before the runtime's hello (i.e. during
 * engine start-up) and without a script on the stack are treated this way, so a game that
 * triggers a driver error later still sees it counted.
 */
export function isEnvSource(file: string): boolean {
  return /^(drivers|platform)\//.test(file) || file === 'servers/audio/audio_server.cpp';
}

/** The C++ file of an "   at: function (file:line)" continuation line, if it is one. */
function atLineFile(text: string): string | undefined {
  return /^\s+at:\s.*\(([^():]+):\d+\)\s*$/.exec(text)?.[1];
}

/** Third-party library chatter printed during start-up, e.g. "ALSA lib conf.c:5208:(...)". */
function isEnvChatter(text: string): boolean {
  return /^ALSA lib /.test(text);
}

/**
 * How long after a failed evaluate its stderr copy may still arrive (stderr is a pipe and
 * the debugger a socket, so the two copies of one error come in on their own schedules).
 */
const EVAL_OUTPUT_GRACE_MS = 5_000;

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
  /** Start-up noise from the machine's drivers (isEnvSource); not counted. */
  env?: boolean;
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
  if (isHeadLine(text) === 'error') return 'error';
  if (isHeadLine(text) === 'warning') return 'warning';
  if (isContinuationLine(text)) return previous;
  return 'info';
}

/** "error"/"warning" when the line STARTS an error or warning report, else undefined. */
export function isHeadLine(text: string): 'error' | 'warning' | undefined {
  if (/^\s*(SCRIPT ERROR|USER ERROR|ERROR|Parse Error)\b/.test(text)) return 'error';
  if (/^\s*(USER WARNING|WARNING)\b/.test(text)) return 'warning';
  return undefined;
}

/** Indented lines Godot prints under an error: "at: ...", the backtrace header and frames. */
export function isContinuationLine(text: string): boolean {
  return /^\s+at:\s/.test(text) || /^\s+GDScript backtrace/.test(text) || /^\s+\[\d+\]\s/.test(text);
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
  /**
   * Debugger evaluations in flight (godot_debug_control evaluate). A failed evaluation
   * makes Godot report an "error" (with the stopped frame's backtrace, e.g. duck.gd:23 in
   * _physics_process) through the debugger AND print it on stderr. Neither is a bug in the
   * game, so while this is > 0 debugger errors are kept out of `errors`, and the matching
   * output lines are marked `evaluate` (see beginEvaluate / endEvaluate).
   */
  private evaluating = 0;
  /** Error texts of recent failed evaluations, to recognise late stderr lines by content. */
  private evalTexts: { text: string; until: number }[] = [];
  /** Level of the current evaluate-output block (continuation lines inherit it). */
  private lastEval = false;
  /**
   * True once the runtime said hello: the engine has started, so driver complaints after
   * this point are not start-up noise any more (see isEnvSource). Runs without the runtime
   * never get here, which keeps their start-up noise tagged too.
   */
  private started = false;
  /** Index in `lines` of the latest error/warning head line, to tag it env from its "at:". */
  private lastHead = -1;

  constructor(
    private readonly child: ChildProcess,
    readonly scene: string,
    readonly headless: boolean,
    readonly session?: DebugSession,
  ) {
    if (session) {
      this.channel = new RuntimeChannel(new ProcessTransport(session));
      void this.channel.ready.then(() => {
        this.started = true;
      });
      session.on('message:error', (m: GameMessage) => {
        const e = parseOutputError(m.data);
        if (!e) return;
        if (!this.started && e.stack.length === 0 && isEnvSource(e.source.file)) e.env = true;
        // Raised by a debugger evaluate, not by the game: DebugState.evaluate reads it
        // itself (its own listener), the game's error list must not show it.
        if (this.evaluating > 0) {
          // stderr prints Godot's description when there is one ("ERROR: <descr>"), else
          // the failed condition; parseOutputError puts the condition first. Remember both.
          this.rememberEvalText(e.message, e.detail);
          return;
        }
        this.errors.push({ seq: this.errorSeq++, ...e });
        if (this.errors.length > MAX_ERRORS) this.errors.shift();
      });
    }
    const attach = (stream: NodeJS.ReadableStream | null, name: 'stdout' | 'stderr') => {
      if (!stream) return;
      let buf = '';
      // setEncoding: decode UTF-8 across chunk boundaries (a character split between two
      // chunks was decoded as two U+FFFD replacement characters; Codex review of 0.1.0).
      stream.setEncoding('utf8');
      stream.on('data', (d: string) => {
        buf += d;
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
    // Node emits 'error' (and no 'exit') when the process can't be started at all, e.g. a
    // missing or non-executable Godot binary. Without a listener that event is unhandled
    // and takes the whole MCP server down; with only the 'once' listener the release code
    // in RunManager.start adds, the run stayed "running" forever with its debugger socket
    // open (Codex review of 0.1.0). Record why and mark the run finished.
    child.on('error', (err) => {
      if (!this.running) return;
      this.running = false;
      this.push('stderr', `ERROR: could not start Godot: ${err.message}`);
      session?.close();
    });
  }

  /** Process id of the game (as spawned). */
  get pid(): number | undefined {
    return this.child.pid;
  }

  /** Called by DebugState right before it sends "evaluate" (see `evaluating`). */
  beginEvaluate(): void {
    this.evaluating++;
  }

  /**
   * Called when an evaluate is done (its error, if any, has arrived or the grace time
   * passed). Late stderr lines of that error are still recognised by their text.
   */
  endEvaluate(): void {
    this.evaluating = Math.max(0, this.evaluating - 1);
  }

  /** Remembers the texts of one evaluate error (they share `until`, which identifies them). */
  private rememberEvalText(...texts: string[]): void {
    const now = Date.now();
    this.evalTexts = this.evalTexts.filter((t) => t.until > now);
    const until = now + EVAL_OUTPUT_GRACE_MS;
    for (const text of texts) if (text) this.evalTexts.push({ text, until });
  }

  /**
   * Does this error/warning head line come from a debugger evaluate? Yes while one is in
   * flight (the game is stopped then, so nothing else of the game runs), or when it repeats
   * the text of an evaluate error that just arrived over the debugger. A recognised error
   * is used up (both its remembered texts): a real game error with the same text later is
   * counted normally.
   */
  private isEvalOutput(text: string): boolean {
    if (this.evaluating > 0) return true;
    const now = Date.now();
    const hit = this.evalTexts.find((t) => t.until > now && text.includes(t.text));
    if (!hit) return false;
    this.evalTexts = this.evalTexts.filter((t) => t.until !== hit.until);
    return true;
  }

  private push(stream: 'stdout' | 'stderr', text: string): void {
    const head = isHeadLine(text);
    let level = classifyLine(text, this.lastLevel);
    let evaluate = false;
    if (head) {
      evaluate = this.isEvalOutput(text);
      this.lastEval = evaluate;
    } else if (level !== 'info' && isContinuationLine(text)) {
      // "at:" / backtrace lines belong to the report above them.
      evaluate = this.lastEval;
    } else {
      this.lastEval = false;
    }
    this.lastLevel = level;
    // Evaluate errors read as info (they're not the game's), tagged so they can be told apart.
    if (evaluate) level = 'info';
    const line: OutputLine = { seq: this.seq++, stream, level, text, ...(head && !evaluate ? { head: true } : {}), ...(evaluate ? { evaluate: true } : {}) };
    if (!this.started) {
      if (head) {
        this.lastHead = this.lines.length;
      } else if (level !== 'info' && this.lastHead >= 0) {
        // Godot prints the location on the line AFTER the "ERROR:"/"WARNING:" head, so the
        // head is tagged once its "at:" line names a driver/platform file.
        const file = atLineFile(text);
        const headLine = this.lines[this.lastHead];
        if (file && isEnvSource(file) && headLine) headLine.env = true;
        if (headLine?.env) line.env = true;
      } else if (isEnvChatter(text)) {
        line.env = true;
      }
    }
    if (!head && level === 'info') this.lastHead = -1;
    this.lines.push(line);
    if (this.lines.length > MAX_LINES) {
      this.lines.shift();
      this.dropped++;
      if (this.lastHead >= 0) this.lastHead--;
    }
  }

  /** Lines with seq >= since, optionally filtered by level. */
  read(since = 0, limit = 200, level: 'all' | 'error' | 'warning' = 'all') {
    let out = this.lines.filter((l) => l.seq >= since);
    // Start-up noise from the drivers is not an error of the game (isEnvSource).
    if (level === 'error') out = out.filter((l) => l.level === 'error' && !l.env);
    else if (level === 'warning') out = out.filter((l) => l.level !== 'info' && !l.env);
    const page = out.slice(0, limit);
    return {
      lines: page,
      // Where the next call should continue from.
      next: page.length > 0 ? page[page.length - 1]!.seq + 1 : since,
      more: out.length > page.length,
      dropped: this.dropped,
    };
  }

  /**
   * Error and warning counts of the output. Only head lines count: Godot prints one error
   * as "ERROR: ..." plus indented "at:" / backtrace lines, and counting those too made
   * run_start / run_output say errors: 2 where run_output errors: true said error_count: 1.
   * Lines evicted from the ring buffer are no longer counted (`dropped` says how many).
   */
  counts() {
    let errors = 0;
    let warnings = 0;
    let env = 0;
    for (const l of this.lines) {
      if (!l.head) continue;
      if (l.env) env++;
      else if (l.level === 'error') errors++;
      else if (l.level === 'warning') warnings++;
    }
    // environment: start-up noise from the machine's drivers (isEnvSource), not counted above.
    return { errors, warnings, ...(env > 0 ? { environment: env } : {}), lines: this.seq };
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
    let release: (() => Promise<void>) | undefined;
    try {
      release = runtimeInstalled(projectPath) ? await injectRuntime(projectPath) : undefined;
    } catch (err) {
      // Don't leave the debugger port listening for a game that never starts.
      session.close();
      throw err;
    }
    session.once('connected', () => {
      if (!opts.breakOnErrors) session.send('core:set_ignore_error_breaks', [true]);
      // Godot's SceneDebugger disables game input after a suspend/resume unless the
      // "runtime node select" type is NONE (0). It defaults to 2D and only the editor's
      // Game view resets it, so a game we launch would lose input after the first
      // godot_game_time pause/resume. Reset it once, for every tool that pauses.
      session.send('scene:runtime_node_select_set_type', [0]);
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
