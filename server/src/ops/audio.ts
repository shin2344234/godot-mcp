/**
 * Audio bus layout operations (the project's default_bus_layout.tres).
 *
 * The GDScript side (addons/godot_mcp/ops/audio_ops.gd) uses AudioServer as
 * the editing engine in both backends. In the editor the change is one undo
 * step that also refreshes the Audio panel and saves the layout file;
 * headless the layout file is written directly.
 */

import { z } from 'zod';
import { forwardOp } from './backend.js';
import { defineOp } from './types.js';

const bus = z.union([z.string(), z.number()]).optional().describe('Bus name or index.');

export const audioBuses = defineOp({
  name: 'audio.buses',
  group: 'audio',
  title: 'Read audio buses',
  description: 'Godot audio: list the audio buses (volume, mute, solo, send) and their effects from the project\'s bus layout.',
  input: z.object({}),
  readOnly: true,
  idempotent: true,
  run: (args, ctx) => forwardOp(ctx, 'audio.buses', args),
});

export const audioEdit = defineOp({
  name: 'audio.edit',
  group: 'audio',
  title: 'Edit audio buses',
  description: 'Godot audio: add, remove, rename, move and set buses (volume, mute, solo, send) and their effects; saves the bus layout.',
  input: z.object({
    ops: z
      .array(
        z.object({
          op: z.enum(['add_bus', 'remove_bus', 'rename_bus', 'move_bus', 'set', 'add_effect', 'remove_effect', 'set_effect']),
          bus,
          name: z.string().optional(),
          index: z.number().optional().describe('New position.'),
          volume_db: z.number().optional(),
          mute: z.boolean().optional(),
          solo: z.boolean().optional(),
          bypass_effects: z.boolean().optional(),
          send: z.string().optional(),
          type: z.string().optional().describe('add_effect: e.g. "AudioEffectReverb".'),
          effect: z.number().optional().describe('Effect index.'),
          properties: z.record(z.string(), z.unknown()).optional(),
          enabled: z.boolean().optional(),
        }),
      ),
  }),
  readOnly: false,
  destructive: false,
  run: (args, ctx) => forwardOp(ctx, 'audio.edit', args),
});

/** Operations in this area, in the order they should appear in tools/list. */
export const operations = [audioBuses, audioEdit];
