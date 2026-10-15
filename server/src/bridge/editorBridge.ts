/**
 * Client side of the editor bridge (see docs/bridge-protocol.md).
 *
 * The Godot editor plugin runs a WebSocket server on 127.0.0.1 and writes
 * `<project>/.godot/godot_mcp/session.json` with the port and a fresh random
 * token. We read that file, connect, authenticate with the token, and then
 * send JSON requests.
 *
 * Connection is LAZY: nothing happens until an operation needs the editor.
 * If the editor isn't running, operations fall back to headless Godot (when
 * the operation supports it) or return an actionable error. If the editor
 * restarts (new port/token), the next call notices the dead socket, re-reads
 * the session file, and reconnects.
 *
 * Uses Node 22's built-in global `WebSocket`, so no extra dependency.
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { OpError } from '../errors.js';
import { log } from '../log.js';

export const PROTOCOL_VERSION = 1;
const CLIENT_VERSION = '0.1.0';

export interface SessionFile {
  protocol: number;
  port: number;
  token: string;
  pid: number;
  godot_version: string;
  plugin_version: string;
  project_path: string;
  started_at?: string;
}

export interface Welcome {
  godot_version: string;
  plugin_version: string;
  project_path: string;
  project_name: string;
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

/** Is a process with this pid alive? Used to detect stale session files after a crash. */
function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means it exists but belongs to someone else -- still alive.
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export class EditorBridge {
  private ws: WebSocket | undefined;
  private welcome: Welcome | undefined;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  /** In-flight connect attempt, so concurrent callers share one handshake. */
  private connecting: Promise<boolean> | undefined;

  constructor(
    private readonly projectPath: string,
    private readonly timeoutMs: number,
  ) {}

  get sessionFilePath(): string {
    return path.join(this.projectPath, '.godot', 'godot_mcp', 'session.json');
  }

  /** Info from the last successful handshake, if connected. */
  get info(): Welcome | undefined {
    return this.isOpen() ? this.welcome : undefined;
  }

  isOpen(): boolean {
    return this.ws !== undefined && this.ws.readyState === WebSocket.OPEN && this.welcome !== undefined;
  }

  /** Read the plugin's session file, or undefined if the editor isn't running the plugin. */
  async readSession(): Promise<SessionFile | undefined> {
    try {
      const session = JSON.parse(await readFile(this.sessionFilePath, 'utf8')) as SessionFile;
      if (typeof session.port !== 'number' || typeof session.token !== 'string') return undefined;
      if (session.pid && !pidAlive(session.pid)) {
        log.debug(`session.json points at dead pid ${session.pid}; ignoring stale file`);
        return undefined;
      }
      return session;
    } catch {
      return undefined;
    }
  }

  /**
   * Make sure we're connected. Returns false (never throws) when the editor
   * is simply not available, so callers can choose a fallback.
   */
  async ensureConnected(): Promise<boolean> {
    if (this.isOpen()) return true;
    this.connecting ??= this.connect().finally(() => {
      this.connecting = undefined;
    });
    return this.connecting;
  }

  private async connect(): Promise<boolean> {
    const session = await this.readSession();
    if (!session) return false;
    if (session.protocol !== PROTOCOL_VERSION) {
      log.warn(`Editor plugin speaks bridge protocol ${session.protocol}, server expects ${PROTOCOL_VERSION}. Update the addon and the server together.`);
    }

    return new Promise<boolean>((resolve) => {
      let settled = false;
      const done = (ok: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(ok);
      };

      // Always 127.0.0.1: the plugin never listens anywhere else.
      const ws = new WebSocket(`ws://127.0.0.1:${session.port}`);
      const timer = setTimeout(() => {
        log.warn('Timed out connecting to the Godot editor bridge');
        ws.close();
        done(false);
      }, 5_000);

      ws.addEventListener('open', () => {
        ws.send(
          JSON.stringify({ type: 'hello', protocol: PROTOCOL_VERSION, token: session.token, client: 'godot-mcp-server', client_version: CLIENT_VERSION }),
        );
      });

      ws.addEventListener('message', (ev) => {
        let msg: Record<string, unknown>;
        try {
          msg = JSON.parse(String(ev.data)) as Record<string, unknown>;
        } catch {
          log.warn('Ignoring non-JSON frame from editor bridge');
          return;
        }
        if (msg.type === 'welcome') {
          this.ws = ws;
          this.welcome = msg as unknown as Welcome;
          log.info(`Connected to Godot editor ${this.welcome.godot_version} (plugin ${this.welcome.plugin_version})`);
          done(true);
          return;
        }
        if (msg.type === 'response') this.handleResponse(msg);
        // 'event' frames are reserved for later steps (runtime logs etc.).
      });

      ws.addEventListener('close', (ev) => {
        if (ev.code === 4001) log.warn('Editor bridge rejected our token (stale session.json?)');
        this.handleClose();
        done(false);
      });

      ws.addEventListener('error', () => {
        // 'close' always follows 'error'; cleanup happens there.
        done(false);
      });
    });
  }

  private handleResponse(msg: Record<string, unknown>): void {
    const id = msg.id as number;
    const pending = this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id);
    clearTimeout(pending.timer);
    if (msg.error) {
      const e = msg.error as { code?: string; message?: string; data?: unknown };
      pending.reject(new OpError((e.code as never) ?? 'GODOT_ERROR', e.message ?? 'Editor returned an error', e.data));
    } else {
      pending.resolve(msg.result);
    }
  }

  private handleClose(): void {
    this.ws = undefined;
    this.welcome = undefined;
    // Fail everything in flight; the editor went away mid-request.
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new OpError('EDITOR_NOT_CONNECTED', 'The Godot editor connection closed before it answered. Was the editor closed or the plugin disabled?'));
      this.pending.delete(id);
    }
  }

  /** Send a request; throws OpError on failure. Caller must ensureConnected() first. */
  async request<T = unknown>(method: string, params: Record<string, unknown> = {}, timeoutMs = this.timeoutMs): Promise<T> {
    if (!this.isOpen() && !(await this.ensureConnected())) {
      throw new OpError('EDITOR_NOT_CONNECTED', EDITOR_NOT_CONNECTED_HINT);
    }
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new OpError('TIMEOUT', `The Godot editor did not answer "${method}" within ${timeoutMs} ms. It may be busy (importing, a modal dialog open) or frozen.`));
      }, timeoutMs);
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      this.ws!.send(JSON.stringify({ type: 'request', id, method, params }));
    });
  }

  close(): void {
    this.ws?.close();
    this.handleClose();
  }
}

export const EDITOR_NOT_CONNECTED_HINT =
  'The Godot editor is not connected. Open this project in the Godot editor with the "Godot MCP" plugin enabled ' +
  '(Project > Project Settings > Plugins), or call godot_editor_launch to start it.';
