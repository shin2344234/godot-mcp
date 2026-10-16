/**
 * debug.control step_out: the note that explains a stop outside the caller frame
 * (2D dogfood: stepping out of a function the physics server called landed elsewhere).
 */
import { describe, expect, it } from 'vitest';
import { stepOutNote } from '../../src/ops/debug.js';

const f = (fn: string, file = 'res://player.gd', line = 1) => ({ function: fn, file, line });

describe('stepOutNote', () => {
  it('is silent when the stop is in the caller', () => {
    expect(stepOutNote([f('take_hit'), f('_on_hurt', 'res://slime.gd', 5)], f('_on_hurt', 'res://slime.gd', 6))).toBeUndefined();
  });
  it('explains an engine-called function (no GDScript caller)', () => {
    const note = stepOutNote([f('take_hit', 'res://player.gd', 40)], f('_physics_process', 'res://slime.gd', 23));
    expect(note).toBe(
      'take_hit() had no GDScript caller (the engine called it: a signal, physics or input callback, or a deferred call), so step_out stopped at the next GDScript line that ran: _physics_process() (res://slime.gd:23).',
    );
  });
  it('names the expected caller when the stop is elsewhere', () => {
    const note = stepOutNote([f('take_hit'), f('_on_hurt', 'res://slime.gd', 5)], f('_process', 'res://hud.gd', 9));
    expect(note).toMatch(/^Expected to stop in the caller _on_hurt\(\) \(res:\/\/slime\.gd:5\), but the next GDScript line that ran was _process\(\) \(res:\/\/hud\.gd:9\)\.$/);
  });
});
