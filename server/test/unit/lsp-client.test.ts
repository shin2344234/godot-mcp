/**
 * LspClient against a fake Godot-like language server on 127.0.0.1: handshake, requests,
 * server-initiated requests/notifications, diagnostics, timeouts and connection loss.
 * The fake parses lengths the way Godot does (all digits after "Content-Length: ").
 */

import net from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { LspClient, LspRequestError } from '../../src/lsp/client.js';
import { encodeMessage } from '../../src/lsp/framing.js';

type Handler = (msg: Record<string, unknown>, send: (m: unknown) => void, sock: net.Socket) => void;

/** Minimal server: Godot-style header parsing, records raw headers it saw. */
async function fakeServer(handler: Handler) {
  const headers: string[] = [];
  const sockets: net.Socket[] = [];
  const server = net.createServer((sock) => {
    sockets.push(sock);
    let buf = Buffer.alloc(0);
    const send = (m: unknown) => sock.write(encodeMessage(m));
    sock.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      for (;;) {
        const end = buf.indexOf('\r\n\r\n');
        if (end === -1) return;
        const header = buf.subarray(0, end).toString();
        headers.push(header);
        const len = Number(header.slice(16).replace(/\D/g, '')); // Godot: substr(16).to_int()
        if (buf.length < end + 4 + len) return;
        const msg = JSON.parse(buf.subarray(end + 4, end + 4 + len).toString());
        buf = buf.subarray(end + 4 + len);
        handler(msg, send, sock);
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as net.AddressInfo).port;
  return {
    port,
    headers,
    close: () => {
      for (const s of sockets) s.destroy();
      server.close();
    },
  };
}

let cleanup: (() => void)[] = [];
afterEach(() => {
  for (const c of cleanup) c();
  cleanup = [];
});

const godotLike: Handler = (msg, send) => {
  if (msg.method === 'initialize') {
    send({ jsonrpc: '2.0', id: msg.id, result: { capabilities: {} } });
  } else if (msg.method === 'initialized') {
    send({ jsonrpc: '2.0', method: 'gdscript/capabilities', params: { native_classes: [{ name: 'Node2D', inherits: 'CanvasItem' }] } });
    // A server->client request the client must answer.
    send({ jsonrpc: '2.0', id: 900, method: 'workspace/applyEdit', params: { edit: {} } });
  } else if (msg.method === 'textDocument/didOpen') {
    const uri = (msg.params as { textDocument: { uri: string } }).textDocument.uri;
    send({ jsonrpc: '2.0', method: 'textDocument/publishDiagnostics', params: { uri, diagnostics: [{ message: 'boom', severity: 1, range: { start: { line: 1, character: 2 }, end: { line: 1, character: 3 } } }] } });
  } else if (msg.method === 'shutdown') {
    send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'Method not found: shutdown' } });
  } else if (msg.method === 'echo') {
    send({ jsonrpc: '2.0', id: msg.id, result: msg.params });
  }
  // 'slow' is never answered.
};

describe('LspClient', () => {
  it('initializes, sends only Content-Length headers and records native classes', async () => {
    const answers: unknown[] = [];
    const srv = await fakeServer((msg, send, sock) => {
      if (msg.id === 900 && !msg.method) answers.push(msg);
      godotLike(msg, send, sock);
    });
    cleanup.push(srv.close);
    const client = await LspClient.connect({ port: srv.port, rootPath: '/tmp/proj', requestTimeoutMs: 2000 });
    cleanup.push(() => client.close());
    expect(await client.request('echo', { a: 1 })).toEqual({ a: 1 });
    await new Promise((r) => setTimeout(r, 50));
    expect(srv.headers.every((h) => /^Content-Length: \d+$/.test(h))).toBe(true);
    expect(client.nativeClasses.get('Node2D')).toBe('CanvasItem');
    // The applyEdit request was answered (and declined).
    expect(answers).toEqual([{ jsonrpc: '2.0', id: 900, result: expect.objectContaining({ applied: false }) }]);
  });

  it('turns JSON-RPC errors into LspRequestError (no shutdown in Godot)', async () => {
    const srv = await fakeServer(godotLike);
    cleanup.push(srv.close);
    const client = await LspClient.connect({ port: srv.port, rootPath: '/tmp/proj', requestTimeoutMs: 2000 });
    cleanup.push(() => client.close());
    await expect(client.request('shutdown', null)).rejects.toBeInstanceOf(LspRequestError);
  });

  it('waits for publishDiagnostics of the opened document', async () => {
    const srv = await fakeServer(godotLike);
    cleanup.push(srv.close);
    const client = await LspClient.connect({ port: srv.port, rootPath: '/tmp/proj', requestTimeoutMs: 2000 });
    cleanup.push(() => client.close());
    const d = await client.diagnose('file:///tmp/proj/a%20b.gd', 'extends Node\n');
    expect(d).toHaveLength(1);
    expect(d![0]!.message).toBe('boom');
  });

  it('times out unanswered requests', async () => {
    const srv = await fakeServer(godotLike);
    cleanup.push(srv.close);
    const client = await LspClient.connect({ port: srv.port, rootPath: '/tmp/proj', requestTimeoutMs: 2000 });
    cleanup.push(() => client.close());
    await expect(client.request('slow', {}, 150)).rejects.toThrow(/did not answer "slow" within 150 ms/);
  });

  it('fails pending requests and reports closed when the server goes away', async () => {
    let socket: net.Socket | undefined;
    const srv = await fakeServer((msg, send, sock) => {
      socket = sock;
      godotLike(msg, send, sock);
    });
    cleanup.push(srv.close);
    const client = await LspClient.connect({ port: srv.port, rootPath: '/tmp/proj', requestTimeoutMs: 5000 });
    let closed = false;
    client.onDidClose(() => (closed = true));
    const pending = client.request('slow', {});
    socket!.destroy();
    await expect(pending).rejects.toThrow(/closed the connection/);
    expect(client.closed).toBe(true);
    expect(closed).toBe(true);
    await expect(client.request('echo', {})).rejects.toThrow(/closed/);
  });

  it('drops the connection on a malformed message', async () => {
    const srv = await fakeServer((msg, send, sock) => {
      if (msg.method === 'initialize') send({ jsonrpc: '2.0', id: msg.id, result: {} });
      if (msg.method === 'echo') sock.write('Content-Length: 5\r\n\r\n{oops');
    });
    cleanup.push(srv.close);
    const client = await LspClient.connect({ port: srv.port, rootPath: '/tmp/proj', requestTimeoutMs: 2000 });
    await expect(client.request('echo', {})).rejects.toThrow(/malformed/);
    expect(client.closed).toBe(true);
  });

  it('gives a clear error when nothing listens', async () => {
    const srv = await fakeServer(godotLike);
    const port = srv.port;
    srv.close();
    await new Promise((r) => setTimeout(r, 50));
    await expect(LspClient.connect({ port, rootPath: '/tmp/proj', requestTimeoutMs: 500 })).rejects.toThrow(/Cannot connect to the GDScript language server/);
  });
});
