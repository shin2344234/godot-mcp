/**
 * Animation operations: AnimationPlayer libraries/tracks/keys, AnimationTree
 * graphs (state machines, blend spaces, blend trees) and SpriteFrames (the
 * flip-book animations of AnimatedSprite2D/3D).
 *
 * All the work happens in GDScript (addons/godot_mcp/ops/anim_ops.gd,
 * core/anim_tree_ops.gd and core/sprite_frames_ops.gd). Edits are `ops` arrays applied in order and
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

/**
 * SpriteFrames: one tool, three bridge methods. `path` (a .tres) goes to
 * anim.frames_file (a file resource, saved at once); otherwise the node's
 * SpriteFrames is read (no ops: anim.frames_read) or edited as one undoable
 * scene mutation (anim.frames), which creates the SpriteFrames if missing.
 * The schema stays flat: the ops share one object, as in anim.edit.
 */
export const animFrames = defineOp({
  name: 'anim.frames',
  group: 'anim',
  title: 'Edit SpriteFrames',
  description:
    'Godot animation: read or edit the SpriteFrames of an AnimatedSprite2D/3D (or a .tres): add/rename/remove animations, speed/loop, frames cut from a sprite sheet. No ops = summary.',
  input: z.object({
    scene,
    node: z.string().optional().describe('AnimatedSprite2D/3D; optional if the scene has one.'),
    path: z.string().optional().describe('SpriteFrames .tres instead of a node.'),
    ops: z
      .array(
        z.object({
          op: z.enum(['add', 'remove', 'rename', 'set', 'add_frames', 'clear']),
          animation: z.string(),
          to: z.string().optional(),
          speed: z.number().optional().describe('FPS.'),
          loop: z.boolean().optional(),
          texture: z.union([z.string(), z.array(z.string())]).optional().describe('Sheet to cut, or whole texture(s). add takes frames too.'),
          hframes: z.number().optional(),
          vframes: z.number().optional(),
          frame_size: z.array(z.number()).optional().describe('[w, h] instead of h/vframes.'),
          cells: z.array(z.unknown()).optional().describe('Row-major indices or [col, row].'),
          start: z.number().optional(),
          count: z.number().optional(),
          duration: z.number().optional().describe('Relative frame length (1).'),
        }),
      )
      .optional(),
  }),
  readOnly: false,
  destructive: false,
  run: (args, ctx) => {
    if (args.path) {
      if (args.node) throw new OpError('BAD_PARAMS', 'Pass either "path" (a SpriteFrames .tres) or "node" (an AnimatedSprite2D/3D in a scene), not both.');
      const { scene: _scene, node: _node, ...rest } = args;
      return forwardOp(ctx, 'anim.frames_file', rest);
    }
    const { path: _path, ops, ...rest } = args;
    if (!ops || ops.length === 0) return forwardOp(ctx, 'anim.frames_read', rest, { needsScene: true });
    return forwardOp(ctx, 'anim.frames', { ...rest, ops }, { needsScene: true });
  },
});

/** Operations in this area, in the order they should appear in tools/list. */
export const operations = [animRead, animEdit, animTreeRead, animTree, animFrames];
