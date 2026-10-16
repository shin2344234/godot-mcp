/**
 * src/project/classCache.ts: detecting class_name scripts that Godot's global
 * class cache doesn't know yet (so headless runs refresh it first).
 */

import { mkdirSync, mkdtempSync, renameSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ClassCacheWatcher, parseClassCache, parseScriptClass } from '../../src/project/classCache.js';

// Exactly what Godot 4.7.2 writes (copied from a sample project's .godot/).
const CACHE = `list=[{
"base": &"Area2D",
"class": &"Enemy",
"icon": "",
"is_abstract": false,
"is_tool": false,
"language": &"GDScript",
"path": "res://enemy.gd"
}, {
"base": &"FloorLib",
"class": &"SubLib",
"icon": "",
"is_abstract": false,
"is_tool": false,
"language": &"GDScript",
"path": "res://sub_lib.gd"
}]
`;

describe('parseClassCache', () => {
  it('reads every entry', () => {
    expect(parseClassCache(CACHE)).toEqual([
      { name: 'Enemy', path: 'res://enemy.gd', base: 'Area2D' },
      { name: 'SubLib', path: 'res://sub_lib.gd', base: 'FloorLib' },
    ]);
    expect(parseClassCache('list=[]\n')).toEqual([]);
  });
});

describe('parseScriptClass', () => {
  it('finds class_name and an identifier extends in the usual layouts', () => {
    expect(parseScriptClass('class_name Foo\nextends Node2D\n')).toEqual({ name: 'Foo', base: 'Node2D' });
    expect(parseScriptClass('@tool\nextends MeshLibrary\nclass_name Lib\n')).toEqual({ name: 'Lib', base: 'MeshLibrary' });
    expect(parseScriptClass('class_name Sub extends Foo\n')).toEqual({ name: 'Sub', base: 'Foo' });
    expect(parseScriptClass('@abstract class_name Abs\nextends Resource\n')).toEqual({ name: 'Abs', base: 'Resource' });
  });
  it('leaves the base out for path extends, and ignores scripts without class_name', () => {
    expect(parseScriptClass('extends "res://a.gd"\nclass_name P\n')).toEqual({ name: 'P', base: undefined });
    expect(parseScriptClass('extends Node\n# class_name Nope\n')).toBeUndefined();
    expect(parseScriptClass('extends Node\nvar s = "class_name X"\n')).toBeUndefined();
  });
});

describe('ClassCacheWatcher', () => {
  let dir = '';
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  function setup(): void {
    dir = mkdtempSync(path.join(os.tmpdir(), 'class-cache-'));
    mkdirSync(path.join(dir, '.godot'));
    writeFileSync(path.join(dir, 'enemy.gd'), 'class_name Enemy\nextends Area2D\n');
    writeFileSync(path.join(dir, 'sub_lib.gd'), 'class_name SubLib extends FloorLib\n');
    // Scripts older than the cache, as after an import.
    const old = new Date(Date.now() - 60_000);
    utimesSync(path.join(dir, 'enemy.gd'), old, old);
    utimesSync(path.join(dir, 'sub_lib.gd'), old, old);
    writeFileSync(path.join(dir, '.godot', 'global_script_class_cache.cfg'), CACHE);
  }

  it('is quiet when the cache matches, and without a cache', async () => {
    setup();
    expect(await new ClassCacheWatcher(dir).staleClasses()).toEqual([]);
    rmSync(path.join(dir, '.godot'), { recursive: true });
    writeFileSync(path.join(dir, 'new.gd'), 'class_name New\nextends Node\n');
    expect(await new ClassCacheWatcher(dir).staleClasses()).toEqual([]);
  });

  it('reports a new class_name script, a changed base and a moved class, once', async () => {
    setup();
    const future = new Date(Date.now() + 60_000);
    mkdirSync(path.join(dir, 'scripts'));
    writeFileSync(path.join(dir, 'scripts', 'floor.gd'), 'class_name FloorTileLibrary\nextends MeshLibrary\n');
    writeFileSync(path.join(dir, 'enemy.gd'), 'class_name Enemy\nextends CharacterBody2D\n');
    utimesSync(path.join(dir, 'scripts', 'floor.gd'), future, future);
    utimesSync(path.join(dir, 'enemy.gd'), future, future);
    // Ignored: hidden folders and folders with .gdignore.
    mkdirSync(path.join(dir, 'ignored'));
    writeFileSync(path.join(dir, 'ignored', '.gdignore'), '');
    writeFileSync(path.join(dir, 'ignored', 'x.gd'), 'class_name Ignored\n');
    const w = new ClassCacheWatcher(dir);
    const stale = await w.needsRefresh();
    expect(stale.map((s) => s.name).sort()).toEqual(['Enemy', 'FloorTileLibrary']);
    expect(stale.find((s) => s.name === 'FloorTileLibrary')?.path).toBe('res://scripts/floor.gd');
    // Same mismatch again (e.g. Godot rejected it): not reported a second time.
    expect(await w.needsRefresh()).toEqual([]);
  });

  it('reports a class whose script was moved or deleted, although the file is old', async () => {
    // files.move keeps the mtime, so the moved script looks older than the cache; the
    // cache entry at the old path is what gives it away (MCP_TEST_LOG Phase A, files_move).
    setup();
    mkdirSync(path.join(dir, 'scripts'));
    renameSync(path.join(dir, 'enemy.gd'), path.join(dir, 'scripts', 'enemy.gd'));
    const stale = await new ClassCacheWatcher(dir).staleClasses();
    expect(stale).toEqual([{ name: 'Enemy', path: 'res://enemy.gd', base: 'Area2D', gone: true }]);
    rmSync(path.join(dir, 'sub_lib.gd'));
    expect((await new ClassCacheWatcher(dir).staleClasses()).map((s) => s.name).sort()).toEqual(['Enemy', 'SubLib']);
  });

  it('ignores a script edited after the cache when its class entry is unchanged', async () => {
    setup();
    const future = new Date(Date.now() + 60_000);
    writeFileSync(path.join(dir, 'enemy.gd'), 'class_name Enemy\nextends Area2D\nvar hp := 3\n');
    utimesSync(path.join(dir, 'enemy.gd'), future, future);
    expect(await new ClassCacheWatcher(dir).staleClasses()).toEqual([]);
  });
});
