/**
 * One-shot headless Godot invocations.
 *
 * When the editor isn't open we can still do most scene/node work by running
 * `godot --headless` with the addon's runner script (see section 2 of
 * docs/bridge-protocol.md). Each call is a fresh process: slower than the live
 * editor (~1-3 s), but it needs nothing running and works on CI-like setups.
 *
 * The runner prints exactly one line starting with RESULT_MARKER; everything
 * else Godot prints is noise we keep only for error messages.
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { OpError } from '../errors.js';
import { log } from '../log.js';
import { findGodot, GODOT_NOT_FOUND_HINT } from './binary.js';

export const RESULT_MARKER = '@@GODOT_MCP_RESULT@@';
export const RUNNER_RES_PATH = 'res://addons/godot_mcp/headless/runner.gd';

export interface ProcessResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

/** Run a process to completion, capturing output, with a hard timeout. */
export function runProcess(file: string, args: string[], opts: { cwd?: string; timeoutMs: number }): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { cwd: opts.cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    child.stdout.on('data', (d: Buffer) => (stdout += d.toString('utf8')));
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString('utf8')));
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, opts.timeoutMs);
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut });
    });
  });
}

/** Last N lines of Godot output, for including in error messages. */
function tail(text: string, lines = 15): string {
  return text.trim().split(/\r?\n/).slice(-lines).join('\n');
}

export class HeadlessRunner {
  constructor(
    private readonly projectPath: string,
    private readonly godotPath: string | undefined,
    private readonly timeoutMs: number,
  ) {}

  /** Is the addon (and therefore the runner script) installed in this project? */
  addonInstalled(): boolean {
    return existsSync(path.join(this.projectPath, 'addons', 'godot_mcp', 'headless', 'runner.gd'));
  }

  /** Call a bridge-protocol method through a headless Godot process. */
  async call<T = unknown>(method: string, params: Record<string, unknown>): Promise<T> {
    const godot = await findGodot(this.godotPath);
    if (!godot) throw new OpError('GODOT_NOT_FOUND', GODOT_NOT_FOUND_HINT);
    if (!this.addonInstalled()) {
      throw new OpError(
        'ADDON_MISSING',
        'The godot_mcp addon is not installed in this project (expected addons/godot_mcp/). ' +
          'Copy the addons/godot_mcp folder from the godot-mcp repository into the project, or open the project in the editor with the plugin enabled.',
      );
    }

    // Params go through a temp file rather than argv: avoids quoting problems
    // (Windows shells in particular) and command-line length limits.
    const dir = await mkdtemp(path.join(os.tmpdir(), 'godot-mcp-'));
    const reqFile = path.join(dir, 'request.json');
    try {
      await writeFile(reqFile, JSON.stringify({ method, params }), 'utf8');
      const args = ['--headless', '--path', this.projectPath, '--script', RUNNER_RES_PATH, '--', reqFile];
      log.debug(`headless: ${godot.path} ${args.join(' ')}`);
      const res = await runProcess(godot.path, args, { cwd: this.projectPath, timeoutMs: this.timeoutMs });

      if (res.timedOut) {
        throw new OpError('TIMEOUT', `Headless Godot did not finish "${method}" within ${this.timeoutMs} ms.\n${tail(res.stdout + res.stderr)}`);
      }

      const line = res.stdout
        .split(/\r?\n/)
        .reverse()
        .find((l) => l.startsWith(RESULT_MARKER));
      if (!line) {
        throw new OpError(
          'GODOT_ERROR',
          `Headless Godot exited (code ${res.code}) without a result for "${method}". Last output:\n${tail(res.stdout + '\n' + res.stderr)}`,
        );
      }
      const payload = JSON.parse(line.slice(RESULT_MARKER.length)) as { result?: T; error?: { code: string; message: string; data?: unknown } };
      if (payload.error) throw new OpError(payload.error.code as never, payload.error.message, payload.error.data);
      return payload.result as T;
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
}
