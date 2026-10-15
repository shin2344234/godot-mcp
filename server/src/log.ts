/**
 * Tiny stderr logger.
 *
 * Why stderr? On the stdio transport, stdout carries the JSON-RPC stream and
 * MUST contain nothing else: a single stray `console.log` corrupts the
 * protocol (this exact bug is a known complaint against other Godot MCP
 * servers). Everything human-readable therefore goes to stderr, which MCP
 * clients typically capture into their own log files.
 *
 * MCP's `logging` capability is deprecated as of spec 2026-07-28 (SEP-2577),
 * so we deliberately do not use it.
 */

type Level = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

// GODOT_MCP_LOG_LEVEL lets users turn on debug output when filing bug reports.
const threshold: number = LEVEL_ORDER[(process.env.GODOT_MCP_LOG_LEVEL as Level) ?? 'info'] ?? LEVEL_ORDER.info;

function write(level: Level, msg: string, extra?: unknown): void {
  if (LEVEL_ORDER[level] < threshold) return;
  const line = `[godot-mcp] ${new Date().toISOString()} ${level.toUpperCase()} ${msg}`;
  if (extra === undefined) {
    process.stderr.write(line + '\n');
  } else {
    // Errors don't JSON.stringify usefully, so print their stack instead.
    const detail = extra instanceof Error ? extra.stack ?? extra.message : safeJson(extra);
    process.stderr.write(`${line} ${detail}\n`);
  }
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export const log = {
  debug: (msg: string, extra?: unknown) => write('debug', msg, extra),
  info: (msg: string, extra?: unknown) => write('info', msg, extra),
  warn: (msg: string, extra?: unknown) => write('warn', msg, extra),
  error: (msg: string, extra?: unknown) => write('error', msg, extra),
};
