/**
 * Docs index building (extension_api.json -> compact index), search ranking, lookups and
 * project-script doc parsing, on a tiny fixture (no Godot needed).
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { buildIndexFromApi, cacheRoot, prettyType } from '../../src/docs/docIndex.js';
import { parseScriptDocs } from '../../src/docs/projectDocs.js';
import { DocSearcher } from '../../src/docs/search.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const api = JSON.parse(readFileSync(path.join(here, 'fixtures', 'docs-mini-api.json'), 'utf8'));
const index = buildIndexFromApi(api, '4.7.2.stable.test');
const engine = new DocSearcher(index.classes);

describe('buildIndexFromApi', () => {
  it('synthesises @GlobalScope and includes the bundled @GDScript', () => {
    const g = engine.getClass('@GlobalScope')!;
    expect(g.m.find((m) => m.n === 'lerp')!.s).toBe('func lerp(from: Variant, to: Variant, weight: Variant) -> Variant');
    expect(g.m.find((m) => m.n === 'print')!.s).toBe('func print(arg1: Variant, ...) -> void');
    expect(g.m.find((m) => m.n === 'KEY_SPACE')).toMatchObject({ k: 'constant', e: 'Key' });
    expect(g.m.find((m) => m.n === 'Input')).toMatchObject({ k: 'property' });
    const gd = engine.getClass('@GDScript')!;
    expect(gd.m.find((m) => m.n === 'preload')).toMatchObject({ k: 'utility', s: 'func preload(path: String) -> Resource' });
    expect(gd.m.some((m) => m.k === 'annotation' && m.n === '@export')).toBe(true);
  });

  it('writes GDScript-style signatures', () => {
    const node = engine.getClass('Node')!;
    expect(node.m.find((m) => m.n === 'get_children')!.s).toBe('func get_children(include_internal: bool = false) -> Array[Node] const');
    expect(node.m.find((m) => m.n === '_process')!.s).toBe('func _process(delta: float) -> void virtual');
    expect(node.m.find((m) => m.n === 'ProcessMode')!.s).toBe('enum ProcessMode { PROCESS_MODE_INHERIT = 0 }');
    expect(node.m.find((m) => m.n === 'PROCESS_MODE_INHERIT')).toMatchObject({ k: 'constant', e: 'ProcessMode' });
    const v2 = engine.getClass('Vector2')!;
    expect(v2.t).toBe('builtin');
    expect(v2.m.find((m) => m.k === 'constructor')!.s).toBe('Vector2(x: float, y: float)');
    expect(v2.m.find((m) => m.n === 'x')!.s).toBe('var x: float');
    expect(engine.getClass('EditorMoveTool')!.a).toBe('editor');
  });

  it('pretty-prints API type names', () => {
    expect(prettyType('enum::Node.ProcessMode')).toBe('Node.ProcessMode');
    expect(prettyType('bitfield::MouseButtonMask')).toBe('MouseButtonMask');
    expect(prettyType('typedarray::Node')).toBe('Array[Node]');
    expect(prettyType('typeddictionary::String;int')).toBe('Dictionary[String, int]');
    expect(prettyType(undefined)).toBe('void');
  });
});

describe('DocSearcher', () => {
  it('ranks exact member names first and editor classes lower', () => {
    const hits = engine.search('move_and_slide', undefined, 10);
    expect(hits.slice(0, 2).map((h) => h.class).sort()).toEqual(['CharacterBody2D', 'CharacterBody3D']);
    expect(hits[0]!.member).toBe('move_and_slide');
    expect(hits[0]!.brief).toBe('Moves the body based on `velocity`.');
    // The prefix match in an editor-only class comes after the exact matches.
    expect(hits.findIndex((h) => h.class === 'EditorMoveTool')).toBeGreaterThan(1);
  });

  it('finds classes by exact name before members containing it', () => {
    const hits = engine.search('node', undefined, 5);
    expect(hits[0]).toMatchObject({ class: 'Node', kind: 'class' });
  });

  it('filters by kind', () => {
    expect(engine.search('ready', 'signal', 5).map((h) => `${h.class}.${h.member}`)).toEqual(['Node.ready']);
    expect(engine.search('Vector2', 'method', 5).every((h) => h.kind === 'method' || h.kind === 'constructor')).toBe(true);
  });

  it('matches multi-word queries against names and briefs', () => {
    const hits = engine.search('play sound', undefined, 5);
    expect(hits[0]).toMatchObject({ class: 'AudioStreamPlayer', member: 'play' });
  });

  it('restricts to a class chain for Class.member searches', () => {
    const names = new Set(engine.chain(engine.getClass('CharacterBody2D')!).map((c) => c.n));
    const hits = engine.search('pro', undefined, 10, names);
    expect(hits.map((h) => h.member)).toContain('process_mode');
    expect(hits.every((h) => names.has(h.class))).toBe(true);
  });

  it('walks inheritance for members and suggests close class names', () => {
    const cb = engine.getClass('characterbody2d')!;
    expect(engine.chain(cb).map((c) => c.n)).toEqual(['CharacterBody2D', 'Node2D', 'Node', 'Object']);
    expect(engine.findMember(cb, 'free')!.owner.n).toBe('Object');
    expect(engine.findMember(cb, 'free', false)).toBeUndefined();
    expect(engine.suggestClasses('Nod2D')).toContain('Node2D');
  });
});

describe('parseScriptDocs', () => {
  const script = [
    '@tool',
    'class_name Enemy',
    'extends CharacterBody2D',
    '## A hostile mob.',
    '##',
    '## Chases the player and deals damage on contact.',
    '',
    '## Emitted when the enemy dies.',
    'signal died(points: int)',
    '',
    'enum Kind { SLIME, BAT }',
    '',
    '## Damage dealt per hit.',
    '@export var damage: int = 10',
    'const MAX_HP := 3 ## Hit points at spawn.',
    '',
    '## Applies [param amount] damage.',
    'func hurt(amount: int,',
    '\t\tsource: Node = null) -> void:',
    '\tvar local := 1 ## not a member',
    '',
    'static func make() -> Enemy: return Enemy.new()',
  ].join('\n');
  const cls = parseScriptDocs(script, 'res://enemy.gd')!;

  it('reads class name, parent, brief and description', () => {
    expect(cls).toMatchObject({ n: 'Enemy', i: 'CharacterBody2D', t: 'project', p: 'res://enemy.gd', b: 'A hostile mob.', d: 'Chases the player and deals damage on contact.' });
  });

  it('reads top-level members with their docs and signatures', () => {
    const m = Object.fromEntries(cls.m.map((x) => [x.n, x]));
    expect(Object.keys(m)).toEqual(['died', 'Kind', 'damage', 'MAX_HP', 'hurt', 'make']);
    expect(m.died).toMatchObject({ k: 'signal', d: 'Emitted when the enemy dies.' });
    expect(m.damage).toMatchObject({ k: 'property', s: '@export var damage: int = 10', d: 'Damage dealt per hit.' });
    expect(m.MAX_HP).toMatchObject({ k: 'constant', d: 'Hit points at spawn.' });
    expect(m.hurt!.s).toBe('func hurt(amount: int, source: Node = null) -> void');
    expect(m.hurt!.d).toBe('Applies [param amount] damage.');
    expect(m.make!.s).toBe('static func make() -> Enemy');
    expect(m.Kind!.k).toBe('enum');
  });

  it('names autoloads without class_name and skips plain scripts', () => {
    expect(parseScriptDocs('extends Node\n## Global data.\n\nvar score := 0\n', 'res://gs.gd', 'GameState')).toMatchObject({ n: 'GameState', i: 'Node', b: 'Global data.' });
    expect(parseScriptDocs('extends Node\n', 'res://x.gd')).toBeUndefined();
  });
});

describe('cacheRoot', () => {
  it('follows OS conventions', () => {
    expect(cacheRoot({ XDG_CACHE_HOME: '/xdg' }, 'linux')).toBe(path.join('/xdg', 'godot-mcp'));
    expect(cacheRoot({ LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local' }, 'win32')).toContain('godot-mcp');
    expect(cacheRoot({}, 'darwin')).toContain(path.join('Library', 'Caches', 'godot-mcp'));
    expect(cacheRoot({ GODOT_MCP_CACHE_DIR: '/custom' }, 'linux')).toBe('/custom');
  });
});
