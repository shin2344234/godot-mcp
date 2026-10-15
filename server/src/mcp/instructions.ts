/**
 * Server instructions, sent to clients that support them (Claude Code,
 * Codex, Gemini CLI, VS Code inject them into the system prompt).
 *
 * Kept short (< 2 KB) and front-loaded: Claude Code truncates at 4,096
 * characters, and with tool search on, instructions are often the only text
 * the model sees about this server until it searches. Per the spec they
 * should not repeat what tool descriptions already say.
 */

import type { ToolMode } from '../config.js';

export function buildInstructions(mode: ToolMode): string {
  const lines = [
    'Godot 4 game engine tools (scenes, nodes, scripts, running the game, errors). Your training data may predate Godot 4.7: prefer Godot 4 APIs (e.g. CharacterBody2D, @export, signal.connect(callable)), never Godot 3 syntax.',
    'Workflow: call godot_status first. It says whether the live editor is connected; if so, scene/node edits happen in the editor and are undoable by the user (save with godot_scene_save). If not, edits are applied headlessly to .tscn files and you must pass "scene".',
    'Paths are res:// paths. Node paths are relative to the scene root ("." is the root).',
    'Edit scenes through the scene/node tools rather than hand-editing .tscn text. Edit scripts with godot_files_edit / godot_files_write; GDScript is syntax-checked automatically.',
    'To test: godot_run_start (mode "process" captures output), then godot_run_output with level "error".',
    // Step 2 tools that change how the model should work, not just what it can call.
    'Several edits to one scene: godot_batch_apply (all-or-nothing, one undo step). Unsure about a Godot class or method: godot_docs_search / godot_docs_class (offline docs for the installed Godot) instead of guessing. GDScript errors and symbols: godot_code_diagnostics, godot_code_lookup.',
  ];
  if (mode === 'compact') {
    lines.push(
      'Only core tools are listed. Find more operations with godot_tools (action "search", then "describe"), and run them with godot_call_read (read-only) or godot_call_write (changes things).',
    );
  }
  return lines.join('\n');
}
