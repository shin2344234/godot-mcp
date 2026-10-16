/**
 * End-to-end: live inspection, live changes and code eval in a running game
 * (godot_game_tree / godot_game_get / godot_game_edit / godot_game_eval):
 *
 *   GODOT_BIN=/path/to/godot npx vitest run test/e2e/live-game.test.ts
 *
 * The first suite drives a headless process run (the server is the game's debugger);
 * the second a game started from a headless editor, through the plugin's relay.
 * Both work on a temp copy of examples/sample_project plus a small UI scene written
 * here (a menu with buttons, a LineEdit, a RichTextLabel and a script with plain,
 * typed and coroutine methods).
 */

import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { appendFileSync, existsSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { copySampleProject, errorText, GODOT_BIN, json, killAndWait, startServer } from './helpers.js';

type Client = Awaited<ReturnType<typeof startServer>>;

const enabled = Boolean(GODOT_BIN);

const UI_SCRIPT = `extends Control

signal started(level: int)

var clicks: int = 0
var _secret: String = "s"
@export var target: Node


func _ready() -> void:
	$Box/Start.pressed.connect(_on_start_pressed)


func _on_start_pressed() -> void:
	clicks += 1
	started.emit(clicks)


func greet(who: String, times: int = 1) -> String:
	return ("hi %s " % who).repeat(times).strip_edges()


func move_box(where: Vector2) -> Vector2:
	($Box as Control).position = where
	return where


func get_double_clicks() -> int:
	return clicks * 2


func slow_double(x: int) -> int:
	await get_tree().create_timer(0.2).timeout
	return x * 2
`;

const UI_SCENE = `[gd_scene format=3]

[ext_resource type="Script" path="res://live_ui.gd" id="1"]

[node name="LiveUI" type="Control"]
layout_mode = 3
anchors_preset = 0
offset_right = 400.0
offset_bottom = 300.0
script = ExtResource("1")

[node name="Box" type="VBoxContainer" parent="."]
layout_mode = 0
offset_left = 10.0
offset_top = 20.0
offset_right = 210.0
offset_bottom = 160.0

[node name="Title" type="Label" parent="Box"]
layout_mode = 2
text = "Main Menu"

[node name="Start" type="Button" parent="Box" groups=["menu_buttons"]]
layout_mode = 2
text = "Start Game"

[node name="Quit" type="Button" parent="Box" groups=["menu_buttons"]]
visible = false
layout_mode = 2
text = "Quit"

[node name="Name" type="LineEdit" parent="Box"]
layout_mode = 2
placeholder_text = "Your name"

[node name="Info" type="RichTextLabel" parent="."]
layout_mode = 0
offset_top = 200.0
offset_right = 300.0
offset_bottom = 240.0
bbcode_enabled = true
text = "[b]Press[/b] start"
`;

function addUiScene(dir: string): void {
  writeFileSync(path.join(dir, 'live_ui.gd'), UI_SCRIPT);
  writeFileSync(path.join(dir, 'live_ui.tscn'), UI_SCENE);
}

describe.skipIf(!enabled)('live game: process run', () => {
  const proj = copySampleProject();
  let client: Client;
  let runId: string;
  const call = (name: string, args: Record<string, unknown> = {}) => client.callTool({ name, arguments: { run_id: runId, ...args } });

  beforeAll(async () => {
    addUiScene(proj.dir);
    spawnSync(GODOT_BIN!, ['--headless', '--path', proj.dir, '--import'], { timeout: 180_000, stdio: 'ignore' });
    client = await startServer({ project: proj.dir, era: 'modern', args: ['--allow-eval'] });
    const started = json(await client.callTool({ name: 'godot_run_start', arguments: { mode: 'process', headless: true, scene: 'res://live_ui.tscn' } }));
    runId = started.run_id;
    expect(runId).toBeTruthy();
  }, 240_000);

  afterAll(async () => {
    await client?.callTool({ name: 'godot_run_stop', arguments: { run_id: runId } }).catch(() => undefined);
    await client?.close();
    await proj.cleanup();
  });

  it('lists the live tree compactly, with rects, visible text and hidden flags', async () => {
    const r = json(await call('godot_game_tree'));
    expect(r.run_id).toBe(runId);
    expect(r.root).toBe('.');
    expect(r.nodes[0]).toMatchObject({ path: '.', name: 'LiveUI', class: 'Control', script: 'res://live_ui.gd', children: 2 });
    const byPath = Object.fromEntries(r.nodes.map((n: { path: string }) => [n.path, n]));
    expect(byPath['Box/Start']).toMatchObject({ class: 'Button', text: 'Start Game' });
    expect(byPath['Box/Start'].rect).toMatch(/^Rect2\(10, \d+, 200, \d+\)$/);
    expect(byPath['Box/Quit'].hidden).toBe(true);
    expect(byPath['Box/Name'].text).toBe('Your name'); // placeholder of an empty LineEdit
    expect(byPath['Info'].text).toBe('Press start'); // BBCode stripped
    expect(r.truncated).toBe(false);
  }, 30_000);

  it('filters by visible text, class, group and caps the output', async () => {
    const text = json(await call('godot_game_tree', { text: 'start game' }));
    expect(text.nodes.map((n: { path: string }) => n.path)).toEqual(['Box/Start']);
    const cls = json(await call('godot_game_tree', { class: 'BaseButton' }));
    expect(cls.nodes.map((n: { path: string }) => n.path)).toEqual(['Box/Start', 'Box/Quit']);
    const capped = json(await call('godot_game_tree', { group: 'menu_buttons', max_nodes: 1 }));
    expect(capped).toMatchObject({ count: 1, total: 2, truncated: true });
    expect(capped.hint).toMatch(/max_nodes/);
    // "/root" shows autoloads, but never the MCP runtime itself.
    const all = json(await call('godot_game_tree', { root: '/root', depth: 1 }));
    const paths = all.nodes.map((n: { path: string }) => n.path);
    expect(paths).toContain('/root/GameState');
    expect(paths.join(' ')).not.toContain('GodotMcpRuntime');
    const bad = errorText(await call('godot_game_tree', { class: 'Buton' }));
    expect(bad).toMatch(/BAD_PARAMS: .*unknown class 'Buton'.*Did you mean: Button/);
  }, 30_000);

  it('reads live values, nested paths, signals and script methods', async () => {
    const r = json(await call('godot_game_get', { signals: true, methods: true }));
    expect(r.properties).toMatchObject({ clicks: 0, _secret: 's', target: null, size: 'Vector2(400, 300)' });
    expect(r.properties.modulate).toBeUndefined(); // default values are omitted...
    expect(r.defaults_omitted).toBeGreaterThan(20);
    expect(r.methods).toContain('greet(who: String, times: int) -> String');
    expect(r.signals['started(level: int)']).toEqual([]);
    const start = json(await call('godot_game_get', { path: 'Box/Start', signals: true }));
    expect(start.groups).toEqual(['menu_buttons']);
    expect(start.signals['pressed()']).toEqual([{ to: '.', method: '_on_start_pressed' }]);
    const some = json(await call('godot_game_get', { path: 'Box', properties: ['position:x', 'modulate'] }));
    expect(some.properties).toEqual({ 'position:x': 10, modulate: 'Color(1, 1, 1, 1)' });
    const all = json(await call('godot_game_get', { path: 'Box', properties: ['*'] }));
    expect(all.properties.modulate).toBe('Color(1, 1, 1, 1)'); // ...unless ["*"]
    const autoload = json(await call('godot_game_get', { path: '/root/GameState', properties: ['score'] }));
    expect(typeof autoload.properties.score).toBe('number');
    const typo = errorText(await call('godot_game_get', { path: 'Box', properties: ['positon'] }));
    expect(typo).toMatch(/NOT_FOUND: .*no property 'positon'.*position/);
    // Derived values through argument-less getters: engine const methods and get_/is_
    // named script methods.
    const getters = json(await call('godot_game_get', { path: 'Box', properties: ['get_global_rect()', 'is_visible_in_tree()'] }));
    expect(getters.properties['get_global_rect()']).toMatch(/^Rect2\(10, 20, /);
    expect(getters.properties['is_visible_in_tree()']).toBe(true);
    expect(json(await call('godot_game_get', { properties: ['get_double_clicks()'] })).properties).toEqual({ 'get_double_clicks()': 0 });
    expect(errorText(await call('godot_game_get', { path: 'Box', properties: ['is_visible_in_tree'] }))).toMatch(/is a method: write "is_visible_in_tree\(\)"/);
    expect(errorText(await call('godot_game_get', { path: 'Box', properties: ['nope'] }))).toMatch(/argument-less getters, e\.g\. "get_screen_center_position\(\)"/);
    expect(errorText(await call('godot_game_get', { properties: ['greet()'] }))).toMatch(/BAD_PARAMS: 'greet\(\)' needs 1 argument/);
    expect(errorText(await call('godot_game_get', { properties: ['queue_free()'] }))).toMatch(/BAD_PARAMS: 'queue_free\(\)' is not a getter/);
    expect(errorText(await call('godot_game_get', { properties: ['get_nope()'] }))).toMatch(/NOT_FOUND: .*no method 'get_nope'/);
    const missing = errorText(await call('godot_game_get', { path: 'Nope' }));
    expect(missing).toMatch(/NOT_FOUND: No node at 'Nope'.*godot_game_tree/);
  }, 30_000);

  it('applies live edits in order: set, call (incl. coroutines), spawn, remove', async () => {
    const r = json(
      await call('godot_game_edit', {
        ops: [
          { action: 'set', path: 'Box/Title', properties: { text: 'Hello', modulate: '#ff0000', 'position:x': 5 } },
          { action: 'set', properties: { target: '/root/GameState' } },
          { action: 'call', method: 'greet', args: ['bob', 2] },
          { action: 'call', method: 'move_box', args: [[30, 40]] },
          { action: 'call', method: 'slow_double', args: [21] },
          { action: 'call', path: 'Box/Start', method: 'emit_signal', args: ['pressed'] },
          { action: 'spawn', parent: 'Box', class: 'Label', name: 'Extra', properties: { text: 'spawned' } },
          { action: 'spawn', scene: 'res://player.tscn', properties: { position: [5, 6] } },
          { action: 'remove', path: 'Box/Quit' },
        ],
      }),
    );
    const res = r.results;
    expect(res[0]).toEqual({ action: 'set', path: 'Box/Title', changed: { text: 'Hello', modulate: 'Color(1, 0, 0, 1)', 'position:x': 5 } });
    expect(res[1].changed.target).toEqual({ node: '/root/GameState', class: 'Node' });
    expect(res[2].return).toBe('hi bob hi bob');
    expect(res[3].return).toBe('Vector2(30, 40)'); // [30, 40] decoded to the Vector2 argument
    expect(res[4].return).toBe(42); // awaited coroutine
    expect(res[6]).toMatchObject({ action: 'spawn', path: 'Box/Extra', class: 'Label' });
    expect(res[7]).toMatchObject({ action: 'spawn', path: 'Player', class: 'CharacterBody2D' });
    expect(res[8]).toEqual({ action: 'remove', removed: 'Box/Quit' });
    const after = json(await call('godot_game_get', { properties: ['clicks'] }));
    expect(after.properties.clicks).toBe(1); // the emitted "pressed" ran the handler
    const tree = json(await call('godot_game_tree', { text: 'spawned' }));
    expect(tree.nodes.map((n: { path: string }) => n.path)).toEqual(['Box/Extra']);
  }, 30_000);

  it('stops at the first failing op and says which one', async () => {
    const e = errorText(
      await call('godot_game_edit', {
        ops: [
          { action: 'set', path: 'Box/Title', properties: { text: 'x' } },
          { action: 'call', method: 'greet', args: [] },
          { action: 'set', path: 'Box/Title', properties: { text: 'never' } },
        ],
      }),
    );
    expect(e).toMatch(/^BAD_PARAMS: ops\[1\] \(call\) failed: greet\(who: String, times: int\) takes 1 to 2 argument\(s\), got 0\. ops\[0\.\.0\] were applied/);
    expect(e).toContain('"failed_index":1');
    const title = json(await call('godot_game_get', { path: 'Box/Title', properties: ['text'] }));
    expect(title.properties.text).toBe('x');
    const typo = errorText(await call('godot_game_edit', { ops: [{ action: 'call', method: 'gret' }] }));
    expect(typo).toMatch(/no method 'gret'.*Did you mean: greet/);
    const value = errorText(await call('godot_game_edit', { ops: [{ action: 'set', path: 'Box', properties: { position: 'abc' } }] }));
    expect(value).toMatch(/expected Vector2.*Valid examples/);
    const runtime = errorText(await call('godot_game_edit', { ops: [{ action: 'remove', path: '/root/GodotMcpRuntime' }] }));
    expect(runtime).toMatch(/refusing to remove/);
  }, 30_000);

  it('evaluates expressions and GDScript snippets, with output and errors', async () => {
    const expr = json(await call('godot_game_eval', { code: 'clicks * 10 + n', inputs: { n: 2 } }));
    expect(expr.result).toBe(12);
    const gd = json(
      await call('godot_game_eval', {
        mode: 'gdscript',
        code: 'print("hey")\nvar total = 0\nfor i in 3:\n    total += i\nawait tree.process_frame\nreturn node.get_node("Box").position + Vector2(total, 0)',
      }),
    );
    expect(gd).toMatchObject({ result: 'Vector2(33, 40)', output: ['hey'] });
    const parse = errorText(await call('godot_game_eval', { code: '1 +' }));
    expect(parse).toMatch(/BAD_PARAMS: Expression parse error.*mode "gdscript"/);
    const compile = errorText(await call('godot_game_eval', { mode: 'gdscript', code: 'var x = \nreturn x' }));
    expect(compile).toMatch(/does not compile: Parse Error: .*\(snippet:1\)/);
    // A runtime error in the snippet (process runs ignore error breaks, so the game goes on).
    const boom = errorText(await call('godot_game_eval', { mode: 'gdscript', code: 'print("before")\nvar d = {}\nreturn d.missing' }));
    expect(boom).toMatch(/GODOT_ERROR: The snippet stopped with a script error: .*'missing'.*\(snippet:3\)/);
    expect(boom).toContain('"output":["before"]');
    expect(json(await call('godot_game_eval', { code: '1 + 1' })).result).toBe(2);
    // Autoloads and engine singletons are visible by name in expressions; inputs win.
    expect(typeof json(await call('godot_game_eval', { code: 'GameState.score' })).result).toBe('number');
    expect(json(await call('godot_game_eval', { code: 'Engine.get_physics_ticks_per_second()' })).result).toBe(60);
    expect(json(await call('godot_game_eval', { code: 'GameState', inputs: { GameState: 5 } })).result).toBe(5);
  }, 30_000);

  it('changes and reloads the scene', async () => {
    const r = json(
      await call('godot_game_edit', {
        ops: [
          { action: 'change_scene', scene: 'res://main.tscn' },
          { action: 'set', path: 'Label', properties: { text: 'Changed' } },
          { action: 'change_scene' },
        ],
      }),
    );
    expect(r.results[0]).toEqual({ action: 'change_scene', current_scene: 'res://main.tscn' });
    expect(r.results[1].path).toBe('Label');
    // The reply says the current scene is a different instance than at the previous call.
    expect(r.scene_changed).toBe('res://main.tscn');
    const tree = json(await call('godot_game_tree', { name: 'label' }));
    expect(tree.nodes).toEqual([expect.objectContaining({ path: 'Label', text: 'Score: 0' })]); // reloaded
    expect(tree.scene_changed).toBeUndefined();
    // A reload the game does by itself (game over -> level restarts) is flagged on the next call.
    await call('godot_game_eval', { mode: 'gdscript', code: 'tree.reload_current_scene.call_deferred()\nreturn 1' });
    await new Promise((r) => setTimeout(r, 300));
    const after = json(await call('godot_game_get', { path: 'Label', properties: ['text'] }));
    expect(after).toMatchObject({ scene_changed: 'res://main.tscn', properties: { text: 'Score: 0' } });
  }, 30_000);
});

describe.skipIf(!enabled)('live game: eval disabled and no game', () => {
  const proj = copySampleProject();
  let client: Client;

  beforeAll(async () => {
    client = await startServer({ project: proj.dir, era: 'modern' });
  }, 60_000);
  afterAll(async () => {
    await client?.close();
    await proj.cleanup();
  });

  it('keeps godot_game_eval listed but refuses it with a DISABLED error saying how to enable it', async () => {
    const tools = (await client.listTools()).tools.map((t) => t.name);
    expect(tools).toEqual(expect.arrayContaining(['godot_game_tree', 'godot_game_get', 'godot_game_edit', 'godot_game_eval']));
    const e = errorText(await client.callTool({ name: 'godot_game_eval', arguments: { code: '1 + 1' } }));
    expect(e).toMatch(/^DISABLED: .*--allow-eval.*GODOT_MCP_ALLOW_EVAL=1/);
  });

  it('says how to start a game when none is running', async () => {
    const e = errorText(await client.callTool({ name: 'godot_game_tree', arguments: {} }));
    expect(e).toMatch(/^GAME_NOT_RUNNING: .*godot_run_start/);
  }, 30_000);
});

describe.skipIf(!enabled)('live game: game started from the editor (relay)', () => {
  const proj = copySampleProject();
  let editor: ChildProcess;
  let client: Client;

  beforeAll(async () => {
    addUiScene(proj.dir);
    // The editor is headless, so the games it starts must be too (no display):
    // editor/run/main_run_args adds --headless to every editor run.
    appendFileSync(path.join(proj.dir, 'project.godot'), '\n[editor]\n\nrun/main_run_args="--headless"\n');
    spawnSync(GODOT_BIN!, ['--headless', '--path', proj.dir, '--import'], { timeout: 180_000, stdio: 'ignore' });
    editor = spawn(GODOT_BIN!, ['--headless', '--editor', '--path', proj.dir], { stdio: 'ignore' });
    const session = path.join(proj.dir, '.godot', 'godot_mcp', 'session.json');
    const deadline = Date.now() + 90_000;
    while (!existsSync(session) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 250));
    client = await startServer({ project: proj.dir, era: 'modern', args: ['--allow-eval'] });
  }, 240_000);

  afterAll(async () => {
    await client?.callTool({ name: 'godot_run_stop', arguments: {} }).catch(() => undefined);
    await client?.close();
    if (editor?.pid) await killAndWait(editor.pid);
    await proj.cleanup();
  });

  it('inspects and edits the editor\'s game through the relay', async () => {
    const started = json(await client.callTool({ name: 'godot_run_start', arguments: { mode: 'editor', scene: 'res://live_ui.tscn' } }));
    expect(started.mode).toBe('editor');
    const tree = json(await client.callTool({ name: 'godot_game_tree', arguments: { text: 'Start' } }));
    expect(tree.run_id).toBe('editor');
    expect(tree.nodes.map((n: { path: string }) => n.path)).toContain('Box/Start');
    const edit = json(
      await client.callTool({
        name: 'godot_game_edit',
        arguments: { run_id: 'editor', ops: [{ action: 'call', path: 'Box/Start', method: 'emit_signal', args: ['pressed'] }, { action: 'call', method: 'greet', args: ['ed'] }] },
      }),
    );
    expect(edit.results[1].return).toBe('hi ed');
    const get = json(await client.callTool({ name: 'godot_game_get', arguments: { run_id: 'editor', properties: ['clicks'] } }));
    expect(get.properties.clicks).toBe(1);
  }, 90_000);

  it('reports a snippet that does not compile without freezing the editor\'s game', async () => {
    // The editor does not ignore error breaks: compiling on the game's main thread would
    // stop it in the editor debugger. The runtime compiles snippets on a worker thread.
    const e = errorText(await client.callTool({ name: 'godot_game_eval', arguments: { mode: 'gdscript', code: 'return 1 +' } }));
    expect(e).toMatch(/does not compile/);
    const ok = json(await client.callTool({ name: 'godot_game_eval', arguments: { mode: 'gdscript', code: 'return node.clicks' } }));
    expect(ok.result).toBe(1);
  }, 60_000);

  it('reads the output of the editor\'s game with godot_run_output', async () => {
    // The editor keeps a game's output in its Output panel only; the runtime's Logger keeps
    // a copy so run_output works for editor runs too (no process run exists here).
    json(await client.callTool({ name: 'godot_game_eval', arguments: { mode: 'gdscript', code: 'print("from-editor-run")\nprinterr("to-stderr")\npush_warning("careful-now")\nreturn 1' } }));
    const out = json(await client.callTool({ name: 'godot_run_output', arguments: {} }));
    expect(out).toMatchObject({ run_id: 'editor', running: true, warning_count: 1 });
    expect(out.error_count).toBeGreaterThanOrEqual(1);
    const text = out.lines.join('\n');
    expect(text).toMatch(/^\d+ from-editor-run$/m);
    expect(text).toMatch(/^\d+ \[stderr\] to-stderr$/m);
    expect(text).toMatch(/^\d+ WARNING careful-now \(at .* in /m);
    const errs = json(await client.callTool({ name: 'godot_run_output', arguments: { run_id: 'editor', errors: true } }));
    // The previous test's snippet that did not compile is in there too, as an error.
    expect(errs.errors).toEqual(expect.arrayContaining([expect.objectContaining({ warning: true, message: 'careful-now' })]));
    const later = json(await client.callTool({ name: 'godot_run_output', arguments: { since: out.next } }));
    expect(later.lines).toEqual([]);
  }, 60_000);
});
