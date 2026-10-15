/**
 * End-to-end tests for docs.search / docs.class against the real Godot binary.
 *
 *   GODOT_BIN=/path/to/godot npx vitest run test/e2e/docs.test.ts
 *
 * The project copy is NOT imported and no editor runs: the docs tools need only the
 * binary. GODOT_MCP_CACHE_DIR points at a temp folder so the index is built from scratch
 * (and the cache file can be checked) without touching the user's real cache.
 */

import { existsSync, mkdtempSync, readdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { copySampleProject, errorText, GODOT_BIN, json, removeDir, startServer } from './helpers.js';

const enabled = Boolean(GODOT_BIN);

describe.skipIf(!enabled)('docs tools', () => {
  const proj = copySampleProject();
  const cache = mkdtempSync(path.join(os.tmpdir(), 'godot-mcp-docs-cache-'));
  let client: Awaited<ReturnType<typeof startServer>>;
  const call = async (name: string, args: Record<string, unknown>) => client.callTool({ name, arguments: args });

  beforeAll(async () => {
    client = await startServer({ project: proj.dir, era: 'modern', env: { GODOT_MCP_CACHE_DIR: cache } });
  }, 60_000);
  afterAll(async () => {
    await client?.close();
    await proj.cleanup();
    await removeDir(cache);
  });

  it('builds the index on first use and finds move_and_slide on CharacterBody2D', async () => {
    const r = json(await call('godot_docs_search', { query: 'move_and_slide' }));
    expect(r.godot_version).toMatch(/^4\.\d/);
    expect(r.hits[0]).toMatchObject({ member: 'move_and_slide', kind: 'method' });
    expect(r.hits.map((h: { class: string }) => h.class)).toContain('CharacterBody2D');
    // Cached per Godot version under the cache dir.
    const versions = readdirSync(path.join(cache, 'docs'));
    expect(versions).toHaveLength(1);
    expect(existsSync(path.join(cache, 'docs', versions[0]!, 'index-v1.json.gz'))).toBe(true);
    // Docs need no import and no editor.
    expect(existsSync(path.join(proj.dir, '.godot'))).toBe(false);
  }, 120_000);

  it('filters by kind and searches words and Class.member fragments', async () => {
    const sig = json(await call('godot_docs_search', { query: 'ready', kind: 'signal', limit: 5 }));
    expect(sig.hits.map((h: { class: string; member: string }) => `${h.class}.${h.member}`)).toContain('Node.ready');
    const words = json(await call('godot_docs_search', { query: 'play sound', limit: 5 }));
    expect(words.hits.some((h: { class: string }) => /^AudioStreamPlayer/.test(h.class))).toBe(true);
    const frag = json(await call('godot_docs_search', { query: 'CharacterBody2D.queue', limit: 5 }));
    expect(frag.hits[0]).toMatchObject({ class: 'Node', member: 'queue_free' });
    const ann = json(await call('godot_docs_search', { query: '@export_range', kind: 'annotation', limit: 3 }));
    expect(ann.hits[0]).toMatchObject({ class: '@GDScript', member: '@export_range' });
  });

  it('returns a class description as markdown with its inheritance chain', async () => {
    const r = json(await call('godot_docs_class', { name: 'Node2D' }));
    expect(r.inherits).toEqual(['CanvasItem', 'Node', 'Object']);
    expect(r.brief).toMatch(/2D game object/);
    expect(r.description).toContain('`CanvasItem`');
    expect(r.description).not.toMatch(/\[(member|method|code)/);
    expect(r.member_counts.methods).toBeGreaterThan(10);
  });

  it('lists own members with briefs and inherited member names', async () => {
    const r = json(await call('godot_docs_class', { name: 'Node2D', members: true, inherited: true }));
    expect(r.members.methods.some((m: string) => m.startsWith('rotate(radians: float) -> void -- '))).toBe(true);
    expect(r.members.properties.some((m: string) => m.startsWith('var position: Vector2'))).toBe(true);
    expect(r.inherited.Node).toContain('add_child()');
    expect(r.inherited.Node).toContain('signal ready');
  });

  it('returns single members, including inherited ones and @GDScript', async () => {
    const pre = json(await call('godot_docs_class', { name: '@GDScript.preload' }));
    expect(pre).toMatchObject({ class: '@GDScript', member: 'preload', kind: 'utility', signature: 'func preload(path: String) -> Resource' });
    expect(pre.description).toContain('```gdscript');
    const qf = json(await call('godot_docs_class', { name: 'CharacterBody2D.queue_free', max_chars: 300 }));
    expect(qf).toMatchObject({ class: 'Node', declared_in: 'Node', requested: 'CharacterBody2D' });
    expect(qf.description.length).toBeLessThan(400);
    const en = json(await call('godot_docs_class', { name: 'Node.ProcessMode' }));
    expect(en.kind).toBe('enum');
    expect(en.values[0]).toMatch(/^PROCESS_MODE_INHERIT = 0/);
  });

  it('documents project classes from ## comments (class_name and autoload)', async () => {
    const enemy = json(await call('godot_docs_class', { name: 'Enemy', members: true }));
    expect(enemy).toMatchObject({ name: 'Enemy', kind: 'project', path: 'res://enemy.gd' });
    expect(enemy.inherits[0]).toBe('Area2D');
    expect(enemy.brief).toMatch(/global script class/);
    expect(enemy.members.properties).toContain('@export var damage: int = 10');
    const gs = json(await call('godot_docs_class', { name: 'GameState.add_score' }));
    expect(gs).toMatchObject({ class: 'GameState', kind: 'method', signature: 'func add_score(amount: int) -> void', path: 'res://game_state.gd' });
    const hit = json(await call('godot_docs_search', { query: 'Enemy', limit: 3 }));
    expect(hit.hits[0]).toMatchObject({ class: 'Enemy', kind: 'class' });
  });

  it('suggests fixes for unknown names', async () => {
    expect(errorText(await call('godot_docs_class', { name: 'Nod2D' }))).toMatch(/Did you mean: Node2D/);
    expect(errorText(await call('godot_docs_class', { name: 'move_and_slide' }))).toMatch(/member of: CharacterBody2D/);
    expect(errorText(await call('godot_docs_class', { name: 'Node2D.rotat' }))).toMatch(/no member "rotat".*rotate/);
  });
});
