/**
 * Test helpers: start the real server over stdio (through tsx, so tests run
 * against the TypeScript source) and connect an MCP client to it.
 */

import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { cpSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const SERVER_ROOT = path.resolve(here, '..', '..');
export const REPO_ROOT = path.resolve(SERVER_ROOT, '..');
export const SAMPLE_PROJECT = path.join(REPO_ROOT, 'examples', 'sample_project');
const TSX = path.join(SERVER_ROOT, 'node_modules', '.bin', 'tsx');

/** Godot binary for e2e tests (tests needing Godot are skipped without it). */
export const GODOT_BIN = process.env.GODOT_BIN ?? process.env.GODOT_PATH;

/**
 * Delete a temp project folder.
 *
 * On Windows a Godot process we just killed can keep file handles open for a
 * moment, so a plain rmSync fails with EPERM/EBUSY. Node's rmSync retries
 * those errors when maxRetries is set (with linear backoff), which covers the
 * gap without slowing down Linux/macOS, where the first attempt succeeds.
 */
export function removeDir(dir: string): void {
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}

/**
 * Kill a process and wait (up to timeoutMs) until it has actually exited.
 * process.kill(pid, 0) throws ESRCH once the pid is gone; it sends no signal.
 */
export async function killAndWait(pid: number, timeoutMs = 10_000): Promise<void> {
  try {
    process.kill(pid);
  } catch {
    return; // already gone
  }
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch {
      return;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
}

export type Era = 'legacy' | 'modern';

export async function startServer(opts: { project: string; era?: Era; env?: Record<string, string>; args?: string[] }) {
  const transport = new StdioClientTransport({
    command: TSX,
    args: [path.join(SERVER_ROOT, 'src', 'index.ts'), '--project', opts.project, ...(opts.args ?? [])],
    env: { ...(process.env as Record<string, string>), GODOT_MCP_LOG_LEVEL: 'warn', ...(GODOT_BIN ? { GODOT_PATH: GODOT_BIN } : {}), ...opts.env },
    stderr: 'inherit',
  });
  const client = new Client(
    { name: 'godot-mcp-tests', version: '0.0.0' },
    opts.era === 'modern' ? { versionNegotiation: { mode: { pin: '2026-07-28' } } } : {},
  );
  await client.connect(transport);
  return client;
}

/** A throwaway project folder with just a project.godot (no Godot needed). */
export function makeMiniProject(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'godot-mcp-mini-'));
  writeFileSync(
    path.join(dir, 'project.godot'),
    [
      'config_version=5',
      '',
      '[application]',
      'config/name="Mini"',
      'run/main_scene="res://main.tscn"',
      'config/features=PackedStringArray("4.7", "Forward Plus")',
      '',
      '[autoload]',
      'Game="*res://game.gd"',
      '',
      '[input]',
      'jump={',
      '"deadzone": 0.2,',
      '"events": []',
      '}',
      '',
    ].join('\n'),
  );
  writeFileSync(path.join(dir, 'game.gd'), 'extends Node\n\nfunc _ready() -> void:\n\tprint("hi")\n');
  return { dir, cleanup: () => removeDir(dir) };
}

/** Copy the sample project (with the addon synced in) to a temp folder. */
export function copySampleProject(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'godot-mcp-sample-'));
  cpSync(SAMPLE_PROJECT, dir, { recursive: true });
  // The addon lives at the repo root; the sample project gets a copy.
  cpSync(path.join(REPO_ROOT, 'addons', 'godot_mcp'), path.join(dir, 'addons', 'godot_mcp'), { recursive: true });
  return { dir, cleanup: () => removeDir(dir) };
}

/** Parse the JSON text block of a tool result. */
export function json(result: unknown): any {
  const r = result as { content: { type: string; text?: string }[]; isError?: boolean };
  const text = r.content.find((c) => c.type === 'text')?.text ?? '';
  if (r.isError) throw new Error(`Tool returned error: ${text}`);
  return JSON.parse(text);
}

export function errorText(result: unknown): string {
  const r = result as { content: { type: string; text?: string }[]; isError?: boolean };
  if (!r.isError) throw new Error('Expected an error result');
  return r.content.find((c) => c.type === 'text')?.text ?? '';
}
