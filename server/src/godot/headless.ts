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
import { ClassCacheWatcher } from '../project/classCache.js';
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

/**
 * Arguments for a one-shot `godot --headless --import` on the project. `--import` starts
 * an editor that loads enabled plugins; the user argument tells the godot_mcp plugin not
 * to open a bridge there (addons/godot_mcp/plugin.gd NO_BRIDGE_ARG), so the run never
 * passes for the user's editor in session.json while it lasts.
 */
export function importArgs(projectPath: string): string[] {
  return ['--headless', '--path', projectPath, '--import', '--', '--godot-mcp-no-bridge'];
}

/** Last N lines of Godot output, for including in error messages. */
function tail(text: string, lines = 15): string {
  return text.trim().split(/\r?\n/).slice(-lines).join('\n');
}

export class HeadlessRunner {
  private readonly classCache: ClassCacheWatcher;
  /**
   * Set by index.ts: asks a running private LSP editor to register changed class_name
   * scripts; resolves true if it did (then no `--import` may run next to it).
   */
  editorRefresh?: () => Promise<boolean>;

  constructor(
    private readonly projectPath: string,
    private readonly godotPath: string | undefined,
    private readonly timeoutMs: number,
  ) {
    this.classCache = new ClassCacheWatcher(projectPath);
  }

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
          'Install it with godot_addon_install (or run `npx -y @shin2344234/godot-mcp init` in the project folder).',
      );
    }

    // A never-opened project has no .godot/ cache: global classes (class_name)
    // aren't registered and resources aren't imported, so the runner would
    // misbehave. Import once first (the same thing opening the editor does).
    if (!existsSync(path.join(this.projectPath, '.godot'))) {
      log.info('Project has no .godot/ cache yet; running a one-time import');
      await runProcess(godot.path, importArgs(this.projectPath), { cwd: this.projectPath, timeoutMs: Math.max(this.timeoutMs, 300_000) });
    } else {
      // Same problem for a class_name script written since the cache was last saved
      // (e.g. by files.write): `--script` runs only read the cache, so the new class
      // would be unknown ("Unknown Resource class"). Only the editor's filesystem scan
      // registers it; `--import` runs that scan and rewrites the cache (verified with
      // Godot 4.7.2). See src/project/classCache.ts.
      const stale = await this.classCache.needsRefresh();
      if (stale.length) {
        const names = stale.map((s) => s.name).join(', ');
        if (this.editorRefresh && (await this.editorRefresh())) {
          // A private editor runs on this project: it registers the classes and saves the
          // cache itself (at the end of its scan, so give it a moment). Never --import
          // next to it; see LspManager.refreshScriptClasses.
          log.info(`Global class cache is missing ${names}; the private editor is refreshing it`);
          for (let i = 0; i < 30 && (await this.classCache.staleClasses()).length; i++) await new Promise((r) => setTimeout(r, 100));
        } else {
          log.info(`Global class cache is missing ${names}; refreshing it with --import`);
          await runProcess(godot.path, importArgs(this.projectPath), { cwd: this.projectPath, timeoutMs: Math.max(this.timeoutMs, 300_000) });
        }
      }
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
