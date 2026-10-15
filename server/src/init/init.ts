/**
 * `godot-mcp init`: set a Godot project up for AI agents in one step.
 *
 *   1. copy the editor addon into addons/godot_mcp and enable it;
 *   2. register this MCP server in each agent's project config
 *      (via the add-mcp library, which knows 20+ clients' file formats);
 *   3. write a short brief into AGENTS.md between markers, and make
 *      CLAUDE.md import it (Claude Code ignores AGENTS.md when CLAUDE.md exists).
 *
 * Safe by default: shows the plan and asks before writing (or use --yes);
 * --dry-run only prints; re-running changes nothing that's already current;
 * --remove undoes the config and brief changes.
 *
 *   godot-mcp init [--project <dir>] [--agents claude-code,cursor,...] [--yes] [--dry-run]
 *                  [--no-addon] [--no-agents-md] [--no-claude-md] [--remove]
 */

import { cpSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { detectProjectAgents, getAgentTypes, listInstalledServers, removeServer, upsertServer, type AgentType, type McpServerConfig } from 'add-mcp';
import { findGodot } from '../godot/binary.js';
import { extractFacts, readProjectSettings } from '../project/projectFile.js';
import { SERVER_VERSION } from '../version.js';
import { buildBrief, CLAUDE_IMPORT } from './brief.js';
import { disablePlugin, enablePlugin } from './enablePlugin.js';
import { hasBlock, removeBlock, upsertBlock } from './markers.js';

export const SERVER_NAME = 'godot';

interface Change {
  /** What the user sees in the plan. */
  summary: string;
  apply: () => void;
}

export interface InitOptions {
  projectPath: string;
  agents?: AgentType[];
  yes: boolean;
  dryRun: boolean;
  addon: boolean;
  agentsMd: boolean;
  claudeMd: boolean;
  remove: boolean;
  /** Override the command written into client configs. */
  serverCommand?: { command: string; args: string[] };
  out?: (line: string) => void;
}

/** Where the bundled addon lives: `addon/` in the npm package, `../addons/` in the repo. */
export function findAddonSource(): string | undefined {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.resolve(here, '..', '..', 'addon', 'godot_mcp'), // package: dist/init -> addon/
    path.resolve(here, '..', '..', '..', 'addons', 'godot_mcp'), // repo: server/src/init -> addons/
  ];
  return candidates.find((c) => existsSync(path.join(c, 'plugin.cfg')));
}

/**
 * How clients should launch this server. When running from the npx cache we
 * write an npx command; otherwise (a local checkout or global install) the
 * absolute path of this entry script, which works before publishing.
 */
function defaultServerCommand(): { command: string; args: string[] } {
  const entry = process.argv[1] ?? '';
  if (entry.includes('_npx') || entry.includes(`${path.sep}npx${path.sep}`)) {
    return { command: 'npx', args: ['-y', `@shin2344234/godot-mcp@${SERVER_VERSION}`] };
  }
  if (entry.endsWith('.ts')) {
    // Running from source via tsx (development).
    return { command: 'npx', args: ['tsx', path.resolve(entry)] };
  }
  return { command: 'node', args: [path.resolve(entry)] };
}

/** Write a file, or delete it if our removal left it empty (we created it). */
function writeOrDelete(file: string, text: string): void {
  if (text.trim() === '') rmSync(file, { force: true });
  else writeFileSync(file, text);
}

function readText(file: string): string {
  return existsSync(file) ? readFileSync(file, 'utf8') : '';
}

export async function runInit(opts: InitOptions): Promise<number> {
  const out = opts.out ?? ((l: string) => process.stderr.write(l + '\n'));
  const root = opts.projectPath;
  const projectFile = path.join(root, 'project.godot');
  if (!existsSync(projectFile)) {
    out(`No project.godot in ${root}. Run this from your Godot project folder or pass --project <dir>.`);
    return 1;
  }

  const settings = await readProjectSettings(root);
  const facts = extractFacts(settings, (rel) => existsSync(path.join(root, rel)));

  // Which agents to configure: explicit list, else whatever the project already uses, else Claude Code.
  let agents = opts.agents ?? detectProjectAgents(root);
  if (agents.length === 0) agents = ['claude-code'];
  const known = new Set(getAgentTypes());
  const unknown = agents.filter((a) => !known.has(a));
  if (unknown.length) {
    out(`Unknown agent(s): ${unknown.join(', ')}. Known: ${[...known].join(', ')}`);
    return 1;
  }

  const changes: Change[] = [];

  // --- 1. Addon -----------------------------------------------------------
  if (opts.addon) {
    const projectText = readText(projectFile);
    if (opts.remove) {
      const next = disablePlugin(projectText);
      if (next !== projectText) changes.push({ summary: 'project.godot: disable the Godot MCP plugin (addon files are left in place)', apply: () => writeFileSync(projectFile, next) });
    } else {
      const src = findAddonSource();
      const dest = path.join(root, 'addons', 'godot_mcp');
      if (!src) {
        out('Warning: bundled addon not found; skipping addon install.');
      } else if (path.resolve(src) !== path.resolve(dest)) {
        const installedVersion = /version="([^"]+)"/.exec(readText(path.join(dest, 'plugin.cfg')))?.[1];
        const bundledVersion = /version="([^"]+)"/.exec(readText(path.join(src, 'plugin.cfg')))?.[1];
        if (installedVersion !== bundledVersion) {
          changes.push({
            summary: installedVersion ? `addons/godot_mcp: update addon ${installedVersion} -> ${bundledVersion}` : `addons/godot_mcp: install addon ${bundledVersion}`,
            apply: () => cpSync(src, dest, { recursive: true }),
          });
        }
      }
      const next = enablePlugin(projectText);
      if (next !== projectText) changes.push({ summary: 'project.godot: enable the Godot MCP plugin under [editor_plugins]', apply: () => writeFileSync(projectFile, next) });
    }
  }

  // --- 2. MCP client configs ----------------------------------------------
  const godot = await findGodot();
  const cmd = opts.serverCommand ?? defaultServerCommand();
  const serverConfig: McpServerConfig = {
    command: cmd.command,
    args: [...cmd.args, '--project', root],
    ...(godot ? { env: { GODOT_PATH: godot.path } } : {}),
  };
  // What's already registered, so re-running reports "up to date" instead of rewriting.
  const installed = await listInstalledServers({ agents, cwd: root }).catch(() => []);
  const current = (agent: AgentType) => installed.find((a) => a.agentType === agent)?.servers.find((s) => s.serverName === SERVER_NAME)?.config;
  for (const agent of agents) {
    const existing = current(agent) as { command?: string; args?: string[] } | undefined;
    const same = existing && existing.command === serverConfig.command && JSON.stringify(existing.args) === JSON.stringify(serverConfig.args);
    if (opts.remove ? !existing : same) continue;
    changes.push({
      summary: opts.remove ? `${agent}: remove the "${SERVER_NAME}" MCP server from its project config` : `${agent}: register the "${SERVER_NAME}" MCP server in its project config`,
      apply: () => {
        const res = opts.remove ? removeServer(agent, SERVER_NAME, { local: true, cwd: root }) : upsertServer(agent, SERVER_NAME, serverConfig, { local: true, cwd: root });
        if (!res.success) out(`  ! ${agent}: ${res.error ?? 'failed'} (${res.path})`);
        else out(`  ✓ ${agent}: ${res.path}`);
      },
    });
  }

  // --- 3. AGENTS.md + CLAUDE.md -------------------------------------------
  if (opts.agentsMd) {
    const file = path.join(root, 'AGENTS.md');
    const text = readText(file);
    const next = opts.remove ? removeBlock(text) : upsertBlock(text, buildBrief(facts), 'end');
    if (next !== text) changes.push({ summary: `AGENTS.md: ${opts.remove ? 'remove' : hasBlock(text) ? 'update' : 'add'} the godot-mcp block`, apply: () => writeOrDelete(file, next) });
  }
  if (opts.claudeMd && agents.includes('claude-code')) {
    const file = path.join(root, 'CLAUDE.md');
    const text = readText(file);
    // Already importing AGENTS.md ourselves or by the user? Then leave it alone.
    const userImports = !hasBlock(text) && /^@AGENTS\.md\s*$/m.test(text);
    if (!userImports) {
      const next = opts.remove ? removeBlock(text) : upsertBlock(text, CLAUDE_IMPORT, 'start');
      if (next !== text) changes.push({ summary: `CLAUDE.md: ${opts.remove ? 'remove' : 'add'} "@AGENTS.md" import`, apply: () => writeOrDelete(file, next) });
    }
  }

  // --- Plan / confirm / apply ---------------------------------------------
  if (changes.length === 0) {
    out('Everything is already up to date.');
    return 0;
  }
  out(`godot-mcp init${opts.remove ? ' --remove' : ''} for ${facts.name ?? root}:`);
  for (const c of changes) out(`  - ${c.summary}`);
  if (opts.dryRun) {
    out('(dry run: nothing written)');
    return 0;
  }
  if (!opts.yes) {
    if (!process.stdin.isTTY) {
      out('Not a terminal; re-run with --yes to apply, or --dry-run to preview.');
      return 1;
    }
    const rl = createInterface({ input: process.stdin, output: process.stderr });
    const answer = (await rl.question('Apply these changes? [y/N] ')).trim().toLowerCase();
    rl.close();
    if (answer !== 'y' && answer !== 'yes') {
      out('Nothing changed.');
      return 0;
    }
  }
  for (const c of changes) c.apply();
  out('Done.');
  if (!opts.remove) {
    out('Next: open the project in Godot (the plugin starts the bridge), then start a new agent session so it picks up the server.');
    if (agents.includes('claude-code')) out('Claude Code will ask you to approve the project MCP server the first time.');
  }
  return 0;
}
