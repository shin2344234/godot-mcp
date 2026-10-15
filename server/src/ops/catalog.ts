/**
 * The full list of operations, and the startup-time filter that decides
 * which of them this server instance offers.
 */

import type { Config } from '../config.js';
import * as core from './core.js';
import * as files from './files.js';
import * as run from './run.js';
import * as scene from './scene.js';
import type { Operation } from './types.js';

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
] as Operation[];

/** Operations enabled by config (toolsets + read-only). */
export function enabledOperations(config: Config): Operation[] {
  return ALL_OPERATIONS.filter((op) => {
    if (config.readOnly && !op.readOnly) return false;
    if (config.toolsets && !config.toolsets.has(op.group)) return false;
    return true;
  });
}
