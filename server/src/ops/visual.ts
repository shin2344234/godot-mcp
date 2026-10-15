/**
 * Visual authoring: VisualShader graphs, Control layout presets and shader
 * compile checks. The Godot side is addons/godot_mcp/ops/visual_ops.gd.
 *
 * Shader graph edits are a list of ops applied in order (all-or-nothing) and
 * saved to the .tres; visual.layout is a scene mutation (one undo step in the
 * editor); visual.shader_check works headless too because Godot 4.7's dummy
 * renderer runs the real shader compiler.
 */

import { z } from 'zod';
import { forwardOp } from './backend.js';
import { defineOp, type Operation } from './types.js';

const shaderType = z.string().optional().describe('e.g. vertex, fragment, light, process.');

const graphOp = z.object({
  op: z.enum(['add_node', 'connect', 'disconnect', 'remove_node', 'set']),
  type: z.string().optional().describe('Node class, e.g. "ColorConstant".'),
  id: z.number().int().optional().describe('0 = Output; new ids >= 2.'),
  position: z.array(z.number()).optional(),
  properties: z.record(z.string(), z.unknown()).optional(),
  inputs: z.record(z.string(), z.unknown()).optional().describe('Port defaults {"1": 2.0}.'),
  from: z.number().int().optional(),
  from_port: z.number().int().optional(),
  to: z.number().int().optional(),
  to_port: z.union([z.number().int(), z.string()]).optional().describe('Or Output port name ("albedo").'),
  shader_type: z.string().optional(),
});

export const shaderGraph = defineOp({
  name: 'visual.shader_graph',
  group: 'visual',
  title: 'Edit visual shader',
  description: 'Godot visual: edit or create a VisualShader .tres with ordered node ops (add, connect, set...).',
  input: z.object({
    path: z.string(),
    create: z.boolean().optional(),
    mode: z.enum(['spatial', 'canvas_item', 'particles', 'sky', 'fog']).optional().describe('For create.'),
    shader_type: shaderType,
    ops: z.array(graphOp),
  }),
  readOnly: false,
  destructive: false,
  run: (args, ctx) => forwardOp(ctx, 'visual.shader_graph', args),
});

export const shaderGraphRead = defineOp({
  name: 'visual.shader_graph_read',
  group: 'visual',
  title: 'Read visual shader',
  description: 'Godot visual: list a VisualShader\'s nodes (id, class, properties) and connections per shader type.',
  input: z.object({ path: z.string(), shader_type: shaderType }),
  readOnly: true,
  idempotent: true,
  run: (args, ctx) => forwardOp(ctx, 'visual.shader_graph_read', args),
});

export const layout = defineOp({
  name: 'visual.layout',
  group: 'visual',
  title: 'Control layout',
  description: 'Godot visual: apply a Control layout preset, anchors/offsets, size flags or minimum size. Undoable.',
  input: z.object({
    scene: z.string().optional(),
    path: z.string().describe('Control node path.'),
    preset: z.string().optional().describe('e.g. full_rect, center, top_wide.'),
    resize_mode: z.enum(['minsize', 'keep_width', 'keep_height', 'keep_size']).optional(),
    margin: z.number().int().optional(),
    anchors: z.array(z.number()).optional().describe('[left, top, right, bottom]'),
    offsets: z.array(z.number()).optional().describe('[left, top, right, bottom]'),
    size_flags: z.record(z.string(), z.unknown()).optional().describe('{horizontal, vertical}: "fill", "expand_fill"...'),
    custom_minimum_size: z.array(z.number()).optional().describe('[w, h]'),
  }),
  readOnly: false,
  destructive: false,
  idempotent: true,
  run: (args, ctx) => forwardOp(ctx, 'visual.layout', args, { needsScene: true }),
});

export const shaderCheck = defineOp({
  name: 'visual.shader_check',
  group: 'visual',
  title: 'Check shader',
  description: 'Godot visual: compile shader code or a .gdshader/VisualShader file and report errors with line numbers.',
  input: z.object({
    path: z.string().optional(),
    code: z.string().optional().describe('Shader source (wins over path).'),
  }),
  readOnly: true,
  idempotent: true,
  run: (args, ctx) => forwardOp(ctx, 'visual.shader_check', args),
});

/** Operations in this area, in the order they should appear in tools/list. */
export const operations: Operation[] = [shaderGraph, shaderGraphRead, layout, shaderCheck] as Operation[];
