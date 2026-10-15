/**
 * End-to-end tests for the audio bus tools (audio.buses, audio.edit) against
 * real Godot; skipped without GODOT_BIN.
 *
 *   GODOT_BIN=/path/to/godot npx vitest run test/e2e/audio.test.ts
 *
 * The sample project has no default_bus_layout.tres, so the first edit
 * creates it (the common real-world case).
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { copySampleProject, errorText, GODOT_BIN, json, killAndWait, startServer } from './helpers.js';

describe.skipIf(!GODOT_BIN)('audio (headless)', () => {
  const proj = copySampleProject();
  const layoutFile = path.join(proj.dir, 'default_bus_layout.tres');
  let client: Awaited<ReturnType<typeof startServer>>;
  const call = async (name: string, args: Record<string, unknown>) => client.callTool({ name, arguments: args });

  beforeAll(async () => {
    client = await startServer({ project: proj.dir, era: 'modern' });
  }, 240_000);
  afterAll(async () => {
    await client?.close();
    await proj.cleanup();
  });

  it('reads the default layout (Master only, no file yet)', async () => {
    const res = json(await call('godot_audio_buses', {}));
    expect(res.backend).toBe('headless');
    expect(res.layout).toBe('res://default_bus_layout.tres');
    expect(res.layout_exists).toBe(false);
    expect(res.buses).toHaveLength(1);
    expect(res.buses[0]).toMatchObject({ name: 'Master', volume_db: 0, send: null, effects: [] });
  }, 60_000);

  it('edits buses and effects and writes the layout file', async () => {
    const res = json(
      await call('godot_audio_edit', {
        ops: [
          { op: 'add_bus', name: 'Music', volume_db: -6 },
          { op: 'add_bus', name: 'SFX' },
          { op: 'add_bus', name: 'Ambience', send: 'SFX' },
          { op: 'add_effect', bus: 'Music', type: 'AudioEffectReverb', properties: { room_size: 0.6 } },
          { op: 'add_effect', bus: 'Music', type: 'AudioEffectLowPassFilter', index: 0, enabled: false },
          { op: 'set_effect', bus: 'Music', effect: 1, properties: { damping: 0.25 } },
          { op: 'rename_bus', bus: 'SFX', name: 'Effects' },
          { op: 'move_bus', bus: 'Ambience', index: 1 },
          { op: 'set', bus: 'Effects', mute: true },
        ],
      }),
    );
    expect(res.saved).toBe(true);
    expect(res.buses.map((b: any) => b.name)).toEqual(['Master', 'Ambience', 'Music', 'Effects']);
    // Renaming SFX also re-pointed the bus that sent to it.
    expect(res.buses[1].send).toBe('Effects');
    expect(res.buses[3].mute).toBe(true);
    expect(res.buses[2].effects.map((e: any) => [e.class, e.enabled])).toEqual([
      ['AudioEffectLowPassFilter', false],
      ['AudioEffectReverb', true],
    ]);
    expect(res.buses[2].effects[1].properties.damping).toBeCloseTo(0.25);

    const text = readFileSync(layoutFile, 'utf8');
    expect(text).toMatch(/^\[gd_resource type="AudioBusLayout" format=3 uid="uid:\/\//);
    expect(text).toContain('bus/2/name = &"Music"');

    const read = json(await call('godot_audio_buses', {}));
    expect(read.layout_exists).toBe(true);
    expect(read.buses[2].effects[0].class).toBe('AudioEffectLowPassFilter');

    const removed = json(await call('godot_audio_edit', { ops: [{ op: 'remove_bus', bus: 'Effects' }, { op: 'remove_effect', bus: 'Music', effect: 0 }] }));
    expect(removed.buses[1].send).toBe('Master'); // Ambience sent to the removed bus
    expect(removed.warnings[0]).toMatch(/now sends to Master/);
    expect(removed.buses[2].effects.map((e: any) => e.class)).toEqual(['AudioEffectReverb']);
  }, 120_000);

  it('rejects bad edits without touching the file', async () => {
    const before = readFileSync(layoutFile, 'utf8');
    expect(errorText(await call('godot_audio_edit', { ops: [{ op: 'remove_bus', bus: 'Master' }] }))).toMatch(/Master bus .* cannot be removed/);
    expect(errorText(await call('godot_audio_edit', { ops: [{ op: 'set', bus: 'Musik', volume_db: -3 }] }))).toMatch(/Did you mean: Music/);
    expect(errorText(await call('godot_audio_edit', { ops: [{ op: 'add_effect', bus: 'Music', type: 'AudioEffectReverbb' }] }))).toMatch(/AudioEffectReverb/);
    // The first op is valid, the second is not: nothing may be saved.
    expect(errorText(await call('godot_audio_edit', { ops: [{ op: 'add_bus', name: 'Voice' }, { op: 'add_bus', name: 'Music' }] }))).toMatch(/already exists/);
    expect(readFileSync(layoutFile, 'utf8')).toBe(before);
  }, 120_000);
});

describe.skipIf(!GODOT_BIN)('audio (editor)', () => {
  const proj = copySampleProject();
  let client: Awaited<ReturnType<typeof startServer>>;
  const call = async (name: string, args: Record<string, unknown>) => client.callTool({ name, arguments: args });

  beforeAll(async () => {
    spawnSync(GODOT_BIN!, ['--headless', '--path', proj.dir, '--import'], { timeout: 180_000, stdio: 'ignore' });
    client = await startServer({ project: proj.dir, era: 'legacy' });
    const launched = json(await call('godot_editor_launch', { headless: true, wait_seconds: 90 }));
    expect(launched.editor ?? launched.connected).toBeTruthy();
  }, 300_000);

  afterAll(async () => {
    await client?.close();
    try {
      const session = JSON.parse(readFileSync(path.join(proj.dir, '.godot', 'godot_mcp', 'session.json'), 'utf8'));
      await killAndWait(session.pid);
    } catch {
      // the editor never came up
    }
    await proj.cleanup();
  });

  it('changes the live AudioServer and saves the layout file', async () => {
    const res = json(
      await call('godot_audio_edit', {
        ops: [
          { op: 'add_bus', name: 'Music', volume_db: -3 },
          { op: 'add_effect', bus: 'Music', type: 'AudioEffectCompressor', properties: { threshold: -12 } },
        ],
      }),
    );
    expect(res.backend).toBe('editor');
    expect(res.buses.map((b: any) => b.name)).toEqual(['Master', 'Music']);

    const read = json(await call('godot_audio_buses', {}));
    expect(read.source).toBe('audio_server');
    expect(read.buses[1]).toMatchObject({ name: 'Music', volume_db: -3 });
    expect(read.buses[1].effects[0]).toMatchObject({ class: 'AudioEffectCompressor' });

    const file = path.join(proj.dir, 'default_bus_layout.tres');
    expect(existsSync(file)).toBe(true);
    expect(readFileSync(file, 'utf8')).toContain('AudioEffectCompressor');
  }, 120_000);
});
