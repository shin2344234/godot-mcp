/**
 * MCP resources: read-only views of the project that a user (or the model)
 * can attach as context, e.g. with Claude Code's `@` picker.
 *
 *   godot://project/info          project facts (name, version, main scene, autoloads, input actions...)
 *   godot://editor/status         editor connection, open/unsaved scenes, playing state
 *   godot://editor/logs           recent editor output (needs the live editor)
 *   godot://scene/{+path}         a scene's node tree as JSON, e.g. godot://scene/levels/level_1.tscn
 *   godot://script/{+path}        a script's source, e.g. godot://script/player.gd
 *
 * They reuse the same operations as the tools, so a resource and its tool
 * always agree. Template `list` callbacks return the concrete scenes and
 * scripts because Claude Code's picker uses resources/list, not completion.
 *
 * Change notifications (resources/updated) aren't sent yet: they need a file
 * watcher, planned for the shipping step. Clients re-read on demand.
 */

import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { ResourceNotFoundError, ResourceTemplate, type McpServer } from '@modelcontextprotocol/server';
import { toOpError } from '../errors.js';
import * as core from '../ops/core.js';
import * as run from '../ops/run.js';
import * as scene from '../ops/scene.js';
import type { OpContext, Operation } from '../ops/types.js';
import { resolveProjectPathStrict } from '../project/paths.js';
import { completeFrom, listProjectFiles } from '../project/scan.js';

/** Cap for template lists: enough for real projects, small enough for a picker. */
const LIST_LIMIT = 300;

/** Run an operation with schema defaults applied, returning pretty JSON or an error note. */
async function runOp(op: Operation, args: Record<string, unknown>, ctx: OpContext): Promise<string> {
  try {
    const result = await op.run(op.input.parse(args), ctx);
    return JSON.stringify(result.data, null, 1);
  } catch (err) {
    const e = toOpError(err);
    // Resources can't return isError; say what went wrong in the content instead.
    return JSON.stringify({ error: e.code, message: e.message });
  }
}

/** godot://scene/levels/a.tscn <-> res://levels/a.tscn */
const toRes = (variable: string | string[] | undefined) => `res://${String(Array.isArray(variable) ? variable.join('/') : (variable ?? '')).replace(/^res:\/\//, '')}`;
const stripRes = (res: string) => res.replace(/^res:\/\//, '');

export function registerResources(server: McpServer, services: Omit<OpContext, 'signal'>): void {
  const root = services.config.projectPath;
  const json = 'application/json';

  server.registerResource(
    'project-info',
    'godot://project/info',
    { title: 'Godot project info', description: 'Project name, Godot version, main scene, autoloads, input actions, plugins.', mimeType: json },
    async (uri, ctx) => ({ contents: [{ uri: uri.href, mimeType: json, text: await runOp(core.projectInfo, {}, { ...services, signal: ctx.mcpReq.signal }) }] }),
  );

  server.registerResource(
    'editor-status',
    'godot://editor/status',
    { title: 'Godot editor status', description: 'Whether the editor is connected, open and unsaved scenes, and whether the game is playing.', mimeType: json },
    async (uri, ctx) => ({ contents: [{ uri: uri.href, mimeType: json, text: await runOp(core.status, {}, { ...services, signal: ctx.mcpReq.signal }) }] }),
  );

  server.registerResource(
    'editor-logs',
    'godot://editor/logs',
    { title: 'Godot editor output', description: 'Recent editor output and errors (needs the editor open with the plugin).', mimeType: json },
    async (uri, ctx) => ({
      contents: [{ uri: uri.href, mimeType: json, text: await runOp(run.editorLogs, { limit: 200 }, { ...services, signal: ctx.mcpReq.signal }) }],
    }),
  );

  server.registerResource(
    'scene',
    new ResourceTemplate('godot://scene/{+path}', {
      list: async () => ({
        resources: (await listProjectFiles(root, ['.tscn'], LIST_LIMIT)).map((res) => ({
          uri: `godot://scene/${stripRes(res)}`,
          name: stripRes(res),
          title: `Scene ${stripRes(res)}`,
          mimeType: json,
        })),
      }),
      complete: { path: async (value) => completeFrom((await listProjectFiles(root, ['.tscn'], 2000)).map(stripRes), value) },
    }),
    { title: 'Godot scene tree', description: 'Node tree of a .tscn scene (names, types, scripts, sub-scenes).', mimeType: json },
    async (uri, variables, ctx) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: json,
          text: await runOp(scene.sceneTree, { scene: toRes(variables.path), depth: 8, max_nodes: 500 }, { ...services, signal: ctx.mcpReq.signal }),
        },
      ],
    }),
  );

  server.registerResource(
    'script',
    new ResourceTemplate('godot://script/{+path}', {
      list: async () => ({
        resources: (await listProjectFiles(root, ['.gd', '.gdshader', '.cs'], LIST_LIMIT)).map((res) => ({
          uri: `godot://script/${stripRes(res)}`,
          name: stripRes(res),
          title: `Script ${stripRes(res)}`,
          mimeType: 'text/plain',
        })),
      }),
      complete: { path: async (value) => completeFrom((await listProjectFiles(root, ['.gd', '.gdshader', '.cs'], 2000)).map(stripRes), value) },
    }),
    { title: 'Godot script source', description: 'Source text of a GDScript, shader or C# file in the project.', mimeType: 'text/plain' },
    async (uri, variables) => {
      // Same sandbox as the file tools: res:// only, no escaping the project via .. or symlinks.
      const file = await resolveProjectPathStrict(root, toRes(variables.path));
      // A missing file is a protocol error (-32602 resource not found in 2026-07-28).
      if (!existsSync(file.abs)) throw new ResourceNotFoundError(uri.href);
      return { contents: [{ uri: uri.href, mimeType: 'text/plain', text: await readFile(file.abs, 'utf8') }] };
    },
  );
}
