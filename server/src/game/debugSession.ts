/**
 * The server as a Godot remote debugger for one game process.
 *
 * Godot games accept `--remote-debug tcp://127.0.0.1:<port>`: at startup the
 * game connects to that address and speaks the same protocol it speaks to the
 * editor's debugger (verified against Godot 4.7.2,
 * core/debugger/remote_debugger*.cpp):
 *
 *   - framing: uint32 little-endian length + one Variant (see variant.ts);
 *   - game -> debugger: [message: String, thread_id: int, data: Array],
 *     e.g. "output", "error", "debug_enter", "stack_dump", "set_pid",
 *     "performance:profile_frame", and our runtime's "mcp:*" messages;
 *   - debugger -> game: [command: String, thread_id: int, data: Array].
 *     The thread id must be one the game is listening on; the main thread's
 *     id is the one it sends in its own messages (1 in practice). Commands
 *     with a "prefix:" go to the capture registered for that prefix
 *     ("core:breakpoint", "scene:suspend_changed", "mcp:request"...). While
 *     the game is stopped at a breakpoint it also takes the bare commands
 *     "step", "next", "out", "continue", "get_stack_dump",
 *     "get_stack_frame_vars" and "evaluate".
 *
 * There's no handshake. The listener binds to 127.0.0.1 only, accepts exactly
 * one connection (the game we launched) and then stops listening, so no other
 * local process can attach afterwards.
 */

import { EventEmitter } from 'node:events';
import net from 'node:net';
import { log } from '../log.js';
import { framePacket, PacketReader, type Encodable, type GodotFloat } from './variant.js';

/** One message from the game. */
export interface GameMessage {
  message: string;
  thread: number;
  data: unknown[];
}

/** Godot's main thread id as seen in debugger messages. Updated from the first message the game sends. */
const DEFAULT_MAIN_THREAD = 1;

export class DebugSession extends EventEmitter {
  private server: net.Server | undefined;
  private socket: net.Socket | undefined;
  private reader = new PacketReader();
  private mainThread = DEFAULT_MAIN_THREAD;
  private connectedResolve!: () => void;
  /** Resolves when the game has connected. */
  readonly connected: Promise<void> = new Promise((resolve) => (this.connectedResolve = resolve));
  port = 0;
  closed = false;

  /** Start listening on 127.0.0.1 (random free port). Call before launching the game. */
  async listen(): Promise<void> {
    this.server = net.createServer((socket) => this.accept(socket));
    await new Promise<void>((resolve, reject) => {
      this.server!.once('error', reject);
      this.server!.listen(0, '127.0.0.1', () => resolve());
    });
    this.port = (this.server.address() as net.AddressInfo).port;
  }

  /** The value for Godot's --remote-debug argument. */
  get uri(): string {
    return `tcp://127.0.0.1:${this.port}`;
  }

  get isConnected(): boolean {
    return this.socket !== undefined && !this.closed;
  }

  private accept(socket: net.Socket): void {
    if (this.socket) {
      // Only the game we launched may attach.
      socket.destroy();
      return;
    }
    this.socket = socket;
    socket.setNoDelay(true);
    // Stop accepting: a second process can't take over this game's channel.
    this.server?.close();
    socket.on('data', (chunk: Buffer) => this.onData(chunk));
    socket.on('close', () => this.onClose());
    socket.on('error', (err) => log.debug(`Debugger socket error: ${err.message}`));
    this.connectedResolve();
    this.emit('connected');
  }

  private onData(chunk: Buffer): void {
    let packets: unknown[];
    try {
      packets = this.reader.push(chunk);
    } catch (err) {
      log.warn(`Dropping the debugger connection: ${(err as Error).message}`);
      this.socket?.destroy();
      return;
    }
    for (const p of packets) {
      if (!Array.isArray(p) || p.length < 3 || typeof p[0] !== 'string' || !Array.isArray(p[2])) {
        log.debug(`Ignoring malformed debugger message: ${JSON.stringify(p).slice(0, 200)}`);
        continue;
      }
      const msg: GameMessage = { message: p[0], thread: Number(p[1]), data: p[2] as unknown[] };
      // The first message comes from the main thread (set_pid / output at startup).
      if (this.mainThread === DEFAULT_MAIN_THREAD && Number.isInteger(msg.thread) && msg.thread > 0 && msg.message === 'set_pid') this.mainThread = msg.thread;
      this.emit('message', msg);
      this.emit(`message:${msg.message}`, msg);
    }
  }

  private onClose(): void {
    if (this.closed) return;
    this.closed = true;
    this.emit('close');
  }

  /** Send a command to the game (to its main thread unless told otherwise). */
  send(command: string, data: (Encodable | GodotFloat)[] = [], thread = this.mainThread): boolean {
    if (!this.isConnected) return false;
    this.socket!.write(framePacket([command, thread, data as Encodable[]]));
    return true;
  }

  /**
   * Wait for the next message named `message` (optionally matching `filter`).
   * Rejects after `timeoutMs`, or when the game disconnects.
   */
  waitFor(message: string, timeoutMs: number, filter?: (m: GameMessage) => boolean, signal?: AbortSignal): Promise<GameMessage> {
    return new Promise((resolve, reject) => {
      const onMsg = (m: GameMessage) => {
        if (filter && !filter(m)) return;
        cleanup();
        resolve(m);
      };
      const onClose = () => {
        cleanup();
        reject(new Error('The game disconnected.'));
      };
      const onAbort = () => {
        cleanup();
        reject(new Error('Cancelled.'));
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(`Timed out after ${timeoutMs} ms waiting for "${message}" from the game.`));
      }, timeoutMs);
      const cleanup = () => {
        clearTimeout(timer);
        this.off(`message:${message}`, onMsg);
        this.off('close', onClose);
        signal?.removeEventListener('abort', onAbort);
      };
      this.on(`message:${message}`, onMsg);
      this.once('close', onClose);
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }

  close(): void {
    this.server?.close();
    this.socket?.destroy();
    this.onClose();
  }
}
