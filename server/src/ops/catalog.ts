/**
 * The full list of operations, and the startup-time filter that decides
 * which of them this server instance offers.
 */

import type { Config } from '../config.js';
import * as animation from './animation.js';
import * as audio from './audio.js';
import * as code from './code.js';
import * as core from './core.js';
import * as docs from './docs.js';
import * as exportsOps from './exports.js';
import * as files from './files.js';
import * as imports from './imports.js';
import * as projectEdit from './projectEdit.js';
import * as resources from './resources.js';
import * as run from './run.js';
import * as scene from './scene.js';
import * as sceneExtra from './sceneExtra.js';
import * as signals from './signals.js';
import type { Operation } from './types.js';
import * as visual from './visual.js';
import * as world from './world.js';

/** Every operation, in a fixed order (the spec asks for a deterministic tools/list). */
export const ALL_OPERATIONS: readonly Operation[] = [
  core.status,
  core.projectInfo,
  core.projectSettings,
  files.filesList,
  files.filesRead,
  files.filesSearch,
  files.filesWrite,
  files.filesEdit,
  files.filesMove,
  files.filesDelete,
  scene.sceneTree,
  scene.sceneCreate,
  scene.sceneOpen,
  scene.sceneSave,
  scene.sceneSaveAs,
  scene.nodeGet,
  scene.nodeAdd,
  scene.nodeSet,
  scene.nodeRemove,
  scene.nodeRename,
  scene.nodeReparent,
  scene.nodeDuplicate,
  scene.scriptAttach,
  scene.scriptValidate,
  run.runStart,
  run.runStop,
  run.runOutput,
  run.editorLogs,
  run.editorLaunch,
  // Step 2: full editor authoring. Each area module owns its own order.
  ...sceneExtra.operations,
  ...signals.operations,
  ...resources.operations,
  ...visual.operations,
  ...animation.operations,
  ...world.operations,
  ...audio.operations,
  ...projectEdit.operations,
  ...imports.operations,
  ...exportsOps.operations,
  ...code.operations,
  ...docs.operations,
] as Operation[];

/** Operations enabled by config (toolsets + read-only). */
export function enabledOperations(config: Config): Operation[] {
  return ALL_OPERATIONS.filter((op) => {
    if (config.readOnly && !op.readOnly) return false;
    if (config.toolsets && !config.toolsets.has(op.group)) return false;
    return true;
  });
}
