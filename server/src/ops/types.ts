/**
 * The operation model.
 *
 * An "operation" is one thing the server can do (e.g. `node.add`). Operations
 * are defined once and then exposed two ways:
 *   - as native MCP tools (`godot_node_add`), and
 *   - through the router tools (`godot_call_read` / `godot_call_write`), which
 *     can reach every operation by name without each one costing context.
 * See src/mcp/server.ts for how the config picks between them.
 */

import type { z } from 'zod';
import type { EditorBridge } from '../bridge/editorBridge.js';
import type { Config } from '../config.js';
import type { HeadlessRunner } from '../godot/headless.js';
import type { RunManager } from '../godot/runs.js';

/**
 * Tool groups, selectable with GODOT_MCP_TOOLSETS. Step 1 shipped the first
 * seven; step 2 (full editor authoring) added the editor areas; step 3 (live
 * game and debugging) added game, debug and test.
 */
export const ALL_GROUPS = [
  'core',
  'files',
  'scene',
  'node',
  'script',
  'run',
  'editor',
  'signal', // signal connections in scenes
  'resource', // .tres/.res resources, dependencies, UIDs
  'visual', // visual shaders, Control layout, shader checks
  'anim', // AnimationPlayer / AnimationTree
  'world', // TileMapLayer, GridMap, TileSet, navigation
  'audio', // audio bus layout
  'project', // project settings, input map, autoloads, plugins, validation
  'import', // import options and reimport
  'export', // export presets and builds
  'code', // GDScript language server: diagnostics, symbols, lookups, rename
  'docs', // offline Godot class reference
  'game', // the running game: live tree, edits, input, timing, screenshots, performance
  'debug', // breakpoints, stepping, call stack and variables in a running game
  'test', // GUT / GdUnit4 test runs
] as const;

export type Group = (typeof ALL_GROUPS)[number];

/** Shared services an operation can use. */
export interface OpContext {
  config: Config;
  bridge: EditorBridge;
  headless: HeadlessRunner;
  runs: RunManager;
  /** Abort signal from the MCP request (client cancelled). */
  signal?: AbortSignal;
  /**
   * Report progress on a long operation (exports, reimports, docs index
   * builds). A no-op when the client didn't ask for progress. `total` may be
   * omitted when unknown.
   */
  progress?: (progress: number, total?: number, message?: string) => void;
}

/** What an operation returns: JSON for the model, plus optional images. */
export interface OpResult {
  data: unknown;
  /** Extra content blocks (e.g. screenshots) to attach after the JSON text. */
  images?: { data: string; mimeType: string }[];
}

export interface Operation<S extends z.ZodObject = z.ZodObject> {
  /** Dotted name, e.g. "node.add". The MCP tool name is derived from it. */
  name: string;
  group: Group;
  /** Short human title for UIs. */
  title: string;
  /**
   * One or two sentences. Start with the search words ("Godot scene: ...")
   * because client-side tool search matches on the start of descriptions.
   */
  description: string;
  input: S;
  /** True if the operation never changes anything (drives readOnlyHint and the read router). */
  readOnly: boolean;
  /** True if it can destroy work (delete, overwrite). Only meaningful when !readOnly. */
  destructive?: boolean;
  /** True if repeating the same call has no further effect. */
  idempotent?: boolean;
  /** Part of the compact core set that is always a native tool. */
  core?: boolean;
  /** Ask Claude Code to load this tool up front even when it defers MCP tools. */
  alwaysLoad?: boolean;
  /**
   * Ask the user before running this call. Return the question to show (e.g.
   * "Delete res://old.gd? This cannot be undone.") or undefined to skip.
   * When the client supports elicitation the server shows it as a yes/no
   * dialog and only runs the operation if the user agrees; otherwise the
   * client's own permission prompt (driven by destructiveHint) is the guard.
   * Reserve it for work that can't be undone. See src/mcp/confirm.ts.
   */
  confirm?: (args: z.infer<S>, ctx: OpContext) => string | undefined | Promise<string | undefined>;
  run(args: z.infer<S>, ctx: OpContext): Promise<OpResult>;
}

/** Helper that keeps the generic type of `input` flowing into `run`. */
export function defineOp<S extends z.ZodObject>(op: Operation<S>): Operation<S> {
  return op;
}

/** `node.add` -> `godot_node_add` */
export function toolName(op: Pick<Operation, 'name'>): string {
  return 'godot_' + op.name.replace(/\./g, '_');
}
