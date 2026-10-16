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
 *
 * A freshly written asset has no .import file yet. Instead of asking the user
 * to run a shell command, both tools import it first (see withFirstImport):
 * headless with the same `--import` run, or through the live editor with a
 * filesystem scan (EditorFileSystem imports new files once a scan finds them).
 */

import { z } from 'zod';
import { OpError } from '../errors.js';
import { findGodot, GODOT_NOT_FOUND_HINT } from '../godot/binary.js';
import { importArgs, runProcess } from '../godot/headless.js';
import { forwardOp } from './backend.js';
import { defineOp, type OpContext, type Operation } from './types.js';

const asset = z.string().describe('Imported asset, e.g. "res://icon.svg".');

export const importGet = defineOp({
  name: 'import.get',
  group: 'import',
  title: 'Get import settings',
  description: 'Godot import: show an asset\'s importer, non-default options (full: all), uid and whether its imported files exist (imports new assets first).',
  input: z.object({ path: asset, full: z.boolean().optional() }),
  readOnly: true,
  idempotent: true,
  run: (args, ctx) => withFirstImport(ctx, () => forwardOp(ctx, 'import.get', args)),
});

export const importSet = defineOp({
  name: 'import.set',
  group: 'import',
  title: 'Change import settings',
  description: 'Godot import: change an asset\'s import options (or importer) and reimport it.',
  input: z.object({
    path: asset,
    options: z.record(z.string(), z.unknown()).optional().describe('Option keys from import.get (full), e.g. {"compress/mode": 2}.'),
    importer: z.string().optional().describe('Switch importer, e.g. "image", "keep".'),
  }),
  readOnly: false,
  destructive: false,
  idempotent: true,
  async run(args, ctx) {
    const res = await withFirstImport(ctx, () => forwardOp(ctx, 'import.set', args));
    const data = res.data as Record<string, unknown>;
    if (data.reimport !== 'pending') return res;
    // Headless: the .import file is written; run Godot's importer, then read back.
    await reimportHeadless(ctx);
    const after = (await forwardOp(ctx, 'import.get', { path: data.path })).data as Record<string, unknown>;
    // Like the editor path (import_ops.gd _import_state): whether the reimport worked, not
    // the whole option list again (MCP_TEST_LOG Phase A: ~600 tokens per call for 1-2 changes).
    const state = { importer: after.importer, imported: after.imported, ...(after.import_failed ? { import_failed: true } : {}) };
    return { data: { ...data, ...state, reimport: 'done' } };
  },
});

/** How long to wait for the live editor to import a new file after a scan. */
const EDITOR_IMPORT_WAIT_MS = 30_000;

/** Is this the addon's "asset exists but was never imported" error (import_ops.gd _load_import)? */
export function needsImport(err: unknown): boolean {
  return err instanceof OpError && err.code === 'NOT_FOUND' && (err.data as { needs_import?: unknown } | undefined)?.needs_import === true;
}

/**
 * Run `call`; if it fails because the asset has no .import file yet, import
 * the project's new files and run it once more.
 * - Live editor: a full filesystem scan (filesystem.refresh without paths).
 *   EditorFileSystem::scan() is asynchronous and imports new files when the
 *   scan ends (editor/file_system/editor_file_system.cpp, Godot 4.7.2), so we
 *   poll the call until the .import file shows up.
 * - Headless: `godot --headless --import`, the same import the editor does on
 *   startup (it scans res://, imports new or changed assets and quits).
 * If the asset still isn't imported afterwards (e.g. Godot has no importer
 * for its extension), the second error goes back to the caller unchanged.
 */
export async function withFirstImport<T>(ctx: OpContext, call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (err) {
    if (!needsImport(err)) throw err;
  }
  if (ctx.bridge.isOpen()) {
    ctx.progress?.(0, 1, 'Asking the editor to scan and import the new file');
    await ctx.bridge.request('filesystem.refresh', {});
    const deadline = Date.now() + EDITOR_IMPORT_WAIT_MS;
    for (;;) {
      await new Promise((r) => setTimeout(r, 500));
      try {
        return await call();
      } catch (err) {
        if (!needsImport(err) || Date.now() > deadline) throw err;
      }
    }
  }
  await reimportHeadless(ctx, 'first');
  return call();
}

/** `godot --headless --import` on the project; throws with Godot's output on failure. */
async function reimportHeadless(ctx: OpContext, kind: 'first' | 'reimport' = 'reimport'): Promise<void> {
  const godot = await findGodot(ctx.config.godotPath);
  if (!godot) throw new OpError('GODOT_NOT_FOUND', GODOT_NOT_FOUND_HINT);
  ctx.progress?.(0, 1, 'Importing with godot --headless --import');
  const timeoutMs = Math.max(ctx.config.headlessTimeoutMs, 300_000);
  const run = await runProcess(godot.path, importArgs(ctx.config.projectPath), { cwd: ctx.config.projectPath, timeoutMs });
  ctx.progress?.(1, 1, 'Import finished');
  const what = kind === 'first' ? 'The asset had no .import file yet, and' : 'The .import file was updated, but';
  if (run.timedOut) {
    throw new OpError('TIMEOUT', `${what} "godot --headless --import" did not finish within ${timeoutMs} ms. Open the project in the editor to finish importing.`);
  }
  if (run.code !== 0) {
    const tail = (run.stdout + '\n' + run.stderr).trim().split(/\r?\n/).slice(-15).join('\n');
    throw new OpError('GODOT_ERROR', `${what} "godot --headless --import" exited with code ${run.code}. Last output:\n${tail}`);
  }
}

/** Operations in this area, in the order they should appear in tools/list. */
export const operations: Operation[] = [importGet, importSet] as Operation[];
