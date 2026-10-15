/**
 * GUT and GdUnit4: detecting them in a project, finding test scripts, and
 * building the command line that runs a chosen set of tests headlessly.
 *
 * Command lines follow each framework's own CLI (verified against the sources
 * of the versions that support Godot 4.7 and by running them on Godot 4.7.2):
 *
 * GUT 9.7.1 (bitwes/Gut, tag v9.7.1, "godot_4_7" branch; addons/gut/cli/gut_cli.gd)
 *   godot --headless --path P -s res://addons/gut/gut_cmdln.gd [opts]
 *   -gdir=a,b          directories to search (files must match -gprefix, default "test_")
 *   -ginclude_subdirs  flag: also search subdirectories of -gdir
 *   -gtest=a,b         full paths of test scripts
 *   -gunit_test_name=x run only tests whose name contains x
 *   -gexit             quit when done (headless runs always quit; passed anyway)
 *   -gdisable_colors   no ANSI colors in the output
 *   -gjunit_xml_file=F write a JUnit XML report to F
 *   res://.gutconfig.json is loaded when present; command-line values win, and an
 *   empty "-gdir=" / "-gtest=" sets the list to [] (so a run of one file doesn't
 *   also run the config's dirs). Exit code 0 = all passed, 1 = failures.
 *   GUT refuses to run until its class_names are imported ("Some GUT class_names
 *   have not been imported"), so a project that was never opened is imported first.
 *
 * GdUnit4 6.2.x / 7.0 (godot-gdunit-labs/gdUnit4, formerly MikeSchulze/gdUnit4;
 * addons/gdUnit4/src/core/runners/GdUnitTestCIRunner.gd and runtest.sh)
 *   godot --headless --path P -s -d --remote-debug tcp://127.0.0.1:0 \
 *     res://addons/gdUnit4/bin/GdUnitCmdTool.gd --ignoreHeadlessMode -c -a <path> ... -rd <dir> -rc 1
 *   -a <dir|suite>     add a directory or test suite (repeatable)
 *   -i <suite:test>    ignore a test case (repeatable); used to run a single test
 *   -c                 continue after the first failure (the default is fail-fast)
 *   -rd <dir>          report folder (6.2.2 maps "/x" to "res://x", so pass a res:// path)
 *   -rc 1              keep one report: the JUnit file lands in <dir>/report_1/results.xml
 *   --ignoreHeadlessMode  required with --headless (it refuses otherwise, exit 103)
 *   "-d --remote-debug tcp://127.0.0.1:0" is what upstream runtest.sh passes: it keeps
 *   Godot's interactive stdin debugger from looping on script errors.
 *   Exit codes: 0 ok, 100 failures/errors, 101 orphan-node warnings, 103 headless,
 *   104 Godot too old, 105 script errors found while discovering tests.
 */

import { existsSync } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import type { Framework } from './junit.js';

export interface FrameworkInfo {
  framework: Framework;
  /** Folder name under addons/ exactly as on disk ("gut", "gdUnit4"). */
  addonDir: string;
  version?: string;
  /** res:// path of the CLI entry script. */
  entry: string;
}

export const SUPPORTED_HINT =
  'Supported test frameworks: GUT (addons/gut, https://github.com/bitwes/Gut; use GUT 9.7.x for Godot 4.7) and ' +
  'GdUnit4 (addons/gdUnit4, https://github.com/godot-gdunit-labs/gdUnit4; use 6.2.x or newer for Godot 4.7). ' +
  'Install one from the Godot editor\'s AssetLib tab, or download its release and copy the addons/<name> folder into the project, ' +
  'enable the plugin in Project > Project Settings > Plugins, then retry.';

/** Read `version="..."` from an addon's plugin.cfg. */
async function pluginVersion(dir: string): Promise<string | undefined> {
  const cfg = await readFile(path.join(dir, 'plugin.cfg'), 'utf8').catch(() => '');
  return /^\s*version\s*=\s*"([^"]*)"/m.exec(cfg)?.[1];
}

/**
 * Which supported frameworks are installed. Folder names are matched
 * case-insensitively (docs spell it "gdunit4", the release ships "gdUnit4")
 * but the on-disk spelling is used in res:// paths.
 */
export async function detectFrameworks(projectPath: string): Promise<FrameworkInfo[]> {
  const addons = path.join(projectPath, 'addons');
  const names = await readdir(addons).catch(() => [] as string[]);
  const out: FrameworkInfo[] = [];
  const gut = names.find((n) => n.toLowerCase() === 'gut');
  if (gut && existsSync(path.join(addons, gut, 'gut_cmdln.gd'))) {
    out.push({ framework: 'gut', addonDir: gut, version: await pluginVersion(path.join(addons, gut)), entry: `res://addons/${gut}/gut_cmdln.gd` });
  }
  const gdu = names.find((n) => n.toLowerCase() === 'gdunit4');
  if (gdu && existsSync(path.join(addons, gdu, 'bin', 'GdUnitCmdTool.gd'))) {
    out.push({ framework: 'gdunit4', addonDir: gdu, version: await pluginVersion(path.join(addons, gdu)), entry: `res://addons/${gdu}/bin/GdUnitCmdTool.gd` });
  }
  return out;
}

/** How a test script declares its framework (first `extends` line). */
const EXTENDS: Record<Framework, RegExp> = {
  gut: /^\s*extends\s+(?:GutTest\b|["']res:\/\/addons\/gut\/test\.gd["'])/m,
  gdunit4: /^\s*extends\s+(?:GdUnitTestSuite\b|["']res:\/\/addons\/gdUnit4\/src\/GdUnitTestSuite\.gd["'])/im,
};

export interface TestScript {
  /** res:// path. */
  res: string;
  /** From the `extends` line; undefined for a file given directly that extends something else. */
  framework?: Framework;
  /** Test function names in the file (both frameworks run functions named test_*). */
  tests: string[];
}

/** `func test_x(` names in a script, including those of inner classes. */
export function testFunctions(source: string): string[] {
  const names: string[] = [];
  for (const m of source.matchAll(/^\s*(?:static\s+)?func\s+(test_\w*)\s*\(/gm)) if (!names.includes(m[1]!)) names.push(m[1]!);
  return names;
}

/** The framework a script's `extends` line belongs to, if any. */
export function scriptFramework(source: string): Framework | undefined {
  if (EXTENDS.gut.test(source)) return 'gut';
  if (EXTENDS.gdunit4.test(source)) return 'gdunit4';
  return undefined;
}

const MAX_SCRIPT_BYTES = 1_000_000;

/**
 * Find test scripts under `startRel` (project-relative, "" = whole project).
 * Skips .godot/, addons/, hidden folders and folders with a .gdignore (Godot
 * ignores those too). A file given directly is always included, whatever it extends.
 */
export async function findTestScripts(projectPath: string, startRel = ''): Promise<TestScript[]> {
  const out: TestScript[] = [];
  const startAbs = path.join(projectPath, startRel);
  const st = await stat(startAbs).catch(() => undefined);
  if (!st) return out;
  const visit = async (abs: string, rel: string, explicit: boolean) => {
    if (!abs.endsWith('.gd')) return;
    const info = await stat(abs).catch(() => undefined);
    if (!info?.isFile() || info.size > MAX_SCRIPT_BYTES) return;
    const source = await readFile(abs, 'utf8').catch(() => '');
    const framework = scriptFramework(source);
    if (!framework && !explicit) return;
    out.push({ res: `res://${rel}`, ...(framework ? { framework } : {}), tests: testFunctions(source) });
  };
  if (st.isFile()) {
    await visit(startAbs, startRel, true);
    return out;
  }
  const walk = async (dirAbs: string, dirRel: string, depth: number) => {
    if (depth > 20) return;
    const entries = await readdir(dirAbs, { withFileTypes: true }).catch(() => []);
    if (entries.some((e) => e.name === '.gdignore')) return;
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const rel = dirRel ? `${dirRel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (e.name.startsWith('.') || (dirRel === '' && (e.name === 'addons' || e.name === 'node_modules'))) continue;
        await walk(path.join(dirAbs, e.name), rel, depth + 1);
      } else if (e.isFile()) {
        await visit(path.join(dirAbs, e.name), rel, false);
      }
    }
  };
  await walk(startAbs, startRel.replace(/\/$/, ''), 0);
  return out;
}

/** Conventional test folders that exist in the project, as res:// paths. */
export function conventionalTestDirs(projectPath: string): string[] {
  return ['test', 'tests'].filter((d) => existsSync(path.join(projectPath, d))).map((d) => `res://${d}`);
}

export interface Selection {
  /** res:// directory or file chosen by the caller; undefined = all tests. */
  path?: string;
  isFile?: boolean;
  /** Test name filter (substring of the function name). */
  test?: string;
}

/**
 * Arguments after `godot --headless --path P` for a GUT run.
 * `scripts` are the discovered test scripts in scope (used for "all tests"
 * when there is no .gutconfig.json).
 */
export function gutArgs(info: FrameworkInfo, sel: Selection, opts: { junitFile: string; hasConfig: boolean; scripts: TestScript[]; projectPath: string }): string[] {
  const args = ['-s', info.entry];
  if (sel.path && sel.isFile) {
    args.push(`-gtest=${sel.path}`, '-gdir=');
  } else if (sel.path) {
    args.push(`-gdir=${sel.path}`, '-ginclude_subdirs', '-gtest=');
  } else if (!opts.hasConfig) {
    // No .gutconfig.json to say where tests live: the usual test folders, plus any
    // GUT script found elsewhere in the project, by full path.
    const dirs = conventionalTestDirs(opts.projectPath);
    const outside = opts.scripts.filter((s) => s.framework === 'gut' && !dirs.some((d) => s.res.startsWith(d + '/'))).map((s) => s.res);
    if (dirs.length) args.push(`-gdir=${dirs.join(',')}`, '-ginclude_subdirs');
    if (outside.length) args.push(`-gtest=${outside.join(',')}`);
  }
  if (sel.test) args.push(`-gunit_test_name=${sel.test}`);
  args.push('-gexit', '-gdisable_colors', `-gjunit_xml_file=${opts.junitFile}`);
  return args;
}

/**
 * Arguments after `godot --headless --path P` for a GdUnit4 run. `reportDir`
 * must be a res:// path (see the header comment). A single-test run adds
 * only the suites that have a matching test and ignores their other tests.
 */
export function gdunitArgs(info: FrameworkInfo, sel: Selection, opts: { reportDir: string; scripts: TestScript[]; projectPath: string }): string[] {
  const args = ['-s', '-d', '--remote-debug', 'tcp://127.0.0.1:0', info.entry, '--ignoreHeadlessMode', '-c'];
  if (sel.test) {
    for (const s of opts.scripts) {
      const matching = s.tests.filter((t) => t.includes(sel.test!));
      if (!matching.length) continue;
      args.push('-a', s.res);
      for (const t of s.tests) if (!matching.includes(t)) args.push('-i', `${s.res}:${t}`);
    }
  } else if (sel.path) {
    args.push('-a', sel.path);
  } else {
    const dirs = conventionalTestDirs(opts.projectPath);
    for (const d of dirs) args.push('-a', d);
    for (const s of opts.scripts) if (s.framework === 'gdunit4' && !dirs.some((d) => s.res.startsWith(d + '/'))) args.push('-a', s.res);
  }
  args.push('-rd', opts.reportDir, '-rc', '1');
  return args;
}
