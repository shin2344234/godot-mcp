/**
 * Export presets and builds.
 *
 * - export.presets / export.preset_set run in Godot (addons/godot_mcp/ops/export_ops.gd),
 *   which reads and writes export_presets.cfg with ConfigFile exactly like the
 *   editor does and redacts secrets. This file adds what only the server can
 *   know cheaply: whether export templates for this Godot version are installed.
 * - export.run starts `godot --headless --path P --export-<mode> "<preset>" <out>`
 *   as a child process. It is a separate editor instance, so it works whether
 *   or not the user's editor is open (exporting while it is open is fine).
 *
 * Godot 4.7 facts this relies on (verified on the 4.7.2 binary/source):
 * - templates live in <editor data dir>/export_templates/<major.minor[.patch].status>/,
 *   e.g. ~/.local/share/godot/export_templates/4.7.2.stable/ (".mono" suffix for
 *   .NET builds); release/debug exports fail without them, pack/patch exports
 *   (`--export-pack` / `--export-patch`) never need them;
 * - the output folder must exist and pack outputs must end in .pck or .zip;
 * - a failed export exits with code 1 and prints "ERROR: ..." lines.
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { OpError } from '../errors.js';
import { findGodot, GODOT_NOT_FOUND_HINT } from '../godot/binary.js';
import { classifyLine } from '../godot/runs.js';
import { log } from '../log.js';
import { PathError, resolveProjectPath } from '../project/paths.js';
import { callGodot, forwardOp } from './backend.js';
import { defineOp, type OpContext, type Operation } from './types.js';

// ---------------------------------------------------------------------------
// Export templates
// ---------------------------------------------------------------------------

/**
 * Template folder name for a `godot --version` string:
 * "4.7.2.stable.official.ed1daf0bf" -> "4.7.2.stable", "4.7.stable.mono.official.x" -> "4.7.stable.mono".
 * (GODOT_VERSION_FULL_CONFIG: numbers up to and including the status, plus ".mono".)
 */
export function templateVersion(version: string): string {
  const parts = version.trim().split('.');
  const out: string[] = [];
  for (const p of parts) {
    out.push(p);
    if (!/^\d+$/.test(p)) break;
  }
  return out.join('.') + (parts.includes('mono') ? '.mono' : '');
}

/**
 * Godot's editor data folder (EditorPaths::get_data_dir): next to the binary in
 * self-contained mode (a `_sc_` or `._sc_` file beside it), otherwise per OS.
 */
export function godotDataDir(binaryPath: string, platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env): string {
  const binDir = path.dirname(binaryPath);
  if (existsSync(path.join(binDir, '_sc_')) || existsSync(path.join(binDir, '._sc_'))) return path.join(binDir, 'editor_data');
  const home = os.homedir();
  if (platform === 'win32') return path.join(env.APPDATA ?? path.join(home, 'AppData', 'Roaming'), 'Godot');
  if (platform === 'darwin') return path.join(home, 'Library', 'Application Support', 'Godot');
  return path.join(env.XDG_DATA_HOME || path.join(home, '.local', 'share'), 'godot');
}

/** Template file a preset needs for one export mode, or undefined when we can't tell. */
export function templateFile(platform: string, mode: 'release' | 'debug', options: Record<string, unknown> = {}): string | undefined {
  const arch = typeof options['binary_format/architecture'] === 'string' ? (options['binary_format/architecture'] as string) : 'x86_64';
  switch (platform) {
    case 'Linux':
      return `linux_${mode}.${arch}`;
    case 'Windows Desktop':
      return `windows_${mode}_${arch}.exe`;
    case 'macOS':
      return 'macos.zip';
    case 'Android':
      return `android_${mode}.apk`;
    case 'iOS':
      return 'ios.zip';
    case 'visionOS':
      return 'visionos.zip';
    case 'Web':
      return options['variant/thread_support'] === true ? `web_${mode}.zip` : `web_nothreads_${mode}.zip`;
    default:
      return undefined;
  }
}

interface TemplatesInfo {
  version: string;
  dir: string;
  installed: boolean;
  files?: string[];
}

async function templatesInfo(ctx: OpContext): Promise<TemplatesInfo | null> {
  const godot = await findGodot(ctx.config.godotPath);
  if (!godot) return null;
  const version = templateVersion(godot.version);
  const dir = path.join(godotDataDir(godot.path), 'export_templates', version);
  const files = await readdir(dir).catch(() => [] as string[]);
  return { version, dir, installed: files.length > 0, ...(files.length ? { files: files.sort() } : {}) };
}

const TEMPLATES_HINT =
  'Install them in the Godot editor (Editor > Manage Export Templates > Download and Install), or download the .tpz for this exact version from https://godotengine.org/download/archive/ and install it there ("Install from File").';

interface PresetInfo {
  name: string;
  platform: string;
  export_path?: string;
  options?: Record<string, unknown>;
}

/** Which template a preset still needs for `mode` ("" when custom templates are set or not checkable). */
function missingTemplate(preset: PresetInfo, mode: 'release' | 'debug', t: TemplatesInfo): string | undefined {
  const custom = preset.options?.[`custom_template/${mode}`];
  if (typeof custom === 'string' && custom !== '') return undefined; // Godot checks that file itself
  const file = templateFile(preset.platform, mode, preset.options);
  if (!file) return undefined;
  return t.files?.includes(file) ? undefined : file;
}

// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------

const presetRef = z.union([z.string(), z.number().int().min(0)]).describe('Preset name or index.');

export const exportPresets = defineOp({
  name: 'export.presets',
  group: 'export',
  title: 'Export presets',
  description: 'Godot export: list export presets (platform, path, filters, options; secrets redacted) and whether export templates are installed.',
  input: z.object({
    preset: presetRef.optional().describe('Show one preset with all its options.'),
  }),
  readOnly: true,
  idempotent: true,
  async run(args, ctx) {
    const { result, backend } = await callGodot<Record<string, unknown>>(ctx, 'export.presets', args);
    const templates = await templatesInfo(ctx);
    const data: Record<string, unknown> = { ...result, backend, templates };
    if (templates) {
      // Per preset: which template file a release/debug export would still need.
      const annotate = (p: PresetInfo & Record<string, unknown>) => {
        const missing = (['release', 'debug'] as const).map((m) => missingTemplate(p, m, templates)).filter((f): f is string => Boolean(f));
        if (missing.length) p.templates_missing = missing;
      };
      if (Array.isArray(result.presets)) (result.presets as (PresetInfo & Record<string, unknown>)[]).forEach(annotate);
      if (result.preset) annotate(result.preset as PresetInfo & Record<string, unknown>);
      if (!templates.installed) data.templates_hint = `No export templates for ${templates.version} in ${templates.dir}; release/debug exports need them (pack exports don't). ${TEMPLATES_HINT}`;
    }
    return { data };
  },
});

export const exportPresetSet = defineOp({
  name: 'export.preset_set',
  group: 'export',
  title: 'Edit export preset',
  description: 'Godot export: change an export preset\'s fields/options, or create a preset, in export_presets.cfg.',
  input: z.object({
    preset: presetRef.optional(),
    set: z.record(z.string(), z.unknown()).optional().describe('e.g. {"export_path": "build/game.exe", "binary_format/embed_pck": true}.'),
    create: z.object({ name: z.string(), platform: z.string().describe('"Linux", "Windows Desktop", "Web", ...') }).optional(),
    allow_new_keys: z.boolean().optional(),
    allow_secrets: z.boolean().optional(),
  }),
  readOnly: false,
  run: (args, ctx) => forwardOp(ctx, 'export.preset_set', args),
});

export const exportRun = defineOp({
  name: 'export.run',
  group: 'export',
  title: 'Export project',
  description: 'Godot export: build the game with an export preset (release, debug, pack-only .pck/.zip, or patch); long-running.',
  input: z.object({
    preset: z.string().describe('Preset name (see godot_export_presets).'),
    mode: z.enum(['release', 'debug', 'pack', 'patch']).default('release'),
    output: z.string().optional().describe("Output file; default the preset's export_path. Relative = inside the project."),
    patches: z.array(z.string()).optional().describe('patch: base .pck files (default: the preset\'s patches).'),
    allow_outside_project: z.boolean().optional().describe('Allow an absolute output path outside the project.'),
    timeout_s: z.number().int().min(10).max(14_400).default(1800),
  }),
  readOnly: false,
  async run(args, ctx) {
    return runExport(args, ctx);
  },
});

/** Operations in this area, in the order they should appear in tools/list. */
export const operations: Operation[] = [exportPresets, exportPresetSet, exportRun] as Operation[];

// ---------------------------------------------------------------------------
// export.run
// ---------------------------------------------------------------------------

interface RunArgs {
  preset: string;
  mode: 'release' | 'debug' | 'pack' | 'patch';
  output?: string;
  patches?: string[];
  allow_outside_project?: boolean;
  timeout_s: number;
}

const ANSI = /\x1b\[[0-9;]*[A-Za-z]/g;
/** An export progress line, "[  42% ] savepack | Storing File: res://x.png": percent, then the step. */
export const PROGRESS_LINE = /^\[\s*(\d+)%\s*\]\s*(.*)$/;
const SESSION_REL = path.join('.godot', 'godot_mcp', 'session.json');

/** Resolve the output file; relative paths and res:// are inside the project. */
function resolveOutput(projectPath: string, raw: string, allowOutside: boolean): string {
  const looksAbsolute = !raw.startsWith('res://') && (path.isAbsolute(raw) || /^[A-Za-z]:[\\/]/.test(raw));
  if (looksAbsolute) {
    const abs = path.resolve(raw);
    const rel = path.relative(projectPath, abs);
    const inside = !rel.startsWith('..') && !path.isAbsolute(rel);
    if (!inside && !allowOutside) {
      throw new OpError('BAD_PARAMS', `Output "${raw}" is outside the project. Pass "allow_outside_project": true to export there, or use a path inside the project such as "build/game.exe".`);
    }
    return abs;
  }
  try {
    const p = resolveProjectPath(projectPath, raw);
    if (p.rel === '' || p.rel.startsWith('.godot/') || p.rel === '.godot') throw new OpError('BAD_PARAMS', `Output "${raw}" must be a file path outside .godot/, e.g. "build/game.x86_64".`);
    return p.abs;
  } catch (err) {
    if (err instanceof PathError) throw new OpError('BAD_PARAMS', err.message);
    throw err;
  }
}

async function runExport(args: RunArgs, ctx: OpContext) {
  const projectPath = ctx.config.projectPath;
  const godot = await findGodot(ctx.config.godotPath);
  if (!godot) throw new OpError('GODOT_NOT_FOUND', GODOT_NOT_FOUND_HINT);

  // Preset details come from Godot (editor or headless), the same reader as export.presets.
  const { result } = await callGodot<{ exists: boolean; preset?: PresetInfo }>(ctx, 'export.presets', { preset: args.preset });
  if (!result.exists || !result.preset) {
    throw new OpError('NOT_FOUND', 'The project has no export_presets.cfg. Create a preset with godot_export_preset_set {"create": {"name": "Linux", "platform": "Linux"}} first.');
  }
  const preset = result.preset;
  const pack = args.mode === 'pack' || args.mode === 'patch';

  let rawOut = args.output ?? preset.export_path ?? '';
  if (!rawOut) {
    throw new OpError('BAD_PARAMS', `Preset "${preset.name}" has no export_path; pass "output" (e.g. "build/game${pack ? '.pck' : ''}") or set it with godot_export_preset_set.`);
  }
  // A pack export written to the game binary's path would be wrong; default to <name>.pck.
  if (pack && !args.output && !/\.(pck|zip)$/i.test(rawOut)) rawOut = rawOut.replace(/(\.[^./\\]*)?$/, '.pck');
  if (pack && !/\.(pck|zip)$/i.test(rawOut)) throw new OpError('BAD_PARAMS', `A ${args.mode} export writes a data pack: "output" must end in .pck or .zip, got "${rawOut}".`);
  const outAbs = resolveOutput(projectPath, rawOut, args.allow_outside_project ?? false);

  // Fail fast on missing templates (release/debug only; pack/patch never need them).
  if (!pack) {
    const templates = await templatesInfo(ctx);
    const missing = templates ? missingTemplate(preset, args.mode as 'release' | 'debug', templates) : undefined;
    if (templates && missing) {
      throw new OpError(
        'GODOT_ERROR',
        `Export templates for Godot ${templates.version} are not installed: "${missing}" is missing from ${templates.dir}. ${TEMPLATES_HINT} ` +
          `A pack-only export (mode "pack") works without templates.`,
        { templates_dir: templates.dir, missing },
      );
    }
  }

  await mkdir(path.dirname(outAbs), { recursive: true });
  const flag = { release: '--export-release', debug: '--export-debug', pack: '--export-pack', patch: '--export-patch' }[args.mode];
  const cliArgs = ['--headless', '--path', projectPath, flag, preset.name, outAbs];
  if (args.mode === 'patch' && args.patches?.length) {
    const patchPaths = args.patches.map((p) => resolveOutput(projectPath, p, true));
    cliArgs.push('--patches', patchPaths.join(','));
  }

  // The export runs a second editor instance with the project's plugins enabled, and
  // godot_mcp's plugin would overwrite (then delete) the live editor's session file.
  // Remember it and put it back afterwards.
  const sessionFile = path.join(projectPath, SESSION_REL);
  const sessionBefore = await readFile(sessionFile, 'utf8').catch(() => undefined);

  const started = Date.now();
  log.info(`export: ${godot.path} ${cliArgs.join(' ')}`);
  const proc = await spawnExport(godot.path, cliArgs, projectPath, args.timeout_s * 1000, ctx);

  if (sessionBefore !== undefined) {
    const after = await readFile(sessionFile, 'utf8').catch(() => undefined);
    if (after !== sessionBefore) await writeFile(sessionFile, sessionBefore, { encoding: 'utf8', mode: 0o600 }).catch(() => undefined);
  }

  const files = await producedFiles(outAbs, started);
  const errors = proc.lines.filter((l) => l.level === 'error').map((l) => l.text);
  const warnings = proc.lines.filter((l) => l.level === 'warning').map((l) => l.text);
  const rel = path.relative(projectPath, outAbs);
  const outputShown = rel.startsWith('..') || path.isAbsolute(rel) ? outAbs : `res://${rel.split(path.sep).join('/')}`;
  const tail = proc.lines.slice(-25).map((l) => (l.level === 'info' ? l.text : `[${l.level}] ${l.text}`));
  const summary = {
    preset: preset.name,
    platform: preset.platform,
    mode: args.mode,
    output: outputShown,
    exit_code: proc.code,
    duration_s: Math.round((Date.now() - started) / 100) / 10,
    files,
    errors: errors.slice(0, 20),
    warning_count: warnings.length,
    tail,
  };

  if (proc.cancelled) throw new OpError('GODOT_ERROR', 'Export cancelled; the Godot process was stopped.', summary);
  if (proc.timedOut) throw new OpError('TIMEOUT', `Export did not finish within ${args.timeout_s} s and was stopped. Raise timeout_s for big projects.`, summary);
  if (proc.code !== 0 || files.length === 0) {
    const why = errors.length ? errors.slice(0, 8).join('\n') : tail.slice(-10).join('\n');
    throw new OpError('GODOT_ERROR', `Export of preset "${preset.name}" (${args.mode}) failed with exit code ${proc.code}:\n${why}`, summary);
  }
  return { data: summary };
}

interface ExportProcess {
  code: number | null;
  timedOut: boolean;
  cancelled: boolean;
  lines: { level: 'info' | 'warning' | 'error'; text: string }[];
}

/** Run the export, streaming output into progress notifications. Keeps the last 400 lines. */
function spawnExport(file: string, args: string[], cwd: string, timeoutMs: number, ctx: OpContext): Promise<ExportProcess> {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const out: ExportProcess = { code: null, timedOut: false, cancelled: false, lines: [] };
    let previous: 'info' | 'warning' | 'error' = 'info';
    let lastPct = -1;
    const onLine = (raw: string) => {
      const text = raw.replace(ANSI, '').replace(/\r/g, '').trimEnd();
      if (!text.trim()) return;
      // Godot prints "[  42% ] savepack | Storing File: res://..." during exports.
      const m = PROGRESS_LINE.exec(text);
      if (m) {
        const pct = Number(m[1]);
        if (pct !== lastPct) {
          lastPct = pct;
          ctx.progress?.(pct, 100, m[2]!.slice(0, 120));
        }
        // Progress lines go to progress notifications only, never into `lines`: a pack
        // export prints one per file, so the result's `tail` used to be ~25 "savepack |
        // Storing File" lines (MCP_TEST_LOG Phase A) and pushed real messages out of it.
        return;
      }
      previous = classifyLine(text, previous);
      out.lines.push({ level: previous, text });
      if (out.lines.length > 400) out.lines.shift();
    };
    const attach = (stream: NodeJS.ReadableStream) => {
      let buf = '';
      stream.on('data', (d: Buffer) => {
        buf += d.toString('utf8');
        let nl: number;
        while ((nl = buf.indexOf('\n')) >= 0) {
          onLine(buf.slice(0, nl));
          buf = buf.slice(nl + 1);
        }
      });
      stream.on('end', () => buf && onLine(buf));
    };
    attach(child.stdout);
    attach(child.stderr);

    const kill = () => {
      child.kill('SIGTERM');
      setTimeout(() => child.exitCode === null && child.kill('SIGKILL'), 5000).unref();
    };
    const timer = setTimeout(() => {
      out.timedOut = true;
      kill();
    }, timeoutMs);
    const onAbort = () => {
      out.cancelled = true;
      kill();
    };
    ctx.signal?.addEventListener('abort', onAbort, { once: true });
    if (ctx.signal?.aborted) onAbort();

    child.on('error', (err) => {
      clearTimeout(timer);
      ctx.signal?.removeEventListener('abort', onAbort);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      ctx.signal?.removeEventListener('abort', onAbort);
      out.code = code;
      resolve(out);
    });
  });
}

/** The output file plus siblings written by the export (game.pck next to game.exe, web files...). */
async function producedFiles(outAbs: string, since: number): Promise<{ path: string; size: number }[]> {
  const dir = path.dirname(outAbs);
  const stem = path.basename(outAbs).replace(/\.[^.]*$/, '');
  const names = await readdir(dir).catch(() => [] as string[]);
  const files: { path: string; size: number }[] = [];
  for (const name of names.sort()) {
    if (name !== path.basename(outAbs) && !name.startsWith(stem + '.')) continue;
    const st = await stat(path.join(dir, name)).catch(() => undefined);
    if (!st?.isFile() || st.mtimeMs < since - 2000) continue;
    files.push({ path: path.join(dir, name), size: st.size });
  }
  return files;
}
