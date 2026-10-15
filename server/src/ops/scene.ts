/**
 * Scene, node and script-attachment operations.
 *
 * These are thin wrappers: the real work happens in GDScript (the editor
 * plugin, or the headless runner), where Godot's own APIs guarantee scenes
 * are saved correctly. Hand-editing .tscn text is a known source of subtle
 * corruption in other Godot MCP servers, so we never do it.
 *
 * Every operation accepts an optional `scene`. With the editor connected it
 * defaults to the scene being edited; headless it is required (there's no
 * "current scene" without an editor).
 */

import { z } from 'zod';
import { OpError } from '../errors.js';
import { callGodot, requireSceneForHeadless } from './backend.js';
import { defineOp, type OpContext } from './types.js';

const scene = z.string().optional().describe('Scene file, e.g. "res://main.tscn". Defaults to the scene open in the editor; required when the editor is closed.');
const nodePath = (what = 'Node path relative to the scene root ("." is the root), e.g. "Player/Sprite2D".') => z.string().describe(what);

/**
 * Value accepted for a property. Godot types can be given as Godot literals
 * ("Vector2(10, 20)", "Color(1,0,0)"), arrays ([10, 20]), objects ({x, y}),
 * "#ff0000" for colors, "res://..." to load a resource, or
 * {"new": "RectangleShape2D", "properties": {...}} to create one.
 */
const properties = z
  .record(z.string(), z.unknown())
  .describe('Property values. Godot types accept literals ("Vector2(10, 20)"), arrays ([10, 20]), "#ff0000" colors, "res://" paths to load resources, or {"new": "CircleShape2D", "properties": {...}}.');

/** Shared helper: route through the backend and tag the result with where it ran. */
// Methods whose headless implementation needs an explicit scene file.
const NEEDS_SCENE = new Set(['scene.tree', 'node.get', 'node.add', 'node.set', 'node.remove', 'node.rename', 'node.reparent', 'node.duplicate', 'script.attach']);

async function forward(ctx: OpContext, method: string, args: Record<string, unknown>, editorOnly = false) {
  // Check before spawning Godot so the model gets the real problem, not a slow generic failure.
  if (!editorOnly && NEEDS_SCENE.has(method)) await requireSceneForHeadless(ctx, args.scene as string | undefined);
  const { result, backend } = await callGodot(ctx, method, args, { editorOnly });
  return { data: { ...(result as object), backend } };
}

export const sceneTree = defineOp({
  name: 'scene.tree',
  group: 'scene',
  title: 'Scene tree',
  description:
    'Godot scene: show the node tree (names, types, scripts, instanced sub-scenes) of a scene. Use depth/max_nodes to keep large scenes small; start from a subtree with root.',
  input: z.object({
    scene,
    root: z.string().optional().describe('Start from this node path instead of the scene root.'),
    depth: z.number().int().min(0).max(50).default(4),
    max_nodes: z.number().int().min(1).max(2000).default(300),
  }),
  readOnly: true,
  idempotent: true,
  core: true,
  alwaysLoad: true,
  run: (args, ctx) => forward(ctx, 'scene.tree', args),
});

export const sceneCreate = defineOp({
  name: 'scene.create',
  group: 'scene',
  title: 'Create scene',
  description: 'Godot scene: create a new .tscn file with a root node of the given type (e.g. Node2D, Node3D, Control, CharacterBody2D).',
  input: z.object({
    path: z.string().describe('New scene file, e.g. "res://levels/level_1.tscn".'),
    root_type: z.string().default('Node2D'),
    root_name: z.string().optional().describe('Defaults to the file name in PascalCase.'),
    open: z.boolean().default(true).describe('Open it in the editor afterwards (editor only).'),
  }),
  readOnly: false,
  destructive: false,
  run: (args, ctx) => forward(ctx, 'scene.create', args),
});

export const sceneOpen = defineOp({
  name: 'scene.open',
  group: 'scene',
  title: 'Open scene',
  description: 'Godot scene: open a scene in the editor so later node operations target it.',
  input: z.object({ path: z.string() }),
  readOnly: false,
  destructive: false,
  idempotent: true,
  run: (args, ctx) => forward(ctx, 'scene.open', args, true),
});

export const sceneSave = defineOp({
  name: 'scene.save',
  group: 'scene',
  title: 'Save scene',
  description: 'Godot scene: save the edited scene in the editor (headless edits are saved automatically).',
  input: z.object({ path: z.string().optional().describe('An open scene to save; defaults to the edited scene.') }),
  readOnly: false,
  destructive: false,
  idempotent: true,
  core: true,
  async run(args, ctx) {
    const { result, backend } = await callGodot(ctx, 'scene.save', args);
    return { data: { ...(result as object), backend } };
  },
});

export const sceneSaveAs = defineOp({
  name: 'scene.save_as',
  group: 'scene',
  title: 'Save scene as',
  description: 'Godot scene: save the edited scene under a new path (editor only).',
  input: z.object({ path: z.string() }),
  readOnly: false,
  destructive: false,
  run: (args, ctx) => forward(ctx, 'scene.save_as', args, true),
});

export const nodeGet = defineOp({
  name: 'node.get',
  group: 'node',
  title: 'Get node',
  description: 'Godot node: read a node\'s type, script, non-default property values and connected signals. Pass properties to read only some.',
  input: z.object({
    scene,
    path: nodePath(),
    properties: z.array(z.string()).optional().describe('Only these, e.g. ["position", "visible"]; ["*"] = all incl. defaults (default: non-default values only).'),
  }),
  readOnly: true,
  idempotent: true,
  core: true,
  run: (args, ctx) => forward(ctx, 'node.get', args),
});

export const nodeAdd = defineOp({
  name: 'node.add',
  group: 'node',
  title: 'Add node',
  description:
    'Godot node: add a node of a built-in type (e.g. Sprite2D, CollisionShape2D, Label) or an instance of a .tscn scene, with optional initial properties. Undoable in the editor.',
  input: z.object({
    scene,
    parent: nodePath('Parent node path; "." for the scene root.').default('.'),
    type: z.string().optional().describe('Node class, e.g. "Sprite2D". Give type or instance.'),
    instance: z.string().optional().describe('Scene to instance, e.g. "res://enemy.tscn".'),
    name: z.string().optional(),
    properties: properties.optional(),
    index: z.number().int().optional().describe('Child position; omit to append.'),
  }),
  readOnly: false,
  destructive: false,
  core: true,
  run: (args, ctx) => forward(ctx, 'node.add', args),
});

export const nodeSet = defineOp({
  name: 'node.set',
  group: 'node',
  title: 'Set node properties',
  description: 'Godot node: set one or more properties on a node (position, texture, shape, modulate, ...). Returns the values read back. Undoable in the editor.',
  input: z.object({ scene, path: nodePath(), properties }),
  readOnly: false,
  destructive: false,
  idempotent: true,
  core: true,
  run: (args, ctx) => forward(ctx, 'node.set', args),
});

export const nodeRemove = defineOp({
  name: 'node.remove',
  group: 'node',
  title: 'Remove node',
  description: 'Godot node: delete a node and its children from the scene. Undoable in the editor; permanent when headless.',
  input: z.object({ scene, path: nodePath() }),
  readOnly: false,
  destructive: true,
  run: (args, ctx) => forward(ctx, 'node.remove', args),
});

export const nodeRename = defineOp({
  name: 'node.rename',
  group: 'node',
  title: 'Rename node',
  description: 'Godot node: rename a node. Note: scripts or NodePaths that refer to the old name are not updated.',
  input: z.object({ scene, path: nodePath(), name: z.string() }),
  readOnly: false,
  destructive: false,
  run: (args, ctx) => forward(ctx, 'node.rename', args),
});

export const nodeReparent = defineOp({
  name: 'node.reparent',
  group: 'node',
  title: 'Move node',
  description: 'Godot node: move a node under a different parent (and/or to a child index), keeping its global transform by default.',
  input: z.object({
    scene,
    path: nodePath(),
    new_parent: nodePath('New parent path; "." for the root.'),
    index: z.number().int().optional(),
    keep_global_transform: z.boolean().default(true),
  }),
  readOnly: false,
  destructive: false,
  run: (args, ctx) => forward(ctx, 'node.reparent', args),
});

export const nodeDuplicate = defineOp({
  name: 'node.duplicate',
  group: 'node',
  title: 'Duplicate node',
  description: 'Godot node: duplicate a node (with children, script and properties) next to the original.',
  input: z.object({ scene, path: nodePath(), name: z.string().optional() }),
  readOnly: false,
  destructive: false,
  run: (args, ctx) => forward(ctx, 'node.duplicate', args),
});

export const scriptAttach = defineOp({
  name: 'script.attach',
  group: 'script',
  title: 'Attach script',
  description: 'Godot script: attach a .gd (or .cs) script to a node, or detach with script: null. Create the file first with godot_files_write.',
  input: z.object({ scene, path: nodePath(), script: z.string().nullable() }),
  readOnly: false,
  destructive: false,
  idempotent: true,
  run: (args, ctx) => forward(ctx, 'script.attach', args),
});

export const scriptValidate = defineOp({
  name: 'script.validate',
  group: 'script',
  title: 'Validate GDScript',
  description: 'Godot script: check GDScript for parse/type errors without running the game. Pass a file path, or source text to check before writing.',
  input: z.object({
    path: z.string().optional().describe('Script file, e.g. "res://player.gd".'),
    source: z.string().optional().describe('GDScript source to check instead of (or as if it were at) path.'),
  }),
  readOnly: true,
  idempotent: true,
  async run(args, ctx) {
    if (!args.path && args.source === undefined) throw new OpError('BAD_PARAMS', 'Pass "path" (a .gd file) or "source" (GDScript text).');
    const { result, backend } = await callGodot(ctx, 'script.validate', args);
    return { data: { ...(result as object), backend } };
  },
});
