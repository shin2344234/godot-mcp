/**
 * Reader for Godot's `project.godot` file.
 *
 * The format looks like INI but isn't quite:
 *   - keys can appear before any `[section]` (e.g. `config_version=5`);
 *   - values are Godot Variant literals and may span MANY lines, e.g. an input
 *     action is `{ "deadzone": 0.2, "events": [Object(InputEventKey, ...)] }`
 *     spread over several lines, so a naive line-by-line parser breaks;
 *   - keys left at their defaults are simply absent.
 *
 * We only need read access for facts (main scene, autoloads, input action
 * names, ...). Writing project settings goes through the editor's
 * `ProjectSettings` API so Godot keeps full control of the file format.
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';

/** Raw settings: `section/key` -> raw value text (exactly as written in the file). */
export type RawSettings = Map<string, string>;

/**
 * Parse project.godot text into a map of `"section/key"` -> raw value text.
 * Top-level keys (before the first section) are stored without a prefix.
 */
export function parseProjectGodot(text: string): RawSettings {
  const settings: RawSettings = new Map();
  const lines = text.split(/\r?\n/);
  let section = '';

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith(';')) continue;

    // Section header, e.g. [application]
    const sectionMatch = /^\[([^\]]+)\]$/.exec(trimmed);
    if (sectionMatch) {
      section = sectionMatch[1]!;
      continue;
    }

    const eq = line.indexOf('=');
    if (eq === -1) continue; // Not a key line; ignore defensively.

    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1);

    // Keep consuming lines until brackets/braces/parens are balanced. String
    // contents are skipped so a "{" inside quotes doesn't confuse us.
    while (!isBalanced(value) && i + 1 < lines.length) {
      i++;
      value += '\n' + lines[i];
    }

    settings.set(section ? `${section}/${key}` : key, value.trim());
  }
  return settings;
}

/** True when every (, [, { opened outside a string has been closed. */
function isBalanced(text: string): boolean {
  let depth = 0;
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (ch === '\\') i++; // skip escaped char
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '(' || ch === '[' || ch === '{') depth++;
    else if (ch === ')' || ch === ']' || ch === '}') depth--;
  }
  return depth <= 0 && !inString;
}

/** Decode a Godot string literal `"..."` (handles the common escapes). */
export function decodeString(raw: string): string | undefined {
  const m = /^&?"((?:[^"\\]|\\.)*)"$/s.exec(raw.trim());
  if (!m) return undefined;
  return m[1]!.replace(/\\(.)/g, (_, c: string) => ({ n: '\n', t: '\t', r: '\r' })[c] ?? c);
}

/** Decode `PackedStringArray("a", "b")` (or a plain `["a","b"]`) into string[]. */
export function decodeStringArray(raw: string): string[] {
  const out: string[] = [];
  const re = /"((?:[^"\\]|\\.)*)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw)) !== null) out.push(decodeString(`"${m[1]}"`) ?? m[1]!);
  return out;
}

/**
 * Best-effort conversion of a raw value into JSON for display. Strings,
 * numbers, booleans and string arrays become JSON natives; anything more
 * complex (Objects, Vectors, dictionaries of events...) is returned as the
 * raw Godot literal text, which LLMs read fine.
 */
export function rawToJson(raw: string): unknown {
  const t = raw.trim();
  if (t === 'true') return true;
  if (t === 'false') return false;
  if (t === 'null') return null;
  if (/^-?\d+(\.\d+)?([eE][-+]?\d+)?$/.test(t)) return Number(t);
  const s = decodeString(t);
  if (s !== undefined) return s;
  if (/^PackedStringArray\(/.test(t)) return decodeStringArray(t);
  return t;
}

/** High-level facts the agent usually wants first. */
export interface ProjectFacts {
  name: string | null;
  /** 5 = Godot 4.x, 4 = Godot 3.x. */
  configVersion: number | null;
  /** e.g. "4.7" from config/features. */
  godotVersion: string | null;
  features: string[];
  mainScene: string | null;
  autoloads: { name: string; path: string; singleton: boolean }[];
  inputActions: string[];
  renderer: string;
  enabledPlugins: string[];
  csharp: boolean;
  testFrameworks: string[];
}

/**
 * Extract the facts above. `listDir` lets callers (and tests) supply
 * directory checks for addon detection without hitting the disk.
 */
export function extractFacts(settings: RawSettings, hasPath: (rel: string) => boolean = () => false): ProjectFacts {
  const get = (k: string) => settings.get(k);
  const features = get('application/config/features') ? decodeStringArray(get('application/config/features')!) : [];
  const godotVersion = features.find((f) => /^\d+\.\d+/.test(f)) ?? null;

  // [autoload] Name="*res://path.gd" -- the leading * marks a global singleton.
  const autoloads: ProjectFacts['autoloads'] = [];
  for (const [key, raw] of settings) {
    if (!key.startsWith('autoload/')) continue;
    const value = decodeString(raw) ?? raw;
    const singleton = value.startsWith('*');
    autoloads.push({ name: key.slice('autoload/'.length), path: singleton ? value.slice(1) : value, singleton });
  }

  const inputActions = [...settings.keys()].filter((k) => k.startsWith('input/')).map((k) => k.slice('input/'.length));

  // forward_plus is the default and therefore usually absent from the file.
  const rendererRaw = get('rendering/renderer/rendering_method');
  const renderer = (rendererRaw && decodeString(rendererRaw)) || 'forward_plus';

  const plugins = get('editor_plugins/enabled') ? decodeStringArray(get('editor_plugins/enabled')!) : [];

  const testFrameworks: string[] = [];
  if (hasPath('addons/gut/plugin.cfg')) testFrameworks.push('gut');
  if (hasPath('addons/gdUnit4/plugin.cfg')) testFrameworks.push('gdunit4');

  const configVersionRaw = get('config_version');
  return {
    name: get('application/config/name') ? (decodeString(get('application/config/name')!) ?? null) : null,
    configVersion: configVersionRaw ? Number(configVersionRaw) : null,
    godotVersion,
    features,
    mainScene: get('application/run/main_scene') ? (decodeString(get('application/run/main_scene')!) ?? null) : null,
    autoloads,
    inputActions,
    renderer,
    enabledPlugins: plugins,
    csharp: features.includes('C#') || settings.has('dotnet/project/assembly_name'),
    testFrameworks,
  };
}

/** Read and parse `<projectPath>/project.godot`. Throws a helpful error if missing. */
export async function readProjectSettings(projectPath: string): Promise<RawSettings> {
  const file = path.join(projectPath, 'project.godot');
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch {
    throw new Error(
      `No project.godot found at ${file}. Start the server from your Godot project folder, ` +
        `or pass --project <path> (or set GODOT_PROJECT_PATH).`,
    );
  }
  return parseProjectGodot(text);
}
