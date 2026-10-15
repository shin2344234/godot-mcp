/**
 * LSP framing, including Godot's header quirk: the server runs String::to_int() over the
 * whole header block, so we must send ONLY "Content-Length: N" (any other digits, e.g. the
 * "8" of "charset=utf-8", would corrupt the length).
 */

import { describe, expect, it } from 'vitest';
import { encodeMessage, FramingError, MAX_MESSAGE_BYTES, MessageReader } from '../../src/lsp/framing.js';

describe('encodeMessage', () => {
  it('writes only the Content-Length header', () => {
    const buf = encodeMessage({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
    const text = buf.toString('utf8');
    const headerEnd = text.indexOf('\r\n\r\n');
    const header = text.slice(0, headerEnd);
    expect(header).toMatch(/^Content-Length: \d+$/);
    expect(header).not.toMatch(/content-type/i);
    // Simulate Godot's parser: every digit after "Content-Length: " is the length.
    const godotLength = Number(header.slice(16).replace(/\D/g, ''));
    expect(godotLength).toBe(buf.length - headerEnd - 4);
  });

  it('counts bytes, not characters, for non-ASCII bodies', () => {
    const buf = encodeMessage({ text: 'héllo 🤖' });
    const header = buf.toString('ascii', 0, buf.indexOf('\r\n\r\n'));
    const body = buf.subarray(buf.indexOf('\r\n\r\n') + 4);
    expect(Number(/\d+/.exec(header)![0])).toBe(body.length);
    expect(JSON.parse(body.toString('utf8'))).toEqual({ text: 'héllo 🤖' });
  });

  it('refuses messages above the 4 MiB Godot limit', () => {
    expect(() => encodeMessage({ big: 'x'.repeat(MAX_MESSAGE_BYTES) })).toThrow(FramingError);
  });
});

describe('MessageReader', () => {
  const frame = (o: unknown) => encodeMessage(o);

  it('decodes messages split across chunks', () => {
    const r = new MessageReader();
    const all = frame({ id: 1, result: 'ok' });
    expect(r.push(all.subarray(0, 5))).toEqual([]);
    expect(r.push(all.subarray(5, 30))).toEqual([]);
    expect(r.push(all.subarray(30))).toEqual([{ id: 1, result: 'ok' }]);
    expect(r.pending).toBe(0);
  });

  it('decodes several messages in one chunk', () => {
    const r = new MessageReader();
    const out = r.push(Buffer.concat([frame({ a: 1 }), frame({ b: 2 }), frame({ c: 3 }).subarray(0, 10)]));
    expect(out).toEqual([{ a: 1 }, { b: 2 }]);
    expect(r.pending).toBeGreaterThan(0);
  });

  it('accepts any header case and extra headers from other servers', () => {
    const r = new MessageReader();
    const body = '{"x":true}';
    const msg = Buffer.from(`content-type: application/vscode-jsonrpc; charset=utf-8\r\ncontent-length: ${body.length}\r\n\r\n${body}`);
    expect(r.push(msg)).toEqual([{ x: true }]);
  });

  it('rejects a missing Content-Length, oversized messages and bad JSON', () => {
    expect(() => new MessageReader().push(Buffer.from('X-Foo: 1\r\n\r\n{}'))).toThrow(/Content-Length/);
    expect(() => new MessageReader().push(Buffer.from(`Content-Length: ${MAX_MESSAGE_BYTES + 1}\r\n\r\n`))).toThrow(/exceeds/);
    expect(() => new MessageReader().push(Buffer.from('Content-Length: 3\r\n\r\n{x}'))).toThrow(/JSON/);
  });

  it('rejects an endless header block', () => {
    expect(() => new MessageReader().push(Buffer.from('a'.repeat(9000)))).toThrow(/header/);
  });
});
