/**
 * Core operations: what an agent should call first to orient itself.
 */

import { existsSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { findGodot } from '../godot/binary.js';
import { extractFacts, rawToJson, readProjectSettings } from '../project/projectFile.js';
import { SERVER_VERSION } from '../version.js';
import { defineOp } from './types.js';

export const status = defineOp({
  name: 'status',
  group: 'core',
  title: 'Status',
  description:
    'Godot status: call this first. Shows the project, whether the live editor is connected (open scenes, unsaved changes, playing state), the Godot executable found, and running games.',
  input: z.object({}),
  readOnly: true,
  idempotent: true,
  core: true,
  alwaysLoad: true,
  async run(_args, ctx) {
    const godot = await findGodot(ctx.config.godotPath);
    const connected = await ctx.bridge.ensureConnected();
    let editor: unknown = null;
    if (connected) {
      try {
        editor = await ctx.bridge.request('editor.status');
      } catch (err) {
        editor = { error: (err as Error).message };
      }
    }
    let projectName: string | null = null;
    try {
      projectName = extractFacts(await readProjectSettings(ctx.config.projectPath)).name;
    } catch {
      // Reported below via project_found.
    }
    return {
      data: {
        server_version: SERVER_VERSION,
        project_path: ctx.config.projectPath,
        project_found: existsSync(path.join(ctx.config.projectPath, 'project.godot')),
        project_name: projectName,
        addon_installed: ctx.headless.addonInstalled(),
        godot: godot ? { path: godot.path, version: godot.version } : null,
        editor_connected: connected,
        editor,
        runs: ctx.runs.list().map((r) => ({ run_id: r.id, scene: r.scene, running: r.running, exit_code: r.exitCode, ...r.counts() })),
        // Tell the agent what will happen for scene edits right now.
        scene_backend: connected ? 'editor (undoable, live)' : ctx.headless.addonInstalled() && godot ? 'headless (edits .tscn files on disk)' : 'unavailable',
      },
    };
  },
});

export const projectInfo = defineOp({
  name: 'project.info',
  group: 'core',
  title: 'Project info',
  description:
    'Godot project facts from project.godot: name, Godot version, main scene, autoloads, input action names, renderer, enabled plugins, C# and test framework detection.',
  input: z.object({}),
  readOnly: true,
  idempotent: true,
  core: true,
  alwaysLoad: true,
  async run(_args, ctx) {
    const settings = await readProjectSettings(ctx.config.projectPath);
    const facts = extractFacts(settings, (rel) => existsSync(path.join(ctx.config.projectPath, rel)));
    return { data: facts };
  },
});

export const projectSettings = defineOp({
  name: 'project.settings',
  group: 'core',
  title: 'Read project settings',
  description:
    'Godot project settings: read raw values from project.godot, filtered by key prefix (e.g. "display/window", "input/jump"). Only non-default values are stored in the file.',
  input: z.object({
    prefix: z.string().optional().describe('Key prefix such as "application" or "input/". Omit to list all keys.'),
    limit: z.number().int().min(1).max(1000).default(200),
  }),
  readOnly: true,
  idempotent: true,
  async run({ prefix, limit }, ctx) {
    const settings = await readProjectSettings(ctx.config.projectPath);
    const entries = [...settings].filter(([k]) => !prefix || k.startsWith(prefix));
    return {
      data: {
        count: entries.length,
        truncated: entries.length > limit,
        settings: Object.fromEntries(entries.slice(0, limit).map(([k, v]) => [k, rawToJson(v)])),
      },
    };
  },
});
