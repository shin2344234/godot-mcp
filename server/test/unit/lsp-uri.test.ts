/**
 * file:// URI conversion, matching Godot's GDScriptWorkspace::get_file_uri (uppercase
 * percent-encoding of every byte outside A-Z a-z 0-9 _ . - ~, drive colon included) and
 * accepting the common forms back. Windows behaviour is tested via the platform parameter.
 */

import { describe, expect, it } from 'vitest';
import { fileUriToPath, godotUriEncode, pathToFileUri, UriError, uriToProjectRel } from '../../src/lsp/uri.js';

describe('godotUriEncode', () => {
  it('keeps unreserved characters and encodes the rest in uppercase hex', () => {
    expect(godotUriEncode('a-b_c.d~e')).toBe('a-b_c.d~e');
    expect(godotUriEncode('my game')).toBe('my%20game');
    expect(godotUriEncode('C:')).toBe('C%3A');
    expect(godotUriEncode('é')).toBe('%C3%A9');
    expect(godotUriEncode('a+b#c')).toBe('a%2Bb%23c');
  });
});

describe('POSIX paths', () => {
  it('round-trips plain and special paths', () => {
    expect(pathToFileUri('/home/me/proj/player.gd', 'linux')).toBe('file:///home/me/proj/player.gd');
    const odd = '/tmp/My Game (copy)/scripts/héros #1.gd';
    const uri = pathToFileUri(odd, 'linux');
    expect(uri).toBe('file:///tmp/My%20Game%20%28copy%29/scripts/h%C3%A9ros%20%231.gd');
    expect(fileUriToPath(uri, 'linux')).toBe(odd);
  });

  it('accepts localhost and Node-style URIs', () => {
    expect(fileUriToPath('file://localhost/tmp/a.gd', 'linux')).toBe('/tmp/a.gd');
    expect(fileUriToPath('file:///tmp/a%20b.gd', 'linux')).toBe('/tmp/a b.gd');
  });

  it('rejects non-file and non-local URIs', () => {
    expect(() => fileUriToPath('res://main.gd', 'linux')).toThrow(UriError);
    expect(() => fileUriToPath('file://server/share/a.gd', 'linux')).toThrow(/Non-local/);
    expect(() => fileUriToPath('file:///bad%E0%A4%A.gd', 'linux')).toThrow(/percent/);
  });
});

describe('Windows paths', () => {
  it('encodes like Godot: drive after a slash, colon percent-encoded', () => {
    expect(pathToFileUri('C:\\Users\\Me\\My Game\\player.gd', 'win32')).toBe('file:///C%3A/Users/Me/My%20Game/player.gd');
    expect(pathToFileUri('D:/proj/a.gd', 'win32')).toBe('file:///D%3A/proj/a.gd');
  });

  it('decodes Godot, VS Code and Node forms to a backslash path', () => {
    expect(fileUriToPath('file:///C%3A/Users/Me/My%20Game/player.gd', 'win32')).toBe('C:\\Users\\Me\\My Game\\player.gd');
    expect(fileUriToPath('file:///c%3a/users/me/a.gd', 'win32')).toBe('c:\\users\\me\\a.gd');
    expect(fileUriToPath('file:///C:/proj/a.gd', 'win32')).toBe('C:\\proj\\a.gd');
  });

  it('maps URIs to project-relative paths case-insensitively', () => {
    const root = 'C:\\Users\\Me\\My Game';
    expect(uriToProjectRel('file:///C%3A/Users/Me/My%20Game/scenes/Player.gd', [root], 'win32')).toBe('scenes/Player.gd');
    expect(uriToProjectRel('file:///c%3A/users/me/my%20game/scenes/Player.gd', [root], 'win32')).toBe('scenes/Player.gd');
    expect(uriToProjectRel('file:///C%3A/Users/Me/Other/x.gd', [root], 'win32')).toBeUndefined();
    expect(uriToProjectRel('file:///D%3A/Users/Me/My%20Game/x.gd', [root], 'win32')).toBeUndefined();
  });
});

describe('uriToProjectRel (POSIX)', () => {
  it('uses any of several root spellings and refuses escapes', () => {
    const roots = ['/var/folders/p', '/private/var/folders/p'];
    expect(uriToProjectRel('file:///private/var/folders/p/a/b.gd', roots, 'darwin')).toBe('a/b.gd');
    expect(uriToProjectRel('file:///var/folders/p/../q/x.gd', roots, 'darwin')).toBeUndefined();
    expect(uriToProjectRel('file:///var/folders/p', roots, 'darwin')).toBeUndefined();
    expect(uriToProjectRel('not a uri', roots, 'linux')).toBeUndefined();
  });
});
