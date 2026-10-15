/**
 * Import settings: read and change an asset's .import options, then reimport.
 * The Godot side is addons/godot_mcp/ops/import_ops.gd.
 *
 * Reimporting needs Godot's EditorFileSystem. In the live editor the addon
 * calls reimport_files() itself. A headless `--script` run has no
 * EditorFileSystem and never imports, so for headless calls the addon only
 * rewrites the .import file and answers `reimport: "pending"`; we then run
 * `godot --headless --path <project> --import` (which imports everything
 * whose source or .import changed, then quits) and read the result back.
 */

import { z } from 'zod';
import { OpError } from '../errors.js';
import { findGodot, GODOT_NOT_FOUND_HINT } from '../godot/binary.js';
import { runProcess } from '../godot/headless.js';
import { forwardOp } from './backend.js';
import { defineOp, type OpContext, type Operation } from './types.js';

const asset = z.string().describe('Imported asset, e.g. "res://icon.svg".');

export const importGet = defineOp({
  name: 'import.get',
  group: 'import',
  title: 'Get import settings',
  description: 'Godot import: show an asset\'s importer, options, uid and whether its imported files exist.',
  input: z.object({ path: asset }),
  readOnly: true,
  idempotent: true,
  run: (args, ctx) => forwardOp(ctx, 'import.get', args),
});

export const importSet = defineOp({
  name: 'import.set',
  group: 'import',
  title: 'Change import settings',
  description: 'Godot import: change an asset\'s import options (or importer) and reimport it.',
  input: z.object({
    path: asset,
    options: z.record(z.string(), z.unknown()).optional().describe('Option keys from import.get, e.g. {"compress/mode": 2}.'),
    importer: z.string().optional().describe('Switch importer, e.g. "image", "keep".'),
  }),
  readOnly: false,
  destructive: false,
  idempotent: true,
  async run(args, ctx) {
    const res = await forwardOp(ctx, 'import.set', args);
    const data = res.data as Record<string, unknown>;
    if (data.reimport !== 'pending') return res;
    // Headless: the .import file is written; run Godot's importer, then read back.
    await reimportHeadless(ctx);
    const after = await forwardOp(ctx, 'import.get', { path: data.path });
    return { data: { ...data, ...(after.data as object), changed: data.changed, reimport: 'done' } };
  },
});

/** `godot --headless --import` on the project; throws with Godot's output on failure. */
async function reimportHeadless(ctx: OpContext): Promise<void> {
  const godot = await findGodot(ctx.config.godotPath);
  if (!godot) throw new OpError('GODOT_NOT_FOUND', GODOT_NOT_FOUND_HINT);
  ctx.progress?.(0, 1, 'Reimporting with godot --headless --import');
  const timeoutMs = Math.max(ctx.config.headlessTimeoutMs, 300_000);
  const run = await runProcess(godot.path, ['--headless', '--path', ctx.config.projectPath, '--import'], { cwd: ctx.config.projectPath, timeoutMs });
  ctx.progress?.(1, 1, 'Reimport finished');
  if (run.timedOut) {
    throw new OpError('TIMEOUT', `The .import file was updated, but "godot --headless --import" did not finish within ${timeoutMs} ms. Open the project in the editor to finish importing.`);
  }
  if (run.code !== 0) {
    const tail = (run.stdout + '\n' + run.stderr).trim().split(/\r?\n/).slice(-15).join('\n');
    throw new OpError('GODOT_ERROR', `The .import file was updated, but "godot --headless --import" exited with code ${run.code}. Last output:\n${tail}`);
  }
}

/** Operations in this area, in the order they should appear in tools/list. */
export const operations: Operation[] = [importGet, importSet] as Operation[];
