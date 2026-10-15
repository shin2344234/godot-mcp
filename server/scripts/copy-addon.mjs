// Prepares the files the npm package needs from OUTSIDE server/. Runs from the
// `prepack` script (so for `npm pack` and `npm publish`), after the TypeScript build.
//
//   1. ../addons/godot_mcp  ->  addon/godot_mcp
//      `godot-mcp init` installs the editor addon into the user's project from this copy
//      (see findAddonSource() in src/init/init.ts).
//   2. ../README.md          ->  README.md   (relative links rewritten to GitHub URLs)
//   3. ../LICENSE            ->  LICENSE
//      npm always packs README* and LICENSE* from the PACKAGE root (server/), never from
//      the repository root (https://docs.npmjs.com/cli/v11/configuring-npm/package-json#files),
//      so without these copies the npm page would show no readme and the tarball would
//      carry no license text, which MIT requires.
//
// All three outputs are git-ignored (server/.gitignore): the repository-root files are
// the source of truth, these are build products.
import { cpSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'); // server/
const repoRoot = path.resolve(root, '..');

/** Where relative README links point once the README is shown on npmjs.com. */
const GITHUB_BLOB = 'https://github.com/shin2344234/godot-mcp/blob/main/';
/** Images must be served raw, or npm would embed GitHub's HTML page instead. */
const GITHUB_RAW = 'https://raw.githubusercontent.com/shin2344234/godot-mcp/main/';

// --- 1. Addon ---------------------------------------------------------------

const src = path.join(repoRoot, 'addons', 'godot_mcp');
const dest = path.join(root, 'addon', 'godot_mcp');
if (!existsSync(path.join(src, 'plugin.cfg'))) {
  console.error(`addon source not found at ${src} (expected plugin.cfg there)`);
  process.exit(1);
}

/**
 * Files that must NOT ship inside the addon. Normally the addon folder holds only
 * .gd, .gd.uid and plugin.cfg, but a developer may have opened it in Godot or a
 * file manager, which leaves caches and OS junk behind.
 *
 * Keep: *.uid files. Godot 4.4+ uses them as stable resource IDs; scenes and scripts that
 * reference the addon by uid:// break without them.
 * Keep: *.import files, if an icon is ever added (harmless; Godot regenerates them).
 */
const EXCLUDED_NAMES = new Set(['.godot', '.DS_Store', 'Thumbs.db', 'desktop.ini', '.git', '.gitignore', '.gitattributes']);
function shouldCopy(file) {
  const name = path.basename(file);
  if (EXCLUDED_NAMES.has(name)) return false;
  if (name.startsWith('._')) return false; // macOS resource forks
  if (name.endsWith('~') || name.endsWith('.tmp') || name.endsWith('.bak')) return false; // editor backups
  return true;
}

// Remove the previous copy first so files deleted from the source don't linger in the package.
rmSync(dest, { recursive: true, force: true });
cpSync(src, dest, { recursive: true, filter: shouldCopy });
console.error(`copied addon -> ${path.relative(root, dest)}`);

// --- 2. README (with links made absolute) -----------------------------------

/**
 * True for link targets that are relative paths inside the repository (and so would be
 * broken on npmjs.com): not a URL with a scheme, not protocol-relative, not an in-page
 * #anchor, not an absolute /path.
 */
function isRepoRelative(target) {
  return target !== '' && !/^[a-z][a-z0-9+.-]*:/i.test(target) && !target.startsWith('//') && !target.startsWith('#') && !target.startsWith('/');
}

/** Rewrite one link target; `image` picks the raw URL so the image itself is served. */
function absolutize(target, image) {
  if (!isRepoRelative(target)) return target;
  const clean = target.replace(/^\.\//, '');
  return (image ? GITHUB_RAW : GITHUB_BLOB) + clean;
}

const readmeSrc = path.join(repoRoot, 'README.md');
if (!existsSync(readmeSrc)) {
  console.error(`README not found at ${readmeSrc}`);
  process.exit(1);
}
let readme = readFileSync(readmeSrc, 'utf8');
// Markdown images ![alt](target "title") and links [text](target "title"). The target is
// the first whitespace-free run inside the parentheses; an optional title follows.
readme = readme.replace(/(!?)\[([^\]]*)\]\(([^)\s]+)((?:\s+"[^"]*")?)\)/g, (_m, bang, text, target, title) => `${bang}[${text}](${absolutize(target, bang === '!')}${title})`);
// Reference-style definitions:  [label]: target
readme = readme.replace(/^(\s{0,3}\[[^\]]+\]:\s*)(\S+)/gm, (_m, head, target) => head + absolutize(target, /\.(png|jpe?g|gif|svg|webp)$/i.test(target)));
// Inline HTML: <img src="..."> and <a href="...">.
readme = readme.replace(/\b(src|href)="([^"]+)"/g, (_m, attr, target) => `${attr}="${absolutize(target, attr === 'src')}"`);
writeFileSync(path.join(root, 'README.md'), readme);
console.error('copied README.md (relative links -> GitHub URLs)');

// --- 3. LICENSE --------------------------------------------------------------

const licenseSrc = path.join(repoRoot, 'LICENSE');
if (!existsSync(licenseSrc)) {
  console.error(`LICENSE not found at ${licenseSrc}`);
  process.exit(1);
}
cpSync(licenseSrc, path.join(root, 'LICENSE'));
console.error('copied LICENSE');
