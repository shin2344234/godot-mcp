/** Godot doc BBCode -> Markdown. */

import { describe, expect, it } from 'vitest';
import { bbcodeToMarkdown, dedent, firstSentence } from '../../src/docs/bbcode.js';

describe('bbcodeToMarkdown', () => {
  it('converts emphasis, inline code and cross references', () => {
    expect(bbcodeToMarkdown('Moves the body based on [member velocity]. Returns [code]true[/code] if [b]any[/b] [i]collision[/i].')).toBe(
      'Moves the body based on `velocity`. Returns `true` if **any** *collision*.',
    );
    expect(bbcodeToMarkdown('See [method Node._physics_process], [signal ready], [constant FOO], [enum Mode], [param delta], [annotation @export].')).toBe(
      'See `Node._physics_process()`, `ready`, `FOO`, `Mode`, `delta`, `@export`.',
    );
  });

  it('turns class references into code and keeps unknown text', () => {
    expect(bbcodeToMarkdown('A [CharacterBody2D] or [@GlobalScope] [int].')).toBe('A `CharacterBody2D` or `@GlobalScope` `int`.');
  });

  it('keeps [code] contents literal, including brackets', () => {
    expect(bbcodeToMarkdown('Use [code][b]x[/b][/code] or [code]Array[lb]int[rb][/code].')).toBe('Use `[b]x[/b]` or `Array[int]`.');
  });

  it('fences code blocks and keeps only GDScript from [codeblocks]', () => {
    const md = bbcodeToMarkdown('Example:\n[codeblocks]\n[gdscript]\nvar a = [1, 2]\nprint(a)\n[/gdscript]\n[csharp]\nvar a = new int[] {1, 2};\n[/csharp]\n[/codeblocks]\nDone.');
    expect(md).toBe('Example:\n```gdscript\nvar a = [1, 2]\nprint(a)\n```\nDone.');
    expect(bbcodeToMarkdown('[codeblock lang=text]\n\tcode [b]here[/b]\n[/codeblock]')).toBe('```text\ncode [b]here[/b]\n```');
  });

  it('converts links, strips purely visual tags and decodes [lb]/[rb]', () => {
    expect(bbcodeToMarkdown('[url=https://docs.godotengine.org]docs[/url] and [url]https://x.y[/url]')).toBe('[docs](https://docs.godotengine.org) and <https://x.y>');
    expect(bbcodeToMarkdown('[center][color=red]Red[/color][/center] [u]u[/u] [lb]x[rb][br]next')).toBe('Red u [x]\nnext');
  });

  it('handles empty input', () => {
    expect(bbcodeToMarkdown('')).toBe('');
  });
});

describe('helpers', () => {
  it('dedents XML-indented text', () => {
    expect(dedent('\t\t\tA\n\t\t\t\tB\n\n\t\t\tC')).toBe('A\n\tB\n\nC');
  });
  it('extracts a first sentence', () => {
    expect(firstSentence('Moves the body. More text.')).toBe('Moves the body.');
    expect(firstSentence('No period here')).toBe('No period here');
    expect(firstSentence('x'.repeat(300), 20)).toBe('x'.repeat(17) + '...');
    expect(firstSentence('Code:\n```gdscript\nvar a\n```')).toBe('Code:');
  });
});
