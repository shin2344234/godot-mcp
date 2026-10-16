/**
 * Protocol-level tests that need no Godot: tool listing in both protocol
 * eras, modes, and the file tools.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { errorText, json, makeMiniProject, startServer } from './helpers.js';

const mini = makeMiniProject();
afterAll(() => mini.cleanup());

describe.each(['legacy', 'modern'] as const)('protocol era: %s', (era) => {
  let client: Awaited<ReturnType<typeof startServer>>;
  beforeAll(async () => {
    client = await startServer({ project: mini.dir, era });
  });
  afterAll(async () => {
    await client.close();
  });

  it('lists tools in a deterministic order with annotations', async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    expect(names[0]).toBe('godot_status');
    expect(names).toContain('godot_node_add');
    expect(names).toContain('godot_tools');
    const status = tools.find((t) => t.name === 'godot_status')!;
    expect(status.annotations?.readOnlyHint).toBe(true);
    expect(status._meta?.['anthropic/alwaysLoad']).toBe(true);
    const del = tools.find((t) => t.name === 'godot_files_delete')!;
    expect(del.annotations?.destructiveHint).toBe(true);
  });

  it('reads project facts', async () => {
    const info = json(await client.callTool({ name: 'godot_project_info', arguments: {} }));
    expect(info.name).toBe('Mini');
    expect(info.godotVersion).toBe('4.7');
    expect(info.autoloads).toEqual([{ name: 'Game', path: 'res://game.gd', singleton: true }]);
    expect(info.inputActions).toEqual(['jump']);
  });

  it('writes, edits, reads and searches files inside the project', async () => {
    json(await client.callTool({ name: 'godot_files_write', arguments: { path: `res://notes_${era}.txt`, content: 'alpha\nbeta\n' } }));
    json(await client.callTool({ name: 'godot_files_edit', arguments: { path: `res://notes_${era}.txt`, old_text: 'beta', new_text: 'gamma' } }));
    const read = json(await client.callTool({ name: 'godot_files_read', arguments: { path: `res://notes_${era}.txt` } }));
    expect(read.content).toContain('gamma');
    const found = json(await client.callTool({ name: 'godot_files_search', arguments: { query: 'gamma' } }));
    expect(found.matches.some((m: { path: string }) => m.path === `res://notes_${era}.txt`)).toBe(true);
  });

  it('godot_tools search without a query returns a compact index', async () => {
    const index = json(await client.callTool({ name: 'godot_tools', arguments: { action: 'search' } }));
    expect(index.groups.files).toContain('files.read: Read file (read)');
    expect(index.operations).toBeUndefined();
    expect(index.count).toBeGreaterThan(50);
  });

  it('refuses paths outside the project', async () => {
    const res = await client.callTool({ name: 'godot_files_read', arguments: { path: '../../etc/passwd' } });
    expect(errorText(res)).toMatch(/escapes the project/);
  });

  it('gives an actionable error when scene tools have no backend', async () => {
    const res = await client.callTool({ name: 'godot_scene_tree', arguments: {} });
    expect(errorText(res)).toMatch(/pass "scene"/);
  });
});

describe('compact mode', () => {
  it('exposes core tools plus routers, and routes calls', async () => {
    const client = await startServer({ project: mini.dir, args: ['--mode', 'compact'] });
    try {
      const names = (await client.listTools()).tools.map((t) => t.name);
      expect(names).toContain('godot_call_read');
      expect(names).toContain('godot_call_write');
      expect(names).not.toContain('godot_files_search');

      const search = json(await client.callTool({ name: 'godot_tools', arguments: { action: 'search', query: 'search' } }));
      expect(search.operations.map((o: { operation: string }) => o.operation)).toContain('files.search');

      const routed = json(await client.callTool({ name: 'godot_call_read', arguments: { operation: 'files.search', args: { query: 'print' } } }));
      expect(routed.count).toBeGreaterThan(0);

      // Wrong router for the operation's kind.
      expect(errorText(await client.callTool({ name: 'godot_call_read', arguments: { operation: 'files.delete', args: { path: 'game.gd' } } }))).toMatch(/godot_call_write/);
      // Bad args are explained with the schema.
      expect(errorText(await client.callTool({ name: 'godot_call_read', arguments: { operation: 'files.search', args: {} } }))).toMatch(/input_schema/);
    } finally {
      await client.close();
    }
  });

  it('read-only mode hides write tools', async () => {
    const client = await startServer({ project: mini.dir, args: ['--read-only'] });
    try {
      const names = (await client.listTools()).tools.map((t) => t.name);
      expect(names).not.toContain('godot_files_write');
      expect(names).toContain('godot_files_read');
    } finally {
      await client.close();
    }
  });
});
