/**
 * End-to-end tests for godot_game_screenshot / godot_game_perf against real
 * Godot (skipped without GODOT_BIN; the rendering suites also need Xvfb):
 *
 *   GODOT_BIN=/path/to/godot npx vitest run test/e2e/game-view.test.ts
 *
 * Rendering: the tests start their own Xvfb display and pass DISPLAY to the
 * server, so games launched with headless:false (and a windowed editor) get
 * a window. The sample project uses the Compatibility renderer
 * (renderer/rendering_method="gl_compatibility"), which runs on Mesa's
 * llvmpipe OpenGL without a GPU.
 *
 * The test scene has a blue background, a red rect at (100,100) 200x100, a
 * hidden yellow "Marker" at (600,300) 100x100 that appears once the file
 * res://show_marker.txt exists, and a 64x64 SubViewport filled with green.
 */

import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, openSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { inflateSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { copySampleProject, errorText, GODOT_BIN, json, killAndWait, startServer } from './helpers.js';

type Client = Awaited<ReturnType<typeof startServer>>;
type ToolResult = { content: { type: string; text?: string; data?: string; mimeType?: string }[]; isError?: boolean };

const hasXvfb = spawnSync('which', ['Xvfb']).status === 0;
const enabled = Boolean(GODOT_BIN);

// --- helpers ------------------------------------------------------------------------

/** Start Xvfb on a free display number; resolves when its socket exists. */
async function startXvfb(): Promise<{ display: string; proc: ChildProcess }> {
  let n = 90 + Math.floor(Math.random() * 100);
  while (existsSync(`/tmp/.X11-unix/X${n}`) || existsSync(`/tmp/.X${n}-lock`)) n++;
  const proc = spawn('Xvfb', [`:${n}`, '-screen', '0', '1280x720x24', '-nolisten', 'tcp'], { stdio: 'ignore' });
  const deadline = Date.now() + 10_000;
  while (!existsSync(`/tmp/.X11-unix/X${n}`) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
  return { display: `:${n}`, proc };
}

/** Minimal PNG decoder (8-bit RGB/RGBA, non-interlaced: what Godot writes). */
function decodePng(buf: Buffer): { width: number; height: number; px: (x: number, y: number) => [number, number, number] } {
  let pos = 8;
  let width = 0;
  let height = 0;
  let colorType = 0;
  const idat: Buffer[] = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('ascii', pos + 4, pos + 8);
    const body = buf.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      colorType = body[9]!;
    } else if (type === 'IDAT') idat.push(body);
    pos += 12 + len;
  }
  const bpp = colorType === 6 ? 4 : 3;
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * bpp;
  const out = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]!;
    for (let i = 0; i < stride; i++) {
      const x = raw[y * (stride + 1) + 1 + i]!;
      const a = i >= bpp ? out[y * stride + i - bpp]! : 0;
      const b = y > 0 ? out[(y - 1) * stride + i]! : 0;
      const c = i >= bpp && y > 0 ? out[(y - 1) * stride + i - bpp]! : 0;
      let v = x;
      if (filter === 1) v = x + a;
      else if (filter === 2) v = x + b;
      else if (filter === 3) v = x + ((a + b) >> 1);
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        v = x + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
      }
      out[y * stride + i] = v & 0xff;
    }
  }
  return { width, height, px: (x, y) => [out[y * stride + x * bpp]!, out[y * stride + x * bpp + 1]!, out[y * stride + x * bpp + 2]!] };
}

function image(result: unknown): { mimeType: string; data: Buffer } {
  const r = result as ToolResult;
  const img = r.content.find((c) => c.type === 'image');
  if (!img) throw new Error(`No image in result: ${JSON.stringify(r.content[0])}`);
  return { mimeType: img.mimeType!, data: Buffer.from(img.data!, 'base64') };
}

/** Rough color check with a margin for filtering/scaling. */
function near(rgb: [number, number, number], want: [number, number, number], tol = 40): boolean {
  return rgb.every((v, i) => Math.abs(v - want[i]!) <= tol);
}

const RED: [number, number, number] = [255, 0, 0];
const BLUE: [number, number, number] = [0, 0, 255];
const GREEN: [number, number, number] = [0, 255, 0];

function writeTestScene(dir: string): void {
  writeFileSync(
    path.join(dir, 'view_test.gd'),
    [
      'extends Node2D',
      '',
      'func _process(_delta: float) -> void:',
      '\theavy_work()',
      '\tif not $Marker.visible and FileAccess.file_exists("res://show_marker.txt"):',
      '\t\t$Marker.visible = true',
      '',
      '## Burns a little time so the script profiler has something to find.',
      'func heavy_work() -> float:',
      '\tvar s := 0.0',
      '\tfor i in 3000:',
      '\t\ts += sqrt(float(i))',
      '\treturn s',
      '',
    ].join('\n'),
  );
  writeFileSync(
    path.join(dir, 'view_test.tscn'),
    `[gd_scene format=3]

[ext_resource type="Script" path="res://view_test.gd" id="1"]

[sub_resource type="RectangleShape2D" id="box"]
size = Vector2(40, 40)

[node name="ViewTest" type="Node2D"]
script = ExtResource("1")

[node name="Background" type="ColorRect" parent="."]
offset_right = 1152.0
offset_bottom = 648.0
color = Color(0, 0, 1, 1)

[node name="Red" type="ColorRect" parent="."]
offset_left = 100.0
offset_top = 100.0
offset_right = 300.0
offset_bottom = 200.0
color = Color(1, 0, 0, 1)

[node name="Marker" type="ColorRect" parent="."]
visible = false
offset_left = 600.0
offset_top = 300.0
offset_right = 700.0
offset_bottom = 400.0
color = Color(1, 1, 0, 1)

[node name="Thing" type="Node2D" parent="."]
position = Vector2(800, 500)

[node name="Shape" type="CollisionShape2D" parent="Thing"]
shape = SubResource("box")

[node name="Logic" type="Node" parent="."]

[node name="Sub" type="SubViewport" parent="."]
size = Vector2i(64, 64)

[node name="Green" type="ColorRect" parent="Sub"]
offset_right = 64.0
offset_bottom = 64.0
color = Color(0, 1, 0, 1)
`,
  );
}

// --- process runs -------------------------------------------------------------------

describe.skipIf(!enabled || !hasXvfb)('game view: windowed process run', () => {
  const proj = copySampleProject();
  let xvfb: { display: string; proc: ChildProcess };
  let client: Client;
  let runId: string;
  const call = (name: string, args: Record<string, unknown> = {}) => client.callTool({ name, arguments: args });

  beforeAll(async () => {
    writeTestScene(proj.dir);
    spawnSync(GODOT_BIN!, ['--headless', '--path', proj.dir, '--import'], { timeout: 180_000, stdio: 'ignore' });
    xvfb = await startXvfb();
    client = await startServer({ project: proj.dir, era: 'modern', env: { DISPLAY: xvfb.display } });
    const r = json(await call('godot_run_start', { scene: 'res://view_test.tscn', mode: 'process', headless: false }));
    expect(r.runtime).toBe(true);
    runId = r.run_id;
  }, 240_000);

  afterAll(async () => {
    await call('godot_run_stop', { run_id: runId }).catch(() => undefined);
    await client?.close();
    xvfb?.proc.kill();
    await new Promise((r) => setTimeout(r, 300));
    await proj.cleanup();
  });

  it('captures the main window, scaled to max_size, as a PNG image block', async () => {
    const result = await call('godot_game_screenshot');
    const r = json(result);
    expect(r).toMatchObject({ run_id: runId, width: 768, height: 432, source: { viewport: 'main window', width: 1152, height: 648 } });
    expect(r.scale).toBeCloseTo(768 / 1152, 3);
    expect(r.image).toBeUndefined(); // the image is a content block, not JSON
    const img = image(result);
    expect(img.mimeType).toBe('image/png');
    const png = decodePng(img.data);
    expect([png.width, png.height]).toEqual([768, 432]);
    // Red rect (100..300, 100..200) -> centre (200,150) * 2/3; background elsewhere.
    expect(near(png.px(133, 100), RED), String(png.px(133, 100))).toBe(true);
    expect(near(png.px(600, 50), BLUE), String(png.px(600, 50))).toBe(true);
  }, 60_000);

  it('crops a region (in viewport pixels) and encodes JPEG', async () => {
    const result = await call('godot_game_screenshot', { region: { x: 100, y: 100, w: 200, h: 100 }, format: 'jpg', quality: 0.9 });
    const r = json(result);
    expect(r).toMatchObject({ width: 200, height: 100, scale: 1, region: { x: 100, y: 100, w: 200, h: 100 } });
    const img = image(result);
    expect(img.mimeType).toBe('image/jpeg');
    expect(img.data[0]).toBe(0xff);
    expect(img.data[1]).toBe(0xd8);
  }, 60_000);

  it('captures a SubViewport by node path', async () => {
    const result = await call('godot_game_screenshot', { node: 'Sub' });
    const r = json(result);
    expect(r).toMatchObject({ width: 64, height: 64, source: { viewport: 'Sub' } });
    const png = decodePng(image(result).data);
    expect(near(png.px(32, 32), GREEN), String(png.px(32, 32))).toBe(true);
  }, 60_000);

  it('frames a node: crops to its on-screen rect plus a little padding', async () => {
    // A Control: its rect (100,100 200x100) grown by 8 px on every side.
    const red = json(await call('godot_game_screenshot', { node: 'Red' }));
    expect(red).toMatchObject({ framed: 'Red', region: { x: 92, y: 92, w: 216, h: 116 }, width: 216, height: 116 });
    // A Node2D with no size of its own is framed by what is below it (here a 40x40
    // collision shape centered on 800,500).
    const thing = json(await call('godot_game_screenshot', { node: 'Thing' }));
    expect(thing).toMatchObject({ framed: 'Thing', region: { x: 772, y: 472, w: 56, h: 56 } });
    // Nodes that are not drawn are refused instead of silently capturing the whole window.
    expect(errorText(await call('godot_game_screenshot', { node: 'Logic' }))).toMatch(/BAD_PARAMS: 'Logic' is a Node, which is not drawn/);
    expect(errorText(await call('godot_game_screenshot', { node: 'Marker' }))).toMatch(/BAD_PARAMS: 'Marker' is hidden/);
    expect(errorText(await call('godot_game_screenshot', { node: 'Red', region: { x: 0, y: 0, w: 5, h: 5 } }))).toMatch(/either 'node'.*or 'region'/);
    // No stretch mode here: the image is in game coordinates, so no game_size is reported.
    expect(red.source.game_size).toBeUndefined();
  }, 60_000);

  it('reports bad regions and unknown nodes clearly', async () => {
    expect(errorText(await call('godot_game_screenshot', { region: { x: 5000, y: 0, w: 10, h: 10 } }))).toMatch(/outside the 1152x648 image/);
    expect(errorText(await call('godot_game_screenshot', { node: 'Nope' }))).toMatch(/NOT_FOUND.*godot_game_tree/);
  }, 60_000);

  it('saves a reference and diffs later screenshots against it', async () => {
    const saved = json(await call('godot_game_screenshot', { save_to: 'user://mcp_shots/ref.png', max_size: 256 }));
    expect(saved.saved_to).toBe('user://mcp_shots/ref.png');
    // width/height describe the scaled preview; the file is full size.
    expect(saved).toMatchObject({ width: 256, saved_size: [1152, 648] });
    const same = json(await call('godot_game_screenshot', { compare_to: 'user://mcp_shots/ref.png' }));
    // The diff runs on the full-resolution capture, whatever max_size the preview has
    // (768 px by default here): the full-size reference needs no scaling.
    expect(same.diff).toMatchObject({ changed_pixels: 0, changed_rect: null, compared_size: [1152, 648] });
    expect(same.diff.reference_size).toBeUndefined();
    const tiny = json(await call('godot_game_screenshot', { compare_to: 'user://mcp_shots/ref.png', max_size: 64 }));
    expect(tiny).toMatchObject({ width: 64, diff: { changed_pixels: 0, compared_size: [1152, 648] } });

    // Show the yellow marker (600,300 100x100) and compare again.
    writeFileSync(path.join(proj.dir, 'show_marker.txt'), 'x');
    await new Promise((r) => setTimeout(r, 1000));
    const changed = json(await call('godot_game_screenshot', { compare_to: 'user://mcp_shots/ref.png' }));
    expect(changed.diff.changed_percent).toBeGreaterThan(1);
    expect(changed.diff.changed_percent).toBeLessThan(3); // 100x100 of 1152x648 is 1.34 %
    const rect = changed.diff.changed_rect;
    for (const [k, want] of Object.entries({ x: 600, y: 300, w: 100, h: 100 })) expect(Math.abs(rect[k] - want), `${k}: ${JSON.stringify(rect)}`).toBeLessThanOrEqual(4);

    expect(errorText(await call('godot_game_screenshot', { compare_to: 'user://mcp_shots/missing.png' }))).toMatch(/No image at/);
  }, 60_000);

  it('returns a performance snapshot', async () => {
    const r = json(await call('godot_game_perf'));
    expect(r.run_id).toBe(runId);
    expect(r.monitors.objects.nodes).toBeGreaterThan(3);
    expect(r.monitors.time).toHaveProperty('process_ms');
    expect(r.monitors.render).toHaveProperty('draw_calls_in_frame');
    expect(r.monitors.engine.rendering_method).toBe('gl_compatibility');
    expect(r.sample).toBeUndefined();
  }, 60_000);

  it('samples frames and profiles script functions at the same time', async () => {
    const r = json(await call('godot_game_perf', { sample_seconds: 1, profile_scripts_seconds: 1, top: 5 }));
    expect(r.sample.frames).toBeGreaterThan(5);
    expect(r.sample.frame_ms.max).toBeGreaterThanOrEqual(r.sample.frame_ms.p95);
    expect(r.sample.frame_ms.p95).toBeGreaterThanOrEqual(r.sample.frame_ms.min);
    expect(r.sample).toHaveProperty('spike_count');
    expect(r.scripts.frames).toBeGreaterThan(5);
    expect(r.scripts.functions.length).toBeLessThanOrEqual(5);
    const heavy = r.scripts.functions.find((f: { function: string }) => f.function === 'heavy_work');
    // Godot reports the first body line (10); the server moves it to the `func` line (9).
    expect(heavy, JSON.stringify(r.scripts)).toMatchObject({ file: 'res://view_test.gd', line: 9, body_line: 10 });
    // A sampling/profiling call leaves the full monitor snapshot out (just fps).
    expect(r.monitors).toBeUndefined();
    expect(typeof r.fps).toBe('number');
    expect(JSON.stringify(r.scripts)).not.toContain('addons/godot_mcp');
    expect(heavy.calls).toBeGreaterThan(5);
    expect(heavy.self_ms).toBeGreaterThan(0);
  }, 60_000);

  it('explains that headless games cannot be captured', async () => {
    const h = json(await call('godot_run_start', { scene: 'res://view_test.tscn', mode: 'process', headless: true }));
    try {
      expect(errorText(await call('godot_game_screenshot', { run_id: h.run_id }))).toMatch(/UNSUPPORTED.*headless:false/);
      // Monitors still work headless.
      expect(json(await call('godot_game_perf', { run_id: h.run_id })).monitors.engine.display).toBe('headless');
    } finally {
      await call('godot_run_stop', { run_id: h.run_id });
    }
  }, 60_000);

  it('needs the editor for editor viewports', async () => {
    expect(errorText(await call('godot_game_screenshot', { source: 'editor_2d' }))).toMatch(/EDITOR_NOT_CONNECTED/);
  }, 60_000);
});

// --- a windowed editor --------------------------------------------------------------

describe.skipIf(!enabled || !hasXvfb)('game view: windowed editor', () => {
  const proj = copySampleProject();
  let xvfb: { display: string; proc: ChildProcess };
  let editor: ChildProcess;
  let client: Client;
  const call = (name: string, args: Record<string, unknown> = {}) => client.callTool({ name, arguments: args });

  beforeAll(async () => {
    writeTestScene(proj.dir);
    spawnSync(GODOT_BIN!, ['--headless', '--path', proj.dir, '--import'], { timeout: 180_000, stdio: 'ignore' });
    xvfb = await startXvfb();
    const log = openSync(path.join(proj.dir, 'editor.log'), 'w');
    editor = spawn(GODOT_BIN!, ['--editor', '--path', proj.dir, '--rendering-driver', 'opengl3'], {
      env: { ...process.env, DISPLAY: xvfb.display },
      stdio: ['ignore', log, log],
    });
    const session = path.join(proj.dir, '.godot', 'godot_mcp', 'session.json');
    const deadline = Date.now() + 120_000;
    while (!existsSync(session) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 250));
    client = await startServer({ project: proj.dir, era: 'modern', env: { DISPLAY: xvfb.display } });
  }, 240_000);

  afterAll(async () => {
    await call('godot_run_stop').catch(() => undefined);
    await client?.close();
    if (editor?.pid) await killAndWait(editor.pid);
    xvfb?.proc.kill();
    await new Promise((r) => setTimeout(r, 300));
    await proj.cleanup();
  });

  it('captures the editor 2D viewport showing the open scene', async () => {
    json(await call('godot_scene_open', { path: 'res://view_test.tscn' }));
    await new Promise((r) => setTimeout(r, 1000));
    const result = await call('godot_game_screenshot', { source: 'editor_2d' });
    const r = json(result);
    expect(r.source).toMatchObject({ viewport: 'editor 2D viewport' });
    expect(r.width).toBeGreaterThan(50);
    const png = decodePng(image(result).data);
    // The red rect is somewhere in view (the editor's camera position is its own choice).
    let red = 0;
    for (let y = 0; y < png.height; y += 2) for (let x = 0; x < png.width; x += 2) if (near(png.px(x, y), RED, 60)) red++;
    expect(red).toBeGreaterThan(10);
  }, 90_000);

  it('switches to the 3D screen when asked for the 3D viewport', async () => {
    const result = await call('godot_game_screenshot', { source: 'editor_3d', max_size: 256 });
    const r = json(result);
    expect(r.switched_main_screen).toBe('3D');
    expect(r.source.viewport).toBe('editor 3D viewport');
    expect(Math.max(r.width, r.height)).toBeLessThanOrEqual(256);
  }, 90_000);

  it('captures the 3D viewport right after another main screen was opened (no CONFLICT)', async () => {
    // The shooting-gallery log: open_script, then editor_3d failed once with "still not
    // visible after switching" (one 300 ms wait wasn't enough); now the server polls.
    json(await call('godot_editor_ui', { action: 'open_script', script: 'res://view_test.gd' }));
    const result = await call('godot_game_screenshot', { source: 'editor_3d', max_size: 128 });
    const r = json(result);
    expect(r.switched_main_screen).toBe('3D');
    expect(r.source.viewport).toBe('editor 3D viewport');
  }, 90_000);

  it('captures a game started from the editor (through the debugger relay)', async () => {
    json(await call('godot_run_start', { scene: 'res://view_test.tscn', mode: 'editor' }));
    const result = await call('godot_game_screenshot', {});
    const r = json(result);
    expect(r.run_id).toBe('editor');
    const png = decodePng(image(result).data);
    expect(near(png.px(133, 100), RED), String(png.px(133, 100))).toBe(true);
    // Monitors work through the relay; the script profiler does not (explained).
    expect(json(await call('godot_game_perf', { sample_seconds: 0.5 })).sample.frames).toBeGreaterThan(0);
    expect(errorText(await call('godot_game_perf', { profile_scripts_seconds: 1 }))).toMatch(/UNSUPPORTED.*process/);
  }, 90_000);
});
