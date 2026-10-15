/**
 * Server configuration, resolved once at startup from CLI flags and
 * environment variables.
 *
 * Everything that changes which tools are listed is decided HERE, at startup,
 * and never mid-session. The 2026-07-28 MCP spec says `tools/list` "MUST NOT
 * vary per-connection or as a side effect of other requests" (SEP-2567), and
 * most clients handle `tools/list_changed` badly anyway, so the tool list is
 * a pure function of this config.
 */

import path from 'node:path';

/** How tools are exposed to the client. */
export type ToolMode =
  /** Every enabled operation is a native MCP tool (best for clients with their own tool search). */
  | 'full'
  /** Only core operations are native; everything else is reached through the router tools. */
  | 'compact';

export interface Config {
  /** Absolute path of the Godot project (the folder containing project.godot). */
  projectPath: string;
  /** Explicit Godot executable, if the user gave one (otherwise we search PATH). */
  godotPath: string | undefined;
  /** Tool groups to enable. `undefined` means "all groups". */
  toolsets: Set<string> | undefined;
  mode: ToolMode;
  /** Hide every operation that changes something. */
  readOnly: boolean;
  /** Timeout for a single headless Godot invocation, in ms. */
  headlessTimeoutMs: number;
  /** Timeout for a single editor-bridge request, in ms. */
  bridgeTimeoutMs: number;
  /**
   * "elicit" (default): ask the user through the client's elicitation dialog
   * before irreversible operations, when the client supports it.
   * "never": don't ask (for unattended runs where nobody can answer, e.g.
   * `claude -p`, which auto-declines elicitation).
   */
  confirm: 'elicit' | 'never';
  /**
   * [code area] GDScript language server settings (src/lsp/manager.ts).
   * `lspPort` overrides the port of the user's editor language server (default: what the
   * plugin reports, else 6005). Always 127.0.0.1.
   */
  lspPort: number | undefined;
  /** Timeout for one language server request, in ms. */
  lspTimeoutMs: number;
  /** Stop the private headless LSP editor after this long without code.* calls, in ms. */
  lspIdleTimeoutMs: number;
  /**
   * [live game area] Allow godot_game_eval to run code inside the running game
   * (`--allow-eval` / GODOT_MCP_ALLOW_EVAL=1). Off by default: evaluated GDScript can do
   * anything the game can (files, OS calls). The tool is listed either way (the tool list
   * never depends on runtime state); while off it returns a DISABLED error saying how to
   * turn it on.
   */
  allowEval: boolean;
}

/** Parse `--flag value` / `--flag=value` style args into a map. */
function parseArgs(argv: string[]): Map<string, string> {
  const out = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (!arg.startsWith('--')) continue;
    const eq = arg.indexOf('=');
    if (eq !== -1) {
      out.set(arg.slice(2, eq), arg.slice(eq + 1));
    } else {
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        out.set(arg.slice(2), next);
        i++;
      } else {
        out.set(arg.slice(2), 'true');
      }
    }
  }
  return out;
}

function truthy(value: string | undefined): boolean {
  return value !== undefined && ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
}

/**
 * Build the config. CLI flags win over environment variables so that a
 * client config can override a globally exported env var.
 */
export function loadConfig(argv: string[] = process.argv.slice(2), env: NodeJS.ProcessEnv = process.env): Config {
  const args = parseArgs(argv);

  // Empty env values count as unset: bundle/plugin installers (Claude Desktop .mcpb,
  // Claude Code plugins) pass "" for settings the user left blank, and that must not
  // hide a real value from another variable or the defaults.
  const nonEmpty = (v: string | undefined) => (v && v.trim() !== '' ? v : undefined);
  const projectArg = args.get('project') ?? nonEmpty(env.GODOT_PROJECT_PATH) ?? process.cwd();

  const toolsetsRaw = args.get('toolsets') ?? env.GODOT_MCP_TOOLSETS;
  let toolsets: Set<string> | undefined;
  if (toolsetsRaw && toolsetsRaw.trim() !== '' && toolsetsRaw.trim().toLowerCase() !== 'all') {
    toolsets = new Set(
      toolsetsRaw
        .split(',')
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean),
    );
    // The core group (status, project info) is what makes the server usable
    // at all, so it is always on even if the user forgets to list it.
    toolsets.add('core');
  }

  const modeRaw = (args.get('mode') ?? env.GODOT_MCP_MODE ?? 'full').toLowerCase();
  const mode: ToolMode = modeRaw === 'compact' ? 'compact' : 'full';

  return {
    projectPath: path.resolve(projectArg),
    godotPath: args.get('godot') ?? nonEmpty(env.GODOT_PATH) ?? nonEmpty(env.GODOT_BIN) ?? undefined,
    toolsets,
    mode,
    readOnly: truthy(args.get('read-only') ?? env.GODOT_MCP_READ_ONLY),
    headlessTimeoutMs: Number(env.GODOT_MCP_HEADLESS_TIMEOUT_MS ?? 120_000),
    bridgeTimeoutMs: Number(env.GODOT_MCP_BRIDGE_TIMEOUT_MS ?? 30_000),
    confirm: (args.get('confirm') ?? env.GODOT_MCP_CONFIRM ?? 'elicit').toLowerCase() === 'never' ? 'never' : 'elicit',
    lspPort: env.GODOT_MCP_LSP_PORT ? Number(env.GODOT_MCP_LSP_PORT) : undefined,
    lspTimeoutMs: Number(env.GODOT_MCP_LSP_TIMEOUT_MS ?? 15_000),
    lspIdleTimeoutMs: Number(env.GODOT_MCP_LSP_IDLE_MS ?? 10 * 60_000),
    allowEval: truthy(args.get('allow-eval') ?? env.GODOT_MCP_ALLOW_EVAL),
  };
}
