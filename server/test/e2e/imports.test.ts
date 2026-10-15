/**
 * E2E: import.get / import.set (addons/godot_mcp/ops/import_ops.gd plus the
 * headless reimport in src/ops/imports.ts), headless and through a live
 * headless editor. Uses the sample project's icon.svg. Skipped without
 * GODOT_BIN.
 */

import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { copySampleProject, errorText, GODOT_BIN, json, killAndWait, startServer } from './helpers.js';

const enabled = Boolean(GODOT_BIN);

function importProject(dir: string): void {
  spawnSync(GODOT_BIN!, ['--headless', '--path', dir, '--import'], { timeout: 180_000, stdio: 'ignore' });
}

describe.skipIf(!enabled)('imports (headless)', () => {
  const proj = copySampleProject();
  let client: Awaited<ReturnType<typeof startServer>>;
  const call = async (name: string, args: Record<string, unknown>) => client.callTool({ name, arguments: args });

  beforeAll(async () => {
    importProject(proj.dir);
    client = await startServer({ project: proj.dir });
  }, 240_000);
  afterAll(async () => {
    await client?.close();
    await proj.cleanup();
  });

  it('reads import settings', async () => {
    const r = json(await call('godot_import_get', { path: 'res://icon.svg' }));
    expect(r).toMatchObject({ importer: 'texture', type: 'CompressedTexture2D', imported: true, backend: 'headless' });
    expect(r.uid).toMatch(/^uid:\/\//);
    expect(r.options['mipmaps/generate']).toBe(false);
    expect(r.dest_files[0].exists).toBe(true);
  }, 60_000);

  it('changes options and reimports with godot --import', async () => {
    const r = json(await call('godot_import_get', { path: 'res://icon.svg' }));
    const dest = path.join(proj.dir, r.dest_files[0].path.replace('res://', ''));
    const before = statSync(dest).mtimeMs;
    const set = json(await call('godot_import_set', { path: 'res://icon.svg', options: { 'mipmaps/generate': true, 'svg/scale': 2 } }));
    expect(set.reimport).toBe('done');
    expect(set.changed).toEqual({ 'mipmaps/generate': true, 'svg/scale': 2 });
    expect(set.options['mipmaps/generate']).toBe(true);
    expect(set.imported).toBe(true);
    expect(statSync(dest).mtimeMs).toBeGreaterThan(before);
    expect(readFileSync(path.join(proj.dir, 'icon.svg.import'), 'utf8')).toContain('mipmaps/generate=true');
  }, 300_000);

  it('imports a never-imported asset itself before reading or changing it', async () => {
    // A freshly written file in a new folder: no .import yet (the MCP_TEST_LOG case).
    mkdirSync(path.join(proj.dir, 'fresh'), { recursive: true });
    copyFileSync(path.join(proj.dir, 'icon.svg'), path.join(proj.dir, 'fresh', 'a.svg'));
    const got = json(await call('godot_import_get', { path: 'res://fresh/a.svg' }));
    expect(got).toMatchObject({ importer: 'texture', imported: true, backend: 'headless' });
    expect(existsSync(path.join(proj.dir, 'fresh', 'a.svg.import'))).toBe(true);
    // Written after that import pass, so import.set meets a missing .import too.
    copyFileSync(path.join(proj.dir, 'icon.svg'), path.join(proj.dir, 'fresh', 'b.svg'));
    const set = json(await call('godot_import_set', { path: 'res://fresh/b.svg', options: { 'svg/scale': 2 } }));
    expect(set).toMatchObject({ reimport: 'done', imported: true, changed: { 'svg/scale': 2 } });
  }, 300_000);

  it('rejects unknown options, bad importers and non-imported files', async () => {
    const opt = errorText(await call('godot_import_set', { path: 'res://icon.svg', options: { 'mipmap/generate': true } }));
    expect(opt).toMatch(/Did you mean: mipmaps\/generate/);
    const imp = errorText(await call('godot_import_set', { path: 'res://icon.svg', importer: 'wav' }));
    expect(imp).toMatch(/texture, image/);
    const typed = errorText(await call('godot_import_set', { path: 'res://icon.svg', options: { 'svg/scale': 'big' } }));
    expect(typed).toMatch(/svg\/scale/);
    const scene = errorText(await call('godot_import_get', { path: 'res://main.tscn' }));
    expect(scene).toMatch(/not imported.*resource\.read/);
  }, 60_000);
});

describe.skipIf(!enabled)('imports (editor)', () => {
  const proj = copySampleProject();
  let client: Awaited<ReturnType<typeof startServer>>;
  const call = async (name: string, args: Record<string, unknown>) => client.callTool({ name, arguments: args });

  beforeAll(async () => {
    importProject(proj.dir);
    client = await startServer({ project: proj.dir });
    const launched = json(await call('godot_editor_launch', { headless: true, wait_seconds: 90 }));
    expect(launched.editor ?? launched.connected).toBeTruthy();
  }, 240_000);
  afterAll(async () => {
    await client?.close();
    try {
      const session = JSON.parse(readFileSync(path.join(proj.dir, '.godot', 'godot_mcp', 'session.json'), 'utf8'));
      await killAndWait(session.pid);
    } catch {
      // the editor never came up
    }
    await proj.cleanup();
  });

  it('reimports through the editor filesystem', async () => {
    const set = json(await call('godot_import_set', { path: 'res://icon.svg', options: { 'process/fix_alpha_border': false } }));
    expect(set.backend).toBe('editor');
    expect(set.reimport).toBe('done');
    expect(set.options['process/fix_alpha_border']).toBe(false);
    expect(set.imported).toBe(true);
    expect(readFileSync(path.join(proj.dir, 'icon.svg.import'), 'utf8')).toContain('process/fix_alpha_border=false');
  }, 120_000);

  it('imports a new asset through an editor filesystem scan', async () => {
    mkdirSync(path.join(proj.dir, 'fresh_editor'), { recursive: true });
    copyFileSync(path.join(proj.dir, 'icon.svg'), path.join(proj.dir, 'fresh_editor', 'c.svg'));
    const got = json(await call('godot_import_get', { path: 'res://fresh_editor/c.svg' }));
    expect(got).toMatchObject({ backend: 'editor', importer: 'texture', imported: true });
  }, 120_000);
});
