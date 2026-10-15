/**
 * godot_addon_install: copies the bundled addon into a project and enables
 * it, for clients that install the server without running `godot-mcp init`
 * (Claude Desktop .mcpb bundles, Claude Code plugins). Also covers the
 * empty-env handling those installers rely on.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config.js';
import { addonInstall, godotVersionHint, status } from '../../src/ops/core.js';
import type { OpContext } from '../../src/ops/types.js';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A bare Godot project (just project.godot) in a temp folder. */
function tempProject(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'addon-install-'));
  dirs.push(dir);
  writeFileSync(path.join(dir, 'project.godot'), 'config_version=5\n\n[application]\n\nconfig/name="t"\n');
  return dir;
}

/** Only the context fields these ops read. */
function ctxFor(projectPath: string): OpContext {
  return {
    config: { projectPath },
    bridge: { ensureConnected: async () => false },
    headless: { addonInstalled: () => existsSync(path.join(projectPath, 'addons', 'godot_mcp', 'plugin.cfg')) },
    runs: { list: () => [] },
  } as unknown as OpContext;
}

describe('godot_addon_install', () => {
  it('copies the addon, enables it, and is a no-op the second time', async () => {
    const dir = tempProject();
    const first = (await addonInstall.run({}, ctxFor(dir))).data as Record<string, unknown>;
    expect(first.copied).toBe(true);
    expect(first.plugin_enabled_now).toBe(true);
    expect(existsSync(path.join(dir, 'addons', 'godot_mcp', 'runtime', 'mcp_runtime.gd'))).toBe(true);
    expect(readFileSync(path.join(dir, 'project.godot'), 'utf8')).toContain('res://addons/godot_mcp/plugin.cfg');

    const second = (await addonInstall.run({}, ctxFor(dir))).data as Record<string, unknown>;
    expect(second).toMatchObject({ copied: false, plugin_enabled_now: false });
  });

  it('asks before replacing an installed addon, not before a fresh install', async () => {
    const dir = tempProject();
    expect(await addonInstall.confirm!({}, ctxFor(dir))).toBeUndefined();
    await addonInstall.run({}, ctxFor(dir));
    expect(await addonInstall.confirm!({}, ctxFor(dir))).toMatch(/Replace/);
  });

  it('godot_status points at it while the addon is missing or outdated', async () => {
    const dir = tempProject();
    const missing = (await status.run({}, ctxFor(dir))).data as Record<string, unknown>;
    expect(missing.addon_hint).toMatch(/godot_addon_install/);
    await addonInstall.run({}, ctxFor(dir));
    const cfg = path.join(dir, 'addons', 'godot_mcp', 'plugin.cfg');
    writeFileSync(cfg, readFileSync(cfg, 'utf8').replace(/version="[^"]+"/, 'version="0.0.1"'));
    const old = (await status.run({}, ctxFor(dir))).data as Record<string, unknown>;
    expect(old.addon_hint).toMatch(/0\.0\.1/);
  });
});

describe('empty environment values', () => {
  it('are treated as unset', () => {
    const c = loadConfig([], { GODOT_PATH: '', GODOT_BIN: '/opt/godot', GODOT_PROJECT_PATH: '  ' });
    expect(c.godotPath).toBe('/opt/godot');
    expect(c.projectPath).toBe(path.resolve(process.cwd()));
  });
});

describe('godot version hint', () => {
  it('warns below 4.7 only', () => {
    expect(godotVersionHint('4.5.1.stable.official.f62fdbde1').godot_hint).toMatch(/older than 4\.7/);
    expect(godotVersionHint('4.7.2.stable.official.ed1daf0bf')).toEqual({});
    expect(godotVersionHint('5.0.stable')).toEqual({});
    expect(godotVersionHint(undefined)).toEqual({});
  });
});
