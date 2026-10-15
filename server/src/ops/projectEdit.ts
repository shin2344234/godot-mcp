/**
 * Project configuration: settings, input map, autoloads, editor plugins and a
 * project-wide health check. The Godot side is addons/godot_mcp/ops/project_ops.gd
 * (+ core/project_input.gd, core/project_validate.gd).
 *
 * All writes go through Godot's ProjectSettings API, never through text edits
 * of project.godot from here: with the editor open, the editor owns the file
 * (it keeps every setting in memory and would overwrite an on-disk edit), and
 * the change becomes one undoable action; headless, ProjectSettings.save()
 * writes exactly what the editor would. The read side (godot_project_info /
 * godot_project_settings in core.ts) reads project.godot directly.
 */

import { z } from 'zod';
import { forwardOp } from './backend.js';
import { defineOp, type Operation } from './types.js';

export const projectSet = defineOp({
  name: 'project.set',
  group: 'project',
  title: 'Set project settings',
  description: 'Godot project: change project settings (project.godot); null resets one to its default. Values are converted to each setting\'s type.',
  input: z.object({
    settings: z
      .record(z.string(), z.unknown())
      .describe('Setting -> value, e.g. {"display/window/size/viewport_width": 1280, "application/run/main_scene": "res://main.tscn"}.'),
    create: z.boolean().optional().describe('Allow adding settings that do not exist yet (custom settings).'),
  }),
  readOnly: false,
  idempotent: true,
  run: (args, ctx) => forwardOp(ctx, 'project.set', args),
});

/**
 * One input binding: a key name, or a flat object validated on the Godot side
 * (core/project_input.gd), which answers with the valid names on a mistake.
 * Kept loose here because a fully spelled-out schema doubled this tool's size.
 */
const inputEvent = z
  .union([z.string(), z.record(z.string(), z.unknown())])
  .describe('Key name ("Space", "Ctrl+S") or {type: key|mouse_button|joy_button|joy_axis, key, button ("left", "a"), axis ("left_x"), value (-1/1), physical, ctrl, shift, alt, meta, device}.');

export const inputEdit = defineOp({
  name: 'input.edit',
  group: 'project',
  title: 'Edit input map',
  description: 'Godot project: edit the input map (actions and their key/mouse/gamepad bindings), applied in order and saved to project.godot.',
  input: z.object({
    ops: z
      .array(
        z.object({
          op: z.enum(['add_action', 'remove_action', 'add_event', 'remove_event', 'clear_events', 'set_deadzone']),
          action: z.string(),
          event: inputEvent.optional(),
          index: z.number().int().min(0).optional().describe('remove_event: index of the binding.'),
          deadzone: z.number().min(0).max(1).optional(),
        }),
      )
      .min(1),
  }),
  readOnly: false,
  run: (args, ctx) => forwardOp(ctx, 'input.edit', args),
});

export const autoloadEdit = defineOp({
  name: 'autoload.edit',
  group: 'project',
  title: 'Edit autoloads',
  description: 'Godot project: add, remove or reorder autoloads (global singletons loaded at startup).',
  input: z.object({
    op: z.enum(['add', 'remove', 'move']),
    name: z.string().describe('Autoload name, e.g. "GameState".'),
    path: z.string().optional().describe('add: script or scene, e.g. "res://game_state.gd".'),
    singleton: z.boolean().optional().describe('Register as a global name (default true).'),
    index: z.number().int().min(0).optional().describe('Load position (0 = first); required for move.'),
  }),
  readOnly: false,
  run: (args, ctx) => forwardOp(ctx, 'autoload.edit', args),
});

export const projectPlugins = defineOp({
  name: 'project.plugins',
  group: 'project',
  title: 'Editor plugins',
  description: 'Godot project: enable or disable editor plugins (addons) and list the available ones.',
  input: z.object({
    enable: z.array(z.string()).optional().describe('Plugin folder names under addons/ or plugin.cfg paths.'),
    disable: z.array(z.string()).optional(),
    force: z.boolean().optional().describe('Allow disabling godot_mcp itself.'),
  }),
  readOnly: false,
  idempotent: true,
  run: (args, ctx) => forwardOp(ctx, 'project.plugins', args),
});

export const projectValidate = defineOp({
  name: 'project.validate',
  group: 'project',
  title: 'Validate project',
  description:
    'Godot project: health check for missing dependencies, stale or duplicate UIDs, script compile errors, broken autoloads, main scene and plugins.',
  input: z.object({
    scope: z.enum(['all', 'project', 'scenes', 'resources', 'scripts', 'uids']).optional(),
    path_prefix: z.string().optional().describe('Only check files under this folder, e.g. "res://levels".'),
    deep: z.boolean().optional().describe('Also load each scene/resource to catch load errors (slower).'),
    limit: z.number().int().min(1).max(1000).optional().describe('Max issues returned (default 200).'),
    offset: z.number().int().min(0).optional(),
  }),
  readOnly: true,
  idempotent: true,
  run: (args, ctx) => forwardOp(ctx, 'project.validate', args),
});

/** Operations in this area, in the order they should appear in tools/list. */
export const operations: Operation[] = [projectSet, inputEdit, autoloadEdit, projectPlugins, projectValidate] as Operation[];
