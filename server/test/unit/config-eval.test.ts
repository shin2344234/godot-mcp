/**
 * The allowEval switch (--allow-eval / GODOT_MCP_ALLOW_EVAL) that gates godot_game_eval,
 * and the rule that it never changes the tool list.
 */

import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config.js';
import { enabledOperations } from '../../src/ops/catalog.js';

const base = ['--project', '/tmp'];

describe('allowEval config', () => {
  it('is off by default', () => {
    expect(loadConfig(base, {}).allowEval).toBe(false);
  });

  it('is turned on by the --allow-eval flag, with or without a value', () => {
    expect(loadConfig([...base, '--allow-eval'], {}).allowEval).toBe(true);
    expect(loadConfig(['--allow-eval', ...base], {}).allowEval).toBe(true);
    expect(loadConfig([...base, '--allow-eval=yes'], {}).allowEval).toBe(true);
    expect(loadConfig([...base, '--allow-eval', 'false'], {}).allowEval).toBe(false);
  });

  it('reads GODOT_MCP_ALLOW_EVAL with the same truthy parsing as read-only', () => {
    for (const v of ['1', 'true', 'TRUE', 'yes', 'on']) expect(loadConfig(base, { GODOT_MCP_ALLOW_EVAL: v }).allowEval, v).toBe(true);
    for (const v of ['0', 'false', 'no', 'off', '']) expect(loadConfig(base, { GODOT_MCP_ALLOW_EVAL: v }).allowEval, v).toBe(false);
  });

  it('lets the flag override the environment', () => {
    expect(loadConfig([...base, '--allow-eval', '0'], { GODOT_MCP_ALLOW_EVAL: '1' }).allowEval).toBe(false);
  });

  it('does not change which tools are listed', () => {
    const names = (allow: boolean) => enabledOperations(loadConfig(allow ? [...base, '--allow-eval'] : base, {})).map((op) => op.name);
    expect(names(true)).toEqual(names(false));
    expect(names(false)).toContain('game.eval');
  });
});
