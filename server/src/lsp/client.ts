/**
 * Minimal JSON-RPC/LSP client for Godot's GDScript language server.
 *
 * Why not vscode-jsonrpc / vscode-languageclient: Godot's server breaks on the extra
 * Content-Type header those libraries write (see framing.ts), it implements only part of
 * LSP, and we need a few Godot-specific messages. A small purpose-built client is simpler
 * and adds no dependency.
 *
 * Facts this client relies on (verified against Godot 4.7.2, see the research notes):
 *   - Transport is plain TCP to 127.0.0.1:<port> (we never connect anywhere else).
 *   - `initialize` needs `rootUri` AND `rootPath` equal to the project the editor has open,
 *     otherwise the server pushes `gdscript_client/changeWorkspace` / a showMessage warning.
 *   - There is no `shutdown`/`exit` (they return -32601); a session ends by closing the
 *     socket.
 *   - After `initialized` the server pushes `gdscript/capabilities` (the native class list).
 *   - `textDocument/publishDiagnostics` is pushed only for documents this client opened,
 *     on didOpen/didChange (even when empty) and goes only to the client that triggered it.
 *   - The server can send requests too (`workspace/applyEdit` when the user connects a
 *     signal in the editor). We must answer every request so the server doesn't wait.
 */

import net from 'node:net';
import { OpError } from '../errors.js';
import { log } from '../log.js';
import { encodeMessage, FramingError, MessageReader } from './framing.js';
import { fileUriToPath, pathToFileUri } from './uri.js';

export interface LspPosition {
  line: number;
  character: number;
}
export interface LspRange {
  start: LspPosition;
  end: LspPosition;
}
export interface LspLocation {
  uri: string;
  range: LspRange;
}
export interface LspDiagnostic {
  range: LspRange;
  severity?: number;
  message: string;
  code?: number | string;
  source?: string;
}
export interface LspDocumentSymbol {
  name: string;
  kind: number;
  detail?: string;
  documentation?: string;
  native_class?: string;
  deprecated?: boolean;
  range: LspRange;
  selectionRange: LspRange;
  children?: LspDocumentSymbol[];
}

export interface LspClientOptions {
  port: number;
  /** Absolute project path as the editor knows it (sent as rootPath / rootUri). */
  rootPath: string;
  /** Default per-request timeout. */
  requestTimeoutMs: number;
  /** How long to wait for the TCP connection itself. */
  connectTimeoutMs?: number;
}

interface Pending {
  method: string;
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

type NotificationHandler = (params: unknown) => void;

/** JSON-RPC "method not found": Godot answers this for every unimplemented LSP method. */
export const METHOD_NOT_FOUND = -32601;

export class LspRequestError extends Error {
  constructor(
    public readonly code: number,
    message: string,
  ) {
    super(message);
  }
}

/** Compare two file URIs by the path they denote (encodings and drive case may differ). */
function uriKey(uri: string): string {
  try {
    const p = fileUriToPath(uri);
    return process.platform === 'win32' ? p.toLowerCase() : p;
  } catch {
    return uri;
  }
}

export class LspClient {
  private socket: net.Socket | undefined;
  private reader = new MessageReader();
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private handlers = new Map<string, Set<NotificationHandler>>();
  private closeListeners = new Set<() => void>();
  private _closed = false;
  /** Native class -> parent class, from the `gdscript/capabilities` push. */
  readonly nativeClasses = new Map<string, string>();
  /** Set when the server says it has a different project open (changeWorkspace). */
  workspaceMismatch: string | undefined;

  private constructor(private readonly opts: LspClientOptions) {}

  /**
   * Connect and run the initialize handshake. Throws OpError when nothing listens on the
   * port or the server doesn't answer `initialize`.
   */
  static async connect(opts: LspClientOptions): Promise<LspClient> {
    const client = new LspClient(opts);
    await client.open();
    try {
      await client.initialize();
    } catch (err) {
      client.close();
      throw err;
    }
    return client;
  }

  get closed(): boolean {
    return this._closed;
  }

  get port(): number {
    return this.opts.port;
  }

  /** URI for an absolute path inside the project. */
  uriFor(absPath: string): string {
    return pathToFileUri(absPath);
  }

  private open(): Promise<void> {
    return new Promise((resolve, reject) => {
      // Loopback only, by design: the language server has no authentication.
      const socket = net.connect({ host: '127.0.0.1', port: this.opts.port });
      const timer = setTimeout(() => {
        socket.destroy();
        reject(new OpError('TIMEOUT', `Timed out connecting to the GDScript language server on 127.0.0.1:${this.opts.port}.`));
      }, this.opts.connectTimeoutMs ?? 5_000);
      socket.once('connect', () => {
        clearTimeout(timer);
        socket.setNoDelay(true);
        this.socket = socket;
        resolve();
      });
      socket.once('error', (err) => {
        clearTimeout(timer);
        if (!this.socket) reject(new OpError('GODOT_ERROR', `Cannot connect to the GDScript language server on 127.0.0.1:${this.opts.port}: ${err.message}`));
      });
      socket.on('data', (chunk: Buffer) => this.onData(chunk));
      socket.on('close', () => this.onClose('the language server closed the connection'));
      socket.on('error', (err) => log.debug(`LSP socket error: ${err.message}`));
    });
  }

  private async initialize(): Promise<void> {
    const root = this.opts.rootPath;
    await this.request(
      'initialize',
      {
        processId: process.pid,
        rootUri: pathToFileUri(root),
        // Must equal the editor's resource path (compared case-insensitively, no trailing
        // slash), or the server pushes gdscript_client/changeWorkspace.
        rootPath: root,
        capabilities: {
          // The only client capability Godot reads; snippets would only add noise.
          textDocument: { completion: { completionItem: { snippetSupport: false } } },
        },
        clientInfo: { name: 'godot-mcp' },
      },
      20_000,
    );
    this.notify('initialized', {});
  }

  private onData(chunk: Buffer): void {
    let messages: unknown[];
    try {
      messages = this.reader.push(chunk);
    } catch (err) {
      // A broken stream can't be resynchronised; drop the connection (callers reconnect).
      log.warn(`GDScript language server sent a malformed message: ${(err as FramingError).message}`);
      this.socket?.destroy();
      this.onClose('malformed message from the language server');
      return;
    }
    for (const msg of messages) this.dispatch(msg as Record<string, unknown>);
  }

  private dispatch(msg: Record<string, unknown>): void {
    const hasId = msg.id !== undefined && msg.id !== null;
    if (typeof msg.method === 'string') {
      if (hasId) this.answerServerRequest(msg.id as number | string, msg.method, msg.params);
      else this.handleNotification(msg.method, msg.params);
      return;
    }
    if (!hasId) return;
    const pending = this.pending.get(msg.id as number);
    if (!pending) return; // late answer to a timed-out request
    this.pending.delete(msg.id as number);
    clearTimeout(pending.timer);
    if (msg.error) {
      const e = msg.error as { code?: number; message?: string };
      pending.reject(new LspRequestError(e.code ?? 0, `${pending.method}: ${e.message ?? 'language server error'}`));
    } else {
      pending.resolve(msg.result ?? null);
    }
  }

  /** Answer requests the server sends us. We never let the editor edit files through us. */
  private answerServerRequest(id: number | string, method: string, _params: unknown): void {
    let result: unknown = null;
    if (method === 'workspace/applyEdit') result = { applied: false, failureReason: 'godot-mcp does not apply edits pushed by the editor' };
    else if (method === 'workspace/configuration') result = [];
    this.write({ jsonrpc: '2.0', id, result });
  }

  private handleNotification(method: string, params: unknown): void {
    switch (method) {
      case 'gdscript/capabilities': {
        const classes = (params as { native_classes?: { name: string; inherits: string }[] })?.native_classes ?? [];
        for (const c of classes) this.nativeClasses.set(c.name, c.inherits);
        break;
      }
      case 'gdscript_client/changeWorkspace':
        this.workspaceMismatch = String((params as { path?: string })?.path ?? '');
        log.warn(`GDScript language server has a different project open: ${this.workspaceMismatch}`);
        break;
      case 'window/showMessage':
      case 'window/logMessage':
        log.debug(`LSP ${method}: ${(params as { message?: string })?.message ?? ''}`);
        break;
      default:
        break;
    }
    for (const h of this.handlers.get(method) ?? []) {
      try {
        h(params);
      } catch (err) {
        log.warn(`LSP notification handler for ${method} failed: ${(err as Error).message}`);
      }
    }
  }

  private onClose(reason: string): void {
    if (this._closed) return;
    this._closed = true;
    this.socket = undefined;
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new OpError('GODOT_ERROR', `GDScript language server request "${p.method}" failed: ${reason}. Retry the call (the server reconnects automatically).`));
      this.pending.delete(id);
    }
    for (const l of this.closeListeners) l();
  }

  private write(message: unknown): void {
    if (!this.socket || this._closed) throw new OpError('GODOT_ERROR', 'The GDScript language server connection is closed.');
    this.socket.write(encodeMessage(message));
  }

  /** Send a request and wait for its result (rejects on error or timeout). */
  request<T = unknown>(method: string, params: unknown, timeoutMs = this.opts.requestTimeoutMs): Promise<T> {
    if (this._closed) return Promise.reject(new OpError('GODOT_ERROR', 'The GDScript language server connection is closed.'));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new OpError('TIMEOUT', `The GDScript language server did not answer "${method}" within ${timeoutMs} ms (the editor may be busy importing or frozen).`));
      }, timeoutMs);
      this.pending.set(id, { method, resolve: resolve as (v: unknown) => void, reject, timer });
      try {
        this.write({ jsonrpc: '2.0', id, method, params });
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(err);
      }
    });
  }

  notify(method: string, params: unknown): void {
    this.write({ jsonrpc: '2.0', method, params });
  }

  /** Subscribe to a server notification; returns an unsubscribe function. */
  on(method: string, handler: NotificationHandler): () => void {
    let set = this.handlers.get(method);
    if (!set) this.handlers.set(method, (set = new Set()));
    set.add(handler);
    return () => set.delete(handler);
  }

  /** Called once when the connection closes; returns an unsubscribe function. */
  onDidClose(listener: () => void): () => void {
    this.closeListeners.add(listener);
    return () => this.closeListeners.delete(listener);
  }

  /**
   * Open a document with the given text, wait for its publishDiagnostics, then close it.
   * The waiter is registered BEFORE didOpen so a fast answer can't be missed. Resolves
   * with undefined when no diagnostics arrive within `timeoutMs`.
   */
  async diagnose(uri: string, text: string, timeoutMs = 10_000): Promise<LspDiagnostic[] | undefined> {
    const key = uriKey(uri);
    let offNote: () => void = () => undefined;
    let offClose: () => void = () => undefined;
    const got = new Promise<LspDiagnostic[] | undefined>((resolve) => {
      const timer = setTimeout(() => resolve(undefined), timeoutMs);
      offNote = this.on('textDocument/publishDiagnostics', (params) => {
        const p = params as { uri: string; diagnostics: LspDiagnostic[] };
        if (uriKey(p.uri) !== key) return;
        clearTimeout(timer);
        resolve(p.diagnostics ?? []);
      });
      offClose = this.onDidClose(() => resolve(undefined));
    });
    try {
      this.notify('textDocument/didOpen', { textDocument: { uri, languageId: 'gdscript', version: 1, text } });
      return await got;
    } finally {
      offNote();
      offClose();
      // Always close: opening an already-open document is rejected by the server, and an
      // open buffer would shadow later changes on disk for this client.
      if (!this._closed) this.notify('textDocument/didClose', { textDocument: { uri } });
    }
  }

  close(): void {
    // No shutdown/exit: Godot doesn't implement them. Closing the socket ends the session.
    this.socket?.end();
    this.socket?.destroy();
    this.onClose('connection closed by godot-mcp');
  }
}
