/**
 * Signal connections saved in scenes (the editor's Node > Signals dock).
 * The Godot side is addons/godot_mcp/ops/signal_ops.gd; only persistent
 * (scene-saved) connections are listed or changed, never ones made in code.
 */

import { z } from 'zod';
import { forwardOp } from './backend.js';
import { defineOp, type Operation } from './types.js';

const scene = z.string().optional().describe('Scene file; defaults to the edited scene, required without the editor.');

export const signalList = defineOp({
  name: 'signal.list',
  group: 'signal',
  title: 'List signal connections',
  description:
    'Godot signal: list saved signal connections of a node or scene and flag problems (missing/mismatched handlers, unconnected _on_* methods).',
  input: z.object({
    scene,
    path: z.string().optional().describe('Default: root.'),
    recursive: z.boolean().default(true),
    include_available: z.boolean().default(false).describe('Also list all signals.'),
  }),
  readOnly: true,
  idempotent: true,
  run: (args, ctx) => forwardOp(ctx, 'signal.list', args, { needsScene: true }),
});

export const signalConnect = defineOp({
  name: 'signal.connect',
  group: 'signal',
  title: 'Connect signal',
  description: 'Godot signal: connect a node\'s signal to a method (saved in the scene), optionally creating the handler stub in the target\'s script.',
  input: z.object({
    scene,
    from: z.string().describe('Emitting node.'),
    signal: z.string(),
    to: z.string().default('.'),
    method: z.string().optional().describe('Default _on_<from>_<signal>.'),
    create_method: z.boolean().optional().describe('Add a stub to the target .gd if missing.'),
    binds: z.array(z.unknown()).optional().describe('Extra call args.'),
    unbinds: z.number().int().optional().describe('Drop N trailing signal args.'),
    flags: z.array(z.enum(['deferred', 'one_shot'])).optional(),
  }),
  readOnly: false,
  destructive: false,
  run: (args, ctx) => forwardOp(ctx, 'signal.connect', args, { needsScene: true }),
});

export const signalDisconnect = defineOp({
  name: 'signal.disconnect',
  group: 'signal',
  title: 'Disconnect signal',
  description: 'Godot signal: remove a saved signal connection from a scene. Undoable in the editor.',
  input: z.object({ scene, from: z.string(), signal: z.string(), to: z.string().default('.'), method: z.string() }),
  readOnly: false,
  destructive: false,
  run: (args, ctx) => forwardOp(ctx, 'signal.disconnect', args, { needsScene: true }),
});

/** Operations in this area, in the order they should appear in tools/list. */
export const operations: Operation[] = [signalList, signalConnect, signalDisconnect] as Operation[];
