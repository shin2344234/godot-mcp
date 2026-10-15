/**
 * Talking to the runtime autoload inside a running game
 * (addons/godot_mcp/runtime/mcp_runtime.gd), whichever debugger host carries
 * the messages:
 *
 *   - ProcessTransport: a game this server launched with --remote-debug; the
 *     server is the debugger (DebugSession).
 *   - the editor relay (editorTransport in hub.ts): a game started from the
 *     Godot editor; the plugin's EditorDebuggerPlugin forwards messages over
 *     the bridge.
 *
 * On top of a transport, RuntimeChannel does JSON request/response:
 * "mcp:request" [json {id, method, params}] -> "mcp:reply" [json {id, result|error}].
 * It also passes through "native" debugger commands (e.g.
 * "scene:suspend_changed") for features Godot's own SceneDebugger already
 * implements in every debug build.
 */

import { EventEmitter } from 'node:events';
import { OpError } from '../errors.js';
import type { DebugSession, GameMessage } from './debugSession.js';
import type { Encodable, GodotFloat } from './variant.js';

/** What the runtime reports in "mcp:hello". */
export interface RuntimeHello {
  protocol: number;
  godot_version: string;
  pid: number;
  current_scene: string;
  display: string;
  methods: string[];
}

/** Minimal message pipe between the server and one game. */
export interface GameTransport extends EventEmitter {
  /** 'process': launched by this server; 'editor': started from the editor. */
  readonly kind: 'process' | 'editor';
  readonly isOpen: boolean;
  /** Send a debugger command, e.g. ("mcp:request", [json]) or ("scene:suspend_changed", [true]). */
  send(command: string, data: (Encodable | GodotFloat)[]): Promise<void>;
  // Emits 'message' (GameMessage) for every message from the game, and 'close'.
}

/** ProcessTransport: a DebugSession seen as a GameTransport. */
export class ProcessTransport extends EventEmitter implements GameTransport {
  readonly kind = 'process' as const;
  constructor(readonly session: DebugSession) {
    super();
    session.on('message', (m: GameMessage) => this.emit('message', m));
    session.on('close', () => this.emit('close'));
  }
  get isOpen(): boolean {
    return this.session.isConnected;
  }
  async send(command: string, data: (Encodable | GodotFloat)[]): Promise<void> {
    if (!this.session.send(command, data)) throw new OpError('GAME_NOT_RUNNING', 'The game is no longer connected (it exited or was stopped).');
  }
}

/** JSON-RPC to the runtime over a transport. */
export class RuntimeChannel extends EventEmitter {
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  hello: RuntimeHello | undefined;
  private helloResolve!: (h: RuntimeHello) => void;
  /** Resolves when the runtime has said hello. */
  readonly ready: Promise<RuntimeHello> = new Promise((resolve) => (this.helloResolve = resolve));

  constructor(readonly transport: GameTransport) {
    super();
    transport.on('message', (m: GameMessage) => this.onMessage(m));
    transport.on('close', () => this.onClose());
  }

  get kind(): 'process' | 'editor' {
    return this.transport.kind;
  }

  get isOpen(): boolean {
    return this.transport.isOpen;
  }

  private onMessage(m: GameMessage): void {
    if (!m.message.startsWith('mcp:')) {
      // Native debugger messages (output, error, debug_enter, profiler frames...).
      this.emit('native', m);
      return;
    }
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(String(m.data[0] ?? '{}')) as Record<string, unknown>;
    } catch {
      return;
    }
    if (m.message === 'mcp:hello') {
      this.hello = payload as unknown as RuntimeHello;
      this.helloResolve(this.hello);
      this.emit('hello', this.hello);
    } else if (m.message === 'mcp:reply') {
      const p = this.pending.get(Number(payload.id));
      if (!p) return;
      this.pending.delete(Number(payload.id));
      clearTimeout(p.timer);
      if (payload.error) {
        const e = payload.error as { code?: string; message?: string; data?: unknown };
        p.reject(new OpError((e.code as never) ?? 'GODOT_ERROR', e.message ?? 'The game runtime reported an error.', e.data));
      } else p.resolve(payload.result);
    } else if (m.message === 'mcp:event') {
      this.emit('event', payload);
    }
  }

  private onClose(): void {
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new OpError('GAME_NOT_RUNNING', 'The game exited before answering.'));
    }
    this.pending.clear();
    this.emit('close');
  }

  /** Call a runtime method. Rejects with OpError on runtime errors, timeouts, cancellation or exit. */
  async request<T = unknown>(method: string, params: Record<string, unknown> = {}, opts: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<T> {
    if (!this.isOpen) throw new OpError('GAME_NOT_RUNNING', 'The game is no longer running. Start it with godot_run_start.');
    const timeoutMs = opts.timeoutMs ?? 15_000;
    const id = this.nextId++;
    const result = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new OpError('TIMEOUT', `The game did not answer "${method}" within ${timeoutMs} ms. It may be stopped at a breakpoint (see godot_debug_state) or frozen.`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      opts.signal?.addEventListener(
        'abort',
        () => {
          if (!this.pending.has(id)) return;
          this.pending.delete(id);
          clearTimeout(timer);
          reject(new OpError('CANCELLED', `"${method}" was cancelled.`));
        },
        { once: true },
      );
    });
    await this.transport.send('mcp:request', [JSON.stringify({ id, method, params })]);
    return (await result) as T;
  }

  /** Send a native debugger command (no reply expected). */
  async native(command: string, data: (Encodable | GodotFloat)[] = []): Promise<void> {
    await this.transport.send(command, data);
  }
}
