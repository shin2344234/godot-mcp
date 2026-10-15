/**
 * Which GDScript language server the code.* tools talk to, and its lifecycle.
 *
 * The language server only exists inside a Godot editor process (there is no standalone
 * mode), so:
 *
 *   1. If the user's editor is connected through the bridge, we use ITS language server:
 *      port reported by the plugin (welcome payload `lsp_port`, from the
 *      `network/language_server/remote_port` editor setting), overridable with
 *      GODOT_MCP_LSP_PORT, default 6005. We never start a second editor on a project the
 *      user has open.
 *
 *   2. Otherwise we lazily start a PRIVATE headless editor on the first code.* call:
 *        godot --headless --editor --path P --lsp-port <free port>
 *              -- --godot-mcp-lsp-only --godot-mcp-lsp-port=<port>
 *      and poll TCP until the server listens (~5-7 s warm/cold; up to 60 s, more for a
 *      never-imported project). It is stopped after an idle timeout (default 10 min), on
 *      server exit, and when the user's editor connects; it is restarted if it dies.
 *
 *      The private editor loads the godot_mcp plugin too. The user argument
 *      `--godot-mcp-lsp-only` makes the plugin write `lsp_session.json` instead of
 *      `session.json`, so the main bridge never routes scene edits into this invisible
 *      editor. We still connect to its bridge (PrivateBridge below) for two reasons:
 *        - after files change on disk we call `filesystem.refresh` on it: a NEW class_name
 *          script is only registered by an EditorFileSystem update (verified: the LSP keeps
 *          reporting "not declared in the current scope" otherwise);
 *        - the plugin quits the editor when no bridge client has been connected for a
 *          while, so even a SIGKILLed MCP server leaves no orphaned Godot behind.
 *      Without the addon (or with the plugin disabled) the LSP still works; we then restart
 *      the private editor when a class_name script appears or changes instead.
 *
 * One manager per project path (module-level registry), because OpContext is shared
 * across MCP connections and has no slot of its own for this.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readdir, readFile, realpath, stat } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { EditorBridge, type SessionFile } from '../bridge/editorBridge.js';
import type { Config } from '../config.js';
import { OpError } from '../errors.js';
import { findGodot, GODOT_NOT_FOUND_HINT } from '../godot/binary.js';
import { log } from '../log.js';
import type { OpContext } from '../ops/types.js';
import { LspClient } from './client.js';
import { pathToFileUri } from './uri.js';

export type LspSource = 'editor' | 'private';

export interface LspSession {
  client: LspClient;
  source: LspSource;
  port: number;
  /** Absolute spellings of the project root, for mapping URIs back to res:// paths. */
  roots: string[];
}

const DEFAULT_EDITOR_LSP_PORT = 6005;
const START_TIMEOUT_MS = 60_000;
/** A never-imported project is imported by the editor on first start; allow for that. */
const COLD_START_TIMEOUT_MS = 180_000;
/** Don't rescan the project for changed scripts more often than this. */
const SYNC_THROTTLE_MS = 1_000;
const SKIP_DIRS = new Set(['.godot', '.git', 'node_modules', '.import', '.mono', '.vs', '.idea']);

/** Bridge to the private editor: reads lsp_session.json and only trusts our own child. */
class PrivateBridge extends EditorBridge {
  constructor(
    private readonly root: string,
    timeoutMs: number,
    private readonly expectedPid: number,
  ) {
    super(root, timeoutMs);
  }

  override get sessionFilePath(): string {
    return path.join(this.root, '.godot', 'godot_mcp', 'lsp_session.json');
  }

  override async readSession(): Promise<SessionFile | undefined> {
    const s = await super.readSession();
    // Another MCP server on the same project may run its own private editor and overwrite
    // the file; never talk to an editor we didn't start.
    return s && s.pid === this.expectedPid ? s : undefined;
  }
}

/** Ask the OS for a free loopback port (tiny race window, acceptable for a local tool). */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const port = (srv.address() as net.AddressInfo).port;
      srv.close(() => resolve(port));
    });
  });
}

/** True once something accepts TCP connections on 127.0.0.1:port. */
function canConnect(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.connect({ host: '127.0.0.1', port });
    const done = (ok: boolean) => {
      s.destroy();
      resolve(ok);
    };
    s.once('connect', () => done(true));
    s.once('error', () => done(false));
    s.setTimeout(1_000, () => done(false));
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Does `p` name the same folder as one of `roots` (case-insensitive on Windows/macOS)? */
function sameProject(roots: string[], p: string): boolean {
  const norm = (s: string) => {
    const n = path.resolve(s).replace(/[\\/]+$/, '');
    return process.platform === 'linux' ? n : n.toLowerCase();
  };
  return roots.some((r) => norm(r) === norm(p));
}

const managers = new Map<string, LspManager>();
let exitHookInstalled = false;

/** The manager for this server's project (created on first use). */
export function lspManagerFor(config: Config): LspManager {
  let m = managers.get(config.projectPath);
  if (!m) {
    m = new LspManager(config);
    managers.set(config.projectPath, m);
  }
  if (!exitHookInstalled) {
    exitHookInstalled = true;
    // 'exit' handlers must be synchronous: just SIGKILL any private editor. index.ts calls
    // process.exit() on SIGINT/SIGTERM/stdin end, which runs this.
    process.once('exit', () => {
      for (const mgr of managers.values()) mgr.killNow();
    });
  }
  return m;
}

export class LspManager {
  private session: LspSession | undefined;
  private starting: Promise<LspSession> | undefined;
  private child: ChildProcess | undefined;
  private childPort = 0;
  private childOutput: string[] = [];
  private privateBridge: PrivateBridge | undefined;
  private idleTimer: NodeJS.Timeout | undefined;
  /** .gd file -> "mtime:size" when the private editor last saw the project. */
  private stamps: Map<string, string> | undefined;
  private lastSync = 0;

  constructor(private readonly config: Config) {}

  /** PID of the private editor, if one is running (for status/tests). */
  get privatePid(): number | undefined {
    return this.child && this.child.exitCode === null && this.child.signalCode === null ? this.child.pid : undefined;
  }

  /**
   * Get a ready language server session, starting/reconnecting as needed.
   * Throws OpError with a how-to-fix message when none can be had.
   */
  async acquire(ctx: OpContext): Promise<LspSession> {
    if (await ctx.bridge.ensureConnected()) return this.acquireEditor(ctx);
    this.touch();
    const s = this.session;
    if (s && s.source === 'private' && !s.client.closed && this.privatePid) {
      await this.syncChangedFiles();
      // The sync may have restarted the editor (class_name change without a bridge).
      if (this.session === s && !s.client.closed) return s;
    }
    this.starting ??= this.startPrivate(ctx).finally(() => {
      this.starting = undefined;
    });
    return this.starting;
  }

  private async acquireEditor(ctx: OpContext): Promise<LspSession> {
    const info = (ctx.bridge.info ?? {}) as { lsp_port?: number; project_path?: string };
    const port = this.config.lspPort ?? (Number(info.lsp_port) || DEFAULT_EDITOR_LSP_PORT);
    const s = this.session;
    if (s && s.source === 'editor' && s.port === port && !s.client.closed) return s;
    this.dropSession();
    // The user's editor owns the project now; a private editor would only compete with it.
    this.stopPrivate('the Godot editor is connected');
    const roots = await this.roots(info.project_path);
    let client: LspClient;
    try {
      client = await LspClient.connect({ port, rootPath: info.project_path ?? roots[0]!, requestTimeoutMs: this.config.lspTimeoutMs, connectTimeoutMs: 3_000 });
    } catch (err) {
      throw new OpError(
        'GODOT_ERROR',
        `The Godot editor is connected, but its GDScript language server is not reachable on 127.0.0.1:${port} (${(err as Error).message}). ` +
          'Check Editor Settings > Network > Language Server > Remote Port (set GODOT_MCP_LSP_PORT if you changed it) and that no other program uses that port; restarting the editor usually fixes a port clash.',
      );
    }
    // Two editors can't share a port: the second one silently runs without a language
    // server, and 127.0.0.1:<port> answers for the FIRST editor's project. Godot tells us
    // (gdscript_client/changeWorkspace, pushed before the initialize response).
    if (client.workspaceMismatch && !sameProject(roots, client.workspaceMismatch)) {
      const other = client.workspaceMismatch;
      client.close();
      throw new OpError(
        'CONFLICT',
        `The GDScript language server on 127.0.0.1:${port} belongs to another Godot editor (project ${other}), probably because two editors are open and only the first one got the port. ` +
          'Close the other editor and restart this one, or give this editor another port (Editor Settings > Network > Language Server > Remote Port) and set GODOT_MCP_LSP_PORT to match.',
      );
    }
    this.session = { client, source: 'editor', port, roots };
    client.onDidClose(() => {
      if (this.session?.client === client) this.session = undefined;
    });
    return this.session;
  }

  private async roots(editorPath?: string): Promise<string[]> {
    const roots = [this.config.projectPath];
    const real = await realpath(this.config.projectPath).catch(() => undefined);
    if (real && real !== this.config.projectPath) roots.push(real);
    if (editorPath && !roots.includes(editorPath)) roots.push(editorPath);
    return roots;
  }

  private async startPrivate(ctx: OpContext): Promise<LspSession> {
    this.dropSession();
    const roots = await this.roots();
    const root = roots[roots.length - 1]!; // the realpath: what the editor will call res://

    // A live private editor whose connection dropped: just reconnect.
    if (this.privatePid && this.childPort) {
      const port = this.childPort;
      {
        try {
          const client = await LspClient.connect({ port, rootPath: root, requestTimeoutMs: this.config.lspTimeoutMs });
          return this.adopt(client, port, roots);
        } catch {
          this.stopPrivate('its language server stopped answering');
        }
      }
    }

    const godot = await findGodot(this.config.godotPath);
    if (!godot) throw new OpError('GODOT_NOT_FOUND', GODOT_NOT_FOUND_HINT);
    if (!existsSync(path.join(root, 'project.godot'))) {
      throw new OpError('NOT_FOUND', `No project.godot in ${root}; the language server needs a Godot project. Check the --project / GODOT_PROJECT_PATH setting.`);
    }
    const cold = !existsSync(path.join(root, '.godot'));
    const port = await freePort();
    const args = ['--headless', '--editor', '--path', root, '--lsp-port', String(port), '--', '--godot-mcp-lsp-only', `--godot-mcp-lsp-port=${port}`];
    log.info(`Starting a private headless Godot editor for the GDScript language server (port ${port})`);
    ctx.progress?.(0, undefined, 'Starting a headless Godot editor for the GDScript language server');
    const child = spawn(godot.path, args, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    this.child = child;
    this.childPort = port;
    this.childOutput = [];
    const keep = (d: Buffer) => {
      this.childOutput.push(...d.toString('utf8').split(/\r?\n/).filter(Boolean));
      if (this.childOutput.length > 40) this.childOutput.splice(0, this.childOutput.length - 40);
    };
    child.stdout?.on('data', keep);
    child.stderr?.on('data', keep);
    child.on('exit', (code, signal) => {
      log.info(`Private LSP editor exited (code ${code}, signal ${signal})`);
      if (this.child === child) {
        this.child = undefined;
        this.dropSession();
        this.privateBridge?.close();
        this.privateBridge = undefined;
      }
    });
    child.on('error', (err) => log.warn(`Private LSP editor failed: ${err.message}`));

    const deadline = Date.now() + (cold ? COLD_START_TIMEOUT_MS : START_TIMEOUT_MS);
    let ticks = 0;
    while (Date.now() < deadline) {
      if (child.exitCode !== null || child.signalCode !== null) break;
      if (ctx.signal?.aborted) {
        this.stopPrivate('the request was cancelled');
        throw new OpError('TIMEOUT', 'Cancelled while starting the GDScript language server.');
      }
      if (await canConnect(port)) {
        const client = await LspClient.connect({ port, rootPath: root, requestTimeoutMs: this.config.lspTimeoutMs });
        this.stamps = await this.scanScripts();
        this.connectPrivateBridge(root, child.pid!);
        ctx.progress?.(1, 1, 'GDScript language server ready');
        return this.adopt(client, port, roots);
      }
      ticks++;
      if (ticks % 4 === 0) ctx.progress?.(ticks, undefined, cold ? 'Importing the project and starting the language server' : 'Waiting for the language server');
      await sleep(500);
    }
    const tail = this.childOutput.slice(-15).join('\n');
    this.stopPrivate('it did not start in time');
    throw new OpError(
      'GODOT_ERROR',
      `The headless Godot editor did not start its GDScript language server${child.exitCode !== null ? ` (exited with code ${child.exitCode})` : ' in time'}. Last output:\n${tail}`,
    );
  }

  private adopt(client: LspClient, port: number, roots: string[]): LspSession {
    const session: LspSession = { client, source: 'private', port, roots };
    this.session = session;
    client.onDidClose(() => {
      if (this.session === session) this.session = undefined;
    });
    this.touch();
    return session;
  }

  /** Connect to the private editor's bridge in the background (optional, see header). */
  private connectPrivateBridge(root: string, pid: number): void {
    const bridge = new PrivateBridge(root, 15_000, pid);
    this.privateBridge = bridge;
    void (async () => {
      // The plugin writes lsp_session.json during editor startup; usually already there.
      for (let i = 0; i < 40 && this.privateBridge === bridge; i++) {
        if (await bridge.ensureConnected()) {
          log.debug('Connected to the private LSP editor bridge');
          return;
        }
        await sleep(500);
      }
      if (this.privateBridge === bridge) log.info('Private LSP editor has no godot_mcp bridge (addon missing or disabled); new class_name scripts will restart it.');
    })();
  }

  /** Reset the idle timer of the private editor. */
  private touch(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => this.stopPrivate('idle timeout'), this.config.lspIdleTimeoutMs);
    this.idleTimer.unref();
  }

  private dropSession(): void {
    const s = this.session;
    this.session = undefined;
    s?.client.close();
  }

  /** Stop the private editor (if any). Safe to call at any time. */
  stopPrivate(reason: string): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = undefined;
    const child = this.child;
    if (!child) return;
    log.info(`Stopping the private LSP editor: ${reason}`);
    if (this.session?.source === 'private') this.dropSession();
    this.privateBridge?.close();
    this.privateBridge = undefined;
    this.child = undefined;
    this.stamps = undefined;
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM');
      // Make sure it really goes away even if it ignores SIGTERM.
      setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      }, 5_000).unref();
    }
  }

  /** Synchronous kill for process exit. */
  killNow(): void {
    const child = this.child;
    if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    this.child = undefined;
  }

  /**
   * Tell the active language server that files changed on disk (after code.rename).
   * The user's editor is refreshed by the caller through the main bridge.
   */
  async filesChanged(session: LspSession, absPaths: string[]): Promise<void> {
    if (session.source !== 'private' || session.client.closed) return;
    await this.refreshPrivate(session, absPaths);
    // Our own writes are now known; don't report them again on the next sync.
    this.stamps = await this.scanScripts();
  }

  /**
   * Private editor only: find scripts changed on disk since it last looked (by other
   * tools or the user) and make it pick them up.
   */
  private async syncChangedFiles(): Promise<void> {
    const s = this.session;
    if (!s || s.source !== 'private' || !this.stamps) return;
    if (Date.now() - this.lastSync < SYNC_THROTTLE_MS) return;
    this.lastSync = Date.now();
    const now = await this.scanScripts();
    const changed: string[] = [];
    let addedOrRemoved = false;
    for (const [rel, stamp] of now) {
      const before = this.stamps.get(rel);
      if (before === stamp) continue;
      changed.push(rel);
      if (before === undefined) addedOrRemoved = true;
    }
    for (const rel of this.stamps.keys()) {
      if (!now.has(rel)) {
        changed.push(rel);
        addedOrRemoved = true;
      }
    }
    this.stamps = now;
    if (changed.length === 0) return;
    const root = s.roots[s.roots.length - 1]!;
    const abs = changed.map((rel) => path.join(root, rel));
    if (this.privateBridge?.isOpen()) {
      await this.refreshPrivate(s, abs, addedOrRemoved);
      return;
    }
    // No bridge: a new or changed class_name needs an editor restart to be registered.
    for (const file of abs) {
      const text = await readFile(file, 'utf8').catch(() => '');
      if (/^\s*class_name\s/m.test(text)) {
        log.info('A class_name script changed and the private editor has no bridge; restarting it');
        this.stopPrivate('class_name scripts changed');
        return;
      }
    }
    for (const file of abs) if (existsSync(file)) s.client.notify('textDocument/didSave', { textDocument: { uri: pathToFileUri(file) } });
  }

  /**
   * Make the private editor see changed files. `fullScan` is needed when files were added
   * or removed: EditorFileSystem.update_file() ignores files in folders it doesn't know
   * yet (verified: a new class_name script in a new folder stayed "not declared"), while
   * a full scan() registers them (and is quick on a headless editor; we give it a moment).
   */
  private async refreshPrivate(session: LspSession, absPaths: string[], fullScan = false): Promise<void> {
    const root = session.roots[session.roots.length - 1]!;
    const res = absPaths.map((a) => 'res://' + path.relative(root, a).split(path.sep).join('/'));
    if (this.privateBridge?.isOpen()) {
      try {
        // update_file() registers changed class_name scripts in the global class cache.
        await this.privateBridge.request('filesystem.refresh', fullScan ? {} : { paths: res }, 15_000);
        if (fullScan) await sleep(300);
      } catch (err) {
        log.warn(`filesystem.refresh on the private LSP editor failed: ${(err as Error).message}`);
      }
    }
    // didSave makes the editor reload the script resource from disk, so other scripts
    // that depend on it see its new members.
    for (const file of absPaths) if (existsSync(file)) session.client.notify('textDocument/didSave', { textDocument: { uri: pathToFileUri(file) } });
  }

  /** "rel path" -> "mtime:size" for every .gd file in the project. */
  private async scanScripts(): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    const root = (await this.roots()).at(-1)!;
    const walk = async (dir: string, rel: string): Promise<void> => {
      const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
      for (const e of entries) {
        if (SKIP_DIRS.has(e.name)) continue;
        const childRel = rel ? `${rel}/${e.name}` : e.name;
        const abs = path.join(dir, e.name);
        if (e.isDirectory()) await walk(abs, childRel);
        else if (e.name.endsWith('.gd')) {
          const st = await stat(abs).catch(() => undefined);
          if (st) out.set(childRel, `${st.mtimeMs}:${st.size}`);
        }
      }
    };
    await walk(root, '');
    return out;
  }
}
