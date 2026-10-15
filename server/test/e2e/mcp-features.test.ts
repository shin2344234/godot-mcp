/**
 * MCP features beyond tools: resources, prompts, completion, and asking the
 * user before irreversible operations (elicitation), in both protocol eras.
 * Needs no Godot, except the scene-tree resource read (skipped without it).
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GODOT_BIN, json, makeMiniProject, startServer } from './helpers.js';

const mini = makeMiniProject();
// A scene and a nested script so the resource lists have something to show.
mkdirSync(path.join(mini.dir, 'levels'), { recursive: true });
writeFileSync(path.join(mini.dir, 'levels', 'level_1.tscn'), '[gd_scene format=3]\n\n[node name="Level1" type="Node2D"]\n');
writeFileSync(path.join(mini.dir, 'levels', 'level.gd'), 'extends Node2D\n');
afterAll(() => mini.cleanup());

describe.each(['legacy', 'modern'] as const)('resources and prompts (%s)', (era) => {
  let client: Awaited<ReturnType<typeof startServer>>;
  beforeAll(async () => {
    client = await startServer({ project: mini.dir, era });
  });
  afterAll(async () => {
    await client.close();
  });

  it('lists static resources and the project scenes/scripts', async () => {
    const { resources } = await client.listResources();
    const uris = resources.map((r) => r.uri);
    expect(uris).toEqual(expect.arrayContaining(['godot://project/info', 'godot://editor/status', 'godot://scene/levels/level_1.tscn', 'godot://script/game.gd', 'godot://script/levels/level.gd']));
    const { resourceTemplates } = await client.listResourceTemplates();
    expect(resourceTemplates.map((t) => t.uriTemplate)).toEqual(expect.arrayContaining(['godot://scene/{+path}', 'godot://script/{+path}']));
  });

  it('reads project info and script source', async () => {
    const info = await client.readResource({ uri: 'godot://project/info' });
    expect(JSON.parse((info.contents[0] as { text: string }).text).name).toBe('Mini');
    const script = await client.readResource({ uri: 'godot://script/levels/level.gd' });
    expect((script.contents[0] as { text: string }).text).toBe('extends Node2D\n');
  });

  it('cannot read files outside the project', async () => {
    // URL parsing folds the ".." away (godot://script/etc/passwd), and that
    // path is resolved inside the project, where it doesn't exist.
    await expect(client.readResource({ uri: 'godot://script/../../etc/passwd' })).rejects.toThrow(/not found/i);
    await expect(client.readResource({ uri: 'godot://script/missing.gd' })).rejects.toThrow(/not found/i);
  });

  it.skipIf(!GODOT_BIN)('reads a scene tree through headless Godot', async () => {
    // The mini project has no addon, so the scene tool reports that clearly.
    const res = await client.readResource({ uri: 'godot://scene/levels/level_1.tscn' });
    const body = JSON.parse((res.contents[0] as { text: string }).text);
    expect(body.error ?? body.root?.name).toBeTruthy();
  });

  it('lists prompts and expands one', async () => {
    const { prompts } = await client.listPrompts();
    expect(prompts.map((p) => p.name)).toEqual(expect.arrayContaining(['scaffold-player', 'triage-errors', 'port-from-godot-3', 'write-shader']));
    const got = await client.getPrompt({ name: 'scaffold-player', arguments: { dimension: '3d' } });
    const text = (got.messages[0]!.content as { text: string }).text;
    expect(text).toContain('CharacterBody3D');
  });

  it('completes prompt arguments and resource template variables', async () => {
    const scene = await client.complete({ ref: { type: 'ref/prompt', name: 'triage-errors' }, argument: { name: 'scene', value: 'level' } });
    expect(scene.completion.values).toEqual(['res://levels/level_1.tscn']);
    const script = await client.complete({ ref: { type: 'ref/resource', uri: 'godot://script/{+path}' }, argument: { name: 'path', value: 'lev' } });
    expect(script.completion.values).toEqual(['levels/level.gd']);
  });
});

describe.each(['legacy', 'modern'] as const)('confirmation before deleting (%s)', (era) => {
  const asked: string[] = [];
  let answer: 'accept' | 'decline' = 'decline';
  let client: Awaited<ReturnType<typeof startServer>>;
  let plain: Awaited<ReturnType<typeof startServer>>;
  beforeAll(async () => {
    client = await startServer({
      project: mini.dir,
      era,
      onElicit: (message) => {
        asked.push(message);
        return answer === 'accept' ? { action: 'accept', content: { confirm: true } } : { action: 'decline' };
      },
    });
    // A client without elicitation support: no dialog, the call just runs.
    plain = await startServer({ project: mini.dir, era });
  });
  afterAll(async () => {
    await client.close();
    await plain.close();
  });

  it('keeps the file when the user declines', async () => {
    writeFileSync(path.join(mini.dir, `keep_${era}.txt`), 'x');
    answer = 'decline';
    const res = json(await client.callTool({ name: 'godot_files_delete', arguments: { path: `res://keep_${era}.txt` } }));
    expect(res.cancelled).toBe(true);
    expect(asked.at(-1)).toMatch(/Delete res:\/\/keep_.*cannot be undone/);
    expect(existsSync(path.join(mini.dir, `keep_${era}.txt`))).toBe(true);
  });

  it('deletes after the user accepts', async () => {
    answer = 'accept';
    const res = json(await client.callTool({ name: 'godot_files_delete', arguments: { path: `res://keep_${era}.txt` } }));
    expect(res.deleted).toBe(`res://keep_${era}.txt`);
    expect(existsSync(path.join(mini.dir, `keep_${era}.txt`))).toBe(false);
  });

  it('runs without asking when the client cannot show a dialog', async () => {
    writeFileSync(path.join(mini.dir, `plain_${era}.txt`), 'x');
    const before = asked.length;
    const res = json(await plain.callTool({ name: 'godot_files_delete', arguments: { path: `res://plain_${era}.txt` } }));
    expect(res.deleted).toBe(`res://plain_${era}.txt`);
    expect(asked.length).toBe(before);
  });
});
