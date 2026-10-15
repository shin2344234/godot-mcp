/**
 * Core operations: what an agent should call first to orient itself.
 */

import { cpSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { OpError } from '../errors.js';
import { findGodot } from '../godot/binary.js';
import { enablePlugin } from '../init/enablePlugin.js';
import { findAddonSource } from '../init/init.js';
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
        // Missing or outdated addon: point at the tool that fixes it (clients like
        // Claude Desktop install the server as a bundle, with no `init` step).
        ...addonHint(ctx.config.projectPath),
        ...godotVersionHint(godot?.version),
      },
    };
  },
});

/**
 * `godot_hint` when the Godot found is older than 4.7. The addon loads on 4.5/4.6, but
 * several tools rely on 4.7-only engine APIs (the e2e suite on 4.5.1 had 32 failures),
 * so say so up front instead of letting individual tools fail in confusing ways.
 */
export function godotVersionHint(version: string | undefined): { godot_hint?: string } {
  const m = /^(\d+)\.(\d+)/.exec(version ?? '');
  if (!m) return {};
  const [major, minor] = [Number(m[1]), Number(m[2])];
  if (major > 4 || (major === 4 && minor >= 7)) return {};
  return { godot_hint: `Godot ${version} is older than 4.7, the minimum this server supports. Some tools will fail; use Godot 4.7 or newer (set GODOT_PATH).` };
}

/** plugin.cfg's version="..." (undefined when the file or the key is missing). */
function addonVersion(dir: string): string | undefined {
  const cfg = path.join(dir, 'plugin.cfg');
  if (!existsSync(cfg)) return undefined;
  return /version="([^"]+)"/.exec(readFileSync(cfg, 'utf8'))?.[1];
}

/** `addon_hint` for godot_status when the project's addon is missing or older than the bundled one. */
function addonHint(projectPath: string): { addon_hint?: string } {
  const src = findAddonSource();
  if (!src || !existsSync(path.join(projectPath, 'project.godot'))) return {};
  const installed = addonVersion(path.join(projectPath, 'addons', 'godot_mcp'));
  const bundled = addonVersion(src);
  if (!installed) return { addon_hint: 'The Godot MCP addon is not in this project. Install it with godot_addon_install (or run `npx -y @shin2344234/godot-mcp init` in the project folder).' };
  if (bundled && installed !== bundled) return { addon_hint: `The project's Godot MCP addon is ${installed}; this server ships ${bundled}. Update it with godot_addon_install.` };
  return {};
}

/**
 * Copy the addon bundled with this server into the project and enable it.
 *
 * The same thing `godot-mcp init` does for the addon, as a tool: people who
 * install the server as a Claude Desktop bundle (.mcpb) or a Claude Code
 * plugin never run the CLI, so without this they'd have no way to get the
 * editor bridge and the runtime into their project from inside the client.
 */
export const addonInstall = defineOp({
  name: 'addon.install',
  group: 'core',
  title: 'Install the editor addon',
  description:
    'Godot addon: install or update addons/godot_mcp (the editor bridge and game runtime this server needs) from the copy bundled with the server, and enable it in project.godot.',
  input: z.object({}),
  readOnly: false,
  // Overwrites files under addons/godot_mcp (ours, but possibly locally edited).
  destructive: true,
  idempotent: true,
  confirm: (_args, ctx) => {
    const installed = addonVersion(path.join(ctx.config.projectPath, 'addons', 'godot_mcp'));
    return installed ? `Replace the Godot MCP addon ${installed} in addons/godot_mcp with the bundled version? Local edits to those files are lost.` : undefined;
  },
  async run(_args, ctx) {
    const root = ctx.config.projectPath;
    const projectFile = path.join(root, 'project.godot');
    if (!existsSync(projectFile)) throw new OpError('NOT_FOUND', `No project.godot in ${root}. Start the server with --project (or GODOT_PROJECT_PATH) pointing at the Godot project folder.`);
    const src = findAddonSource();
    if (!src) throw new OpError('NOT_FOUND', 'This server build has no bundled addon. Reinstall the server, or copy addons/godot_mcp from https://github.com/shin2344234/godot-mcp into the project.');
    const dest = path.join(root, 'addons', 'godot_mcp');
    const before = addonVersion(dest);
    const bundled = addonVersion(src);
    // Running from the repo with --project pointing at the repo itself: nothing to copy.
    const copied = path.resolve(src) !== path.resolve(dest) && before !== bundled;
    if (copied) cpSync(src, dest, { recursive: true });
    const text = readFileSync(projectFile, 'utf8');
    const next = enablePlugin(text);
    if (next !== text) writeFileSync(projectFile, next);
    const editorOpen = await ctx.bridge.ensureConnected().catch(() => false);
    return {
      data: {
        installed_version: bundled,
        previous_version: before ?? null,
        copied,
        plugin_enabled_now: next !== text,
        // The editor only loads plugin scripts at startup / when the plugin is toggled.
        note: copied || next !== text
          ? editorOpen
            ? 'Restart the Godot editor (or turn the plugin off and on in Project Settings > Plugins) to load the new addon.'
            : 'Open the project in the Godot editor to start the bridge; headless tools can use the addon right away.'
          : 'The addon was already installed and enabled.',
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
