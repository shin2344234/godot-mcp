/**
 * Tool results trimmed after the 2D dogfood test (MCP_TEST_LOG Phase A), which found
 * replies full of things nobody asked for: files.list (sidecars and addons/),
 * godot_tools with an empty query (the whole catalog) and export.run's tail (progress
 * lines). No Godot needed.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { catalogIndex } from '../../src/mcp/server.js';
import { ALL_OPERATIONS } from '../../src/ops/catalog.js';
import { PROGRESS_LINE } from '../../src/ops/exports.js';
import { filesList } from '../../src/ops/files.js';
import type { OpContext } from '../../src/ops/types.js';

describe('files.list', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'files-list-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(path.join(dir, 'project.godot'), 'config_version=5\n');
  writeFileSync(path.join(dir, 'player.gd'), 'extends Node\n');
  writeFileSync(path.join(dir, 'player.gd.uid'), 'uid://abc\n');
  writeFileSync(path.join(dir, 'icon.png'), 'x');
  writeFileSync(path.join(dir, 'icon.png.import'), '[remap]\n');
  mkdirSync(path.join(dir, 'addons', 'gut'), { recursive: true });
  writeFileSync(path.join(dir, 'addons', 'gut', 'gut.gd'), 'extends Node\n');
  writeFileSync(path.join(dir, 'addons', 'gut', 'gut.gd.uid'), 'uid://def\n');
  const ctx = { config: { projectPath: dir }, bridge: { isOpen: () => false } } as unknown as OpContext;
  const list = async (args: Record<string, unknown>) =>
    (await filesList.run({ path: 'res://', recursive: true, all: false, max: 500, ...args } as never, ctx)).data as {
      entries: { path: string }[];
      hidden?: number;
      hint?: string;
    };

  it('hides sidecars and addons/ contents by default, and says so', async () => {
    const r = await list({});
    expect(r.entries.map((e) => e.path)).toEqual(['res://addons', 'res://icon.png', 'res://player.gd', 'res://project.godot']);
    expect(r.hidden).toBe(3); // two sidecars + the addons folder
    expect(r.hint).toMatch(/all: true/);
  });

  it('shows everything with all, inside res://addons, or for a sidecar pattern', async () => {
    expect((await list({ all: true })).entries).toHaveLength(9);
    expect((await list({ all: true })).hidden).toBeUndefined();
    const addons = await list({ path: 'res://addons' });
    expect(addons.entries.map((e) => e.path)).toEqual(['res://addons/gut', 'res://addons/gut/gut.gd']);
    const uids = await list({ pattern: '*.uid' });
    expect(uids.entries.map((e) => e.path)).toEqual(['res://player.gd.uid']);
  });
});

describe('godot_tools search without a query', () => {
  it('lists names and titles grouped by area, far smaller than the full catalog', () => {
    const index = catalogIndex(ALL_OPERATIONS);
    expect(index.count).toBe(ALL_OPERATIONS.length);
    expect(index.groups.files).toContain('files.read: Read file (read)');
    expect(index.groups.files).toContain('files.write: Write file');
    const full = JSON.stringify(ALL_OPERATIONS.map((op) => ({ operation: op.name, group: op.group, description: op.description })));
    expect(JSON.stringify(index).length).toBeLessThan(full.length / 3);
  });
});

describe('export.run progress lines', () => {
  it('recognises the lines that only feed progress notifications', () => {
    expect(PROGRESS_LINE.exec('[  42% ] savepack | Storing File: res://icon.svg')?.slice(1)).toEqual(['42', 'savepack | Storing File: res://icon.svg']);
    expect(PROGRESS_LINE.test('[ 100% ] export | Done')).toBe(true);
    expect(PROGRESS_LINE.test('ERROR: Cannot export project with preset "Linux".')).toBe(false);
    expect(PROGRESS_LINE.test('[ DONE ] savepack')).toBe(false);
  });
});
