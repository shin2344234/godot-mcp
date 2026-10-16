/**
 * End-to-end tests for the export tools (export.presets, export.preset_set,
 * export.run) against real Godot.
 *
 *   GODOT_BIN=/path/to/godot npx vitest run test/e2e/exports.test.ts
 *
 * The temp project gets a minimal Linux export_presets.cfg (never the sample
 * project itself). The test machine may or may not have export templates:
 * pack exports never need them, and release exports are checked for the
 * "templates missing" fast failure when they are absent.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { templateFile, templateVersion } from '../../src/ops/exports.js';
import { copySampleProject, errorText, GODOT_BIN, json, killAndWait, startServer } from './helpers.js';

const enabled = Boolean(GODOT_BIN);

function importProject(dir: string): void {
  spawnSync(GODOT_BIN!, ['--headless', '--path', dir, '--import'], { timeout: 180_000, stdio: 'ignore' });
}

/** A Linux preset as a hand-written file would have it, plus an inline secret to redact. */
const PRESETS = `[preset.0]

name="Linux"
platform="Linux"
runnable=true
export_filter="all_resources"
include_filter=""
exclude_filter=""
export_path="build/game.x86_64"

[preset.0.options]

binary_format/embed_pck=false
binary_format/architecture="x86_64"
keystore/release_password="hunter2"
`;

const presetsFile = (dir: string) => readFileSync(path.join(dir, 'export_presets.cfg'), 'utf8');

describe('export helpers', () => {
  it('derives the template folder and file names', () => {
    expect(templateVersion('4.7.2.stable.official.ed1daf0bf')).toBe('4.7.2.stable');
    expect(templateVersion('4.7.stable.mono.official.abc')).toBe('4.7.stable.mono');
    expect(templateFile('Linux', 'release')).toBe('linux_release.x86_64');
    expect(templateFile('Windows Desktop', 'debug', { 'binary_format/architecture': 'arm64' })).toBe('windows_debug_arm64.exe');
    expect(templateFile('Web', 'release', { 'variant/thread_support': false })).toBe('web_nothreads_release.zip');
  });
});

describe.skipIf(!enabled)('export tools (headless)', () => {
  const proj = copySampleProject();
  let client: Awaited<ReturnType<typeof startServer>>;
  const call = async (name: string, args: Record<string, unknown>) => client.callTool({ name, arguments: args });

  beforeAll(async () => {
    importProject(proj.dir);
    client = await startServer({ project: proj.dir, era: 'modern' });
  }, 240_000);
  afterAll(async () => {
    await client?.close();
    await proj.cleanup();
  });

  it('export.presets reports a project without presets', async () => {
    const res = json(await call('godot_export_presets', {}));
    expect(res.exists).toBe(false);
    expect(res.hint).toContain('export.preset_set');
    expect(res.templates.version).toMatch(/^4\.\d+(\.\d+)?\.\w+/);
  }, 60_000);

  it('export.presets lists presets with secrets redacted', async () => {
    writeFileSync(path.join(proj.dir, 'export_presets.cfg'), PRESETS);
    const list = json(await call('godot_export_presets', {}));
    expect(list.presets).toHaveLength(1);
    expect(list.presets[0]).toMatchObject({ name: 'Linux', platform: 'Linux', runnable: true, export_path: 'build/game.x86_64' });
    expect(JSON.stringify(list)).not.toContain('hunter2');

    const one = json(await call('godot_export_presets', { preset: 'Linux' }));
    expect(one.preset.options['keystore/release_password']).toBe('<redacted>');
    expect(one.preset.redacted).toContain('options/keystore/release_password');
    expect(JSON.stringify(one)).not.toContain('hunter2');
    if (!one.templates.installed) expect(one.preset.templates_missing).toContain('linux_release.x86_64');

    expect(errorText(await call('godot_export_presets', { preset: 'Linx' }))).toContain('Did you mean: Linux');
  }, 60_000);

  it('export.preset_set edits fields and options in place', async () => {
    const res = json(await call('godot_export_preset_set', { preset: 'Linux', set: { export_path: 'build/linux/game.x86_64', 'binary_format/embed_pck': 'true', runnable: true } }));
    expect(res.changed['options/binary_format/embed_pck']).toBe(true);
    const text = presetsFile(proj.dir);
    expect(text).toContain('export_path="build/linux/game.x86_64"');
    expect(text).toContain('binary_format/embed_pck=true');
    // 4.7 layout: runnable lives in [runnable_presets], the legacy key is dropped.
    expect(text).toContain('[runnable_presets]\n\nLinux="Linux"');
    expect(text).not.toContain('runnable=true');
    // The inline secret is preserved on disk (we don't touch what we didn't change).
    expect(text).toContain('keystore/release_password="hunter2"');
    expect(JSON.stringify(res)).not.toContain('hunter2');
  }, 60_000);

  it('export.preset_set creates presets and refuses typos and credentials', async () => {
    const created = json(await call('godot_export_preset_set', { create: { name: 'Web', platform: 'web' }, set: { export_path: 'build/web/index.html' } }));
    expect(created.created).toBe(true);
    expect(created.preset).toMatchObject({ index: 1, name: 'Web', platform: 'Web', export_path: 'build/web/index.html' });
    expect(presetsFile(proj.dir)).toContain('[preset.1]\n\nname="Web"\nplatform="Web"');
    // A new preset has every platform option with its default (export_defaults.cfg), so
    // documented keys work in the same call (MCP_TEST_LOG: embed_pck was rejected).
    expect(presetsFile(proj.dir)).toContain('variant/thread_support=false');
    const linux = json(
      await call('godot_export_preset_set', { create: { name: 'Linux ARM', platform: 'Linux' }, set: { 'binary_format/embed_pck': true, 'binary_format/architecture': 'arm64' } }),
    );
    expect(linux.changed).toEqual({ 'options/binary_format/embed_pck': true, 'options/binary_format/architecture': 'arm64' });
    expect(presetsFile(proj.dir)).toMatch(/\[preset\.2\.options\][^[]*texture_format\/s3tc_bptc=true[^[]*binary_format\/architecture="arm64"/);
    expect(errorText(await call('godot_export_preset_set', { preset: 'Linux ARM', set: { 'binary_format/embedpck': true } }))).toContain('Did you mean');

    expect(errorText(await call('godot_export_preset_set', { create: { name: 'Web', platform: 'Web' } }))).toContain('already exists');
    expect(errorText(await call('godot_export_preset_set', { create: { name: 'X', platform: 'Amiga' } }))).toContain('Valid platforms');
    expect(errorText(await call('godot_export_preset_set', { preset: 'Linux', set: { 'binary_format/embedpck': true } }))).toContain('Did you mean: binary_format/embed_pck');
    expect(errorText(await call('godot_export_preset_set', { preset: 'Linux', set: { 'keystore/release_password': 'x' } }))).toContain('export_credentials.cfg');
    // A secret option the preset has (a created preset has every option) still needs allow_secrets;
    // on the hand-written 'Linux' preset, which lacks it, the unknown-option check comes first.
    expect(errorText(await call('godot_export_preset_set', { preset: 'Linux ARM', set: { 'ssh_remote_deploy/host': 'me@host' } }))).toContain('allow_secrets');
    expect(errorText(await call('godot_export_preset_set', { preset: 'Linux', set: { 'ssh_remote_deploy/host': 'me@host' } }))).toContain('allow_new_keys');
    // An unknown name containing "key" is a typo first, not a secret (MCP_TEST_LOG Phase A).
    const bogus = errorText(await call('godot_export_preset_set', { preset: 'Linux', set: { bogus_key: 1 } }));
    expect(bogus).toContain("has no option 'bogus_key'");
    expect(bogus).not.toContain('looks like a secret');
    expect(errorText(await call('godot_export_preset_set', { preset: 'Linux', set: { export_filter: 'everything' } }))).toContain('all_resources');
  }, 60_000);

  it('export.run release fails fast and clearly without templates', async () => {
    const presets = json(await call('godot_export_presets', {}));
    if (presets.templates.installed) return; // this machine has templates; nothing to check
    const err = errorText(await call('godot_export_run', { preset: 'Linux', mode: 'release' }));
    expect(err).toContain('Export templates for Godot');
    expect(err).toContain('Manage Export Templates');
    expect(err).toContain('linux_release.x86_64');
  }, 60_000);

  it('export.run pack writes a .pck without templates', async () => {
    const res = json(await call('godot_export_run', { preset: 'Linux', mode: 'pack', output: 'build/game.pck' }));
    expect(res.exit_code).toBe(0);
    expect(res.output).toBe('res://build/game.pck');
    expect(res.files).toHaveLength(1);
    expect(res.files[0].size).toBeGreaterThan(1000);
    expect(statSync(path.join(proj.dir, 'build', 'game.pck')).size).toBe(res.files[0].size);
    // Per-file progress lines feed progress notifications, not the tail (MCP_TEST_LOG Phase A).
    expect(res.tail.filter((l: string) => /Storing File|^\[\s*\d+%/.test(l))).toEqual([]);
  }, 600_000);

  it('export.run validates preset and output', async () => {
    expect(errorText(await call('godot_export_run', { preset: 'Linx', mode: 'pack' }))).toContain('Did you mean: Linux');
    expect(errorText(await call('godot_export_run', { preset: 'Linux', mode: 'pack', output: 'build/game.exe' }))).toContain('.pck or .zip');
    expect(errorText(await call('godot_export_run', { preset: 'Linux', mode: 'pack', output: '/tmp/elsewhere/game.pck' }))).toContain('allow_outside_project');
    expect(errorText(await call('godot_export_run', { preset: 'Linux', mode: 'pack', output: '../escape.pck' }))).toMatch(/escapes the project/);
  }, 120_000);
});

describe.skipIf(!enabled)('export tools (editor open)', () => {
  const proj = copySampleProject();
  let client: Awaited<ReturnType<typeof startServer>>;
  const call = async (name: string, args: Record<string, unknown>) => client.callTool({ name, arguments: args });
  const sessionPath = path.join(proj.dir, '.godot', 'godot_mcp', 'session.json');

  beforeAll(async () => {
    writeFileSync(path.join(proj.dir, 'export_presets.cfg'), PRESETS);
    importProject(proj.dir);
    client = await startServer({ project: proj.dir, era: 'legacy' });
    const launched = json(await call('godot_editor_launch', { headless: true, wait_seconds: 90 }));
    expect(launched.editor ?? launched.connected).toBeTruthy();
  }, 240_000);

  afterAll(async () => {
    await client?.close();
    try {
      const session = JSON.parse(readFileSync(sessionPath, 'utf8'));
      await killAndWait(session.pid);
    } catch {
      // the editor never came up
    }
    await proj.cleanup();
  });

  it('export.preset_set writes the file and asks the editor to reload its presets', async () => {
    const res = json(await call('godot_export_preset_set', { preset: 0, set: { export_path: 'build/editor/game.x86_64' } }));
    expect(res.backend).toBe('editor');
    expect(res.editor_reloaded).toBe(true);
    expect(presetsFile(proj.dir)).toContain('export_path="build/editor/game.x86_64"');
    const list = json(await call('godot_export_presets', {}));
    expect(list.presets[0].export_path).toBe('build/editor/game.x86_64');
  }, 60_000);

  it('export.run works while the editor is open and keeps its session file', async () => {
    const sessionBefore = readFileSync(sessionPath, 'utf8');
    const res = json(await call('godot_export_run', { preset: 'Linux', mode: 'pack', output: 'build/editor/game.zip' }));
    expect(res.exit_code).toBe(0);
    expect(existsSync(path.join(proj.dir, 'build', 'editor', 'game.zip'))).toBe(true);
    expect(readFileSync(sessionPath, 'utf8')).toBe(sessionBefore);
    const status = json(await call('godot_status', {}));
    expect(status.editor_connected).toBe(true);
  }, 600_000);

  it('left no addon errors in the editor log', async () => {
    const logs = json(await call('godot_editor_logs', { level: 'error' }));
    const ours = logs.entries.filter((e: unknown) => JSON.stringify(e).includes('addons/godot_mcp'));
    expect(ours).toEqual([]);
  });
});
