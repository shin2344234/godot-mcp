/**
 * Regression tests for the bugs the Codex review (vet) found in 0.1.0 and the verifier
 * reproduced. Each block names the finding it covers; the full report is
 * /mnt/project-files/release/vet-review-0.1.0.md in the project files.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RunManager } from '../../src/godot/runs.js';
import { runProcess } from '../../src/godot/headless.js';
import { assertNoResEscape, resPathEscapes } from '../../src/ops/backend.js';
import { filesEdit, filesList, filesSearch } from '../../src/ops/files.js';
import type { OpContext } from '../../src/ops/types.js';

const dirs: string[] = [];
function tempDir(prefix: string): string {
  const d = mkdtempSync(path.join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

/** The smallest OpContext the file operations need (no editor connected). */
function fileCtx(projectPath: string): OpContext {
  return { config: { projectPath }, bridge: { isOpen: () => false } } as unknown as OpContext;
}

// Finding 1: res://../x.tscn passed Godot's simplify_path() check.
describe('res:// paths that escape the project', () => {
  it('detects a .. that climbs above the root', () => {
    expect(resPathEscapes('res://../x.tscn')).toBe(true);
    expect(resPathEscapes('res://a/../../x.tscn')).toBe(true);
    expect(resPathEscapes('res://./../x')).toBe(true);
    expect(resPathEscapes('res://..')).toBe(true);
    expect(resPathEscapes('res:\\\\..\\x.tscn')).toBe(true);
  });
  it('allows paths that stay inside', () => {
    expect(resPathEscapes('res://a/../x.tscn')).toBe(false);
    expect(resPathEscapes('res://levels/level_1.tscn')).toBe(false);
    expect(resPathEscapes('res://..foo/x.tscn')).toBe(false); // a folder named "..foo"
    expect(resPathEscapes('Player/Sprite2D')).toBe(false); // node paths aren't res:// paths
  });
  it('checks nested values such as a texture inside properties', () => {
    expect(() => assertNoResEscape({ scene: 'res://main.tscn', properties: { texture: 'res://../secret.png' } })).toThrow(/escapes the project/);
    expect(() => assertNoResEscape({ scene: 'res://main.tscn', ops: [{ path: 'res://ok.tres' }] })).not.toThrow();
  });
});

// Finding 2: files.search / recursive files.list followed links out of the project.
// Folder links are junctions on Windows: they need no special rights (real symlinks need
// Developer Mode or admin) and are what the review reproduced the bug with. The setup
// runs in beforeAll, not in the describe body, so it never runs during test collection.
describe('file walks and links', () => {
  const dirLink = process.platform === 'win32' ? 'junction' : 'dir';
  let ctx: OpContext;
  /** False where file symlinks need rights this machine doesn't have (Windows EPERM). */
  let fileLinks = true;

  beforeAll(() => {
    const outside = tempDir('godot-mcp-outside-');
    writeFileSync(path.join(outside, 'secret.gd'), 'var token = "OUTSIDE_SECRET"\n');
    const proj = tempDir('godot-mcp-proj-');
    writeFileSync(path.join(proj, 'project.godot'), '');
    writeFileSync(path.join(proj, 'inside.gd'), 'var token = "INSIDE"\n');
    mkdirSync(path.join(proj, 'sub'));
    symlinkSync(outside, path.join(proj, 'sub', 'out'), dirLink); // a folder link leaving the project
    symlinkSync(path.join(proj, 'sub'), path.join(proj, 'sub', 'loop'), dirLink); // a link back to its parent
    try {
      symlinkSync(path.join(proj, 'inside.gd'), path.join(proj, 'alias.gd')); // a link that stays inside
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EPERM') throw err;
      fileLinks = false;
    }
    ctx = fileCtx(proj);
  });

  it('files.search skips links that leave the project', async () => {
    const res = (await filesSearch.run({ query: 'token', regex: false, case_sensitive: false, path: 'res://', max_results: 100 } as never, ctx)).data as {
      matches: { path: string; text: string }[];
    };
    const texts = res.matches.map((m) => m.text).join('\n');
    expect(texts).not.toContain('OUTSIDE_SECRET');
    const paths = res.matches.map((m) => m.path);
    expect(paths).toContain('res://inside.gd');
    if (fileLinks) expect(paths).toContain('res://alias.gd');
  });

  it('files.list does not walk outside the project or loop', async () => {
    const res = (await filesList.run({ path: 'res://', recursive: true, all: true, max: 500 } as never, ctx)).data as { entries: { path: string }[] };
    const paths = res.entries.map((e) => e.path);
    expect(paths.some((p) => p.includes('secret.gd'))).toBe(false);
    if (fileLinks) expect(paths).toContain('res://alias.gd');
    expect(paths.length).toBeLessThan(20); // no endless sub/loop/loop/... recursion
  });
});

// Finding 5: multi-line files.edit never matched a CRLF file.
describe('files.edit on CRLF files', () => {
  it('matches multi-line text copied from files.read and keeps CRLF', async () => {
    const proj = tempDir('godot-mcp-crlf-');
    writeFileSync(path.join(proj, 'project.godot'), '');
    const file = path.join(proj, 'player.gd');
    writeFileSync(file, 'extends Node\r\n\r\nfunc _ready():\r\n\tpass\r\n');
    // files.read shows lines without "\r", so this is what an agent copies.
    await filesEdit.run({ path: 'res://player.gd', old_text: 'func _ready():\n\tpass', new_text: 'func _ready():\n\tprint("hi")', replace_all: false } as never, fileCtx(proj));
    expect(readFileSync(file, 'utf8')).toBe('extends Node\r\n\r\nfunc _ready():\r\n\tprint("hi")\r\n');
  });
});

// Finding 4: UTF-8 characters split across pipe chunks came back as U+FFFD.
describe('process output decoding', () => {
  it('keeps multi-byte characters intact across chunk boundaries', async () => {
    // Write one byte at a time, so every multi-byte character is split between chunks.
    const script = "const b = Buffer.from('Señor ✓ 日本 '.repeat(50)); let i = 0; const t = setInterval(() => { if (i >= b.length) { clearInterval(t); return; } process.stdout.write(b.subarray(i, i + 1)); i++; }, 0);";
    const res = await runProcess(process.execPath, ['-e', script], { timeoutMs: 60_000 });
    expect(res.stdout).not.toContain('�');
    expect(res.stdout).toBe('Señor ✓ 日本 '.repeat(50));
  }, 70_000);
});

// Finding 3: a Godot binary that can't be started crashed the server.
describe('starting a game with a missing Godot binary', () => {
  it('marks the run finished instead of throwing an unhandled error', async () => {
    const proj = tempDir('godot-mcp-nogodot-');
    writeFileSync(path.join(proj, 'project.godot'), '');
    const runs = new RunManager();
    const run = await runs.start(path.join(proj, 'no-such-godot'), proj, { headless: true });
    // 'error' is emitted asynchronously; give it a moment.
    for (let i = 0; i < 50 && run.running; i++) await new Promise((r) => setTimeout(r, 20));
    expect(run.running).toBe(false);
    runs.stopAll();
  });
});
