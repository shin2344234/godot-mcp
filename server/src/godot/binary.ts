/**
 * Finding the Godot executable.
 *
 * Godot ships as a single unzipped binary with a versioned file name
 * (e.g. `Godot_v4.7.2-stable_win64.exe`), and people put it in all sorts of
 * places, so we check, in order:
 *   1. the explicit path from --godot / GODOT_PATH / GODOT_BIN;
 *   2. common names on PATH (`godot`, `godot4`, `Godot`);
 *   3. any `Godot_v4*` executable in a PATH directory.
 */

import { execFile } from 'node:child_process';
import { access, readdir } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface GodotBinary {
  path: string;
  /** Full version string, e.g. "4.7.2.stable.official.ed1daf0bf". */
  version: string;
  /** Parsed major/minor for feature gating. */
  major: number;
  minor: number;
}

async function isExecutable(file: string): Promise<boolean> {
  try {
    await access(file, process.platform === 'win32' ? constants.F_OK : constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function candidatesFromPath(): Promise<string[]> {
  const dirs = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean);
  const exe = process.platform === 'win32' ? '.exe' : '';
  const names = ['godot', 'godot4', 'Godot', 'godot-4'].map((n) => n + exe);
  const found: string[] = [];
  for (const dir of dirs) {
    for (const name of names) found.push(path.join(dir, name));
    // Versioned downloads, newest-looking name first.
    try {
      const entries = (await readdir(dir)).filter((e) => /^Godot_v4.*(\.exe|x86_64|arm64|universal)?$/i.test(e) && !/console/i.test(e));
      entries.sort().reverse();
      for (const e of entries) found.push(path.join(dir, e));
    } catch {
      // Unreadable PATH entries are common (stale dirs); ignore them.
    }
  }
  return found;
}

/** Ask a binary for its version; returns undefined if it isn't a working Godot. */
export async function probeGodot(file: string): Promise<GodotBinary | undefined> {
  try {
    const { stdout } = await execFileAsync(file, ['--version', '--headless'], { timeout: 20_000, windowsHide: true });
    const version = stdout.trim().split(/\r?\n/).pop() ?? '';
    const m = /^(\d+)\.(\d+)/.exec(version);
    if (!m) return undefined;
    return { path: file, version, major: Number(m[1]), minor: Number(m[2]) };
  } catch {
    return undefined;
  }
}

let cached: Promise<GodotBinary | undefined> | undefined;

/**
 * Locate a working Godot 4 binary (cached for the process lifetime).
 * Returns undefined rather than throwing so callers can produce a tailored
 * "how to fix" message.
 */
export function findGodot(explicitPath?: string): Promise<GodotBinary | undefined> {
  cached ??= (async () => {
    const candidates = explicitPath ? [explicitPath] : await candidatesFromPath();
    for (const file of candidates) {
      if (!(await isExecutable(file))) continue;
      const bin = await probeGodot(file);
      if (bin && bin.major >= 4) return bin;
    }
    return undefined;
  })();
  return cached;
}

/** Standard message used whenever an operation needs Godot and none was found. */
export const GODOT_NOT_FOUND_HINT =
  'Godot 4 executable not found. Set GODOT_PATH to the full path of your Godot 4.x binary ' +
  '(e.g. C:\\Godot\\Godot_v4.7.2-stable_win64.exe) in the MCP server config, or put it on PATH as "godot".';
