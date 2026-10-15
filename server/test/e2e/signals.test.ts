/**
 * End-to-end tests for signal.list / signal.connect / signal.disconnect
 * against real Godot (skipped when GODOT_BIN isn't set):
 *
 *   GODOT_BIN=/path/to/godot npx vitest run test/e2e/signals.test.ts
 *
 * Each suite works on its own temp copy of examples/sample_project, whose
 * main.tscn has one saved connection (Timer.timeout -> . _on_timer_timeout).
 */

import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { copySampleProject, errorText, GODOT_BIN, json, killAndWait, startServer } from './helpers.js';

type Client = Awaited<ReturnType<typeof startServer>>;

const enabled = Boolean(GODOT_BIN);
const read = (dir: string, file: string) => readFileSync(path.join(dir, file), 'utf8');

describe.skipIf(!enabled)('signals: headless', () => {
  const proj = copySampleProject();
  let client: Client;
  const call = (name: string, args: Record<string, unknown>) => client.callTool({ name, arguments: args });

  beforeAll(async () => {
    client = await startServer({ project: proj.dir, era: 'modern' });
  }, 240_000);
  afterAll(async () => {
    await client?.close();
    await proj.cleanup();
  });

  it('lists saved connections compactly', async () => {
    const r = json(await call('godot_signal_list', { scene: 'res://main.tscn' }));
    expect(r.connections).toEqual([{ from: 'Timer', signal: 'timeout', to: '.', method: '_on_timer_timeout' }]);
    expect(r.problem_count).toBe(0);
    expect(r.available).toBeUndefined();
    const avail = json(await call('godot_signal_list', { scene: 'res://main.tscn', path: 'Timer', recursive: false, include_available: true }));
    expect(avail.available.Timer).toContain('timeout()');
  }, 60_000);

  it('connects with binds and flags, creating the handler stub', async () => {
    const r = json(
      await call('godot_signal_connect', {
        scene: 'res://main.tscn',
        from: 'Timer',
        signal: 'tree_exited',
        method: '_on_timer_gone',
        binds: [3, 'x'],
        flags: ['deferred'],
        create_method: true,
      }),
    );
    expect(r).toMatchObject({ connected: true, flags: ['deferred'], binds: [3, 'x'], method_created: { script: 'res://main.gd' }, saved: true });
    expect(read(proj.dir, 'main.gd')).toContain('func _on_timer_gone(extra_arg_0: int, extra_arg_1: String) -> void:');
    expect(read(proj.dir, 'main.tscn')).toContain('[connection signal="tree_exited" from="Timer" to="." method="_on_timer_gone" flags=3 binds= [3, "x"]]');
    // Default method name and argument types from the signal.
    const d = json(await call('godot_signal_connect', { scene: 'res://main.tscn', from: 'Timer', signal: 'child_entered_tree', create_method: true }));
    expect(d.method).toBe('_on_timer_child_entered_tree');
    expect(read(proj.dir, 'main.gd')).toContain('func _on_timer_child_entered_tree(node: Node) -> void:');
  }, 120_000);

  it('gives actionable errors', async () => {
    const typo = errorText(await call('godot_signal_connect', { scene: 'res://main.tscn', from: 'Timer', signal: 'timout', method: '_on_timer_timeout' }));
    expect(typo).toMatch(/NOT_FOUND: .*no signal 'timout'.*Did you mean: timeout/);
    const dup = errorText(await call('godot_signal_connect', { scene: 'res://main.tscn', from: 'Timer', signal: 'timeout', method: '_on_timer_timeout' }));
    expect(dup).toMatch(/^CONFLICT: .*already connected/);
    const missing = errorText(await call('godot_signal_connect', { scene: 'res://main.tscn', from: 'Timer', signal: 'ready', method: '_nope' }));
    expect(missing).toMatch(/has no method '_nope'.*create_method: true/);
    const noScript = errorText(await call('godot_signal_connect', { scene: 'res://main.tscn', from: 'Timer', signal: 'ready', to: 'Label', method: 'x', create_method: true }));
    expect(noScript).toMatch(/needs a script on 'Label'.*script\.attach/);
    const notConnected = errorText(await call('godot_signal_disconnect', { scene: 'res://main.tscn', from: 'Timer', signal: 'timeout', method: '_other' }));
    expect(notConnected).toMatch(/NOT_FOUND: .*Existing connections of that signal: -> '\.' method '_on_timer_timeout'/);
  }, 120_000);

  it('disconnects and then flags the now-unconnected handler', async () => {
    const r = json(await call('godot_signal_disconnect', { scene: 'res://main.tscn', from: 'Timer', signal: 'timeout', method: '_on_timer_timeout' }));
    expect(r.disconnected).toBe(true);
    expect(read(proj.dir, 'main.tscn')).not.toContain('signal="timeout"');
    const list = json(await call('godot_signal_list', { scene: 'res://main.tscn' }));
    expect(list.unconnected_handlers).toContainEqual({ to: '.', method: '_on_timer_timeout', from: 'Timer', signal: 'timeout' });
    expect(list.problem_count).toBeGreaterThan(0);
  }, 120_000);

  it('flags connections to missing or mismatched methods', async () => {
    writeFileSync(
      path.join(proj.dir, 'broken.tscn'),
      [
        '[gd_scene format=3]',
        '',
        '[ext_resource type="Script" path="res://main.gd" id="1_main"]',
        '',
        '[node name="Main" type="Node2D"]',
        'script = ExtResource("1_main")',
        '',
        '[node name="Timer" type="Timer" parent="."]',
        '',
        '[connection signal="timeout" from="Timer" to="." method="_on_missing"]',
        '[connection signal="timeout" from="Timer" to="." method="_on_timer_timeout" binds= [1]]',
        '',
      ].join('\n'),
    );
    const r = json(await call('godot_signal_list', { scene: 'res://broken.tscn' }));
    // (main.gd also has stubs from earlier tests that are unconnected in this scene.)
    expect(r.problem_count).toBeGreaterThanOrEqual(2);
    expect(r.connections.filter((c: { problem?: string }) => c.problem).length).toBe(2);
    expect(r.connections[0].problem).toMatch(/method '_on_missing' does not exist/);
    expect(r.connections[1].problem).toMatch(/takes 0 argument\(s\) but the connection passes 1/);
  }, 60_000);
});

/** First import of a fresh copy (creates .godot/, uid caches). */
function importProject(dir: string): void {
  spawnSync(GODOT_BIN!, ['--headless', '--path', dir, '--import'], { timeout: 180_000, stdio: 'ignore' });
}

describe.skipIf(!enabled)('signals: editor', () => {
  const proj = copySampleProject();
  let client: Client;
  const call = (name: string, args: Record<string, unknown>) => client.callTool({ name, arguments: args });

  beforeAll(async () => {
    importProject(proj.dir);
    client = await startServer({ project: proj.dir, era: 'legacy' });
    const launched = json(await call('godot_editor_launch', { headless: true, wait_seconds: 90 }));
    expect(launched.editor ?? launched.connected).toBeTruthy();
  }, 300_000);

  afterAll(async () => {
    await client?.close();
    try {
      const session = JSON.parse(read(proj.dir, '.godot/godot_mcp/session.json'));
      await killAndWait(session.pid);
    } catch {
      // the editor never came up
    }
    await proj.cleanup();
  });

  it('connects (creating the stub in a non-tool script), disconnects and saves', async () => {
    json(await call('godot_scene_open', { path: 'res://main.tscn' }));
    const c = json(await call('godot_signal_connect', { from: 'Timer', signal: 'tree_entered', create_method: true }));
    expect(c).toMatchObject({ backend: 'editor', connected: true, method: '_on_timer_tree_entered', saved: false });
    expect(read(proj.dir, 'main.gd')).toContain('func _on_timer_tree_entered() -> void:');
    const list = json(await call('godot_signal_list', {}));
    expect(list.connections).toContainEqual({ from: 'Timer', signal: 'tree_entered', to: '.', method: '_on_timer_tree_entered' });
    expect(list.problem_count).toBe(0);

    const d = json(await call('godot_signal_disconnect', { from: 'Timer', signal: 'timeout', method: '_on_timer_timeout' }));
    expect(d.disconnected).toBe(true);
    json(await call('godot_scene_save', {}));
    const tscn = read(proj.dir, 'main.tscn');
    expect(tscn).toContain('[connection signal="tree_entered" from="Timer" to="." method="_on_timer_tree_entered"]');
    expect(tscn).not.toContain('signal="timeout"');
  }, 120_000);
});
