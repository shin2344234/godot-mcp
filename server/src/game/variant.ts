/**
 * Godot's binary Variant serialization (encode_variant / decode_variant), as
 * used by the remote debugger protocol between a running game and its
 * debugger (normally the editor; here, this server).
 *
 * Reference: core/io/marshalls.cpp in Godot 4.7.2 and the "Binary
 * serialization API" page of the Godot docs. All numbers are little-endian.
 * Every value starts with a 32-bit header: the low 8 bits are the
 * Variant::Type, bit 16 is a per-type flag (64-bit numbers for INT/FLOAT and
 * the math types, "object as id" for OBJECT, typed-container info for ARRAY
 * and DICTIONARY), then the payload follows, padded to 4 bytes.
 *
 * Decoding returns JSON-friendly values that follow the same conventions as
 * the addon's variant_codec.gd (docs/bridge-protocol.md section 3), because
 * they go straight to the model:
 *   - null/bool/int/float/String/StringName/NodePath -> JSON natives;
 *   - math and misc types (Vector2, Color, Transform3D...) -> var_to_str-like
 *     strings such as "Vector2(1, 2)";
 *   - objects sent as ids -> { object_id: "123" } (the game owns the object);
 *   - full objects -> { object: "ClassName", properties: {...} };
 *   - 64-bit ints outside JavaScript's safe range -> decimal strings.
 *
 * Encoding only needs what the server sends: commands whose data is made of
 * null, bool, numbers, strings, arrays and string-keyed objects.
 */

/** Variant::Type in Godot 4.7 (core/variant/variant.h). */
export enum VT {
  NIL = 0,
  BOOL,
  INT,
  FLOAT,
  STRING,
  VECTOR2,
  VECTOR2I,
  RECT2,
  RECT2I,
  VECTOR3,
  VECTOR3I,
  TRANSFORM2D,
  VECTOR4,
  VECTOR4I,
  PLANE,
  QUATERNION,
  AABB,
  BASIS,
  TRANSFORM3D,
  PROJECTION,
  COLOR,
  STRING_NAME,
  NODE_PATH,
  RID,
  OBJECT,
  CALLABLE,
  SIGNAL,
  DICTIONARY,
  ARRAY,
  PACKED_BYTE_ARRAY,
  PACKED_INT32_ARRAY,
  PACKED_INT64_ARRAY,
  PACKED_FLOAT32_ARRAY,
  PACKED_FLOAT64_ARRAY,
  PACKED_STRING_ARRAY,
  PACKED_VECTOR2_ARRAY,
  PACKED_VECTOR3_ARRAY,
  PACKED_COLOR_ARRAY,
  PACKED_VECTOR4_ARRAY,
  VARIANT_MAX,
}

const TYPE_MASK = 0xff;
const FLAG_64 = 1 << 16; // same bit as OBJECT_AS_ID
/** Typed-container kinds (2 bits each): array element type at bit 16, dictionary key at 16 and value at 18. */
const KIND_NONE = 0;
const KIND_BUILTIN = 1;
const KIND_CLASS_NAME = 2;
const KIND_SCRIPT = 3;

/** Nesting limit, like Variant::MAX_RECURSION_DEPTH, so a hostile packet can't blow the stack. */
const MAX_DEPTH = 1024;

/** Math types: name, number of components, whether components are int32 (vs real_t floats). */
const MATH: Partial<Record<number, { name: string; n: number; int?: boolean }>> = {
  [VT.VECTOR2]: { name: 'Vector2', n: 2 },
  [VT.VECTOR2I]: { name: 'Vector2i', n: 2, int: true },
  [VT.RECT2]: { name: 'Rect2', n: 4 },
  [VT.RECT2I]: { name: 'Rect2i', n: 4, int: true },
  [VT.VECTOR3]: { name: 'Vector3', n: 3 },
  [VT.VECTOR3I]: { name: 'Vector3i', n: 3, int: true },
  [VT.TRANSFORM2D]: { name: 'Transform2D', n: 6 },
  [VT.VECTOR4]: { name: 'Vector4', n: 4 },
  [VT.VECTOR4I]: { name: 'Vector4i', n: 4, int: true },
  [VT.PLANE]: { name: 'Plane', n: 4 },
  [VT.QUATERNION]: { name: 'Quaternion', n: 4 },
  [VT.AABB]: { name: 'AABB', n: 6 },
  [VT.BASIS]: { name: 'Basis', n: 9 },
  [VT.TRANSFORM3D]: { name: 'Transform3D', n: 12 },
  [VT.PROJECTION]: { name: 'Projection', n: 16 },
};

export class VariantDecodeError extends Error {}

/** Formats numbers the way var_to_str does for whole numbers ("1" not "1.0") — close enough for reading. */
function num(n: number): string {
  return Number.isFinite(n) ? String(Math.round(n * 1e6) / 1e6) : n > 0 ? 'inf' : n < 0 ? '-inf' : 'nan';
}

class Reader {
  pos = 0;
  constructor(private readonly buf: Buffer) {}

  private need(n: number): void {
    if (this.pos + n > this.buf.length) throw new VariantDecodeError(`Variant data ends early (need ${n} bytes at ${this.pos} of ${this.buf.length}).`);
  }
  u32(): number {
    this.need(4);
    const v = this.buf.readUInt32LE(this.pos);
    this.pos += 4;
    return v;
  }
  i32(): number {
    this.need(4);
    const v = this.buf.readInt32LE(this.pos);
    this.pos += 4;
    return v;
  }
  i64(): number | string {
    this.need(8);
    const v = this.buf.readBigInt64LE(this.pos);
    this.pos += 8;
    return v >= BigInt(Number.MIN_SAFE_INTEGER) && v <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(v) : v.toString();
  }
  u64(): string {
    this.need(8);
    const v = this.buf.readBigUInt64LE(this.pos);
    this.pos += 8;
    return v.toString();
  }
  f32(): number {
    this.need(4);
    const v = this.buf.readFloatLE(this.pos);
    this.pos += 4;
    return v;
  }
  f64(): number {
    this.need(8);
    const v = this.buf.readDoubleLE(this.pos);
    this.pos += 8;
    return v;
  }
  bytes(n: number): Buffer {
    this.need(n);
    const b = this.buf.subarray(this.pos, this.pos + n);
    this.pos += n;
    return b;
  }
  /** uint32 length + UTF-8 bytes, padded to a multiple of 4. */
  str(): string {
    const len = this.u32();
    if (len > this.buf.length) throw new VariantDecodeError(`String length ${len} is larger than the packet.`);
    const s = this.bytes(len).toString('utf8');
    this.pos += (4 - (len % 4)) % 4;
    return s;
  }
}

/** Decode one Variant from `buf` starting at `offset`. Returns the value and the number of bytes used. */
export function decodeVariant(buf: Buffer, offset = 0): { value: unknown; used: number } {
  const r = new Reader(buf);
  r.pos = offset;
  const value = readValue(r, 0);
  return { value, used: r.pos - offset };
}

function readContainerType(r: Reader, kind: number): void {
  // The element type only matters to Godot; we read past it.
  if (kind === KIND_BUILTIN) r.u32();
  else if (kind === KIND_CLASS_NAME || kind === KIND_SCRIPT) r.str();
  else if (kind !== KIND_NONE) throw new VariantDecodeError(`Invalid container type kind ${kind}.`);
}

function readValue(r: Reader, depth: number): unknown {
  if (depth > MAX_DEPTH) throw new VariantDecodeError('Variant is nested too deeply.');
  const header = r.u32();
  const type = header & TYPE_MASK;
  const wide = (header & FLAG_64) !== 0;
  const real = () => (wide ? r.f64() : r.f32());

  const math = MATH[type];
  if (math) {
    const parts: number[] = [];
    for (let i = 0; i < math.n; i++) parts.push(math.int ? r.i32() : real());
    return `${math.name}(${parts.map(num).join(', ')})`;
  }

  switch (type) {
    case VT.NIL:
      return null;
    case VT.BOOL:
      return r.u32() !== 0;
    case VT.INT:
      return wide ? r.i64() : r.i32();
    case VT.FLOAT:
      return wide ? r.f64() : r.f32();
    case VT.STRING:
    case VT.STRING_NAME:
      return r.str();
    case VT.COLOR: {
      // Colors are always 32-bit floats.
      const c = [r.f32(), r.f32(), r.f32(), r.f32()];
      return `Color(${c.map(num).join(', ')})`;
    }
    case VT.NODE_PATH: {
      const first = r.u32();
      if ((first & 0x80000000) === 0) {
        // Old format: the length was a plain string length.
        r.pos -= 4;
        return r.str();
      }
      const names = first & 0x7fffffff;
      let subnames = r.u32();
      const flags = r.u32();
      if (flags & 2) subnames++; // obsolete format with the property separate from the subpath
      const parts: string[] = [];
      for (let i = 0; i < names + subnames; i++) parts.push(r.str());
      const path = parts.slice(0, names).join('/');
      const sub = parts.slice(names);
      return (flags & 1 ? '/' : '') + path + (sub.length ? ':' + sub.join(':') : '');
    }
    case VT.RID:
      return `RID(${r.u64()})`;
    case VT.OBJECT: {
      if (wide) {
        const id = r.u64();
        return id === '0' ? null : { object_id: id };
      }
      const cls = r.str();
      if (!cls) return null;
      const count = r.u32();
      const properties: Record<string, unknown> = {};
      for (let i = 0; i < count; i++) {
        const name = r.str();
        properties[name] = readValue(r, depth + 1);
      }
      return { object: cls, properties };
    }
    case VT.CALLABLE:
      return 'Callable()';
    case VT.SIGNAL: {
      const name = r.str();
      const id = r.u64();
      return { signal: name, object_id: id };
    }
    case VT.DICTIONARY: {
      readContainerType(r, (header >> 16) & 3);
      readContainerType(r, (header >> 18) & 3);
      const count = r.u32() & 0x7fffffff;
      const out: Record<string, unknown> = {};
      for (let i = 0; i < count; i++) {
        const key = readValue(r, depth + 1);
        const value = readValue(r, depth + 1);
        out[typeof key === 'string' ? key : JSON.stringify(key)] = value;
      }
      return out;
    }
    case VT.ARRAY: {
      readContainerType(r, (header >> 16) & 3);
      const count = r.u32() & 0x7fffffff;
      const out: unknown[] = [];
      for (let i = 0; i < count; i++) out.push(readValue(r, depth + 1));
      return out;
    }
    case VT.PACKED_BYTE_ARRAY: {
      const n = r.u32();
      const bytes = [...r.bytes(n)];
      r.pos += (4 - (n % 4)) % 4;
      return bytes;
    }
    case VT.PACKED_INT32_ARRAY:
      return repeat(r.u32(), () => r.i32());
    case VT.PACKED_INT64_ARRAY:
      return repeat(r.u32(), () => r.i64());
    case VT.PACKED_FLOAT32_ARRAY:
      return repeat(r.u32(), () => r.f32());
    case VT.PACKED_FLOAT64_ARRAY:
      return repeat(r.u32(), () => r.f64());
    case VT.PACKED_STRING_ARRAY:
      return repeat(r.u32(), () => r.str());
    case VT.PACKED_VECTOR2_ARRAY:
      return repeat(r.u32(), () => `Vector2(${num(real())}, ${num(real())})`);
    case VT.PACKED_VECTOR3_ARRAY:
      return repeat(r.u32(), () => `Vector3(${num(real())}, ${num(real())}, ${num(real())})`);
    case VT.PACKED_VECTOR4_ARRAY:
      return repeat(r.u32(), () => `Vector4(${num(real())}, ${num(real())}, ${num(real())}, ${num(real())})`);
    case VT.PACKED_COLOR_ARRAY:
      return repeat(r.u32(), () => `Color(${num(r.f32())}, ${num(r.f32())}, ${num(r.f32())}, ${num(r.f32())})`);
    default:
      throw new VariantDecodeError(`Unknown Variant type ${type}.`);
  }
}

function repeat<T>(count: number, fn: () => T): T[] {
  // Each element takes at least 4 bytes, so a huge count in a small packet fails fast in the reader.
  const out: T[] = [];
  for (let i = 0; i < count; i++) out.push(fn());
  return out;
}

// --- Encoding ---------------------------------------------------------------

/** A value the server can send: JSON-like data. Integers become INT, other numbers FLOAT (64-bit). */
export type Encodable = null | undefined | boolean | number | bigint | string | Encodable[] | { [key: string]: Encodable };

/** Marks a number that must be sent as FLOAT even if it is whole (e.g. a time scale of 1). */
export class GodotFloat {
  constructor(readonly value: number) {}
}

export function encodeVariant(value: Encodable | GodotFloat): Buffer {
  const chunks: Buffer[] = [];
  write(value, chunks, 0);
  return Buffer.concat(chunks);
}

function u32(n: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n >>> 0);
  return b;
}

function writeString(s: string, out: Buffer[]): void {
  const bytes = Buffer.from(s, 'utf8');
  out.push(u32(bytes.length), bytes, Buffer.alloc((4 - (bytes.length % 4)) % 4));
}

function write(value: Encodable | GodotFloat, out: Buffer[], depth: number): void {
  if (depth > MAX_DEPTH) throw new Error('Value is nested too deeply to encode.');
  if (value === null || value === undefined) {
    out.push(u32(VT.NIL));
  } else if (typeof value === 'boolean') {
    out.push(u32(VT.BOOL), u32(value ? 1 : 0));
  } else if (value instanceof GodotFloat) {
    const b = Buffer.alloc(8);
    b.writeDoubleLE(value.value);
    out.push(u32(VT.FLOAT | FLAG_64), b);
  } else if (typeof value === 'bigint' || (typeof value === 'number' && Number.isInteger(value))) {
    const n = BigInt(value);
    if (n >= -2147483648n && n <= 2147483647n) {
      const b = Buffer.alloc(4);
      b.writeInt32LE(Number(n));
      out.push(u32(VT.INT), b);
    } else {
      const b = Buffer.alloc(8);
      b.writeBigInt64LE(n);
      out.push(u32(VT.INT | FLAG_64), b);
    }
  } else if (typeof value === 'number') {
    const b = Buffer.alloc(8);
    b.writeDoubleLE(value);
    out.push(u32(VT.FLOAT | FLAG_64), b);
  } else if (typeof value === 'string') {
    out.push(u32(VT.STRING));
    writeString(value, out);
  } else if (Array.isArray(value)) {
    out.push(u32(VT.ARRAY), u32(value.length));
    for (const v of value) write(v, out, depth + 1);
  } else {
    const entries = Object.entries(value);
    out.push(u32(VT.DICTIONARY), u32(entries.length));
    for (const [k, v] of entries) {
      write(k, out, depth + 1);
      write(v, out, depth + 1);
    }
  }
}

// --- Packet framing -----------------------------------------------------------

/** Debugger packets: uint32 byte length, then one encoded Variant (always an Array). */
export function framePacket(message: Encodable | GodotFloat): Buffer {
  const body = encodeVariant(message);
  return Buffer.concat([u32(body.length), body]);
}

/**
 * Splits a TCP byte stream into decoded packets. Godot's own peer refuses
 * packets above 8 MiB (core/debugger/remote_debugger_peer.cpp); we allow the
 * same, since screenshots and big trees can come close.
 */
export class PacketReader {
  static readonly MAX_PACKET = 8 << 20;
  private pending: Buffer = Buffer.alloc(0);

  /** Feed bytes; returns every complete packet decoded. Throws on a malformed or oversized packet. */
  push(chunk: Buffer): unknown[] {
    this.pending = this.pending.length ? Buffer.concat([this.pending, chunk]) : chunk;
    const out: unknown[] = [];
    while (this.pending.length >= 4) {
      const size = this.pending.readUInt32LE(0);
      if (size > PacketReader.MAX_PACKET) throw new VariantDecodeError(`Debugger packet too large (${size} bytes).`);
      if (this.pending.length < 4 + size) break;
      const body = this.pending.subarray(4, 4 + size);
      this.pending = this.pending.subarray(4 + size);
      out.push(decodeVariant(body).value);
    }
    return out;
  }
}
