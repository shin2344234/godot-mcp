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

// Secrets inside the project folder: export passwords and the editor bridge token.
// Every file tool resolves paths here, so refusing them here covers reads, writes and edits.
describe('secret files', () => {
  it.each([
    'res://.godot/export_credentials.cfg',
    'res://.GODOT/Export_Credentials.cfg',
    '.godot\\godot_mcp\\session.json',
    'res://.godot/godot_mcp/../godot_mcp/lsp_session.json',
  ])('refuses %s', (p) => {
    expect(() => resolveProjectPath(root, p)).toThrow(/secrets/);
  });

  it('still allows other files in .godot/', () => {
    expect(resolveProjectPath(root, 'res://.godot/godot_mcp/override.cfg.user-backup').rel).toBe('.godot/godot_mcp/override.cfg.user-backup');
  });
});
