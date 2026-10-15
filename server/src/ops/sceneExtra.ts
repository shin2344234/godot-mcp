/**
 * Scene and node extras: instancing, inherited scenes, find, reorder, groups,
 * closing tabs, and batched edits. The Godot side is
 * addons/godot_mcp/ops/scene_extra_ops.gd (batch.apply: core/scene_batch.gd).
 *
 * Like src/ops/scene.ts, scene-bound operations take an optional `scene`
 * (the edited scene when the editor is connected; required headless).
 */

import { z } from 'zod';
import { OpError } from '../errors.js';
import { forwardOp } from './backend.js';
import { defineOp, type Operation } from './types.js';

const scene = z.string().optional().describe('Scene file; defaults to the edited scene, required without the editor.');
const path = z.string().describe('Node path from the scene root ("." = root).');

export const nodeInstance = defineOp({
  name: 'node.instance',
  group: 'node',
  title: 'Instance scene',
  description: 'Godot node: instance a .tscn as a linked sub-scene under a parent, optionally with Editable Children. Undoable in the editor.',
  input: z.object({
    scene,
    instance: z.string().describe('e.g. "res://enemy.tscn"'),
    parent: z.string().default('.'),
    name: z.string().optional(),
    properties: z.record(z.string(), z.unknown()).optional(),
    index: z.number().int().optional(),
    editable_children: z.boolean().optional(),
  }),
  readOnly: false,
  destructive: false,
  run: (args, ctx) => forwardOp(ctx, 'node.instance', args, { needsScene: true }),
});

export const sceneInherit = defineOp({
  name: 'scene.inherit',
  group: 'scene',
  title: 'New inherited scene',
  description: 'Godot scene: create a new scene file that inherits a base scene (like "New Inherited Scene"); opens it in the editor.',
  input: z.object({
    path: z.string().describe('New .tscn path.'),
    base: z.string().describe('Base scene, e.g. "res://enemy.tscn".'),
    root_name: z.string().optional().describe('Defaults to the file name in PascalCase.'),
    open: z.boolean().default(true),
  }),
  readOnly: false,
  destructive: false,
  run: (args, ctx) => forwardOp(ctx, 'scene.inherit', args),
});

export const nodeFind = defineOp({
  name: 'node.find',
  group: 'node',
  title: 'Find nodes',
  description: 'Godot node: find nodes in a scene by name (glob/substring), type (incl. subclasses), group, script or property value.',
  input: z.object({
    scene,
    name: z.string().optional().describe('Substring or glob (*, ?).'),
    type: z.string().optional(),
    group: z.string().optional(),
    script: z.string().optional(),
    property: z.string().optional(),
    value: z.unknown().optional().describe('Required property value.'),
    root: z.string().optional().describe('Search under this node.'),
    limit: z.number().int().default(100),
  }),
  readOnly: true,
  idempotent: true,
  run: (args, ctx) => forwardOp(ctx, 'node.find', args, { needsScene: true }),
});

export const nodeMove = defineOp({
  name: 'node.move',
  group: 'node',
  title: 'Reorder node',
  description: 'Godot node: move a node to another position among its siblings (draw/process order). Undoable in the editor.',
  input: z.object({ scene, path, index: z.number().int().describe('New index; negative counts from the end (-1 = last).') }),
  readOnly: false,
  destructive: false,
  idempotent: true,
  run: (args, ctx) => forwardOp(ctx, 'node.move', args, { needsScene: true }),
});

export const nodeGroups = defineOp({
  name: 'node.groups',
  group: 'node',
  title: 'Edit node groups',
  description: 'Godot node: add or remove a node\'s groups (saved in the scene). Undoable in the editor.',
  input: z.object({ scene, path, add: z.array(z.string()).optional(), remove: z.array(z.string()).optional() }),
  readOnly: false,
  destructive: false,
  idempotent: true,
  async run(args, ctx) {
    if (!args.add?.length && !args.remove?.length) throw new OpError('BAD_PARAMS', 'Pass "add" and/or "remove" (arrays of group names).');
    return forwardOp(ctx, 'node.groups', args, { needsScene: true });
  },
});

export const sceneClose = defineOp({
  name: 'scene.close',
  group: 'scene',
  title: 'Close scene tab',
  description: 'Godot scene: close a scene tab in the editor. Refuses unsaved changes unless save or discard is true.',
  input: z.object({
    path: z.string().optional().describe('Open scene; defaults to the edited one.'),
    save: z.boolean().optional(),
    discard: z.boolean().optional().describe('Drop unsaved changes.'),
  }),
  readOnly: false,
  destructive: false,
  run: (args, ctx) => forwardOp(ctx, 'scene.close', args, { editorOnly: true }),
});

/**
 * Batch item: `method` is any scene-mutation method (node.add, node.set,
 * signal.connect, ... including other areas' scene mutations). The addon is
 * the authority on which methods qualify (it lists them on a bad name), so
 * the server only normalizes tool-style names ("godot_node_set" -> "node.set").
 */
export const batchApply = defineOp({
  name: 'batch.apply',
  group: 'scene',
  title: 'Batch scene edits',
  description:
    'Godot scene: apply up to 100 scene edits (node.add, node.set, signal.connect, ...) to one scene in order, all-or-nothing; one undo step in the editor.',
  input: z.object({
    scene,
    ops: z
      .array(z.object({ method: z.string().describe('e.g. "node.add"'), params: z.record(z.string(), z.unknown()) }))
      .min(1)
      .max(100)
      .describe('Later ops see earlier ones (add a node, then set it).'),
  }),
  readOnly: false,
  destructive: false,
  async run(args, ctx) {
    const ops = args.ops.map((op) => ({ ...op, method: normalizeMethod(op.method) }));
    const bad = ops.findIndex((op) => op.method === 'batch.apply');
    if (bad >= 0) throw new OpError('BAD_PARAMS', `ops[${bad}]: batches cannot be nested.`);
    return forwardOp(ctx, 'batch.apply', { ...args, ops }, { needsScene: true });
  },
});

/** Accept tool names too: "godot_node_set" -> "node.set". */
export function normalizeMethod(method: string): string {
  const m = method.trim();
  if (!m.startsWith('godot_')) return m;
  const rest = m.slice('godot_'.length);
  const i = rest.indexOf('_');
  return i < 0 ? rest : `${rest.slice(0, i)}.${rest.slice(i + 1)}`;
}

/** Operations in this area, in the order they should appear in tools/list. */
export const operations: Operation[] = [nodeInstance, nodeFind, nodeMove, nodeGroups, sceneInherit, sceneClose, batchApply] as Operation[];
