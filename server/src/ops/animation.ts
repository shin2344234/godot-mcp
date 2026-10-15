/**
 * Animation operations: AnimationPlayer libraries/tracks/keys and
 * AnimationTree graphs (state machines, blend spaces, blend trees).
 *
 * All the work happens in GDScript (addons/godot_mcp/ops/anim_ops.gd and
 * core/anim_tree_ops.gd). Edits are `ops` arrays applied in order and
 * committed as ONE undo step in the editor; headless they are saved into the
 * .tscn (animations are embedded sub-resources of the scene).
 *
 * Schemas stay flat (no unions at the root) and descriptions short: every
 * tool definition is re-sent to the model on each turn.
 */

import { z } from 'zod';
import { OpError } from '../errors.js';
import { forwardOp } from './backend.js';
import { defineOp } from './types.js';

const scene = z.string().optional().describe('Scene; required headless.');
const player = z.string().optional().describe('AnimationPlayer path; optional if the scene has one.');
const tree = z.string().optional().describe('AnimationTree path; optional if the scene has one.');
const allowMissing = z.boolean().optional().describe('Skip existence checks.');

export const animRead = defineOp({
  name: 'anim.read',
  group: 'anim',
  title: 'Read animations',
  description:
    'Godot animation: list an AnimationPlayer\'s libraries and animations, or with animation the tracks and keys of one. Pass library (a .tres) instead of a scene player to read an AnimationLibrary file.',
  input: z.object({
    scene,
    player,
    library: z.string().optional().describe('AnimationLibrary .tres instead of a player.'),
    animation: z.string().optional().describe('"name" or "library/name": include its tracks.'),
    max_keys: z.number().optional().describe('Keys per track (default 50).'),
  }),
  readOnly: true,
  idempotent: true,
  run: (args, ctx) => {
    if (args.library) {
      if (args.player) throw new OpError('BAD_PARAMS', 'Pass either "library" (an AnimationLibrary .tres) or "player" (an AnimationPlayer in a scene), not both.');
      const { scene: _scene, player: _player, ...rest } = args;
      return forwardOp(ctx, 'anim.read_library', rest);
    }
    return forwardOp(ctx, 'anim.read', args, { needsScene: true });
  },
});

const trackTypes = ['value', 'position_3d', 'rotation_3d', 'scale_3d', 'blend_shape', 'method', 'bezier', 'audio', 'animation'] as const;

export const animEdit = defineOp({
  name: 'anim.edit',
  group: 'anim',
  title: 'Edit animations',
  description:
    'Godot animation: create/remove/rename animations and add tracks and keys on an AnimationPlayer. ops run in order as one undo step; track paths are "Node:property" relative to the player\'s root_node.',
  input: z.object({
    scene,
    player,
    animation: z.string().optional().describe('Default animation for ops that omit it.'),
    allow_missing: allowMissing,
    ops: z
      .array(
        z.object({
          op: z.enum(['create', 'remove', 'rename', 'set', 'add_track', 'remove_track', 'insert_key', 'remove_key']),
          animation: z.string().optional().describe('"walk" or "library/walk".'),
          to: z.string().optional(),
          length: z.number().optional(),
          loop: z.enum(['none', 'linear', 'pingpong']).optional(),
          step: z.number().optional(),
          type: z.enum(trackTypes).optional().describe('Track type (default value).'),
          path: z.string().optional().describe('add_track: e.g. "Sprite2D:modulate".'),
          interpolation: z.enum(['nearest', 'linear', 'cubic', 'linear_angle', 'cubic_angle']).optional(),
          update_mode: z.enum(['continuous', 'discrete', 'capture']).optional(),
          track: z.union([z.number(), z.string()]).optional().describe('Track index or path.'),
          time: z.number().optional(),
          key: z.number().optional(),
          value: z
            .unknown()
            .optional()
            .describe('Typed like the property; method: {method,args}; rotation_3d: [x,y,z] deg.'),
          transition: z.number().optional().describe('Easing (1 = linear).'),
        }),
      ),
  }),
  readOnly: false,
  destructive: false,
  run: (args, ctx) => forwardOp(ctx, 'anim.edit', args, { needsScene: true }),
});

export const animTreeRead = defineOp({
  name: 'anim.tree_read',
  group: 'anim',
  title: 'Read AnimationTree',
  description: 'Godot animation: show an AnimationTree\'s graph (states, transitions, blend points, blend tree nodes) and its parameters.',
  input: z.object({
    scene,
    tree,
    parameters: z.boolean().optional(),
  }),
  readOnly: true,
  idempotent: true,
  run: (args, ctx) => forwardOp(ctx, 'anim.tree_read', args, { needsScene: true }),
});

export const animTree = defineOp({
  name: 'anim.tree',
  group: 'anim',
  title: 'Edit AnimationTree',
  description:
    'Godot animation: build an AnimationTree state machine, blend space or blend tree (states, transitions, start/end, blend points). ops run in order as one undo step.',
  input: z.object({
    scene,
    tree,
    nested: z.string().optional().describe('Edit a nested graph, e.g. "Locomotion".'),
    allow_missing: allowMissing,
    ops: z
      .array(
        z.object({
          op: z.enum([
            'set_root', 'add_state', 'remove_state', 'rename_state', 'add_transition', 'remove_transition',
            'set_start', 'set_end', 'add_blend_point', 'remove_blend_point', 'set',
          ]),
          type: z.string().optional().describe('state_machine, blend_space_1d|2d, blend_tree, or AnimationNode class.'),
          name: z.string().optional().describe('State, node or blend point name.'),
          to: z.string().optional(),
          from: z.string().optional(),
          animation: z.string().optional(),
          position: z.union([z.number(), z.array(z.number())]).optional().describe('Number (1D) or [x, y].'),
          index: z.number().optional().describe('Point index or input port.'),
          switch_mode: z.enum(['immediate', 'sync', 'at_end']).optional(),
          advance_mode: z.enum(['disabled', 'enabled', 'auto']).optional(),
          advance_condition: z.string().optional(),
          advance_expression: z.string().optional(),
          xfade_time: z.number().optional(),
          properties: z.record(z.string(), z.unknown()).optional(),
        }),
      ),
  }),
  readOnly: false,
  destructive: false,
  run: (args, ctx) => forwardOp(ctx, 'anim.tree', args, { needsScene: true }),
});

/** Operations in this area, in the order they should appear in tools/list. */
export const operations = [animRead, animEdit, animTreeRead, animTree];
