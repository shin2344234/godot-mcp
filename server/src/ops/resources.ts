/**
 * Resource operations: read, create and modify .tres/.res/.gdshader files,
 * and list dependencies / dependents (also uid:// <-> path).
 *
 * The work happens in addons/godot_mcp/ops/resource_ops.gd. In the editor
 * the cached resource instance is edited, so open scenes update at once and
 * resource.set is undoable; headless each call loads, edits and saves (UIDs
 * are preserved, see core/res_save.gd).
 */

import { z } from 'zod';
import { forwardOp } from './backend.js';
import { defineOp, type Operation } from './types.js';

const resPath = z.string().describe('res:// path or uid://.');
const values = z
  .record(z.string(), z.unknown())
  .describe('Values ("#ff0000", [x, y], "res://...", {"new": Class}). Keys may be nested ("next_pass:albedo_color") or Theme items ("Button/colors/font_color").');

export const resourceRead = defineOp({
  name: 'resource.read',
  group: 'resource',
  title: 'Read resource',
  description: 'Godot resource: read a .tres/.res/.gdshader (or uid://): class, uid, non-default properties, shader uniforms, theme items.',
  input: z.object({
    path: resPath,
    properties: z.array(z.string()).optional().describe('Only these (nested paths allowed).'),
    depth: z.number().int().min(0).max(4).optional().describe('Sub-resource expansion depth (default 1).'),
  }),
  readOnly: true,
  idempotent: true,
  run: (args, ctx) => forwardOp(ctx, 'resource.read', args),
});

export const resourceCreate = defineOp({
  name: 'resource.create',
  group: 'resource',
  title: 'Create resource',
  description: 'Godot resource: create a resource file of any Resource class (materials, Theme, Gradient, shapes...) or a .gdshader with code.',
  input: z.object({
    path: z.string().describe('e.g. "res://mats/red.tres" or "res://x.gdshader".'),
    type: z.string().optional().describe('Resource class, e.g. "StandardMaterial3D".'),
    properties: values.optional(),
    code: z.string().optional().describe('For .gdshader.'),
    overwrite: z.boolean().optional(),
  }),
  readOnly: false,
  destructive: false,
  run: (args, ctx) => forwardOp(ctx, 'resource.create', args),
});

export const resourceSet = defineOp({
  name: 'resource.set',
  group: 'resource',
  title: 'Set resource properties',
  description: 'Godot resource: set properties of an existing resource file and save it (undoable in the editor; open scenes update).',
  input: z.object({ path: resPath, properties: values }),
  readOnly: false,
  destructive: false,
  idempotent: true,
  run: (args, ctx) => forwardOp(ctx, 'resource.set', args),
});

export const resourceDeps = defineOp({
  name: 'resource.deps',
  group: 'resource',
  title: 'Resource dependencies',
  description: 'Godot resource: list a file\'s dependencies (missing ones flagged), optionally the files that use it; resolves uid:// paths.',
  input: z.object({
    path: resPath,
    dependents: z.boolean().optional().describe('Also scan the project for files referencing it.'),
    limit: z.number().int().min(1).max(1000).optional().describe('Max dependents (default 100).'),
  }),
  readOnly: true,
  idempotent: true,
  run: (args, ctx) => forwardOp(ctx, 'resource.deps', args),
});

/** Operations in this area, in the order they should appear in tools/list. */
export const operations: Operation[] = [resourceRead, resourceCreate, resourceSet, resourceDeps] as Operation[];
