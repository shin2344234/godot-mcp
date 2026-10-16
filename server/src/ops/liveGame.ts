/**
 * Step 3: live inspection, live changes and opt-in code eval in the RUNNING game
 * (godot_game_tree / godot_game_get / godot_game_edit / godot_game_eval).
 *
 * The Godot side is addons/godot_mcp/runtime/ops/rt_live.gd, reached over the runtime
 * channel (docs/runtime-protocol.md) with runtimeCall(): a process run started by
 * godot_run_start, or a game started from the editor through the plugin's relay.
 * Params and results are documented in docs/methods/live-game.md.
 *
 * Descriptions are deliberately terse: every tool definition is re-sent to the model
 * on every turn (see test/unit/budget.test.ts).
 */

import { z } from 'zod';
import { OpError } from '../errors.js';
import { runtimeCall } from '../game/hub.js';
import { defineOp, type Operation } from './types.js';

/**
 * How long the server waits for game.edit / game.eval. The runtime itself stops waiting
 * for coroutines and scene changes after 10 s in total per request (AWAIT_BUDGET_S in
 * rt_live.gd) and answers with "pending", so this only fires for a frozen game or one
 * stopped at a breakpoint.
 */
const WAIT_MS = 20_000;

const runId = z.string().optional().describe('Default: newest running game.');
const path = z.string().optional().describe('Node path: relative to the current scene (default ".") or /root/....');

/** What godot_game_eval says while eval is off (the tool stays listed: the tool list never changes). */
export const EVAL_DISABLED_MESSAGE =
  'Code evaluation in the game is off. The user can enable it by starting the MCP server with --allow-eval ' +
  '(or env GODOT_MCP_ALLOW_EVAL=1) in the MCP client config, then restarting the server. ' +
  'Without it, godot_game_get reads values and godot_game_edit sets properties and calls methods.';

export const gameTree = defineOp({
  name: 'game.tree',
  group: 'game',
  title: 'Live game tree',
  description:
    'Godot game: the running game\'s live nodes as a flat list (path, class, script, rect/pos, visible text). Filters list matches only; text "Start" finds the button to click.',
  input: z.object({
    run_id: runId,
    root: z.string().optional().describe('Default: current scene; "/root" adds autoloads.'),
    depth: z.number().int().min(0).optional(),
    max_nodes: z.number().int().min(1).max(2000).optional().describe('Default 150.'),
    name: z.string().optional().describe('Name contains.'),
    class: z.string().optional().describe('Incl. subclasses.'),
    group: z.string().optional(),
    text: z.string().optional().describe('Visible text contains (Label, Button, LineEdit...).'),
  }),
  readOnly: true,
  idempotent: true,
  run: ({ run_id, ...params }, ctx) => runtimeCall(ctx, run_id, 'game.tree', params),
});

export const gameGet = defineOp({
  name: 'game.get',
  group: 'game',
  title: 'Read live node',
  description:
    'Godot game: current values of a live node: script variables and non-default properties (or listed ones, "prop:sub" ok), groups; optionally signal connections and script methods.',
  input: z.object({
    run_id: runId,
    path,
    properties: z.array(z.string()).optional().describe('Only these; "get_x()" calls a getter; ["*"] = all incl. defaults.'),
    signals: z.boolean().optional(),
    methods: z.boolean().optional(),
  }),
  readOnly: true,
  idempotent: true,
  run: ({ run_id, ...params }, ctx) => runtimeCall(ctx, run_id, 'game.get', params),
});

export const gameEdit = defineOp({
  name: 'game.edit',
  group: 'game',
  title: 'Change live game',
  description:
    'Godot game: change the running game with ops in order: set properties, call a method (returns its value, awaits coroutines), spawn, remove, change/reload scene. Stops at the first failing op; earlier ops stay (no undo, nothing saved).',
  input: z.object({
    run_id: runId,
    ops: z
      .array(
        z.object({
          action: z
            .enum(['set', 'call', 'spawn', 'remove', 'change_scene'])
            .describe('set {path, properties} | call {path, method, args} | spawn {class or scene, parent, name, properties} | remove {path} | change_scene {scene; omit to reload}'),
          path,
          properties: z.record(z.string(), z.unknown()).optional().describe('e.g. {"position": [10, 20]}'),
          method: z.string().optional(),
          args: z.array(z.unknown()).optional(),
          class: z.string().optional(),
          scene: z.string().optional(),
          parent: z.string().optional(),
          name: z.string().optional(),
        }),
      )
      .min(1)
      .max(50),
  }),
  readOnly: false,
  destructive: false,
  run: ({ run_id, ...params }, ctx) => runtimeCall(ctx, run_id, 'game.edit', params, WAIT_MS),
});

export const gameEval = defineOp({
  name: 'game.eval',
  group: 'game',
  title: 'Evaluate code in game',
  description:
    'Godot game: evaluate code in the running game: an Expression with self = node (default; autoloads and singletons by name), or a GDScript body of func run(node, tree, inputs) (use return). Off unless the server runs with --allow-eval.',
  input: z.object({
    run_id: runId,
    code: z.string(),
    mode: z.enum(['expression', 'gdscript']).optional(),
    path,
    inputs: z.record(z.string(), z.unknown()).optional().describe('Named values for the code.'),
  }),
  readOnly: false,
  destructive: true,
  async run({ run_id, ...params }, ctx) {
    // Checked before touching the game, so the answer is the same with or without one.
    if (!ctx.config.allowEval) throw new OpError('DISABLED', EVAL_DISABLED_MESSAGE);
    return runtimeCall(ctx, run_id, 'game.eval', params, WAIT_MS);
  },
});

/** Operations in this area, in the order they should appear in tools/list. */
export const operations: Operation[] = [gameTree, gameGet, gameEdit, gameEval] as Operation[];
