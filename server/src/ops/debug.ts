/**
 * Step 3: breakpoint debugging of running games (debug.breakpoints / debug.control / debug.state).
 *
 * Works on process runs (godot_run_start mode "process"), where this server is the game's
 * remote debugger and speaks Godot's own debugger protocol: no DAP, no editor. The protocol
 * details and the per-run state live in src/game/debugState.ts; docs/methods/debug.md
 * describes the tools. Games started from the editor report their breakpoints to the
 * editor's own debugger (plugins never see debug_enter/stack_dump), so they're refused
 * with UNSUPPORTED.
 *
 * Read-only flags, honestly: debug.state only reads (stack dumps and variables have no
 * side effects in Godot), so it is readOnly and reachable through the read router.
 * Evaluating an expression can call methods and change the game, so it lives in
 * debug.control (not readOnly) instead of debug.state.
 */

import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { OpError } from '../errors.js';
import { debugStateFor, splitBreakpoint, VARIANT_NIL, VARIANT_OBJECT, type DebugState, type StackFrame, type StackVariable, type StopInfo } from '../game/debugState.js';
import type { GameRun } from '../godot/runs.js';
import { PathError, resolveProjectPath, resolveProjectPathStrict } from '../project/paths.js';
import { defineOp, type OpContext, type Operation } from './types.js';

/** How long a tool waits for a just-started game to connect its debugger. */
const CONNECT_WAIT_MS = 10_000;
/** Default seconds to wait for the game to stop again after a step or pause. */
const DEFAULT_WAIT_S = 10;
/** Output caps, so a frame with big arrays or many members can't flood the context. */
const MAX_VARS = 50;
const MAX_STRING = 300;
const MAX_ITEMS = 20;
const MAX_DEPTH = 3;

const EDITOR_UNSUPPORTED =
  'Breakpoint debugging works on games this server launches: the editor\'s own debugger receives the breakpoints of games started from the editor. Start the game with godot_run_start {mode: "process", breakpoints: ["res://file.gd:LINE"]} instead.';
const NO_RUN =
  'No game started with godot_run_start (mode "process") is running. Start one, e.g. godot_run_start {mode: "process", breakpoints: ["res://player.gd:42"]}, then use the debug tools.';

const runId = z.string().optional().describe('Default: newest process run.');

// --- Finding the run ----------------------------------------------------------

async function editorPlaying(ctx: OpContext): Promise<boolean> {
  if (!ctx.bridge.isOpen()) return false;
  const status = (await ctx.bridge.request('editor.status').catch(() => ({}))) as { is_playing?: boolean };
  return Boolean(status.is_playing);
}

/** The process run a debug tool works on, with its debug state (connected and probed). */
async function debugTarget(ctx: OpContext, id?: string): Promise<{ run: GameRun; state: DebugState }> {
  if (id === 'editor') throw new OpError('UNSUPPORTED', EDITOR_UNSUPPORTED);
  let run: GameRun | undefined;
  if (id) {
    run = ctx.runs.get(id);
    if (!run) throw new OpError('NOT_FOUND', `No run with id "${id}". Known runs: ${ctx.runs.list().map((r) => r.id).join(', ') || 'none'}.`);
  } else {
    run = ctx.runs.list().filter((r) => r.running && r.session).pop();
    if (!run) {
      if (await editorPlaying(ctx)) throw new OpError('UNSUPPORTED', EDITOR_UNSUPPORTED);
      throw new OpError('GAME_NOT_RUNNING', NO_RUN);
    }
  }
  if (!run.session) throw new OpError('UNSUPPORTED', 'This run has no debugger connection. Start the game again with godot_run_start mode "process".');
  if (!run.running || run.session.closed) {
    throw new OpError('GAME_NOT_RUNNING', `Run "${run.id}" has exited${run.exitCode === null ? '' : ` (code ${run.exitCode})`}. Read what happened with godot_run_output (errors: true), or start it again.`);
  }
  if (!run.session.isConnected) {
    // Just started: Godot connects to the debugger during its boot.
    await Promise.race([run.session.connected, new Promise((r) => setTimeout(r, CONNECT_WAIT_MS))]);
    if (!run.session.isConnected) throw new OpError('GAME_NOT_RUNNING', `Run "${run.id}" hasn't connected its debugger (still booting, or it failed). Check godot_run_output and retry.`);
  }
  const state = debugStateFor(run);
  await state.ready;
  return { run, state };
}

// --- Breakpoint specs ---------------------------------------------------------

export type BreakpointSpec = string | { file: string; line: number };

/**
 * Validate a breakpoint against the project: a .gd file that exists, a line in range.
 * Returns the canonical res:// path (Godot matches breakpoints by the script's exact
 * path) and a warning for lines that can never stop.
 *
 * Verified with Godot 4.7.2: GDScript stops only where the compiler emitted a line
 * opcode, i.e. lines with statements. Blank lines, comments and `func` declaration lines
 * never stop (Godot doesn't move such breakpoints, they just never trigger); a member
 * `var x := 1` line stops while the object is constructed (@implicit_new).
 */
export async function resolveBreakpoint(projectPath: string, spec: BreakpointSpec): Promise<{ file: string; line: number; warning?: string }> {
  const parsed = typeof spec === 'string' ? splitBreakpoint(spec.trim()) : spec;
  if (!parsed || !parsed.file) throw new OpError('BAD_PARAMS', `"${String(spec)}" is not a breakpoint. Use "res://path/to/script.gd:LINE" (1-based line) or {file, line}.`);
  let p;
  try {
    p = await resolveProjectPathStrict(projectPath, parsed.file);
  } catch (err) {
    if (err instanceof PathError) throw new OpError('BAD_PARAMS', err.message);
    throw err;
  }
  if (!p.rel.endsWith('.gd')) throw new OpError('BAD_PARAMS', `${p.res}: breakpoints work in GDScript (.gd) files only.`);
  let text: string;
  try {
    text = readFileSync(p.abs, 'utf8');
  } catch {
    throw new OpError('NOT_FOUND', `${p.res} doesn't exist in the project. Check the path (godot_files_list / godot_files_search can find scripts).`);
  }
  const lines = text.split(/\r?\n/);
  if (text.endsWith('\n')) lines.pop();
  const line = parsed.line;
  if (!Number.isInteger(line) || line < 1 || line > lines.length) {
    throw new OpError('BAD_PARAMS', `${p.res} has ${lines.length} lines; line ${line} is out of range (lines are 1-based).`);
  }
  const isCode = (s: string) => !/^\s*(#.*)?$/.test(s);
  const nextCode = () => {
    for (let i = line; i < lines.length; i++) if (isCode(lines[i]!) && !/^\s*(static\s+)?func\s/.test(lines[i]!)) return i + 1;
    return undefined;
  };
  const here = lines[line - 1]!;
  let warning: string | undefined;
  // Declarations that compile to no line opcode: `extends`, `class_name`, `signal`,
  // `const`, `enum`, annotations alone on a line, and member `var`s without an initializer
  // (a member var WITH one runs at construction, see above). The dogfood test set one on
  // an `extends` line, got no warning, and waited for a stop that never came.
  const declaration =
    /^(extends|class_name|signal|const|enum|@tool|@icon|@static_unload|@export_(category|group|subgroup))\b/.test(here) ||
    /^@\w+(\(.*\))?\s*$/.test(here) ||
    (/^(@\w+(\(.*\))?\s+)*(static\s+)?var\s/.test(here) && !/[^=!<>]=[^=]|:=/.test(here.replace(/#.*$/, '')));
  if (!isCode(here) || /^\s*(static\s+)?func\s/.test(here) || declaration) {
    const n = nextCode();
    const what = !isCode(here) ? 'blank or a comment' : declaration ? 'a declaration' : 'a func declaration';
    warning = `${p.res}:${line} is ${what}; Godot only stops on lines with statements, so it will never trigger.${n ? ` The next code line is ${n}.` : ''}`;
  }
  return { file: p.res, line, ...(warning ? { warning } : {}) };
}

// --- Formatting -----------------------------------------------------------------

/** Shorten long strings, arrays and dictionaries (decoded values are JSON already). */
function compact(v: unknown, depth = 0): unknown {
  if (typeof v === 'string') return v.length > MAX_STRING ? `${v.slice(0, MAX_STRING)}… (+${v.length - MAX_STRING} chars)` : v;
  if (Array.isArray(v)) {
    if (depth >= MAX_DEPTH) return `Array(${v.length})`;
    const out = v.slice(0, MAX_ITEMS).map((x) => compact(x, depth + 1));
    if (v.length > MAX_ITEMS) out.push(`… +${v.length - MAX_ITEMS} more`);
    return out;
  }
  if (v && typeof v === 'object') {
    if ('object_id' in v) return v; // { object_id } refers to a live object in the game
    const entries = Object.entries(v);
    if (depth >= MAX_DEPTH) return `Dictionary(${entries.length})`;
    const out: Record<string, unknown> = {};
    for (const [k, x] of entries.slice(0, MAX_ITEMS)) out[k] = compact(x, depth + 1);
    if (entries.length > MAX_ITEMS) out['…'] = `+${entries.length - MAX_ITEMS} more`;
    return out;
  }
  return v;
}

/** One variable's value for the model. */
function formatValue(v: StackVariable): unknown {
  // Godot sends null instead of values over 1 MiB (ScriptStackVariable::serialize).
  if (v.value === null && v.type !== VARIANT_NIL && v.type !== VARIANT_OBJECT) return '<too large to send>';
  if (v.value && typeof v.value === 'object' && 'object_id' in v.value) return v.typeHint ? { ...v.value, class: v.typeHint } : v.value;
  return compact(v.value);
}

/** Variables of one scope as { name: value }, capped. */
function scopeVars(vars: StackVariable[], scope: number): Record<string, unknown> {
  const list = vars.filter((v) => v.scope === scope);
  const out: Record<string, unknown> = {};
  for (const v of list.slice(0, MAX_VARS)) out[v.name] = formatValue(v);
  if (list.length > MAX_VARS) out['…'] = `+${list.length - MAX_VARS} more`;
  return out;
}

/** The source text of a script line (trimmed), to show where the game is. */
function codeAt(ctx: OpContext, file: string, line: number): string | undefined {
  try {
    const p = resolveProjectPath(ctx.config.projectPath, file);
    const text = readFileSync(p.abs, 'utf8').split(/\r?\n/)[line - 1]?.trim();
    return text ? text.slice(0, 200) : undefined;
  } catch {
    return undefined;
  }
}

function frameInfo(ctx: OpContext, f: StackFrame, withCode: boolean) {
  const code = withCode ? codeAt(ctx, f.file, f.line) : undefined;
  return { file: f.file, line: f.line, function: f.function, ...(code ? { code } : {}) };
}

/** What the stop means and what to do next, for the stops that need explaining. */
function stopNote(stop: StopInfo): string | undefined {
  if (!stop.hasStack) return 'Paused outside GDScript (between frames), so there is no call stack. step_into stops at the next GDScript line that runs; continue resumes.';
  if (!stop.canStep) return 'Stopped on a script error: Godot only allows continue from here (the failing function is aborted). All errors: godot_run_output errors: true.';
  return undefined;
}

function stopHeader(stop: StopInfo) {
  return { stopped: true, reason: stop.reason, ...(stop.error ? { error: stop.error } : {}) };
}

/** After the game exited mid-call: give its exit code a moment to arrive. */
async function exitedResult(run: GameRun) {
  for (let i = 0; i < 10 && run.running; i++) await new Promise((r) => setTimeout(r, 100));
  return { run_id: run.id, stopped: false, running: run.running, exited: true, exit_code: run.exitCode, note: 'The game exited. godot_run_output shows its last output and errors.' };
}

/** `text` ending in sentence punctuation (adds a period when it has none). */
export function withPeriod(text: string): string {
  const t = text.trimEnd();
  return /[.!?:]$/.test(t) ? t : `${t}.`;
}

// --- Opening object variables -----------------------------------------------------

/** How many objects one debug.state call may expand. */
const MAX_EXPAND = 5;

/**
 * Engine properties worth showing for common game objects (2D and 3D bodies, sprites,
 * Controls). Read with Object.get(), which returns null for a property the class doesn't
 * have, so one list fits every class; nulls are dropped.
 */
const COMMON_PROPS = [
  'position', 'global_position', 'rotation', 'scale', 'velocity', 'linear_velocity', 'angular_velocity',
  'visible', 'modulate', 'size', 'text', 'animation', 'frame', 'current_animation', 'process_mode',
];

/**
 * One level of an object variable: its class, its script variables and the common engine
 * properties above. Godot's debugger sends object locals as an id and class only
 * (ScriptStackVariable), so the dogfood test could not see a CharacterBody2D's position or
 * velocity without typing evaluate expressions by hand. Two evaluate calls in the stopped
 * frame do it here: the script's property names, then one dictionary of values.
 */
async function expandObject(state: DebugState, name: string, frame: number): Promise<unknown> {
  // Only plain identifiers (locals, members, self): the name is spliced into an expression.
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) return { error: `"${name}" is not a variable name.` };
  const self = await state.evaluate(name, frame);
  if (self.error) return { error: withPeriod(self.error) };
  if (self.type !== VARIANT_OBJECT) return { error: `"${name}" is not an object (it is ${JSON.stringify(compact(self.value))}).` };
  if (self.value === null) return { error: `"${name}" is null.` };
  const kind = await state.evaluate(`${name}.get_class()`, frame);
  if (kind.error) return { error: withPeriod(kind.error) };
  const props = [...COMMON_PROPS];
  // Script variables (get_script() is null for objects without a script: the evaluate fails then).
  const listed = await state.evaluate(`${name}.get_script().get_script_property_list()`, frame);
  if (!listed.error && Array.isArray(listed.value)) {
    for (const p of listed.value as { name?: unknown; usage?: unknown }[]) {
      // PROPERTY_USAGE_SCRIPT_VARIABLE (4096) marks real script vars (not groups/categories).
      if (typeof p?.name === 'string' && (Number(p.usage) & 4096) !== 0 && !props.includes(p.name)) props.push(p.name);
    }
  }
  const expr = `{${props.map((p) => `"${p}": ${name}.get("${p}")`).join(', ')}}`;
  const values = await state.evaluate(expr, frame);
  if (values.error) return { class: kind.value, error: withPeriod(values.error) };
  const out: Record<string, unknown> = { class: kind.value };
  for (const [k, v] of Object.entries((values.value ?? {}) as Record<string, unknown>)) if (v !== null) out[k] = compact(v);
  return out;
}

// --- Tools ----------------------------------------------------------------------

export const debugBreakpoints = defineOp({
  name: 'debug.breakpoints',
  group: 'debug',
  title: 'Breakpoints',
  description: 'Godot debug: list, add, remove or clear breakpoints of a game started with godot_run_start (process mode), running or stopped.',
  input: z.object({
    action: z.enum(['list', 'add', 'remove', 'clear']).default('list'),
    breakpoints: z
      .array(z.union([z.string(), z.object({ file: z.string(), line: z.number().int() })]))
      .optional()
      .describe('"res://player.gd:42" or {file, line}.'),
    run_id: runId,
  }),
  readOnly: false,
  destructive: false,
  idempotent: true,
  async run({ action, breakpoints, run_id }, ctx) {
    const { run, state } = await debugTarget(ctx, run_id);
    if ((action === 'add' || action === 'remove') && !breakpoints?.length) {
      throw new OpError('BAD_PARAMS', `action "${action}" needs breakpoints, e.g. ["res://player.gd:42"].`);
    }
    const changed: string[] = [];
    const warnings: string[] = [];
    if (action === 'add') {
      // Validate everything first, so a typo doesn't leave half the list applied.
      const resolved = await Promise.all(breakpoints!.map((b) => resolveBreakpoint(ctx.config.projectPath, b)));
      for (const bp of resolved) {
        if (bp.warning) warnings.push(bp.warning);
        state.setBreakpoint(bp.file, bp.line, true);
        changed.push(`${bp.file}:${bp.line}`);
      }
    } else if (action === 'remove') {
      for (const b of breakpoints!) {
        const parsed = typeof b === 'string' ? splitBreakpoint(b.trim()) : b;
        if (!parsed) throw new OpError('BAD_PARAMS', `"${String(b)}" is not a breakpoint. Use "res://path/to/script.gd:LINE".`);
        let file: string;
        try {
          file = resolveProjectPath(ctx.config.projectPath, parsed.file).res;
        } catch (err) {
          throw new OpError('BAD_PARAMS', (err as Error).message);
        }
        if (!state.hasBreakpoint(file, parsed.line)) warnings.push(`${file}:${parsed.line} was not set.`);
        // Sent anyway: harmless, and clears it if it was set some other way.
        state.setBreakpoint(file, parsed.line, false);
        changed.push(`${file}:${parsed.line}`);
      }
    } else if (action === 'clear') {
      for (const spec of state.list()) {
        const bp = splitBreakpoint(spec)!;
        state.setBreakpoint(bp.file, bp.line, false);
        changed.push(spec);
      }
    }
    return {
      data: {
        run_id: run.id,
        breakpoints: state.list(),
        ...(action === 'add' ? { added: changed } : action === 'list' ? {} : { removed: changed }),
        ...(warnings.length ? { warnings } : {}),
        stopped: Boolean(state.stop),
      },
    };
  },
});

export const debugControl = defineOp({
  name: 'debug.control',
  group: 'debug',
  title: 'Debug control',
  description:
    'Godot debug: continue, pause, step_into/over/out (returns the new location and locals), or evaluate an expression in a stopped game (process runs).',
  input: z.object({
    action: z.enum(['continue', 'pause', 'step_into', 'step_over', 'step_out', 'evaluate']),
    expression: z.string().optional().describe('evaluate: a Godot Expression; sees locals, self\'s members/methods, autoloads. Can have side effects.'),
    frame: z.number().int().min(0).default(0).describe('evaluate: stack frame (0 = innermost).'),
    wait: z.number().min(0).max(120).optional().describe('Seconds to wait for the next stop (default 10; continue 0).'),
    run_id: runId,
  }),
  readOnly: false,
  destructive: false,
  async run({ action, expression, frame, wait, run_id }, ctx) {
    const { run, state } = await debugTarget(ctx, run_id);

    if (action === 'evaluate') {
      if (!expression?.trim()) throw new OpError('BAD_PARAMS', 'action "evaluate" needs an expression, e.g. "position.x + 1" or "get_child_count()".');
      const r = await state.evaluate(expression, frame);
      if (r.error) {
        throw new OpError(
          'GODOT_ERROR',
          // Godot's error text usually has no final period ("... on base type Object"), so
          // add one before our hint, or the two sentences run together.
          `Evaluating "${expression}" failed: ${withPeriod(r.error)} Expressions use Godot's Expression class: one expression (no statements or "=" assignments) over the frame's locals, self's members and methods, autoloads and singletons. ` +
            '(This error is not recorded as a game error.)',
        );
      }
      return { data: { run_id: run.id, expression, frame, value: formatValue({ ...r, name: expression, scope: 3 }) } };
    }

    const waitMs = (wait ?? (action === 'continue' ? 0 : DEFAULT_WAIT_S)) * 1000;
    let outcome: StopInfo | 'exited' | 'timeout';
    let stepFrom: StackFrame[] | undefined;
    if (action === 'pause') {
      if (state.stop) {
        const stop = state.stop;
        return { data: { run_id: run.id, ...stopHeader(stop), note: 'Already stopped; nothing to pause. Inspect with godot_debug_state.' } };
      }
      outcome = await state.pause(Math.max(waitMs, 1000), ctx.signal);
    } else {
      const stop = state.requireStopped();
      // After a pause there is no stack: "next"/"out" are relative to a frame, so every
      // step becomes "step" (stop at the next GDScript line), like the editor's step does.
      const command = action === 'continue' ? 'continue' : !stop.hasStack ? 'step' : action === 'step_into' ? 'step' : action === 'step_over' ? 'next' : 'out';
      // step_out: remember where we were and who called us, so the result can say when it
      // did not land in that caller (see stepOutNote).
      if (command === 'out') stepFrom = await state.stack();
      outcome = await state.resume(command, waitMs, ctx.signal);
    }

    if (outcome === 'exited') return { data: await exitedResult(run) };
    if (outcome === 'timeout') {
      const note =
        action === 'continue'
          ? waitMs > 0
            ? `Running; no breakpoint was hit within ${waitMs / 1000}s.`
            : undefined
          : action === 'pause'
            ? `The game did not stop within ${Math.max(waitMs, 1000) / 1000}s (its main loop may be blocked). Check godot_debug_state later.`
            : `Still running after ${waitMs / 1000}s: no GDScript line ran yet at the step's target. It stops when one does; check godot_debug_state.`;
      return { data: { run_id: run.id, stopped: false, running: true, ...(note ? { note } : {}) } };
    }
    // Stopped: report where, from a fresh stack dump, with the innermost frame's locals.
    const stop = outcome;
    const stack = await state.stack();
    const top = stack[0];
    const locals = top ? scopeVars(await state.variables(0), 0) : undefined;
    const note = [stopNote(stop), stepFrom ? stepOutNote(stepFrom, top) : undefined].filter(Boolean).join(' ') || undefined;
    return {
      data: {
        run_id: run.id,
        ...stopHeader(stop),
        ...(top ? { at: frameInfo(ctx, top, true), depth: stack.length, locals } : {}),
        ...(note ? { note } : {}),
      },
    };
  },
});

/**
 * step_out runs until the current function returns and stops in its caller. When the
 * function was called by the engine (a signal, a physics or input callback, a deferred
 * call) there is no GDScript caller frame, so Godot stops at the next GDScript line that
 * runs, wherever that is. The 2D dogfood test stepped out of Player.take_hit (called from a
 * hurtbox's body_entered handler, itself flushed by the physics server) and landed in
 * slime._physics_process with no word of why. Say so when the stop is not in the caller.
 */
export function stepOutNote(from: StackFrame[], top: StackFrame | undefined): string | undefined {
  const [current, caller] = from;
  if (!current || !top) return undefined;
  const where = (f: StackFrame) => `${f.function}() (${f.file}:${f.line})`;
  if (!caller) {
    return `${current.function}() had no GDScript caller (the engine called it: a signal, physics or input callback, or a deferred call), so step_out stopped at the next GDScript line that ran: ${where(top)}.`;
  }
  if (top.file === caller.file && top.function === caller.function) return undefined;
  return `Expected to stop in the caller ${where(caller)}, but the next GDScript line that ran was ${where(top)}.`;
}

export const debugState = defineOp({
  name: 'debug.state',
  group: 'debug',
  title: 'Debug state',
  description: 'Godot debug: is the game stopped (breakpoint, error, pause)? Call stack and variables (locals, members, globals) of a frame.',
  input: z.object({
    frame: z.number().int().min(0).default(0).describe('Frame for variables (0 = innermost).'),
    variables: z.boolean().default(true),
    globals: z.boolean().default(false).describe('Also globals (autoloads).'),
    expand: z.array(z.string()).optional().describe('Object variables to open, e.g. ["self","body"].'),
    wait: z.number().min(0).max(60).optional().describe('Seconds to wait for a stop.'),
    run_id: runId,
  }),
  readOnly: true,
  idempotent: true,
  async run({ frame, variables, globals, expand, wait, run_id }, ctx) {
    const { run, state } = await debugTarget(ctx, run_id);
    // An action that runs into a breakpoint (a game_input click, a game_edit call) returns
    // first; the stop arrives a moment later. `wait` covers that gap.
    if (!state.stop && wait) {
      const r = await state.waitForStop(wait * 1000, ctx.signal);
      if (r === 'exited') return { data: await exitedResult(run) };
    }
    const stop = state.stop;
    if (!stop) {
      return { data: { run_id: run.id, stopped: false, running: true, breakpoints: state.list(), errors: run.errors.filter((e) => e.level === 'error').length } };
    }
    const stack = await state.stack();
    if (stack.length > 0 && frame >= stack.length) throw new OpError('BAD_PARAMS', `Frame ${frame} doesn't exist; the stack has ${stack.length} frame(s) (0 = innermost).`);
    const vars = variables && stack.length > 0 ? await state.variables(frame) : undefined;
    let note = stopNote(stop);
    const expanded: Record<string, unknown> = {};
    if (expand?.length && stack.length > 0) {
      for (const name of expand.slice(0, MAX_EXPAND)) expanded[name] = await expandObject(state, name, frame);
    } else if (vars?.some((v) => v.type === VARIANT_OBJECT && v.scope !== 2)) {
      // Object variables arrive as {object_id, class} only; say how to look inside.
      note = [note, 'Object variables show only their id and class: pass expand: ["<name>"] (or "self") to read their script variables and common properties.'].filter(Boolean).join(' ');
    }
    return {
      data: {
        run_id: run.id,
        ...stopHeader(stop),
        can_step: stop.canStep,
        stack: stack.map((f, i) => frameInfo(ctx, f, i === frame)),
        ...(vars
          ? {
              frame,
              locals: scopeVars(vars, 0),
              members: scopeVars(vars, 1),
              ...(globals ? { globals: scopeVars(vars, 2) } : {}),
            }
          : {}),
        ...(Object.keys(expanded).length ? { expanded } : {}),
        ...(note ? { note } : {}),
      },
    };
  },
});

/** Operations in this area, in the order they should appear in tools/list. */
export const operations: Operation[] = [debugState, debugControl, debugBreakpoints] as Operation[];
