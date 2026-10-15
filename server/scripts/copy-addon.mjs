// Bundles the Godot addon (../addons/godot_mcp) into the npm package as
// addon/godot_mcp, so `godot-mcp init` can install it into projects.
import { cpSync, rmSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = path.resolve(root, '..', 'addons', 'godot_mcp');
const dest = path.resolve(root, 'addon', 'godot_mcp');
if (!existsSync(src)) {
  console.error(`addon source not found at ${src}`);
  process.exit(1);
}
rmSync(dest, { recursive: true, force: true });
cpSync(src, dest, { recursive: true });
console.error(`copied addon -> ${path.relative(root, dest)}`);
