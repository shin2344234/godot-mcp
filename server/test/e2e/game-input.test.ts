/**
 * End-to-end tests for godot_game_input / godot_game_time / godot_game_record
 * against real Godot (skipped when GODOT_BIN isn't set):
 *
 *   GODOT_BIN=/path/to/godot npx vitest run test/e2e/game-input.test.ts
 *
 * The movie test also needs a display; run it under Xvfb:
 *
 *   GODOT_BIN=... xvfb-run -a -s "-screen 0 1280x720x24" npx vitest run test/e2e/game-input.test.ts
 *
 * Each suite works on a temp copy of examples/sample_project (actions move_left,
 * move_right, jump) plus a small UI scene written below, whose script prints
 * markers (BUTTON_PRESSED, JUMP_JUST...) we read back with godot_run_output.
 */

import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { copySampleProject, errorText, GODOT_BIN, json, killAndWait, startServer } from './helpers.js';

type Client = Awaited<ReturnType<typeof startServer>>;

const enabled = Boolean(GODOT_BIN);

const SCRIPT = `extends Control
## Test scene for game-input.test.ts.

signal scored(points: int, who: String)

var clicks: int = 0
var ticks: int = 0
var pticks: int = 0


func _ready() -> void:
	$Start.pressed.connect(_on_start)
	$Name.text_submitted.connect(_on_submitted)
	$Reload.pressed.connect(func() -> void: get_tree().reload_current_scene())


func _on_start() -> void:
	clicks += 1
	print("BUTTON_PRESSED ", clicks)
	get_tree().create_timer(0.2).timeout.connect(_on_later)


func _on_later() -> void:
	scored.emit(5, "start")
	var n := Node2D.new()
	n.name = "Spawned%d" % clicks
	add_child(n)


func _on_submitted(t: String) -> void:
	print("SUBMITTED ", t)


func _process(_delta: float) -> void:
	ticks += 1
	if Input.is_action_just_pressed("jump"):
		print("JUMP_JUST")


func _physics_process(delta: float) -> void:
	pticks += 1
	if Input.is_action_pressed("move_right"):
		$Mover.position.x += 200.0 * delta


func _input(e: InputEvent) -> void:
	if e is InputEventJoypadButton and e.pressed:
		print("JOY ", e.button_index)
	elif e is InputEventJoypadMotion:
		print("AXIS ", e.axis, " ", e.axis_value)


func _unhandled_input(e: InputEvent) -> void:
	if e is InputEventKey and e.pressed and e.ctrl_pressed:
		print("KEY ", e.as_text_keycode())
`;

const rect = (l: number, t: number, r: number, b: number) => `offset_left = ${l}.0\noffset_top = ${t}.0\noffset_right = ${r}.0\noffset_bottom = ${b}.0\n`;

const SCENE = `[gd_scene format=3]

[ext_resource type="Script" path="res://input_test.gd" id="1"]

[sub_resource type="RectangleShape2D" id="box"]
size = Vector2(40, 40)

[node name="InputTest" type="Control"]
layout_mode = 3
anchors_preset = 15
anchor_right = 1.0
anchor_bottom = 1.0
script = ExtResource("1")

[node name="Start" type="Button" parent="."]
${rect(100, 100, 220, 140)}text = "Start"

[node name="Covered" type="Button" parent="."]
${rect(300, 100, 420, 140)}text = "Covered"

[node name="Cover" type="ColorRect" parent="."]
${rect(290, 90, 430, 150)}
[node name="Name" type="LineEdit" parent="."]
${rect(100, 200, 400, 240)}
[node name="Slider" type="HSlider" parent="."]
${rect(100, 300, 400, 330)}max_value = 100.0

[node name="Mover" type="Node2D" parent="."]
position = Vector2(0, 500)

[node name="Reload" type="Button" parent="."]
${rect(500, 100, 600, 140)}text = "Reload"

[node name="Crate" type="StaticBody2D" parent="."]
position = Vector2(800, 400)

[node name="Shape" type="CollisionShape2D" parent="Crate"]
shape = SubResource("box")
`;

function addTestScene(dir: string): void {
  writeFileSync(path.join(dir, 'input_test.gd'), SCRIPT);
  writeFileSync(path.join(dir, 'input_test.tscn'), SCENE);
}

async function waitFor(check: () => boolean | Promise<boolean>, timeoutMs = 10_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

describe.skipIf(!enabled)('game input/time/record: process run (headless)', () => {
  const proj = copySampleProject();
  let client: Client;
  let runId: string;
  const call = (name: string, args: Record<string, unknown>) => client.callTool({ name, arguments: args });
  const input = async (steps: unknown[]) => json(await call('godot_game_input', { steps }));
  const time = async (args: Record<string, unknown>) => json(await call('godot_game_time', args));
  const output = async () => (json(await call('godot_run_output', { run_id: runId, limit: 2000 })).lines as string[]).join('\n');
  /** Reads a value from the game: a one-element array is truthy, so the wait returns at once with it. */
  const read = async (expr: string) => (await time({ action: 'wait_for', condition: `[${expr}]`, timeout_ms: 2000 })).value[0];

  beforeAll(async () => {
    addTestScene(proj.dir);
    spawnSync(GODOT_BIN!, ['--headless', '--path', proj.dir, '--import'], { timeout: 180_000, stdio: 'ignore' });
    client = await startServer({ project: proj.dir, era: 'modern' });
    const run = json(await call('godot_run_start', { mode: 'process', headless: true, scene: 'res://input_test.tscn' }));
    expect(run.runtime).toBe(true);
    runId = run.run_id;
  }, 240_000);

  afterAll(async () => {
    await call('godot_run_stop', { run_id: runId }).catch(() => undefined);
    await client?.close();
    await proj.cleanup();
  });

  it('clicks a button by node path and reports what it hit', async () => {
    const r = await input([{ type: 'click', at: 'Start' }]);
    expect(r.run_id).toBe(runId);
    // Headless games start with a 64x64 root window; the first input call resizes it.
    expect(r.viewport).toEqual([1152, 648]);
    expect(r.warnings?.[0]).toMatch(/resized the root viewport from 64x64/);
    expect(r.steps[0]).toMatchObject({ type: 'click', at: [160, 120], hit: 'Start', handled: true, hit_target: true });
    expect(await waitFor(async () => (await output()).includes('BUTTON_PRESSED 1'))).toBe(true);
    // Clicks on positions work too, and an overlay that eats the click is reported.
    const covered = await input([{ type: 'click', at: 'Covered' }, { type: 'click', at: [150, 110] }]);
    expect(covered.steps[0]).toMatchObject({ hit: 'Cover', hit_target: false });
    expect(covered.steps[1].hit).toBe('Start');
    expect(await read('clicks')).toBe(2);
    // Physics objects under the pointer are reported separately from the Control `hit`
    // (here the full-rect root Control).
    const crate = await input([{ type: 'click', at: 'Crate' }, { type: 'move', at: [805, 395] }, { type: 'move', at: [10, 10] }]);
    expect(crate.steps[0]).toMatchObject({ at: [800, 400], hit: '.', physics: ['Crate'] });
    expect(crate.steps[1].physics).toEqual(['Crate']);
    expect(crate.steps[2].physics).toBeUndefined();
  }, 60_000);

  it('types text into the focused control', async () => {
    const r = await input([{ type: 'click', at: 'Name' }, { type: 'text', text: 'Hello World!\n' }]);
    expect(r.steps[1]).toMatchObject({ focus: 'Name', text: 'Hello World!' });
    expect(await waitFor(async () => (await output()).includes('SUBMITTED Hello World!'))).toBe(true);
  }, 60_000);

  it('sends keys and actions that _process/_physics_process see', async () => {
    const r = await input([{ type: 'key', key: 'Space' }, { type: 'key', key: 'Ctrl+S' }]);
    expect(r.steps.map((s: { key: string }) => s.key)).toEqual(['Space', 'Ctrl+S']);
    // The actions the key triggers are listed (project actions first). Ctrl+S triggers none,
    // and nothing consumed it (the game reads it in _unhandled_input without marking it), so
    // there is no `handled: false` noise either.
    expect(r.steps[0].actions).toEqual(['jump', 'ui_accept', 'ui_select']);
    expect(r.steps[1]).toEqual({ type: 'key', key: 'Ctrl+S' });
    // is_action_just_pressed("jump") in _process and the modifier combo in _unhandled_input.
    expect(await waitFor(async () => /JUMP_JUST[\s\S]*KEY Ctrl\+S/.test(await output()))).toBe(true);
    const before = Number(await read("get_node('Mover').position.x"));
    const act = await input([{ type: 'action', action: 'move_right', phase: 'press' }, { type: 'wait', ms: 300 }, { type: 'action', action: 'move_right', phase: 'release' }]);
    expect(act.steps[0]).toMatchObject({ action: 'move_right', pressed: true });
    const after = Number(await read("get_node('Mover').position.x"));
    expect(after - before).toBeGreaterThan(20);
  }, 60_000);

  it('drags, scrolls, and sends joypad and touch input', async () => {
    const d = await input([{ type: 'drag', at: [110, 315], to: [390, 315], ms: 200, steps: 8 }]);
    expect(d.steps[0].hit).toBe('Slider');
    expect(Number(await read("get_node('Slider').value"))).toBeGreaterThan(80);
    const s = await input([{ type: 'scroll', at: 'Slider', button: 'down', value: 3 }]);
    expect(s.steps[0].hit).toBe('Slider');
    const j = await input([{ type: 'joy_button', button: 'a' }, { type: 'joy_axis', axis: 'left_x', value: 1, ms: 50 }]);
    expect(j.steps[1]).toMatchObject({ axis: 'left_x', value: 1 });
    expect(await waitFor(async () => /JOY 0[\s\S]*AXIS 0 1[\s\S]*AXIS 0 0/.test(await output()))).toBe(true);
    // Touch is emulated as a mouse click by default (input_devices/pointing/emulate_mouse_from_touch).
    const clicks = Number(await read('clicks'));
    const t = await input([{ type: 'touch', at: 'Start' }]);
    expect(t.steps[0].at).toEqual([160, 120]);
    expect(await read('clicks')).toBe(clicks + 1);
  }, 60_000);

  it('gives actionable errors', async () => {
    const action = errorText(await call('godot_game_input', { steps: [{ type: 'action', action: 'jmp' }] }));
    expect(action).toMatch(/BAD_PARAMS: steps\[0\] \(action\): the game has no input action 'jmp'\. Project actions: jump, move_left, move_right/);
    const key = errorText(await call('godot_game_input', { steps: [{ type: 'key', key: 'Spcae' }] }));
    expect(key).toMatch(/unknown key 'Spcae'.*Space, Enter/);
    const node = errorText(await call('godot_game_input', { steps: [{ type: 'wait', ms: 1 }, { type: 'click', at: 'Nope' }] }));
    expect(node).toMatch(/NOT_FOUND: steps\[1\] \(click\): No node at 'Nope'/);
    const sig = errorText(await call('godot_game_time', { action: 'wait_for', node: 'Start', signal: 'presed' }));
    expect(sig).toMatch(/has no signal 'presed'.*pressed/);
    const cond = errorText(await call('godot_game_time', { action: 'wait_for', condition: 'clicks >' }));
    expect(cond).toMatch(/BAD_PARAMS: condition does not parse/);
    const mutate = errorText(await call('godot_game_time', { action: 'wait_for', condition: 'queue_free()' }));
    expect(mutate).toMatch(/condition failed to evaluate/);
  }, 60_000);

  it('waits for signals, nodes, conditions, frames and seconds without blocking other calls', async () => {
    // Let signals from earlier clicks (emitted 0.2 s later) pass first.
    await new Promise((r) => setTimeout(r, 400));
    const next = Number(await read('clicks')) + 1;
    const signal = call('godot_game_time', { action: 'wait_for', node: '.', signal: 'scored', timeout_ms: 5000 });
    const node = call('godot_game_time', { action: 'wait_for', node: `Spawned${next}`, timeout_ms: 5000 });
    // While both wait, the runtime keeps serving requests: this click triggers them.
    await new Promise((r) => setTimeout(r, 200));
    await input([{ type: 'click', at: 'Start' }]);
    const s = json(await signal);
    expect(s.args).toEqual([5, 'start']);
    expect(s.elapsed_ms).toBeGreaterThan(150);
    expect(json(await node)).toMatchObject({ node: `Spawned${next}`, type: 'Node2D' });
    const cond = await time({ action: 'wait_for', condition: 'ticks > 5', timeout_ms: 3000 });
    expect(cond.value).toBe(true);
    // Autoloads and engine singletons are visible in conditions.
    expect((await time({ action: 'wait_for', condition: 'Engine.get_physics_ticks_per_second() == 60 and GameState != null', timeout_ms: 2000 })).value).toBe(true);
    // A watched node that is freed while waiting is a result ({freed: true}), not an error:
    // both for a condition on it and for a signal it will now never emit.
    await call('godot_game_edit', { ops: [{ action: 'spawn', class: 'Timer', name: 'Doomed' }] });
    const condFreed = call('godot_game_time', { action: 'wait_for', node: 'Doomed', condition: 'is_stopped() == false', timeout_ms: 5000 });
    const sigFreed = call('godot_game_time', { action: 'wait_for', node: 'Doomed', signal: 'timeout', timeout_ms: 5000 });
    await new Promise((r) => setTimeout(r, 200));
    await call('godot_game_edit', { ops: [{ action: 'remove', path: 'Doomed' }] });
    expect(json(await condFreed)).toMatchObject({ freed: true, node: 'Doomed', value: false });
    expect(json(await sigFreed)).toMatchObject({ freed: true, node: 'Doomed' });
    const frames = await time({ action: 'wait_for', frames: 10 });
    expect(frames.frames).toBeGreaterThanOrEqual(10);
    const secs = await time({ action: 'wait_for', seconds: 0.3 });
    expect(secs.elapsed_ms).toBeGreaterThanOrEqual(250);
    const timeout = errorText(await call('godot_game_time', { action: 'wait_for', node: 'Never', timeout_ms: 300 }));
    expect(timeout).toMatch(/TIMEOUT: Timed out after 300 ms: no node appeared at 'Never'/);
  }, 60_000);

  it('pauses the whole game, steps exact frames, changes speed and resumes', async () => {
    const paused = await time({ action: 'pause' });
    expect(paused).toMatchObject({ suspended: true, tree_paused: false, effective_time_scale: 0 });
    const t0 = await read('ticks');
    await new Promise((r) => setTimeout(r, 200));
    expect(await read('ticks')).toBe(t0); // frozen: _process doesn't run
    const stepped = await time({ action: 'step', frames: 3 });
    expect(stepped).toMatchObject({ stepped: { frames: 3 }, suspended: true });
    expect(stepped.frames).toBeUndefined(); // the engine's ever-running counters are not in a step result
    expect(await read('ticks')).toBe(t0 + 3);
    // Physics ticks: exactly N, whatever the frame rate; the counts are what really ran.
    const p0 = Number(await read('pticks'));
    const t1 = Number(await read('ticks'));
    const one = await time({ action: 'step', physics_ticks: 1 });
    expect(one.stepped.physics_ticks).toBe(1);
    expect(await read('pticks')).toBe(p0 + 1);
    expect(await read('ticks')).toBe(t1 + one.stepped.frames);
    const five = await time({ action: 'step', physics_ticks: 5 });
    expect(five.stepped.physics_ticks).toBe(5);
    expect(await read('pticks')).toBe(p0 + 6);
    // Input while paused is accepted but flagged as discarded (Godot drops it, nothing queues).
    const warn = await input([{ type: 'key', key: 'Space' }]);
    expect(warn.warnings.join(' ')).toMatch(/The game is paused.*discarded/);
    expect(warn.discarded).toBe(true);
    const resumed = await time({ action: 'resume' });
    expect(resumed).toMatchObject({ suspended: false, game_time_scale: 1, effective_time_scale: 1 });
    expect(await waitFor(async () => Number(await read('ticks')) > t0 + 10)).toBe(true);
    const fast = await time({ action: 'speed', scale: 2 });
    expect(fast).toMatchObject({ speed: 2, effective_time_scale: 2 });
    const secs = await time({ action: 'wait_for', seconds: 1 });
    expect(secs.elapsed_ms).toBeLessThan(800); // 1 game second at 2x
    expect((await time({ action: 'speed', scale: 1 })).effective_time_scale).toBe(1);
    // Stepping a running game pauses it first.
    const auto = await time({ action: 'step' });
    expect(auto).toMatchObject({ stepped: { frames: 1 }, paused_first: true, suspended: true });
    await time({ action: 'resume' });
  }, 60_000);

  it('records input, returns it as JSON, saves it and replays it', async () => {
    expect(json(await call('godot_game_record', { action: 'start' })).recording).toBe(true);
    expect(errorText(await call('godot_game_record', { action: 'start' }))).toMatch(/CONFLICT: Already recording/);
    // (Not Space: it would also press the focused Start button through ui_accept on replay.)
    await input([{ type: 'key', key: 'A' }, { type: 'wait', ms: 100 }, { type: 'click', at: 'Start' }]);
    const stop = json(await call('godot_game_record', { action: 'stop' }));
    const rec = stop.recording;
    expect(rec.version).toBe(1);
    const kinds = rec.events.map((e: { e: string }) => e.e);
    expect(kinds).toContain('key');
    expect(kinds).toContain('mb');
    expect(rec.events.find((e: { e: string; key?: string; p: boolean }) => e.e === 'key' && e.p)).toMatchObject({ key: 'A', u: 97 });
    const click = rec.events.find((e: { e: string; p: boolean }) => e.e === 'mb' && e.p);
    expect(click).toMatchObject({ b: 1, x: 160, y: 120 });
    expect(click.t).toBeGreaterThan(80); // timestamps relative to start

    const clicks = Number(await read('clicks'));
    const replay = json(await call('godot_game_record', { action: 'replay', recording: rec, speed: 2 }));
    expect(replay.replayed).toBe(rec.events.length);
    expect(await read('clicks')).toBe(clicks + 1);

    // Save to a file and replay from it.
    await call('godot_game_record', { action: 'start' });
    await input([{ type: 'click', at: 'Start' }]);
    const saved = json(await call('godot_game_record', { action: 'stop', path: 'res://recordings/click.json' }));
    expect(saved.path).toBe('res://recordings/click.json');
    expect(saved.recording).toBeUndefined();
    const file = JSON.parse(readFileSync(path.join(proj.dir, 'recordings', 'click.json'), 'utf8'));
    expect(file.events.length).toBe(saved.event_count);
    const fromFile = json(await call('godot_game_record', { action: 'replay', path: 'res://recordings/click.json' }));
    expect(fromFile.replayed).toBe(saved.event_count);
    expect(await read('clicks')).toBe(clicks + 3);
    expect(errorText(await call('godot_game_record', { action: 'stop' }))).toMatch(/CONFLICT: Not recording/);
  }, 60_000);

  // Last in this suite: it reloads the scene.
  it('reports the hit of a click that reloads the scene, and the scene change after it', async () => {
    const r = await input([{ type: 'click', at: 'Reload' }]);
    // The button is freed by the reload; its path was captured before that.
    expect(r.steps[0]).toMatchObject({ hit: 'Reload', hit_target: true, handled: true });
    // The reload happens at the end of the frame, so the next call is the first to see it.
    const next = json(await call('godot_game_get', { properties: ['clicks'] }));
    expect(next).toMatchObject({ scene_changed: 'res://input_test.tscn', properties: { clicks: 0 } });
    expect(json(await call('godot_game_get', { properties: ['clicks'] })).scene_changed).toBeUndefined();
  }, 60_000);
});

describe.skipIf(!enabled)('game input/time: game started from a headless editor (relay)', () => {
  const proj = copySampleProject();
  let client: Client;
  let editorPid: number | undefined;
  const call = (name: string, args: Record<string, unknown>) => client.callTool({ name, arguments: args });

  beforeAll(async () => {
    addTestScene(proj.dir);
    // The editor is headless, and so must be the games it starts (no display).
    appendFileSync(path.join(proj.dir, 'project.godot'), '\n[editor]\n\nrun/main_run_args="--headless"\n');
    spawnSync(GODOT_BIN!, ['--headless', '--path', proj.dir, '--import'], { timeout: 180_000, stdio: 'ignore' });
    client = await startServer({ project: proj.dir, era: 'modern' });
    const launched = json(await call('godot_editor_launch', { headless: true, wait_seconds: 120 }));
    editorPid = launched.pid;
    expect(launched.editor ?? launched.already_running).toBeTruthy();
  }, 240_000);

  afterAll(async () => {
    await call('godot_run_stop', {}).catch(() => undefined);
    await client?.close();
    if (editorPid) await killAndWait(editorPid);
    await proj.cleanup();
  });

  it('clicks, waits and pauses through the editor relay', async () => {
    const run = json(await call('godot_run_start', { mode: 'editor', scene: 'res://input_test.tscn' }));
    expect(run.mode).toBe('editor');
    const r = json(await call('godot_game_input', { steps: [{ type: 'click', at: 'Start' }] }));
    expect(r.run_id).toBe('editor');
    expect(r.steps[0]).toMatchObject({ hit: 'Start', handled: true });
    const cond = json(await call('godot_game_time', { action: 'wait_for', condition: 'clicks == 1', timeout_ms: 3000 }));
    expect(cond.value).toBe(true);
    // Godot's own scene:* debugger commands go through the relay too.
    expect(json(await call('godot_game_time', { action: 'pause' }))).toMatchObject({ run_id: 'editor', suspended: true });
    expect(json(await call('godot_game_time', { action: 'step', frames: 2 }))).toMatchObject({ stepped: { frames: 2 }, suspended: true });
    expect(json(await call('godot_game_time', { action: 'step', physics_ticks: 2 }))).toMatchObject({ stepped: { physics_ticks: 2 }, suspended: true });
    expect(json(await call('godot_game_time', { action: 'resume' }))).toMatchObject({ suspended: false });
  }, 90_000);
});

// Windowed games and Movie Maker (godot_run_start write_movie). Needs a display (Xvfb
// works: Mesa llvmpipe gives OpenGL; a Forward+ project falls back to OpenGL 3 by itself).
describe.skipIf(!enabled || !process.env.DISPLAY)('windowed game and write_movie (needs a display)', () => {
  const proj = copySampleProject();
  let client: Client;

  beforeAll(async () => {
    addTestScene(proj.dir);
    spawnSync(GODOT_BIN!, ['--headless', '--path', proj.dir, '--import'], { timeout: 180_000, stdio: 'ignore' });
    client = await startServer({ project: proj.dir, era: 'modern' });
  }, 240_000);

  afterAll(async () => {
    await client?.close();
    await proj.cleanup();
  });

  it('clicks and steps frames in a windowed game (frames are really drawn)', async () => {
    const call = (name: string, args: Record<string, unknown>) => client.callTool({ name, arguments: args });
    const run = json(await call('godot_run_start', { mode: 'process', headless: false, scene: 'res://input_test.tscn' }));
    expect(run).toMatchObject({ headless: false, runtime: true });
    const read = async (expr: string) => json(await call('godot_game_time', { action: 'wait_for', condition: `[${expr}]`, timeout_ms: 2000 })).value[0];
    const r = json(await call('godot_game_input', { steps: [{ type: 'click', at: 'Start' }] }));
    expect(r.warnings).toBeUndefined(); // no headless resize
    expect(r.steps[0]).toMatchObject({ hit: 'Start', handled: true });
    expect(r.steps[0].warning).toBeUndefined(); // the pointer got there (see below)
    expect(await read('clicks')).toBe(1);
    // In a window, get_mouse_position() follows the real OS pointer, not the events; the
    // runtime warps the pointer with every injected mouse event so games that aim with it
    // see the click position (Start spans 100..220 x 100..140: center 160, 120).
    expect(await read('get_viewport().get_mouse_position()')).toBe('Vector2(160, 120)');
    const moved = json(await call('godot_game_input', { steps: [{ type: 'move', at: [500, 300] }] }));
    expect(moved.steps[0].warning).toBeUndefined();
    expect(await read('get_viewport().get_mouse_position()')).toBe('Vector2(500, 300)');
    expect(json(await call('godot_game_time', { action: 'pause' })).suspended).toBe(true);
    const t0 = Number(await read('ticks'));
    // Here SceneDebugger re-suspends on the real frame_post_draw (no headless helper).
    expect(json(await call('godot_game_time', { action: 'step', frames: 2 }))).toMatchObject({ stepped: { frames: 2 }, suspended: true });
    expect(await read('ticks')).toBe(t0 + 2);
    // A drawing game runs as many physics ticks per frame as real time allows (often 2 at
    // ~30 fps under llvmpipe); physics_ticks still steps exactly one.
    const p0 = Number(await read('pticks'));
    expect(json(await call('godot_game_time', { action: 'step', physics_ticks: 1 })).stepped.physics_ticks).toBe(1);
    expect(await read('pticks')).toBe(p0 + 1);
    await call('godot_game_time', { action: 'resume' });
    await call('godot_run_stop', { run_id: run.run_id });
  }, 60_000);

  it('writes an AVI that Godot finalizes when the game quits by itself', async () => {
    const movie = path.join(proj.dir, 'capture.avi');
    const run = json(await client.callTool({ name: 'godot_run_start', arguments: { mode: 'process', headless: false, write_movie: movie, quit_after_frames: 30 } }));
    let out = '';
    expect(
      await waitFor(async () => {
        const o = json(await client.callTool({ name: 'godot_run_output', arguments: { run_id: run.run_id, limit: 2000 } }));
        out = (o.lines as string[]).join('\n');
        return !o.running;
      }, 60_000),
    ).toBe(true);
    expect(out).toMatch(/Done recording movie at path/);
    expect(existsSync(movie)).toBe(true);
    expect(statSync(movie).size).toBeGreaterThan(10_000);
  }, 120_000);
});
