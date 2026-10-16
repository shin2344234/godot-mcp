/** Comment/string masking used to drop the language server's false rename/reference hits. */

import { describe, expect, it } from 'vitest';
import { completionHint, findIdentifier, fixDeclDetail, GdMask, isIdentifier } from '../../src/lsp/gdscriptText.js';

const src = [
  'extends Node', // 0
  '## Doc mentions score here', // 1
  'var score := 0 # trailing score comment', // 2
  'var s := "score # not a comment"', // 3
  "var t := &'score' + ^\"a/score\"", // 4
  'var u := """multi', // 5
  'line score', // 6
  'end""" + str(score)', // 7
  'var v := "esc \\" score" + score', // 8
  'var w := r"raw \\" score"', // 9
].join('\n');

describe('GdMask', () => {
  const mask = GdMask.build(src);
  const at = (line: number, word = 'score', nth = 0) => {
    const col = findIdentifier(src.split('\n')[line]!, word)[nth]!;
    return mask.kindAt(line, col);
  };

  it('finds doc and trailing comments', () => {
    expect(at(1)).toBe('comment');
    expect(at(2, 'score', 0)).toBeUndefined();
    expect(at(2, 'score', 1)).toBe('comment');
  });

  it('treats # inside strings as text', () => {
    expect(at(3)).toBe('string');
    expect(mask.kindAt(3, src.split('\n')[3]!.indexOf('#'))).toBe('string');
  });

  it('handles StringName/NodePath prefixes and single quotes', () => {
    expect(at(4, 'score', 0)).toBe('string');
    expect(at(4, 'score', 1)).toBe('string');
  });

  it('tracks triple-quoted strings across lines', () => {
    expect(at(5, 'multi')).toBe('string');
    expect(at(6)).toBe('string');
    expect(at(7, 'end')).toBe('string');
    expect(at(7, 'score')).toBeUndefined();
  });

  it('respects escaped quotes, also in raw strings', () => {
    expect(at(8, 'score', 0)).toBe('string');
    expect(at(8, 'score', 1)).toBeUndefined();
    expect(at(9)).toBe('string');
  });
});

describe('findIdentifier', () => {
  it('matches whole identifiers only, or prefixes on request', () => {
    expect(findIdentifier('score += my_score + score2 + score', 'score')).toEqual([0, 29]);
    expect(findIdentifier('move_and_slide()', 'move_and')).toEqual([]);
    expect(findIdentifier('move_and_slide()', 'move_and', true)).toEqual([0]);
  });
  it('validates identifiers', () => {
    expect(isIdentifier('add_points2')).toBe(true);
    expect(isIdentifier('2fast')).toBe(false);
    expect(isIdentifier('a-b')).toBe(false);
  });
});

describe('completionHint', () => {
  const src = 'extends Node\n\nvar speed := 1.0 # tune me\n\nfunc _ready() -> void:\n\tpass\n';
  it('is silent when there are items', () => {
    expect(completionHint(src, 5, 1, 10, 3, '')).toBeUndefined();
  });
  it('explains a prefix that filtered everything out', () => {
    expect(completionHint(src, 5, 3, 120, 0, 'pz')).toMatch(/120 items .*"pz"/);
  });
  it('explains positions with no completion context', () => {
    expect(completionHint(src, 3, 0, 0, 0, '')).toMatch(/script level/);
    expect(completionHint(src, 2, 26, 0, 0, '')).toMatch(/inside a comment/);
    expect(completionHint(src, 5, 1, 0, 0, '')).toMatch(/partial identifier/);
  });
});

describe('fixDeclDetail', () => {
  // Source and the details Godot 4.7.2's documentSymbol returned for it (probed with a
  // headless editor's language server).
  const lines = [
    'extends Node2D', // 0
    'signal damaged(lives_left: int)', // 1
    'signal hit(by: Node,', // 2
    '\t\tamount: float) # comment, (with parens)', // 3
    'signal plain', // 4
    'var knock := Vector2(1, 2)', // 5
    'var label: String = "hi \\"q\\""', // 6
    'var tint: Color = Color.RED: set = _set_tint', // 7
    'var t := Transform2D.IDENTITY', // 8
    'var with_setter: int = 3:', // 9
    'var arr := [Vector2(1, 2),', // 10
    '\tVector2(3, 4)]', // 11
    'func take_hit(knockback: Vector2 = Vector2(0, -180), name_: String = "x, y", n: int = 3, c := Color.RED, e: Mode = Mode.A) -> void:', // 12
    'func multi(', // 13
    '\t\ta: int,', // 14
    '\t\tb := Vector2.ZERO,', // 15
    ') -> int:', // 16
  ];
  const fix = (detail: string, kind: string, name: string, line: number) => fixDeclDetail(detail, kind, name, lines, line);

  it('puts signal parameter types back from the source', () => {
    expect(fix('signal damaged(lives_left)', 'signal', 'damaged', 1)).toBe('signal damaged(lives_left: int)');
    expect(fix('signal hit(by, amount)', 'signal', 'hit', 2)).toBe('signal hit(by: Node, amount: float)');
    expect(fix('signal plain()', 'signal', 'plain', 4)).toBe('signal plain()');
  });

  it('replaces quoted non-String defaults with the source expression', () => {
    expect(fix('var knock: Vector2 = "(1.0, 2.0)"', 'var', 'knock', 5)).toBe('var knock: Vector2 = Vector2(1, 2)');
    expect(fix('var t: Transform2D = "[X: (1.0, 0.0), Y: (0.0, 1.0), O: (0.0, 0.0)]"', 'var', 't', 8)).toBe('var t: Transform2D = Transform2D.IDENTITY');
    expect(fix('var tint: Color = "(1.0, 0.0, 0.0, 1.0)"', 'var', 'tint', 7)).toBe('var tint: Color = Color.RED');
    expect(fix('var arr: Array = "[(1.0, 2.0), (3.0, 4.0)]"', 'var', 'arr', 10)).toBe('var arr: Array = [Vector2(1, 2), Vector2(3, 4)]');
    expect(
      fix(
        'func take_hit(knockback: Vector2 = "(0.0, -180.0)", name_: String = "x, y", n: int = 3, c: Color = "(1.0, 0.0, 0.0, 1.0)", e: SymProbe.Mode = 0) -> void',
        'func',
        'take_hit',
        12,
      ),
    ).toBe('func take_hit(knockback: Vector2 = Vector2(0, -180), name_: String = "x, y", n: int = 3, c: Color = Color.RED, e: SymProbe.Mode = 0) -> void');
    expect(fix('func multi(a: int, b: Vector2 = "(0.0, 0.0)") -> int', 'func', 'multi', 13)).toBe('func multi(a: int, b: Vector2 = Vector2.ZERO) -> int');
  });

  it('keeps real strings and unquoted values as Godot reports them', () => {
    expect(fix('var label: String = "hi \\"q\\""', 'var', 'label', 6)).toBe('var label: String = "hi \\"q\\""');
    expect(fix('var with_setter: int = 3', 'var', 'with_setter', 9)).toBe('var with_setter: int = 3');
  });

  it('leaves the detail alone when the source does not line up', () => {
    expect(fix('signal gone(a)', 'signal', 'gone', 1)).toBe('signal gone(a)');
    expect(fix('func take_hit(knockback: Vector2 = "(0.0, -180.0)") -> void', 'func', 'take_hit', 12)).toBe('func take_hit(knockback: Vector2 = "(0.0, -180.0)") -> void');
    expect(fix('class Foo', 'class', 'Foo', 0)).toBe('class Foo');
  });
});
