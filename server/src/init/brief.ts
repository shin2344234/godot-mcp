/**
 * The AGENTS.md brief.
 *
 * Deliberately SHORT and limited to things an agent can't discover by
 * itself. An ETH Zurich study (arXiv:2602.11988, Feb 2026) found generated
 * repository overviews raised cost by 20%+ without improving success, while
 * short, non-discoverable notes did help (arXiv:2601.20404). So: no autoload
 * lists, no scene trees (godot_project_info has those), just how to work
 * here and the gotchas.
 *
 * Everything in AGENTS.md / CLAUDE.md is loaded on every turn, so every line
 * here costs context in every conversation.
 */

export interface BriefFacts {
  godotVersion: string | null;
  csharp: boolean;
  testFrameworks: string[];
}

export function buildBrief(facts: BriefFacts): string {
  const version = facts.godotVersion ? `Godot ${facts.godotVersion}` : 'Godot 4';
  const lines = [
    '## Godot (managed by godot-mcp; edit outside these markers)',
    '',
    `- This is a ${version} project. Your training data may be older: use Godot 4 APIs and GDScript 2.0 syntax, never Godot 3.`,
    '- Use the `godot_*` MCP tools. Start with `godot_status`, then `godot_project_info` for the main scene, autoloads and input actions.',
    '- Change scenes with the scene/node tools, not by hand-editing `.tscn` text. If the editor is open, edits there are undoable; save with `godot_scene_save`.',
    "- Don't edit `.godot/` (generated cache). Keep `*.uid` and `*.import` files next to their resources when moving files.",
    '- Check your work: `godot_run_start` (mode "process"), then `godot_run_output` with level "error".',
  ];
  if (facts.csharp) lines.push('- C# project: build before running (`godot --headless --build-solutions --quit`).');
  if (facts.testFrameworks.includes('gut')) lines.push('- Tests (GUT): `godot --headless -d -s --path . addons/gut/gut_cmdln.gd -gexit`.');
  if (facts.testFrameworks.includes('gdunit4')) lines.push('- Tests (GdUnit4): `addons/gdUnit4/runtest.sh -a res://test` (set GODOT_BIN).');
  return lines.join('\n');
}

/** CLAUDE.md block: Claude Code reads CLAUDE.md, and only falls back to AGENTS.md when no CLAUDE.md exists. */
export const CLAUDE_IMPORT = '@AGENTS.md';
