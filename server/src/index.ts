#!/usr/bin/env node
/**
 * godot-mcp entry point.
 *
 *   godot-mcp [serve] [--project <path>] [--godot <exe>] [--mode full|compact]
 *                     [--toolsets core,files,scene,...] [--read-only]
 *
 * Serves MCP over stdio (the client launches this process). Speaks both the
 * 2026-07-28 protocol and 2025-era clients: `serveStdio` with
 * `legacy: 'serve'` pins each connection to whichever era the client opens
 * with, and our single server factory works for both.
 */

import path from 'node:path';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { EditorBridge } from './bridge/editorBridge.js';
import { loadConfig } from './config.js';
import { HeadlessRunner } from './godot/headless.js';
import { RunManager } from './godot/runs.js';
import { log } from './log.js';
import { buildServer } from './mcp/server.js';
import { SERVER_VERSION } from './version.js';
import { runInit } from './init/init.js';
import type { AgentType } from 'add-mcp';

/** Parse `init` flags (kept separate from server flags: different audience). */
async function runInitCommand(argv: string[]): Promise<number> {
  const flag = (name: string) => argv.includes(`--${name}`);
  const value = (name: string) => {
    const i = argv.indexOf(`--${name}`);
    return i !== -1 ? argv[i + 1] : argv.find((a) => a.startsWith(`--${name}=`))?.split('=').slice(1).join('=');
  };
  const agents = value('agents')?.split(',').map((a) => a.trim()).filter(Boolean) as AgentType[] | undefined;
  return runInit({
    projectPath: path.resolve(value('project') ?? process.env.GODOT_PROJECT_PATH ?? process.cwd()),
    agents,
    yes: flag('yes') || flag('y'),
    dryRun: flag('dry-run'),
    addon: !flag('no-addon'),
    agentsMd: !flag('no-agents-md'),
    claudeMd: !flag('no-claude-md'),
    remove: flag('remove'),
  });
}

const USAGE = `godot-mcp ${SERVER_VERSION}: MCP server for the Godot 4 engine

Usage:
  godot-mcp [serve] [options]   Run the MCP server on stdio (what MCP clients launch)
  godot-mcp init [options]      Install the editor addon into a Godot project and register
                                the server with your agents (--dry-run, --remove, --yes,
                                --agents claude-code,cursor,...)
  godot-mcp version             Print the version

Common options (each also has an environment variable):
  --project <dir>    Godot project folder (GODOT_PROJECT_PATH; default: current folder)
  --godot <path>     Godot 4 executable (GODOT_PATH)
  --mode full|compact, --toolsets a,b,c, --read-only, --allow-eval

Docs: https://github.com/shin2344234/godot-mcp
`;

function main(): void {
  const argv = process.argv.slice(2);
  // --version / --help are checked before the command split below, which treats any
  // leading "--flag" as an option of the default "serve" command (so `godot-mcp
  // --project x` starts the server). Without this, `--version` would start a stdio
  // server and wait for input instead of printing.
  if (argv[0] === '--version' || argv[0] === '-v') {
    process.stdout.write(SERVER_VERSION + '\n');
    return;
  }
  if (argv[0] === '--help' || argv[0] === '-h' || argv[0] === 'help') {
    process.stdout.write(USAGE);
    return;
  }
  const command = argv[0] && !argv[0].startsWith('--') ? argv[0] : 'serve';

  if (command === 'version') {
    process.stdout.write(SERVER_VERSION + '\n');
    return;
  }
  if (command === 'init') {
    void runInitCommand(argv.slice(1)).then((code) => process.exit(code));
    return;
  }
  if (command !== 'serve') {
    process.stderr.write(`Unknown command "${command}". Usage: godot-mcp [serve|init] [--project <path>] [--mode full|compact]\n`);
    process.exit(2);
  }

  const config = loadConfig(argv);
  log.info(`godot-mcp ${SERVER_VERSION} for project ${config.projectPath} (mode ${config.mode}${config.readOnly ? ', read-only' : ''})`);

  // Shared across connections: one editor link, one set of game runs.
  const services = {
    config,
    bridge: new EditorBridge(config.projectPath, config.bridgeTimeoutMs),
    headless: new HeadlessRunner(config.projectPath, config.godotPath, config.headlessTimeoutMs),
    runs: new RunManager(),
  };

  const handle = serveStdio(() => buildServer(config, services), {
    legacy: 'serve',
    onerror: (err) => log.error('Transport error', err),
  });

  // Don't leave orphaned game processes behind when the client disconnects.
  const shutdown = async () => {
    services.runs.stopAll();
    services.bridge.close();
    await handle.close().catch(() => undefined);
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  process.stdin.on('end', shutdown);
}

main();
