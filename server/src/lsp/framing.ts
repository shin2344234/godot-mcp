/**
 * JSON-RPC message framing for the GDScript language server (LSP base protocol).
 *
 * Every message is `Content-Length: N\r\n\r\n<N bytes of UTF-8 JSON>`.
 *
 * Godot quirk (verified against 4.7.2, gdscript_language_protocol.cpp): the server reads
 * the length as `header.substr(16).to_int()`, i.e. it runs String::to_int() over the WHOLE
 * header block after "Content-Length: ". to_int() collects every digit it meets, so an extra
 * `Content-Type: application/vscode-jsonrpc; charset=utf-8` header turns "123" into
 * "1238" and the server waits forever for bytes that never come. We therefore send ONLY the
 * Content-Length header. (Off-the-shelf vscode-jsonrpc writers add Content-Type, which is
 * one reason we don't use them.)
 *
 * Godot rejects messages bigger than LSP_MAX_BUFFER_SIZE (4 MiB); we apply the same cap in
 * both directions so a runaway response can't make us buffer unbounded memory.
 */

/** Same limit as Godot's LSP_MAX_BUFFER_SIZE. */
export const MAX_MESSAGE_BYTES = 4 * 1024 * 1024;

/** Headers longer than this without a blank line mean the stream is garbage. */
const MAX_HEADER_BYTES = 8 * 1024;

export class FramingError extends Error {}

/** Frame one JSON-RPC message (only the Content-Length header; see the file comment). */
export function encodeMessage(message: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(message), 'utf8');
  if (body.length > MAX_MESSAGE_BYTES) {
    throw new FramingError(`LSP message of ${body.length} bytes exceeds the ${MAX_MESSAGE_BYTES}-byte limit of the Godot language server.`);
  }
  return Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, 'ascii'), body]);
}

/**
 * Incremental decoder: feed it socket chunks, get complete parsed messages back.
 * Messages may be split across chunks or several may arrive in one chunk.
 */
export class MessageReader {
  private buf: Buffer = Buffer.alloc(0);

  /**
   * Add bytes and return every message completed by them. Throws FramingError on a
   * malformed or oversized message; the caller should drop the connection then, because
   * the stream can't be resynchronised reliably.
   */
  push(chunk: Buffer): unknown[] {
    this.buf = this.buf.length === 0 ? chunk : Buffer.concat([this.buf, chunk]);
    const out: unknown[] = [];
    for (;;) {
      const headerEnd = this.buf.indexOf('\r\n\r\n');
      if (headerEnd === -1) {
        if (this.buf.length > MAX_HEADER_BYTES) throw new FramingError('LSP header block too long (no blank line found).');
        return out;
      }
      const header = this.buf.subarray(0, headerEnd).toString('ascii');
      // Be lenient on input: any header order and case (only Content-Length matters).
      const m = /(?:^|\r\n)content-length:\s*(\d+)\s*(?:\r\n|$)/i.exec(header);
      if (!m) throw new FramingError(`LSP message without a Content-Length header: ${JSON.stringify(header.slice(0, 200))}`);
      const length = Number(m[1]);
      if (length > MAX_MESSAGE_BYTES) throw new FramingError(`LSP message of ${length} bytes exceeds the ${MAX_MESSAGE_BYTES}-byte limit.`);
      const start = headerEnd + 4;
      if (this.buf.length < start + length) return out;
      const body = this.buf.subarray(start, start + length).toString('utf8');
      this.buf = this.buf.subarray(start + length);
      try {
        out.push(JSON.parse(body));
      } catch {
        throw new FramingError(`LSP message body is not valid JSON: ${body.slice(0, 200)}`);
      }
    }
  }

  /** Bytes buffered but not yet forming a whole message. */
  get pending(): number {
    return this.buf.length;
  }
}
