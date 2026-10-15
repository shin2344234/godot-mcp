/**
 * Godot binary Variant codec (src/game/variant.ts). Byte layouts follow
 * core/io/marshalls.cpp (Godot 4.7.2); the "from Godot" packets below were
 * captured from a real 4.7.2 game connected with --remote-debug.
 */

import { describe, expect, it } from 'vitest';
import { decodeVariant, encodeVariant, framePacket, GodotFloat, PacketReader, VariantDecodeError } from '../../src/game/variant.js';

const hex = (s: string) => Buffer.from(s.replace(/\s+/g, ''), 'hex');

describe('Variant codec', () => {
  it('round-trips the JSON-like values the server sends', () => {
    const value = ['mcp:request', 1, ['{"id":1}', true, null, -5, 3_000_000_000, 1.5, { a: [1, 'x'] }]];
    expect(decodeVariant(encodeVariant(value as never)).value).toEqual(value);
  });

  it('encodes strings with 4-byte padding and integers as 32-bit when they fit', () => {
    // STRING(4) len=3 "abc" + 1 pad byte
    expect(encodeVariant('abc').toString('hex')).toBe('04000000' + '03000000' + '61626300');
    expect(encodeVariant(7).toString('hex')).toBe('02000000' + '07000000');
    // INT with FLAG_64 for values beyond int32
    expect(encodeVariant(2 ** 33).readUInt32LE(0)).toBe(2 | (1 << 16));
    // A whole number that must stay a float
    expect(encodeVariant(new GodotFloat(1)).readUInt32LE(0)).toBe(3 | (1 << 16));
  });

  it('decodes a real "set_pid" message from Godot 4.7.2', () => {
    // [ "set_pid", 1, [ 1195 ] ]
    const body = hex('1c000000 03000000 04000000 07000000 7365745f70696400 02000000 01000000 1c000000 01000000 02000000 ab040000');
    expect(decodeVariant(body).value).toEqual(['set_pid', 1, [1195]]);
  });

  it('decodes math types, colors, node paths and objects', () => {
    const v2 = Buffer.concat([u32(5), f32(1), f32(2.5)]);
    expect(decodeVariant(v2).value).toBe('Vector2(1, 2.5)');
    const color = Buffer.concat([u32(20), f32(1), f32(0), f32(0), f32(1)]);
    expect(decodeVariant(color).value).toBe('Color(1, 0, 0, 1)');
    // NodePath new format: 2 names, 1 subname, absolute flag
    const np = Buffer.concat([u32(22), u32(0x80000002), u32(1), u32(1), str('root'), str('Main'), str('position')]);
    expect(decodeVariant(np).value).toBe('/root/Main:position');
    // Object encoded as id (FLAG_64 on OBJECT)
    const obj = Buffer.concat([u32(24 | (1 << 16)), u64(42n)]);
    expect(decodeVariant(obj).value).toEqual({ object_id: '42' });
    // Typed Array[int]: kind BUILTIN (1) at bit 16, then the element type, then the count
    const typed = Buffer.concat([u32(28 | (1 << 16)), u32(2), u32(2), u32(2), u32(5), u32(2), u32(6)]);
    expect(decodeVariant(typed).value).toEqual([5, 6]);
  });

  it('splits a byte stream into packets, across chunk boundaries', () => {
    const a = framePacket(['output', 1, [['hello'], [0]]]);
    const b = framePacket(['mcp:hello', 1, ['{}']]);
    const all = Buffer.concat([a, b]);
    const reader = new PacketReader();
    const first = reader.push(all.subarray(0, 10));
    const rest = reader.push(all.subarray(10));
    expect([...first, ...rest]).toEqual([
      ['output', 1, [['hello'], [0]]],
      ['mcp:hello', 1, ['{}']],
    ]);
  });

  it('rejects truncated and oversized data instead of hanging', () => {
    expect(() => decodeVariant(hex('04000000 ff000000'))).toThrow(VariantDecodeError);
    expect(() => new PacketReader().push(u32(PacketReader.MAX_PACKET + 1))).toThrow(/too large/);
  });
});

function u32(n: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n >>> 0);
  return b;
}
function u64(n: bigint): Buffer {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(n);
  return b;
}
function f32(n: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeFloatLE(n);
  return b;
}
function str(s: string): Buffer {
  const bytes = Buffer.from(s, 'utf8');
  return Buffer.concat([u32(bytes.length), bytes, Buffer.alloc((4 - (bytes.length % 4)) % 4)]);
}
