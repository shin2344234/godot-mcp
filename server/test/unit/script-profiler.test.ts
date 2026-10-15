/**
 * Parsing of Godot's script profiler frames (src/game/scriptProfiler.ts).
 * Layouts follow ServersProfilerFrame::serialize() in Godot 4.7.2.
 */

import { describe, expect, it } from 'vitest';
import { parseServersFrame, parseSignature } from '../../src/game/scriptProfiler.js';

describe('script profiler parsing', () => {
  it('parses a frame with server blocks and functions', () => {
    const frame = [
      12, 0.016, 0.004, 0.001, 0.0005, 0.002, // frame_number .. script_time
      2, // two servers
      'physics_2d', 4, 'step', 0.0003, 'sync', 0.0001,
      'audio', 0,
      10, // two functions * 5
      0, 3, 0.0015, 0.002, 0,
      1, 60, 0.0005, 0.0005, 0,
    ];
    expect(parseServersFrame(frame)).toEqual({
      frameNumber: 12,
      scriptTime: 0.002,
      functions: [
        { sig: 0, calls: 3, self: 0.0015, total: 0.002 },
        { sig: 1, calls: 60, self: 0.0005, total: 0.0005 },
      ],
    });
  });

  it('parses a final (total) frame, which has no server blocks', () => {
    expect(parseServersFrame([99, 0, 0, 0, 0, 0.5, 0, 5, 4, 7, 0.25, 0.5, 0])?.functions).toEqual([{ sig: 4, calls: 7, self: 0.25, total: 0.5 }]);
  });

  it('rejects truncated frames', () => {
    expect(parseServersFrame([1, 2, 3])).toBeUndefined();
    expect(parseServersFrame([1, 0, 0, 0, 0, 0, 1, 'srv'])).toBeUndefined();
  });

  it('splits GDScript signatures', () => {
    expect(parseSignature('res://player.gd::42::_process')).toEqual({ file: 'res://player.gd', line: 42, function: '_process' });
    expect(parseSignature('res://a.gd::7::Inner.run')).toEqual({ file: 'res://a.gd', line: 7, function: 'Inner.run' });
    expect(parseSignature('weird')).toEqual({ file: '', line: 0, function: 'weird' });
  });
});
