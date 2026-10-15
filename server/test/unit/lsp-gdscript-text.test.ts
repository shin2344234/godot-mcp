/** Comment/string masking used to drop the language server's false rename/reference hits. */

import { describe, expect, it } from 'vitest';
import { findIdentifier, GdMask, isIdentifier } from '../../src/lsp/gdscriptText.js';

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
