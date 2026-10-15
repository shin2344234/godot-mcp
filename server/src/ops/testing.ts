/**
 * Step 3: test runners and editor UI helpers.
 *
 * - test.run runs GUT or GdUnit4 tests as a separate headless Godot process
 *   (server/src/testing/: framework CLIs, JUnit parsing, progress/cancel).
 *   It works with or without the editor open and never installs anything.
 * - editor.ui drives small pieces of the live editor's UI (selection, opening a
 *   script at a line, save all, toasts) through the bridge; the Godot side is
 *   addons/godot_mcp/ops/editor_ui_ops.gd (editor-only).
 * See docs/methods/tests-editor-ui.md.
 */

import { z } from 'zod';
import { runTests } from '../testing/runner.js';
import { forwardOp } from './backend.js';
import { defineOp, type Operation } from './types.js';

export const testRun = defineOp({
  name: 'test.run',
  group: 'test',
  title: 'Run tests',
  description: 'Godot test: run GUT or GdUnit4 tests headlessly (all, a folder, a file or one test name); returns totals and failures with file:line.',
  input: z.object({
    path: z.string().optional().describe('Test folder or .gd file; default all tests.'),
    test: z.string().optional().describe('Test function name (or part of it).'),
    framework: z.enum(['auto', 'gut', 'gdunit4']).default('auto'),
    timeout_s: z.number().int().min(10).max(3600).default(600),
  }),
  // Runs project code and writes (temporary) reports, so it is not read-only.
  readOnly: false,
  run: (args, ctx) => runTests(args, ctx),
});

export const editorUi = defineOp({
  name: 'editor.ui',
  group: 'editor',
  title: 'Editor UI',
  description: 'Godot editor: get/set the selected nodes, open a script at a line, save all scenes and scripts, or show a toast.',
  input: z.object({
    action: z.enum(['get_selection', 'select', 'open_script', 'save_all', 'toast']),
    paths: z.array(z.string()).optional().describe('select: node paths ([] clears).'),
    scene: z.string().optional().describe('select/get_selection: scene to open first.'),
    script: z.string().optional().describe('open_script: res:// path.'),
    line: z.number().int().min(1).optional(),
    column: z.number().int().min(1).optional(),
    message: z.string().optional().describe('toast text.'),
    severity: z.enum(['info', 'warning', 'error']).optional(),
  }),
  readOnly: false,
  run: (args, ctx) => forwardOp(ctx, 'editor.ui', args, { editorOnly: true }),
});

/** Operations in this area, in the order they should appear in tools/list. */
export const operations: Operation[] = [testRun, editorUi] as Operation[];
