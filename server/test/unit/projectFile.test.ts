import { describe, expect, it } from 'vitest';
import { extractFacts, parseProjectGodot, rawToJson } from '../../src/project/projectFile.js';

const SAMPLE = `; Engine configuration file.
config_version=5

[application]

config/name="Dash \\"Deluxe\\""
run/main_scene="uid://b3k2x1"
config/features=PackedStringArray("4.7", "C#", "Forward Plus")

[autoload]

Game="*res://autoload/game.gd"
Sfx="res://autoload/sfx.gd"

[input]

jump={
"deadzone": 0.2,
"events": [Object(InputEventKey,"resource_local_to_scene":false,"keycode":32,"unicode":32)
]
}
move_left={
"deadzone": 0.5,
"events": []
}

[rendering]

renderer/rendering_method="gl_compatibility"
`;

describe('parseProjectGodot', () => {
  const settings = parseProjectGodot(SAMPLE);

  it('handles top-level keys and sections', () => {
    expect(settings.get('config_version')).toBe('5');
    expect(settings.get('application/config/name')).toBe('"Dash \\"Deluxe\\""');
  });

  it('joins multi-line values until brackets balance', () => {
    const jump = settings.get('input/jump')!;
    expect(jump.startsWith('{')).toBe(true);
    expect(jump.endsWith('}')).toBe(true);
    expect(jump).toContain('InputEventKey');
    // The next key must not have been swallowed.
    expect(settings.has('input/move_left')).toBe(true);
  });

  it('extracts facts', () => {
    const facts = extractFacts(settings, (rel) => rel === 'addons/gut/plugin.cfg');
    expect(facts.name).toBe('Dash "Deluxe"');
    expect(facts.godotVersion).toBe('4.7');
    expect(facts.mainScene).toBe('uid://b3k2x1');
    expect(facts.csharp).toBe(true);
    expect(facts.renderer).toBe('gl_compatibility');
    expect(facts.inputActions).toEqual(['jump', 'move_left']);
    expect(facts.autoloads).toEqual([
      { name: 'Game', path: 'res://autoload/game.gd', singleton: true },
      { name: 'Sfx', path: 'res://autoload/sfx.gd', singleton: false },
    ]);
    expect(facts.testFrameworks).toEqual(['gut']);
  });

  it('converts simple raw values to JSON', () => {
    expect(rawToJson('5')).toBe(5);
    expect(rawToJson('true')).toBe(true);
    expect(rawToJson('"x"')).toBe('x');
    expect(rawToJson('PackedStringArray("a", "b")')).toEqual(['a', 'b']);
    expect(rawToJson('Vector2(1, 2)')).toBe('Vector2(1, 2)');
  });
});
