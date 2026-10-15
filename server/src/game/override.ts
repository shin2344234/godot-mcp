/**
 * Getting the runtime autoload into a game the server launches, without
 * changing project.godot.
 *
 * Godot reads `res://override.cfg` at startup, after project.godot, and its
 * entries override project settings, autoloads included (verified with Godot
 * 4.7.2: an `[autoload]` entry in override.cfg is instantiated like one in
 * project.godot). Autoloads are only read at startup, so the file is needed
 * just for the moment the game boots:
 *
 *   1. before spawning: write override.cfg with our autoload (keeping the
 *      user's own override.cfg content, if any, and a backup of it);
 *   2. when the game says hello (or fails to start, or after a timeout):
 *      put the user's file back, or delete ours.
 *
 * A marker line identifies our version, so a file left behind by a crash is
 * restored the next time the server injects or starts (`cleanupStale`). The
 * runtime itself is inert without a debugger attached, so even a leftover
 * file can't do anything in a normal or exported run.
 *
 * The editor plugin does the same for games started from the editor
 * (addons/godot_mcp/plugin.gd); both use the same marker and backup path so
 * each can clean up after the other.
 */

import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { log } from '../log.js';

export const RUNTIME_AUTOLOAD_NAME = 'GodotMcpRuntime';
export const RUNTIME_SCRIPT = 'res://addons/godot_mcp/runtime/mcp_runtime.gd';
export const OVERRIDE_MARKER = '; godot_mcp: temporary runtime autoload (removed automatically)';

const overridePath = (projectPath: string) => path.join(projectPath, 'override.cfg');
const backupPath = (projectPath: string) => path.join(projectPath, '.godot', 'godot_mcp', 'override.cfg.user-backup');

/** True when the addon's runtime script exists in the project (it ships with the addon). */
export function runtimeInstalled(projectPath: string): boolean {
  return existsSync(path.join(projectPath, 'addons', 'godot_mcp', 'runtime', 'mcp_runtime.gd'));
}

/** Number of injections in flight in this process; the file is restored when it drops to 0. */
let active = 0;

/**
 * Write override.cfg with the runtime autoload. Returns a release function
 * (idempotent) that restores the original state.
 */
export async function injectRuntime(projectPath: string): Promise<() => Promise<void>> {
  if (active === 0) await cleanupStale(projectPath);
  active++;
  if (active === 1) {
    const file = overridePath(projectPath);
    let original = '';
    if (existsSync(file)) {
      original = await readFile(file, 'utf8');
      await mkdir(path.dirname(backupPath(projectPath)), { recursive: true });
      await writeFile(backupPath(projectPath), original, 'utf8');
    }
    // A repeated [autoload] section header is fine: Godot's config parser just
    // continues the section, so the user's own autoload overrides stay intact.
    const ours = `${OVERRIDE_MARKER}\n[autoload]\n\n${RUNTIME_AUTOLOAD_NAME}="${RUNTIME_SCRIPT}"\n`;
    await writeFile(file, original ? `${original.replace(/\s*$/, '\n')}\n${ours}` : ours, 'utf8');
  }
  let released = false;
  return async () => {
    if (released) return;
    released = true;
    active--;
    if (active === 0) await restore(projectPath);
  };
}

/** Put the user's override.cfg back (or delete ours). Safe to call when nothing was injected. */
async function restore(projectPath: string): Promise<void> {
  const file = overridePath(projectPath);
  const backup = backupPath(projectPath);
  try {
    if (existsSync(backup)) await rename(backup, file);
    else if (existsSync(file) && (await readFile(file, 'utf8')).includes(OVERRIDE_MARKER)) await rm(file, { force: true });
  } catch (err) {
    log.warn(`Could not restore ${file}: ${(err as Error).message}`);
  }
}

/** Restore a file left behind by a crashed run (ours carries the marker). */
export async function cleanupStale(projectPath: string): Promise<void> {
  if (active > 0) return;
  const file = overridePath(projectPath);
  if (existsSync(file) && (await readFile(file, 'utf8').catch(() => '')).includes(OVERRIDE_MARKER)) await restore(projectPath);
}
