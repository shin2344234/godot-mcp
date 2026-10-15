import { describe, expect, it } from 'vitest';
import { enablePlugin, disablePlugin, PLUGIN_CFG } from '../../src/init/enablePlugin.js';
import { BEGIN, END, removeBlock, upsertBlock } from '../../src/init/markers.js';

describe('managed blocks', () => {
  it('appends, replaces in place, and removes without touching user text', () => {
    const user = '# My project\n\nOur rules.\n';
    const once = upsertBlock(user, 'v1');
    expect(once.startsWith(user.trimEnd())).toBe(true);
    expect(once).toContain(`${BEGIN}\nv1\n${END}`);
    const twice = upsertBlock(once + '\nMore user text.\n', 'v2');
    expect(twice).toContain('v2');
    expect(twice).not.toContain('v1');
    expect(twice).toContain('More user text.');
    expect(removeBlock(twice)).toBe('# My project\n\nOur rules.\n\nMore user text.\n');
  });
  it('prepends when asked (CLAUDE.md import must come first)', () => {
    expect(upsertBlock('existing\n', '@AGENTS.md', 'start').startsWith(BEGIN)).toBe(true);
  });
  it('is idempotent', () => {
    const a = upsertBlock('x\n', 'same');
    expect(upsertBlock(a, 'same')).toBe(a);
  });
});

describe('enablePlugin', () => {
  it('adds a section when missing', () => {
    const out = enablePlugin('config_version=5\n\n[application]\nconfig/name="X"\n');
    expect(out).toContain(`[editor_plugins]\n\nenabled=PackedStringArray("${PLUGIN_CFG}")`);
  });
  it('appends to an existing list and is idempotent', () => {
    const src = '[editor_plugins]\n\nenabled=PackedStringArray("res://addons/gut/plugin.cfg")\n';
    const out = enablePlugin(src);
    expect(out).toContain(`enabled=PackedStringArray("res://addons/gut/plugin.cfg", "${PLUGIN_CFG}")`);
    expect(enablePlugin(out)).toBe(out);
    expect(disablePlugin(out)).toContain('enabled=PackedStringArray("res://addons/gut/plugin.cfg")');
  });
  it('preserves CRLF line endings', () => {
    const out = enablePlugin('[editor_plugins]\r\n\r\nenabled=PackedStringArray()\r\n');
    expect(out).toContain('\r\n');
    expect(out).toContain(PLUGIN_CFG);
  });
});
