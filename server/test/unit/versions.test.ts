/**
 * Release consistency: the version in server/package.json, server/package-lock.json,
 * server/src/version.ts, addons/godot_mcp/plugin.cfg and server.json must agree, and
 * server.json must name the same npm package / mcpName as package.json.
 *
 * Runs the same check as `npm run check:versions` (scripts/check-versions.mjs at the repo
 * root), so a version bump that misses one file fails `npm test`, not just a release.
 */

import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
// Plain .mjs with no type declarations; vitest loads it as an ES module.
// @ts-ignore -- no .d.ts for the repo-root script (tests are not type-checked by tsc anyway).
import { checkVersions, REPO_ROOT, setVersions as setVersionsUntyped } from '../../../scripts/check-versions.mjs';
import { SERVER_VERSION } from '../../src/version.js';

type Result = { ok: boolean; versions: Record<string, string | undefined>; problems: string[] };
const check = checkVersions as (root?: string) => Result;
const setVersions = setVersionsUntyped as (version: string, root?: string) => void;

/** The files checkVersions reads, relative to the repo root. */
const FILES = ['server/package.json', 'server/package-lock.json', 'server/src/version.ts', 'addons/godot_mcp/plugin.cfg', 'server.json'];

/** Copy just those files into a throwaway "repo" so a test can corrupt one of them. */
function fixtureRepo(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'godot-mcp-versions-'));
  for (const f of FILES) {
    mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
    cpSync(path.join(REPO_ROOT as string, f), path.join(dir, f));
  }
  return dir;
}

const temps: string[] = [];
afterEach(() => {
  for (const d of temps.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('release versions', () => {
  it('agree across package.json, lockfile, version.ts, plugin.cfg and server.json', () => {
    const result = check();
    // Show the offending files in the failure message, not just "false".
    expect(result.problems).toEqual([]);
    expect(result.ok).toBe(true);
    // Every source was actually found and read.
    for (const v of Object.values(result.versions)) expect(v).toBe(SERVER_VERSION);
    expect(Object.keys(result.versions)).toEqual(
      expect.arrayContaining(['server/package.json', 'server/src/version.ts', 'addons/godot_mcp/plugin.cfg', 'server.json']),
    );
  });

  it('detects a version that drifted in one file', () => {
    const dir = fixtureRepo();
    temps.push(dir);
    const cfg = path.join(dir, 'addons/godot_mcp/plugin.cfg');
    writeFileSync(cfg, readFileSync(cfg, 'utf8').replace(/version="[^"]+"/, 'version="9.9.9"'));
    const result = check(dir);
    expect(result.ok).toBe(false);
    expect(result.problems.join('\n')).toContain('addons/godot_mcp/plugin.cfg: 9.9.9');
  });

  it('--set bumps every file, and the result passes the check', () => {
    const dir = fixtureRepo();
    temps.push(dir);
    const lockBefore = readFileSync(path.join(dir, 'server/package-lock.json'), 'utf8');
    setVersions('9.8.7-beta.1', dir);
    const result = check(dir);
    expect(result.problems).toEqual([]);
    for (const v of Object.values(result.versions)) expect(v).toBe('9.8.7-beta.1');
    // Only the version fields changed: the lockfile keeps npm's exact formatting.
    const lockAfter = readFileSync(path.join(dir, 'server/package-lock.json'), 'utf8');
    expect(lockAfter.replaceAll('9.8.7-beta.1', SERVER_VERSION)).toBe(lockBefore);
    // Dependency ranges in package.json are untouched.
    const pkg = JSON.parse(readFileSync(path.join(dir, 'server/package.json'), 'utf8'));
    const realPkg = JSON.parse(readFileSync(path.join(REPO_ROOT as string, 'server/package.json'), 'utf8'));
    expect(pkg.dependencies).toEqual(realPkg.dependencies);
    expect(() => setVersions('^1.0.0', dir)).toThrow(/not a plain semver/);
  });

  it('detects a server.json name that does not match package.json mcpName', () => {
    const dir = fixtureRepo();
    temps.push(dir);
    const file = path.join(dir, 'server.json');
    const json = JSON.parse(readFileSync(file, 'utf8'));
    json.name = 'io.github.someone-else/godot-mcp';
    writeFileSync(file, JSON.stringify(json, null, 2));
    const result = check(dir);
    expect(result.ok).toBe(false);
    expect(result.problems.join('\n')).toContain('mcpName');
  });
});
