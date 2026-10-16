#!/usr/bin/env node
/**
 * Release consistency check: fails (exit 1) when the places that carry the release
 * version, or the package / registry names, disagree.
 *
 *   node scripts/check-versions.mjs            (from the repo root)
 *   npm run check:versions                     (from server/; also part of `prepack`)
 *   node scripts/check-versions.mjs --set 0.2.0   (release bump: writes 0.2.0 into every
 *                                                  file below, then checks)
 *
 * Version sources (all must be equal):
 *   - server/package.json                "version"
 *   - server/package-lock.json           "version" and packages[""].version (npm rewrites
 *                                        these on `npm version`; a stale lock is a hint
 *                                        that someone edited package.json by hand)
 *   - server/src/version.ts              SERVER_VERSION (sent to clients in serverInfo and
 *                                        printed by `godot-mcp --version`; kept by hand)
 *   - addons/godot_mcp/plugin.cfg        version="..." (`godot-mcp init` compares it with
 *                                        the installed addon to decide whether to update)
 *   - addons/godot_mcp/core/constants.gd PLUGIN_VERSION (the version the addon reports in
 *                                        the bridge welcome, editor.status and the session
 *                                        file; scripts/build-addon-zip.mjs refuses to build
 *                                        when it disagrees with plugin.cfg)
 *   - server.json                        "version" and the npm package entry's "version"
 *                                        (the MCP Registry entry)
 *
 * Name checks (the MCP Registry rejects a publish when these disagree):
 *   - server.json "name"  ==  server/package.json "mcpName"
 *     (https://modelcontextprotocol.io/registry/package-types#ownership-verification)
 *   - server.json npm package "identifier"  ==  server/package.json "name"
 *
 * The same function is imported by server/test/unit/versions.test.ts so `npm test`
 * catches drift too. No dependencies, no network: plain file reads.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Repository root (this file lives in <root>/scripts/). */
export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

/**
 * Collect every version/name and compare them.
 *
 * @param {string} root  repository root (overridable so tests can point at a fixture copy)
 * @returns {{ ok: boolean, versions: Record<string, string | undefined>, problems: string[] }}
 */
export function checkVersions(root = REPO_ROOT) {
  const problems = [];
  /** label -> version found there (undefined = could not be read). */
  const versions = {};
  const rel = (p) => path.join(root, p);

  // --- server/package.json ---------------------------------------------------
  const pkg = readJson(rel('server/package.json'));
  versions['server/package.json'] = pkg.version;

  // --- server/package-lock.json (optional: absent in a source-only tarball) ----
  if (existsSync(rel('server/package-lock.json'))) {
    const lock = readJson(rel('server/package-lock.json'));
    versions['server/package-lock.json'] = lock.version;
    versions['server/package-lock.json packages[""]'] = lock.packages?.['']?.version;
  }

  // --- server/src/version.ts -----------------------------------------------------
  // Matches: export const SERVER_VERSION = '0.1.0';   (single or double quotes)
  const versionTs = readFileSync(rel('server/src/version.ts'), 'utf8');
  versions['server/src/version.ts'] = /SERVER_VERSION\s*=\s*['"]([^'"]+)['"]/.exec(versionTs)?.[1];

  // --- addons/godot_mcp/plugin.cfg ------------------------------------------------
  // Godot ConfigFile syntax: version="0.1.0" on its own line in [plugin].
  const pluginCfg = readFileSync(rel('addons/godot_mcp/plugin.cfg'), 'utf8');
  versions['addons/godot_mcp/plugin.cfg'] = /^\s*version\s*=\s*"([^"]+)"/m.exec(pluginCfg)?.[1];

  // --- addons/godot_mcp/core/constants.gd -------------------------------------------
  // GDScript: const PLUGIN_VERSION: String = "0.1.0"
  // 0.1.1 shipped with this still at 0.1.0 because nothing here checked it.
  const constantsGd = readFileSync(rel('addons/godot_mcp/core/constants.gd'), 'utf8');
  versions['addons/godot_mcp/core/constants.gd'] = /PLUGIN_VERSION\s*:\s*String\s*=\s*"([^"]+)"/.exec(constantsGd)?.[1];

  // --- server.json (MCP Registry) ---------------------------------------------------
  const serverJson = readJson(rel('server.json'));
  versions['server.json'] = serverJson.version;
  const npmEntries = (serverJson.packages ?? []).filter((p) => p.registryType === 'npm');
  if (npmEntries.length === 0) {
    problems.push('server.json: no package with "registryType": "npm"');
  }
  for (const [i, entry] of npmEntries.entries()) {
    versions[`server.json packages[npm#${i}]`] = entry.version;
    if (entry.identifier !== pkg.name) {
      problems.push(`server.json: npm package identifier "${entry.identifier}" != server/package.json name "${pkg.name}"`);
    }
  }
  if (serverJson.name !== pkg.mcpName) {
    problems.push(`server.json name "${serverJson.name}" != server/package.json mcpName "${pkg.mcpName}" (the MCP Registry requires them to match)`);
  }

  // --- packaging/claude-plugin/.claude-plugin/plugin.json (Claude Code plugin) -------
  // Optional so fixture copies without packaging/ still check. The .mcpb manifest has
  // no version of its own: scripts/build-mcpb.mjs fills it in from server/package.json.
  const pluginJson = 'packaging/claude-plugin/.claude-plugin/plugin.json';
  if (existsSync(rel(pluginJson))) versions[pluginJson] = readJson(rel(pluginJson)).version;

  // --- compare -------------------------------------------------------------------------
  const expected = pkg.version;
  for (const [label, value] of Object.entries(versions)) {
    if (value === undefined) problems.push(`${label}: version not found`);
    else if (value !== expected) problems.push(`${label}: ${value} (expected ${expected}, from server/package.json)`);
  }

  return { ok: problems.length === 0, versions, problems };
}

/** Plain semver (with optional prerelease), the only shape we release under. */
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

/**
 * Write `version` into every source listed at the top of this file (the release bump).
 * Text-level replacements, so each file keeps its formatting; the lockfile is rewritten
 * the way npm writes it (2-space JSON + trailing newline).
 *
 * @param {string} version  e.g. "0.2.0"
 * @param {string} root     repository root
 */
export function setVersions(version, root = REPO_ROOT) {
  if (!SEMVER.test(version)) throw new Error(`"${version}" is not a plain semver version like 1.2.3 or 1.2.3-beta.1`);
  const rel = (p) => path.join(root, p);
  /** Replace with a regex that MUST match (a silent no-op would defeat the point). */
  const edit = (file, re, replacement) => {
    const before = readFileSync(rel(file), 'utf8');
    if (!re.test(before)) throw new Error(`${file}: version field not found (pattern ${re})`);
    re.lastIndex = 0;
    writeFileSync(rel(file), before.replace(re, replacement));
  };

  // package.json: only the top-level "version" (the first one; dependencies use ranges
  // under their own names, never a "version" key).
  edit('server/package.json', /^(\s*"version"\s*:\s*")[^"]*(")/m, `$1${version}$2`);

  if (existsSync(rel('server/package-lock.json'))) {
    const lock = readJson(rel('server/package-lock.json'));
    lock.version = version;
    if (lock.packages?.['']) lock.packages[''].version = version;
    writeFileSync(rel('server/package-lock.json'), JSON.stringify(lock, null, 2) + '\n');
  }

  edit('server/src/version.ts', /(SERVER_VERSION\s*=\s*['"])[^'"]*(['"])/, `$1${version}$2`);
  edit('addons/godot_mcp/plugin.cfg', /^(\s*version\s*=\s*")[^"]*(")/m, `$1${version}$2`);
  edit('addons/godot_mcp/core/constants.gd', /(PLUGIN_VERSION\s*:\s*String\s*=\s*")[^"]*(")/, `$1${version}$2`);
  // server.json: the top-level "version" and each package "version" (the only "version"
  // keys in the file). Global flag: all of them.
  edit('server.json', /("version"\s*:\s*")[^"]*(")/g, `$1${version}$2`);
  // Claude Code plugin manifest: its single top-level "version".
  const pluginJson = 'packaging/claude-plugin/.claude-plugin/plugin.json';
  if (existsSync(rel(pluginJson))) edit(pluginJson, /^(\s*"version"\s*:\s*")[^"]*(")/m, `$1${version}$2`);
}

// Run as a CLI only when executed directly (not when imported by the unit test).
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  // `--set X.Y.Z` bumps every file first, then verifies like a normal run.
  const setIndex = process.argv.indexOf('--set');
  if (setIndex !== -1) {
    const version = process.argv[setIndex + 1];
    try {
      setVersions(version ?? '');
    } catch (err) {
      console.error(`check-versions: ${err.message}`);
      process.exit(1);
    }
    console.log(`check-versions: set version ${version} in all files.`);
  }
  const { ok, versions, problems } = checkVersions();
  for (const [label, value] of Object.entries(versions)) console.log(`  ${String(value).padEnd(12)} ${label}`);
  if (ok) {
    console.log('check-versions: all versions and names agree.');
  } else {
    console.error('check-versions: MISMATCH');
    for (const p of problems) console.error(`  - ${p}`);
    process.exit(1);
  }
}
