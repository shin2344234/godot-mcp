/**
 * MCP prompts: reusable starting points a user can pick (in Claude Code they
 * show up as slash commands, e.g. /mcp__godot__scaffold-player).
 *
 * Each prompt expands into one user message that names the steps and tools,
 * so the model starts from a good plan instead of guessing. Arguments are
 * strings (the protocol sends prompt arguments as a string map); scene and
 * script paths offer completion from the project's files.
 *
 * Tool names are written as in full mode (godot_node_add ...). In compact
 * mode the same operations are reached through godot_tools / godot_call_*,
 * which the server instructions already explain.
 */

import { completable, type McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { completeFrom, listProjectFiles } from '../project/scan.js';

type PromptMessage = { role: 'user'; content: { type: 'text'; text: string } };
const user = (text: string): { messages: PromptMessage[] } => ({ messages: [{ role: 'user', content: { type: 'text', text } }] });

export function registerPrompts(server: McpServer, projectPath: string): void {
  // Completion markers go on the inner string schema (then .optional()), which
  // is where the SDK looks for them. `value` may still be undefined at runtime.
  const scenes = async (value?: string) => completeFrom(await listProjectFiles(projectPath, ['.tscn'], 2000), value ?? '');
  const scripts = async (value?: string) => completeFrom(await listProjectFiles(projectPath, ['.gd'], 2000), value ?? '');

  server.registerPrompt(
    'scaffold-player',
    {
      title: 'Scaffold a player character',
      description: 'Create a controllable player scene (2D or 3D) with movement script, collision and input actions.',
      argsSchema: z.object({
        dimension: completable(z.string().describe('"2d" or "3d"'), (v) => ['2d', '3d'].filter((d) => d.startsWith(v.toLowerCase()))),
        style: z.string().optional().describe('e.g. "platformer", "top-down", "first-person"'),
        scene: completable(z.string().describe('Where to save, e.g. res://player/player.tscn'), scenes).optional(),
      }),
    },
    ({ dimension, style, scene }) => {
      const is3d = dimension.trim().toLowerCase() === '3d';
      const body = is3d ? 'CharacterBody3D' : 'CharacterBody2D';
      const path = scene || (is3d ? 'res://player/player_3d.tscn' : 'res://player/player.tscn');
      return user(
        [
          `Create a ${style ? `${style} ` : ''}${is3d ? '3D' : '2D'} player character in this Godot project.`,
          '1. Call godot_status and godot_project_info to see the Godot version, existing input actions and scenes.',
          `2. Create ${path} with a ${body} root (godot_scene_create), then add a collision shape and a ${is3d ? 'MeshInstance3D and Camera3D' : 'Sprite2D (or AnimatedSprite2D) and Camera2D'} (godot_batch_apply or godot_node_add).`,
          '3. Add any missing input actions (move left/right/up/down, jump) with godot_input_edit, using keyboard and gamepad events.',
          `4. Write a typed Godot 4 movement script (move_and_slide, Input.get_vector / get_axis, @export tunables) with godot_files_write and attach it with godot_script_attach.`,
          '5. Check it with godot_script_validate, run the scene with godot_run_start (mode "process") and fix any errors from godot_run_output.',
          'Save the scene at the end and summarize what you created.',
        ].join('\n'),
      );
    },
  );

  server.registerPrompt(
    'triage-errors',
    {
      title: 'Find and fix runtime errors',
      description: 'Run the game (or a scene), collect errors and warnings, and fix their causes.',
      argsSchema: z.object({
        scene: completable(z.string().describe('Scene to run (default: the main scene)'), scenes).optional(),
        error: z.string().optional().describe('An error message you already saw, if any'),
      }),
    },
    ({ scene, error }) =>
      user(
        [
          `Find and fix errors in this Godot project${scene ? `, starting from ${scene}` : ''}.`,
          error ? `The user saw this error:\n${error}\n` : '',
          '1. Call godot_status. If the editor is connected, read godot_editor_logs (level "error") for existing errors.',
          `2. Run ${scene ? `"${scene}"` : 'the main scene'} with godot_run_start (mode "process", quit_after_frames around 300 if it never exits), then read godot_run_output with level "error" and "warning".`,
          '3. For each problem, open the referenced script (godot_files_read) or node (godot_node_get), find the root cause, and fix it with the smallest change. Validate edited scripts with godot_script_validate.',
          '4. Re-run until there are no errors, then list what was wrong and what you changed.',
        ]
          .filter(Boolean)
          .join('\n'),
      ),
  );

  server.registerPrompt(
    'port-from-godot-3',
    {
      title: 'Port a script from Godot 3',
      description: 'Convert a Godot 3 GDScript file to Godot 4 syntax and APIs.',
      argsSchema: z.object({ script: completable(z.string().describe('The script to port, e.g. res://player.gd'), scripts) }),
    },
    ({ script }) =>
      user(
        [
          `Port ${script} from Godot 3 to Godot 4 GDScript.`,
          '1. Read it with godot_files_read and check it with godot_script_validate to see what breaks.',
          '2. Apply the Godot 4 changes: KinematicBody -> CharacterBody (velocity property + move_and_slide() with no arguments), export -> @export, onready -> @onready, tool -> @tool, yield -> await, connect("signal", obj, "method") -> signal.connect(callable), setget -> property get/set, instance() -> instantiate(), and renamed nodes/methods (Spatial -> Node3D, rand_range -> randf_range, etc.). Look up anything unsure with godot_docs_search / godot_docs_class.',
          '3. Keep behavior identical; add static types where obvious.',
          '4. Write it back with godot_files_edit or godot_files_write, validate again, and list the changes.',
        ].join('\n'),
      ),
  );

  server.registerPrompt(
    'write-shader',
    {
      title: 'Write a shader',
      description: 'Write a Godot shader for an effect and apply it to a node with a ShaderMaterial.',
      argsSchema: z.object({
        effect: z.string().describe('What the shader should do, e.g. "pixelated dissolve with a glowing edge"'),
        kind: completable(z.string().describe('canvas_item (2D), spatial (3D), particles, sky or fog'), (v) =>
          ['canvas_item', 'spatial', 'particles', 'sky', 'fog'].filter((k) => k.startsWith(v.toLowerCase())),
        ).optional(),
        node: z.string().optional().describe('Node to apply it to, e.g. Player/Sprite2D (in the edited scene)'),
      }),
    },
    ({ effect, kind, node }) =>
      user(
        [
          `Write a Godot 4 shader: ${effect}.`,
          `1. Use shader_type ${kind || 'canvas_item (2D) or spatial (3D), whichever fits the target'}; expose tunables as uniforms with hints (source_color, hint_range).`,
          '2. Create it with godot_resource_create as a .gdshader file (or godot_files_write), then check it with godot_visual_shader_check if available.',
          node
            ? `3. Apply it to ${node}: set its material to a new ShaderMaterial using the shader (godot_node_set with {"material": {"new": "ShaderMaterial", "properties": {"shader": "res://..."}}}), and set sensible uniform values.`
            : '3. If the user names a target node, apply it with a ShaderMaterial (godot_node_set).',
          '4. Explain the uniforms and how to tweak them.',
        ].join('\n'),
      ),
  );
}
