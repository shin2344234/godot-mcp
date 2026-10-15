import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { PathError, resolveProjectPath } from '../../src/project/paths.js';

const root = path.resolve('/tmp/proj');

describe('resolveProjectPath', () => {
  it('accepts res://, relative and ./ forms', () => {
    expect(resolveProjectPath(root, 'res://a/b.gd').res).toBe('res://a/b.gd');
    expect(resolveProjectPath(root, 'a/b.gd').res).toBe('res://a/b.gd');
    expect(resolveProjectPath(root, './a/b.gd').rel).toBe('a/b.gd');
    expect(resolveProjectPath(root, 'a\\b.gd').rel).toBe('a/b.gd');
    expect(resolveProjectPath(root, 'res://').rel).toBe('');
  });

  it('rejects escapes, absolute paths and user://', () => {
    expect(() => resolveProjectPath(root, '../x')).toThrow(PathError);
    expect(() => resolveProjectPath(root, 'res://a/../../x')).toThrow(PathError);
    expect(() => resolveProjectPath(root, '/etc/passwd')).toThrow(PathError);
    expect(() => resolveProjectPath(root, 'C:/Windows/x')).toThrow(PathError);
    expect(() => resolveProjectPath(root, 'user://save.dat')).toThrow(PathError);
  });
});
