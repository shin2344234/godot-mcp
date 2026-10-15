#!/usr/bin/env node
/**
 * Build the Claude Desktop bundle: dist-bundles/godot-mcp-<version>.mcpb
 *
 *   node scripts/build-mcpb.mjs [--skip-build] [--no-smoke] [--keep-staging]
 *
 *   --skip-build    reuse server/dist instead of rebuilding it
 *   --no-smoke      don't unpack and test the finished bundle
 *   --keep-staging  leave dist-bundles/staging/ in place for inspection
 *
 * Set GODOT_PATH when running this to also exercise a real headless Godot call in
 * the smoke test (otherwise that step is skipped).
 *
 * An .mcpb ("MCP Bundle", formerly .dxt) is a zip with a manifest.json at its root
 * plus everything the server needs to run, including node_modules: Claude Desktop
 * runs it with its built-in Node.js and never runs `npm install`.
 * Spec: https://github.com/modelcontextprotocol/mcpb/blob/main/MANIFEST.md
 * CLI:  https://github.com/modelcontextprotocol/mcpb/blob/main/CLI.md
 *
 * Steps:
 *   1. build the server (tsc -> server/dist)
 *   2. stage a clean bundle directory:
 *        manifest.json   packaging/mcpb/manifest.json + version + generated tools list
 *        icon.png        packaging/mcpb/icon.png (see make-icon.mjs)
 *        package.json    trimmed copy of server/package.json ("type": "module" is
 *                        REQUIRED: dist/*.js are ES modules)
 *        dist/           compiled server, without source maps
 *        addon/godot_mcp the Godot editor addon, where `godot-mcp init` looks for it
 *                        (findAddonSource in server/src/init/init.ts: dist/init/../../addon)
 *        node_modules/   production dependencies only (npm ci --omit=dev), pruned
 *        LICENSE
 *   3. `mcpb validate` the staged manifest, then `mcpb pack` it
 *   4. smoke test: unpack the .mcpb into an empty temp folder and talk MCP to it
 *
 * The npm registry is only used here, at build time (npm ci, npx mcpb). The shipped
 * server makes no network connections.
 */

import { spawn, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// --- Paths and options -----------------------------------------------------

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SERVER = path.join(ROOT, 'server');
const ADDON = path.join(ROOT, 'addons', 'godot_mcp');
const PACKAGING = path.join(ROOT, 'packaging', 'mcpb');
const OUT_DIR = path.join(ROOT, 'dist-bundles');
const STAGE = path.join(OUT_DIR, 'staging', 'godot-mcp');
const SAMPLE_PROJECT = path.join(ROOT, 'examples', 'sample_project');

/**
 * The mcpb CLI, pinned so builds are reproducible. 2.1.2 is the latest release
 * at the time of writing (npm view @anthropic-ai/mcpb version, 2026-10).
 */
const MCPB_CLI = '@anthropic-ai/mcpb@2.1.2';

const argv = new Set(process.argv.slice(2));
const opts = {
  skipBuild: argv.has('--skip-build'),
  smoke: !argv.has('--no-smoke'),
  keepStaging: argv.has('--keep-staging'),
};

const isWindows = process.platform === 'win32';
// On Windows npm/npx are .cmd shims, which spawn() can only run through a shell.
const NPM = isWindows ? 'npm.cmd' : 'npm';
const NPX = isWindows ? 'npx.cmd' : 'npx';

function log(msg) {
  process.stderr.write(`[build-mcpb] ${msg}\n`);
}

function fail(msg) {
  log(`ERROR: ${msg}`);
  process.exit(1);
}

/** Run a command, streaming its output; exit the build if it fails. */
function run(cmd, args, cwd) {
  log(`$ ${cmd} ${args.join(' ')}   (in ${path.relative(ROOT, cwd) || '.'})`);
  // .cmd shims need a shell on Windows; quote arguments with spaces for it.
  const useShell = isWindows && /\.cmd$/i.test(cmd);
  const finalArgs = useShell ? args.map((a) => (/\s/.test(a) ? `"${a}"` : a)) : args;
  const res = spawnSync(cmd, finalArgs, { cwd, stdio: 'inherit', shell: useShell });
  if (res.status !== 0) fail(`${cmd} ${args.join(' ')} exited with ${res.status ?? res.signal}`);
}

/** Total size of a file or folder in bytes. */
function sizeOf(p) {
  const st = statSync(p);
  if (!st.isDirectory()) return st.size;
  return readdirSync(p).reduce((sum, e) => sum + sizeOf(path.join(p, e)), 0);
}

const mb = (bytes) => `${(bytes / 1024 / 1024).toFixed(2)} MB`;

// --- 0. Version --------------------------------------------------------------

// The single source of truth for the version is server/package.json.
const pkg = JSON.parse(readFileSync(path.join(SERVER, 'package.json'), 'utf8'));
const VERSION = pkg.version;
log(`${pkg.name} ${VERSION}`);

// src/version.ts is bumped by hand; a mismatch means the server would report a
// different version than the bundle says. Warn rather than fail: it's owned elsewhere.
const versionTs = readFileSync(path.join(SERVER, 'src', 'version.ts'), 'utf8');
const tsVersion = /SERVER_VERSION\s*=\s*'([^']+)'/.exec(versionTs)?.[1];
if (tsVersion !== VERSION) log(`WARNING: server/src/version.ts says ${tsVersion}, package.json says ${VERSION}`);

const addonVersion = /version="([^"]+)"/.exec(readFileSync(path.join(ADDON, 'plugin.cfg'), 'utf8'))?.[1];
if (addonVersion !== VERSION) log(`WARNING: addons/godot_mcp/plugin.cfg says ${addonVersion}, package.json says ${VERSION}`);

// --- 1. Build the server -----------------------------------------------------

if (!opts.skipBuild) {
  // tsc needs the dev dependencies; install them if this is a fresh checkout.
  if (!existsSync(path.join(SERVER, 'node_modules'))) run(NPM, ['ci', '--no-audit', '--no-fund'], SERVER);
  // Start from an empty dist/ so files of deleted sources can't sneak into the bundle.
  rmSync(path.join(SERVER, 'dist'), { recursive: true, force: true });
  run(NPM, ['run', 'build'], SERVER);
}
if (!existsSync(path.join(SERVER, 'dist', 'index.js'))) fail('server/dist/index.js missing; build the server first');

// --- 2. Stage the bundle -----------------------------------------------------

rmSync(STAGE, { recursive: true, force: true });
mkdirSync(STAGE, { recursive: true });
log(`staging in ${path.relative(ROOT, STAGE)}`);

// 2a. Compiled server, minus source maps (they'd point at src/, which isn't shipped).
cpSync(path.join(SERVER, 'dist'), path.join(STAGE, 'dist'), {
  recursive: true,
  filter: (src) => !src.endsWith('.map'),
});

// 2b. The Godot addon. Godot's own cache/OS junk is skipped; *.uid files are kept
// (Godot 4.4+ uses them to keep script references stable).
cpSync(ADDON, path.join(STAGE, 'addon', 'godot_mcp'), {
  recursive: true,
  filter: (src) => !['.godot', '.DS_Store', 'Thumbs.db'].includes(path.basename(src)),
});

// 2c. Production node_modules. `npm ci` needs a package.json that matches the
// lockfile, so install with the real one first and trim it afterwards.
cpSync(path.join(SERVER, 'package.json'), path.join(STAGE, 'package.json'));
cpSync(path.join(SERVER, 'package-lock.json'), path.join(STAGE, 'package-lock.json'));
// --ignore-scripts: nothing in the runtime tree needs an install script, and the
// package's own prepack (build + copy addon) must not run here.
run(NPM, ['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], STAGE);
rmSync(path.join(STAGE, 'package-lock.json'));
rmSync(path.join(STAGE, 'node_modules', '.package-lock.json'), { force: true });

// Prune files that are never loaded at runtime: TypeScript sources and
// declarations (*.ts, *.d.ts, *.mts, *.cts; zod alone ships ~4 MB of src/*.ts),
// source maps and Markdown docs. Node resolves packages to their .js/.cjs files
// through package.json "exports"/"main", never to .ts. LICENSE files stay (the
// licenses require shipping them).
let pruned = 0;
function prune(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      prune(p);
    } else if (/\.[cm]?ts$|\.map$|\.md$/i.test(entry.name) && !/^licen[cs]e/i.test(entry.name)) {
      pruned += statSync(p).size;
      rmSync(p);
    }
  }
}
prune(path.join(STAGE, 'node_modules'));
log(`pruned ${mb(pruned)} of TypeScript sources/declarations, maps and docs from node_modules`);

// The bundle's package.json only needs what Node reads at runtime ("type") plus
// identification. No scripts: nothing should ever be run from it.
const runtimePkg = {
  name: pkg.name,
  version: VERSION,
  description: pkg.description,
  license: pkg.license,
  type: pkg.type, // "module": required for the ESM files in dist/
  main: pkg.main,
  engines: pkg.engines,
  dependencies: pkg.dependencies,
};
writeFileSync(path.join(STAGE, 'package.json'), JSON.stringify(runtimePkg, null, 2) + '\n');

// 2d. License and icon.
cpSync(path.join(ROOT, 'LICENSE'), path.join(STAGE, 'LICENSE'));
cpSync(path.join(PACKAGING, 'icon.png'), path.join(STAGE, 'icon.png'));

// --- MCP over stdio (used for the tools list and the smoke test) ------------

/**
 * Start the server and return a tiny JSON-RPC client over newline-delimited stdio
 * (the MCP stdio transport). We speak the 2025-06-18 protocol with an initialize
 * handshake, which the server serves via its legacy-era support; that is what
 * today's desktop clients send.
 */
function startMcp(entry, env, cwd) {
  const child = spawn(process.execPath, [entry], { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
  let buf = '';
  let stderr = '';
  const pending = new Map();
  let nextId = 1;
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      const msg = JSON.parse(line);
      if (msg.id !== undefined && pending.has(msg.id)) {
        pending.get(msg.id)(msg);
        pending.delete(msg.id);
      }
    }
  });
  child.stderr.on('data', (d) => (stderr += d));
  const exited = new Promise((resolve) => child.on('exit', resolve));

  const send = (obj) => child.stdin.write(JSON.stringify(obj) + '\n');
  const request = (method, params = {}, timeoutMs = 120_000) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      const timer = setTimeout(() => reject(new Error(`${method} timed out; server stderr:\n${stderr}`)), timeoutMs);
      pending.set(id, (msg) => {
        clearTimeout(timer);
        if (msg.error) reject(new Error(`${method}: ${JSON.stringify(msg.error)}`));
        else resolve(msg.result);
      });
      send({ jsonrpc: '2.0', id, method, params });
    });

  return {
    async initialize() {
      const res = await request('initialize', {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'build-mcpb', version: VERSION },
      });
      send({ jsonrpc: '2.0', method: 'notifications/initialized' });
      return res;
    },
    /** All tools, following nextCursor pagination if the server uses it. */
    async listTools() {
      const tools = [];
      let cursor;
      do {
        const res = await request('tools/list', cursor ? { cursor } : {});
        tools.push(...res.tools);
        cursor = res.nextCursor;
      } while (cursor);
      return tools;
    },
    callTool: (name, args = {}, timeoutMs) => request('tools/call', { name, arguments: args }, timeoutMs),
    /** Closing stdin is how a client says goodbye; the server exits on 'end'. */
    async close() {
      child.stdin.end();
      const t = setTimeout(() => child.kill(), 5000);
      await exited;
      clearTimeout(t);
    },
    stderr: () => stderr,
  };
}

/** First sentence of a tool description, for the install UI's tool list. */
function firstSentence(text) {
  const m = /^(.+?[.!?])(\s|$)/s.exec(text.trim());
  return (m ? m[1] : text).trim();
}

// --- 2e. Manifest ------------------------------------------------------------

const manifest = JSON.parse(readFileSync(path.join(PACKAGING, 'manifest.json'), 'utf8'));
manifest.version = VERSION; // the template's version is a placeholder

// The tools list is shown on the install screen. It's generated from the built
// server with the default config (mode "full", all groups), so it can't drift from
// the code. tools_generated: true (set in the template) tells clients the real
// list depends on the user's settings (mode, groups, read-only).
{
  const mcp = startMcp(path.join(STAGE, 'dist', 'index.js'), { ...process.env, GODOT_PROJECT_PATH: SAMPLE_PROJECT, GODOT_MCP_LOG_LEVEL: 'warn' }, STAGE);
  await mcp.initialize();
  const tools = await mcp.listTools();
  await mcp.close();
  manifest.tools = tools.map((t) => ({ name: t.name, description: firstSentence(t.description ?? '') }));
  log(`manifest lists ${tools.length} tools`);
}
writeFileSync(path.join(STAGE, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');

// --- 3. Validate and pack ----------------------------------------------------

run(NPX, ['-y', MCPB_CLI, 'validate', path.join(STAGE, 'manifest.json')], ROOT);

const bundle = path.join(OUT_DIR, `godot-mcp-${VERSION}.mcpb`);
rmSync(bundle, { force: true });
run(NPX, ['-y', MCPB_CLI, 'pack', STAGE, bundle], ROOT);
log(`bundle: ${path.relative(ROOT, bundle)} (${mb(statSync(bundle).size)}; staged ${mb(sizeOf(STAGE))})`);

// --- 4. Smoke test the finished bundle ----------------------------------------

/**
 * Unpack the .mcpb into an empty temp folder and run it the way Claude Desktop
 * would: `node <bundle>/dist/index.js` with the env from manifest.server.mcp_config,
 * ${__dirname} and ${user_config.*} substituted (user_config defaults, plus a
 * project folder). The working directory is another empty folder, so nothing from
 * this checkout can leak in.
 */
async function smokeTest() {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'godot-mcp-mcpb-'));
  try {
    const unpacked = path.join(tmp, 'bundle');
    run(NPX, ['-y', MCPB_CLI, 'unpack', bundle, unpacked], ROOT);
    const project = path.join(tmp, 'project');
    cpSync(SAMPLE_PROJECT, project, { recursive: true, filter: (src) => !src.includes(`${path.sep}.godot`) && !src.includes(`${path.sep}addons`) });
    const cwd = path.join(tmp, 'cwd');
    mkdirSync(cwd);

    const shipped = JSON.parse(readFileSync(path.join(unpacked, 'manifest.json'), 'utf8'));
    const userConfig = Object.fromEntries(Object.entries(shipped.user_config).map(([k, v]) => [k, v.default]));
    userConfig.project_path = project;
    if (process.env.GODOT_PATH) userConfig.godot_path = process.env.GODOT_PATH;
    const substitute = (s) =>
      s.replace(/\$\{__dirname\}/g, unpacked).replace(/\$\{user_config\.([^}]+)\}/g, (_, k) => String(userConfig[k]));
    const cfg = shipped.server.mcp_config;
    const entry = substitute(cfg.args[0]);
    // Only a minimal inherited environment: PATH (to find node's helpers) and temp dirs.
    const baseEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => /^(PATH|HOME|USERPROFILE|TEMP|TMP|TMPDIR|SystemRoot)$/i.test(k)));
    const env = { ...baseEnv, GODOT_MCP_LOG_LEVEL: 'warn', ...Object.fromEntries(Object.entries(cfg.env).map(([k, v]) => [k, substitute(v)])) };
    log(`smoke: node ${entry}  env ${JSON.stringify(cfg.env)}`);

    // (a) Handshake, tool list and status.
    let mcp = startMcp(entry, env, cwd);
    const init = await mcp.initialize();
    if (init.serverInfo?.version !== VERSION) fail(`smoke: server reports version ${init.serverInfo?.version}, expected ${VERSION}`);
    const tools = await mcp.listTools();
    if (tools.length !== shipped.tools.length) fail(`smoke: ${tools.length} tools listed, manifest has ${shipped.tools.length}`);
    const status = await mcp.callTool('godot_status');
    await mcp.close();
    const statusData = status.structuredContent ?? JSON.parse(status.content?.[0]?.text ?? '{}');
    if (!statusData.project_found) fail(`smoke: godot_status did not find the project: ${JSON.stringify(statusData)}`);
    log(`smoke: initialize OK (${init.protocolVersion}), ${tools.length} tools, godot_status project_found=${statusData.project_found} addon_installed=${statusData.addon_installed}`);

    // (b) The bundled addon is where `init` looks for it: install it into the project.
    run(process.execPath, [entry, 'init', '--project', project, '--yes', '--no-agents-md', '--no-claude-md', '--agents', 'claude-code'], cwd);
    if (!existsSync(path.join(project, 'addons', 'godot_mcp', 'plugin.cfg'))) fail('smoke: init did not install the bundled addon');
    log('smoke: bundled addon installs into a project via `init`');

    // (c) With a Godot binary, one real headless operation through the addon.
    if (process.env.GODOT_PATH) {
      mcp = startMcp(entry, env, cwd);
      await mcp.initialize();
      const tree = await mcp.callTool('godot_scene_tree', { scene: 'res://main.tscn' }, 300_000);
      await mcp.close();
      if (tree.isError) fail(`smoke: godot_scene_tree failed: ${JSON.stringify(tree.content)}`);
      log(`smoke: headless godot_scene_tree OK: ${(tree.content?.[0]?.text ?? '').slice(0, 120).replace(/\s+/g, ' ')}...`);
    } else {
      log('smoke: GODOT_PATH not set, skipping the headless Godot call');
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
}

if (opts.smoke) await smokeTest();
if (!opts.keepStaging) rmSync(path.join(OUT_DIR, 'staging'), { recursive: true, force: true });
log('done');
