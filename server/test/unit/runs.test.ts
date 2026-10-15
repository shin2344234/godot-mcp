import { describe, expect, it } from 'vitest';
import { classifyLine } from '../../src/godot/runs.js';

describe('classifyLine', () => {
  it('recognises Godot error and warning prefixes', () => {
    expect(classifyLine('SCRIPT ERROR: Invalid call.', 'info')).toBe('error');
    expect(classifyLine('ERROR: Cannot open file.', 'info')).toBe('error');
    expect(classifyLine('WARNING: deprecated', 'info')).toBe('warning');
    expect(classifyLine('Hello world', 'error')).toBe('info');
  });
  it('continuation lines inherit the previous level', () => {
    expect(classifyLine('   at: _ready (res://player.gd:12)', 'error')).toBe('error');
  });
});
