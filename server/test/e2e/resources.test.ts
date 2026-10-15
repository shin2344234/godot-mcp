/**
 * E2E: resource.read / resource.create / resource.set / resource.deps
 * (addons/godot_mcp/ops/resource_ops.gd), headless and through a live
 * headless editor. Skipped without GODOT_BIN.
 *
 * Uses examples/sample_project/resources/sample_material.tres: a
 * StandardMaterial3D with an icon.svg texture (ext_resource with uid) and an
 * embedded next_pass material.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { copySampleProject, errorText, GODOT_BIN, json, killAndWait, startServer } from './helpers.js';

const enabled = Boolean(GODOT_BIN);

function importProject(dir: string): void {
  spawnSync(GODOT_BIN!, ['--headless', '--path', dir, '--import'], { timeout: 180_000, stdio: 'ignore' });
}

describe.skipIf(!enabled)('resources (headless)', () => {
  const proj = copySampleProject();
  let client: Awaited<ReturnType<typeof startServer>>;
  const call = async (name: string, args: Record<string, unknown>) => client.callTool({ name, arguments: args });

  beforeAll(async () => {
    importProject(proj.dir);
    client = await startServer({ project: proj.dir });
  }, 240_000);
  afterAll(async () => {
    await client?.close();
    proj.cleanup();
  });

  it('reads non-default properties, embedded sub-resources and the uid', async () => {
    const r = json(await call('godot_resource_read', { path: 'res://resources/sample_material.tres' }));
    expect(r.backend).toBe('headless');
    expect(r.class).toBe('StandardMaterial3D');
    expect(r.uid).toBe('uid://dg2xiy8hs44vm');
    expect(r.properties.albedo_texture).toEqual({ resource: 'res://icon.svg', class: 'CompressedTexture2D' });
    expect(r.properties.next_pass).toMatchObject({ class: 'StandardMaterial3D', embedded: true, properties: { albedo_color: 'Color(0, 0, 1, 1)' } });
    // Picking (nested) properties, and reading by uid://.
    const picked = json(await call('godot_resource_read', { path: 'uid://dg2xiy8hs44vm', properties: ['next_pass:albedo_color', 'roughness'] }));
    expect(picked.path).toBe('res://resources/sample_material.tres');
    expect(picked.properties).toEqual({ 'next_pass:albedo_color': 'Color(0, 0, 1, 1)', roughness: 1 });
  }, 60_000);

  it('reports unknown properties with suggestions', async () => {
    const msg = errorText(await call('godot_resource_read', { path: 'res://resources/sample_material.tres', properties: ['albedo_colr'] }));
    expect(msg).toMatch(/albedo_color/);
  }, 60_000);

  it('creates a Theme with items and lists them back', async () => {
    const created = json(
      await call('godot_resource_create', {
        path: 'res://ui/theme.tres',
        type: 'Theme',
        properties: {
          default_font_size: 18,
          'Button/colors/font_color': '#ff0000',
          'Panel/styles/panel': { new: 'StyleBoxFlat', properties: { bg_color: '#102030' } },
        },
      }),
    );
    expect(created.uid).toMatch(/^uid:\/\//);
    const text = readFileSync(path.join(proj.dir, 'ui', 'theme.tres'), 'utf8');
    expect(text.split('\n')[0]).toContain(`uid="${created.uid}"`);
    const r = json(await call('godot_resource_read', { path: 'res://ui/theme.tres' }));
    expect(r.properties.default_font_size).toBe(18);
    expect(r.theme_items.Button.colors.font_color).toBe('Color(1, 0, 0, 1)');
    expect(r.theme_items.Panel.styles.panel).toMatchObject({ class: 'StyleBoxFlat', embedded: true });
  }, 60_000);

  it('refuses to overwrite and rejects unknown classes', async () => {
    const conflict = errorText(await call('godot_resource_create', { path: 'res://resources/sample_material.tres', type: 'StandardMaterial3D' }));
    expect(conflict).toMatch(/already exists.*overwrite/);
    const bad = errorText(await call('godot_resource_create', { path: 'res://x.tres', type: 'StandardMaterial' }));
    expect(bad).toMatch(/StandardMaterial3D/);
  }, 60_000);

  it('creates a .gdshader with a .uid sidecar and shader uniforms', async () => {
    const created = json(
      await call('godot_resource_create', { path: 'res://shaders/tint.gdshader', code: 'shader_type canvas_item;\nuniform vec4 tint : source_color;\nvoid fragment() { COLOR *= tint; }\n' }),
    );
    expect(created.type).toBe('Shader');
    expect(readFileSync(path.join(proj.dir, 'shaders', 'tint.gdshader.uid'), 'utf8').trim()).toBe(created.uid);
    const r = json(await call('godot_resource_read', { path: 'res://shaders/tint.gdshader' }));
    expect(r.uniforms).toEqual([{ name: 'tint', type: 'Color' }]);
  }, 60_000);

  it('sets nested properties and keeps the file uid and ext_resource uids', async () => {
    const r = json(
      await call('godot_resource_set', {
        path: 'res://resources/sample_material.tres',
        properties: { 'next_pass:albedo_color': [0, 1, 0], roughness: 0.25, 'albedo_color:a': 0.5 },
      }),
    );
    expect(r.saved).toBe(true);
    expect(r.undoable).toBe(false);
    expect(r.changed['next_pass:albedo_color']).toBe('Color(0, 1, 0, 1)');
    const text = readFileSync(path.join(proj.dir, 'resources', 'sample_material.tres'), 'utf8');
    expect(text.split('\n')[0]).toContain('uid="uid://dg2xiy8hs44vm"');
    expect(text).toMatch(/\[ext_resource type="Texture2D" uid="uid:\/\/co7qc6cxx4spi" path="res:\/\/icon.svg"/);
    expect(text).toContain('roughness = 0.25');
    expect(text).toContain('albedo_color = Color(0, 1, 0, 1)');
  }, 60_000);

  it('rejects bad resource.set calls with actionable messages', async () => {
    const unknown = errorText(await call('godot_resource_set', { path: 'res://resources/sample_material.tres', properties: { next_pas: null } }));
    expect(unknown).toMatch(/Did you mean: next_pass/);
    const imported = errorText(await call('godot_resource_set', { path: 'res://icon.svg', properties: { foo: 1 } }));
    expect(imported).toMatch(/import\.set/);
    const typed = errorText(await call('godot_resource_set', { path: 'res://resources/sample_material.tres', properties: { roughness: 'very' } }));
    expect(typed).toMatch(/roughness/);
  }, 60_000);

  it('lists dependencies and dependents, resolving uids', async () => {
    const d = json(await call('godot_resource_deps', { path: 'res://resources/sample_material.tres' }));
    expect(d.dependencies).toEqual([{ path: 'res://icon.svg', uid: 'uid://co7qc6cxx4spi', type: 'CompressedTexture2D', exists: true }]);
    expect(d.missing).toEqual([]);
    const users = json(await call('godot_resource_deps', { path: 'uid://co7qc6cxx4spi', dependents: true }));
    expect(users.path).toBe('res://icon.svg');
    const paths = users.dependents.map((u: { path: string }) => u.path);
    expect(paths).toContain('res://player.tscn');
    expect(paths).toContain('res://resources/sample_material.tres');
    const missing = errorText(await call('godot_resource_deps', { path: 'res://nope.tres' }));
    expect(missing).toMatch(/does not exist/);
  }, 60_000);
});

describe.skipIf(!enabled)('resources (editor)', () => {
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
    proj.cleanup();
  });

  it('sets properties on the cached resource as an undoable edit and saves', async () => {
    const r = json(await call('godot_resource_set', { path: 'res://resources/sample_material.tres', properties: { metallic: 0.75, 'next_pass:albedo_color': '#ffffff' } }));
    expect(r.backend).toBe('editor');
    expect(r.undoable).toBe(true);
    const text = readFileSync(path.join(proj.dir, 'resources', 'sample_material.tres'), 'utf8');
    expect(text).toContain('metallic = 0.75');
    expect(text.split('\n')[0]).toContain('uid="uid://dg2xiy8hs44vm"');
    const back = json(await call('godot_resource_read', { path: 'res://resources/sample_material.tres', properties: ['metallic'] }));
    expect(back.properties.metallic).toBe(0.75);
  }, 120_000);

  it('creates resources through the editor with a uid', async () => {
    const created = json(await call('godot_resource_create', { path: 'res://made/gradient.tres', type: 'Gradient', properties: { colors: ['Color(1, 0, 0, 1)', 'Color(0, 0, 1, 1)'] } }));
    expect(created.backend).toBe('editor');
    expect(created.uid).toMatch(/^uid:\/\//);
    expect(existsSync(path.join(proj.dir, 'made', 'gradient.tres'))).toBe(true);
    const deps = json(await call('godot_resource_deps', { path: created.uid }));
    expect(deps.path).toBe('res://made/gradient.tres');
  }, 120_000);
});
