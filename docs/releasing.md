# Releasing godot-mcp

How to publish a release to **npm** (`@shin2344234/godot-mcp`) and the **official MCP
Registry** (`io.github.shin2344234/godot-mcp`). Run the steps in order: the registry checks
the npm package, so npm must come first.

Everything below was checked against the real tools on 2026-10-15 (npm 10.9, gh 2.89,
mcp-publisher 1.8.1, server.json schema `2025-12-11`). Sources are linked at the end.

## What gets released

| Thing | File | Notes |
| --- | --- | --- |
| npm package | `server/package.json` | `dist/` (compiled server), `addon/godot_mcp/` (the editor addon that `godot-mcp init` installs), `README.md`, `LICENSE`. About 165 files, ~370 kB packed. |
| MCP Registry entry | `server.json` (repo root) | Metadata only; it points at the npm package. |
| Version, shown to clients | `server/src/version.ts` | `SERVER_VERSION`, sent as `serverInfo.version` and printed by `godot-mcp version`. |
| Addon version | `addons/godot_mcp/plugin.cfg` | `godot-mcp init` compares it with the installed addon to decide whether to update it. |

These must always carry the **same version**. `scripts/check-versions.mjs` enforces it
(also run by `npm test`, through `server/test/unit/versions.test.ts`, and by `npm pack` /
`npm publish`, through the `prepack` script). It also checks that `server.json`'s `name`
equals `mcpName` in `server/package.json` and that the npm `identifier` equals the package
name, which the registry requires.

What `prepack` does (it runs automatically on `npm pack` and `npm publish`):

1. `node ../scripts/check-versions.mjs`: refuse to pack mismatched versions.
2. Delete `server/dist/` and rebuild it with `tsc` (so no stale files from deleted sources ship).
3. `node scripts/copy-addon.mjs`: copy `addons/godot_mcp` to `server/addon/godot_mcp`
   (skipping `.godot/` caches and OS junk; `.uid` files are kept), and copy the repo-root
   `README.md` (relative links rewritten to GitHub URLs, so they work on npmjs.com) and
   `LICENSE` into `server/`. npm only picks up README and LICENSE from the package folder.
   All three copies are git-ignored.

Source maps (`dist/**/*.map`) are excluded from the package by the `files` list: they point
at `src/*.ts`, which is not shipped.

## One-time setup

1. **Make the GitHub repository public** (the npm page, README links and the registry
   entry all point at it):

   ```bash
   gh repo edit shin2344234/godot-mcp --visibility public --accept-visibility-change-consequences
   gh api repos/shin2344234/godot-mcp --jq .visibility    # public
   ```

2. **npm account.** The package is scoped to `@shin2344234`, so the npm account must be
   the user `shin2344234` (or own an npm organization of that name). Turn on two-factor
   authentication on npmjs.com if it is not on already: publishing directly requires 2FA on
   the account (or a granular token with "bypass 2FA", which this guide does not use).

3. **Install `mcp-publisher`** (the official registry CLI):

   ```bash
   # macOS / Linux (pre-built binary from the registry's GitHub releases)
   curl -L "https://github.com/modelcontextprotocol/registry/releases/latest/download/mcp-publisher_$(uname -s | tr '[:upper:]' '[:lower:]')_$(uname -m | sed 's/x86_64/amd64/;s/aarch64/arm64/').tar.gz" | tar xz mcp-publisher && sudo mv mcp-publisher /usr/local/bin/
   # or: brew install mcp-publisher
   mcp-publisher --help
   ```

   On Windows (PowerShell):

   ```powershell
   $arch = if ([System.Runtime.InteropServices.RuntimeInformation]::ProcessArchitecture -eq "Arm64") { "arm64" } else { "amd64" }; Invoke-WebRequest -Uri "https://github.com/modelcontextprotocol/registry/releases/latest/download/mcp-publisher_windows_$arch.tar.gz" -OutFile "mcp-publisher.tar.gz"; tar xf mcp-publisher.tar.gz mcp-publisher.exe; rm mcp-publisher.tar.gz
   # then move mcp-publisher.exe to a folder on your PATH
   ```

## Each release

Replace `0.2.0` with the new version. Run from the repository root unless a step says
otherwise.

### 1. Bump the version everywhere

```bash
git switch main && git pull
node scripts/check-versions.mjs --set 0.2.0
```

`--set` rewrites the version in `server/package.json`, `server/package-lock.json`,
`server/src/version.ts`, `addons/godot_mcp/plugin.cfg` and `server.json` (top-level
`version` and the npm package `version`), then runs the check. Review the diff:

```bash
git diff --stat   # expect exactly those 5 files
```

Registry versions are immutable: a version can be published to the MCP Registry only once,
and its metadata cannot be changed afterwards. If `server.json` needs a fix after a
release, release a new patch version of everything.

### 2. Test

```bash
cd server
npm ci
npm run typecheck
npm test               # unit + e2e; e2e tests that need Godot are skipped without GODOT_PATH
# with Godot installed, run the full e2e suite too:
GODOT_PATH=/path/to/godot npm run test:e2e
cd ..
```

### 3. Inspect the package

```bash
cd server
npm pack --dry-run     # runs prepack; lists every file that would ship
```

Check: `dist/`, `addon/godot_mcp/` (`.gd` + `.gd.uid` + `plugin.cfg`), `README.md`,
`LICENSE`, `package.json`, and nothing else (no tests, no `.map` files, no `src/`, no
`.tgz`). Optional end-to-end check of the real tarball:

```bash
npm pack --pack-destination /tmp/godot-mcp-pack
mkdir /tmp/godot-mcp-try && cd /tmp/godot-mcp-try && npm init -y && npm i /tmp/godot-mcp-pack/shin2344234-godot-mcp-0.2.0.tgz
npx godot-mcp version                                    # 0.2.0
cp -r <repo>/examples/sample_project ./proj && npx godot-mcp init --dry-run --project ./proj
cd <repo>/server
```

### 4. Commit and tag

```bash
git add -A && git commit -m "Release 0.2.0"
git tag v0.2.0
git push origin main v0.2.0
```

### 5. Publish to npm

```bash
npm login              # opens the browser; the session lasts 2 hours
npm whoami             # shin2344234
cd server
npm publish --dry-run  # last look; nothing is uploaded
npm publish            # asks for the 2FA code / browser confirmation
cd ..
```

`publishConfig.access` is `public` in `server/package.json`, so the scoped package is
published publicly without `--access public` (scoped packages default to private/restricted
otherwise). `mcpName` in `server/package.json` is what the MCP Registry reads to verify that
this npm package belongs to `io.github.shin2344234/godot-mcp`.

Verify:

```bash
npm view @shin2344234/godot-mcp version mcpName       # 0.2.0, io.github.shin2344234/godot-mcp
npx -y @shin2344234/godot-mcp@0.2.0 version           # 0.2.0 (fresh download from npm)
```

### 6. Publish to the MCP Registry

```bash
mcp-publisher login github     # device flow: open https://github.com/login/device, enter the code,
                               # sign in as shin2344234 (the namespace io.github.shin2344234/ requires it)
mcp-publisher validate         # validates ./server.json against the registry (no login needed, publishes nothing)
mcp-publisher publish          # publishes ./server.json
```

Expected output of `publish`:

```text
Publishing to https://registry.modelcontextprotocol.io...
✓ Successfully published
✓ Server io.github.shin2344234/godot-mcp version 0.2.0
```

Verify:

```bash
curl "https://registry.modelcontextprotocol.io/v0.1/servers?search=io.github.shin2344234/godot-mcp"
```

The response lists the new version with `"isLatest": true` under
`_meta["io.modelcontextprotocol.registry/official"]`.

### 7. GitHub release (optional)

```bash
gh release create v0.2.0 --title "v0.2.0" --generate-notes
```

## Troubleshooting

| Problem | Fix |
| --- | --- |
| `check-versions: MISMATCH` during `npm pack` / `npm publish` | Run `node scripts/check-versions.mjs --set <version>` and commit. |
| npm `E402 Payment Required` / "You must sign up for private packages" | The `publishConfig.access: public` line is missing; scoped packages are restricted by default. |
| npm `E403` / `E404` on publish | Not logged in as the owner of the `@shin2344234` scope (`npm whoami`), or the 2-hour session expired (`npm login` again). |
| Registry: "Registry validation failed for package" | npm does not have this version yet, or its `package.json` lacks `mcpName` / has a different one. Check with `npm view @shin2344234/godot-mcp@<version> mcpName`. |
| Registry: "Invalid or expired Registry JWT token" | `mcp-publisher login github` again. |
| Registry: "You do not have permission to publish this server" | Logged in to GitHub as someone other than `shin2344234`. |
| Registry: "deprecated schema detected" | A newer server.json schema is current. Update `$schema` in `server.json` following the [schema changelog](https://github.com/modelcontextprotocol/registry/blob/main/docs/reference/server-json/CHANGELOG.md). |
| Registry rejects a version as already published | Versions are immutable; bump to a new version. |

## Notes

- The MCP Registry is in preview; its docs warn that breaking changes or data resets may
  happen before general availability.
- The shipped server makes no network requests: it talks to the client over stdio, to the
  Godot editor and the game over 127.0.0.1, and runs the local Godot binary. (Verified by
  running the installed tarball inside a network namespace with no network.)
- Publishing from CI with npm trusted publishing (OIDC) and `mcp-publisher login
  github-oidc` is possible later; this guide covers publishing by hand.

## Sources

- MCP Registry quickstart (mcpName, `mcp-publisher` install/login/publish, verification):
  https://modelcontextprotocol.io/registry/quickstart
- npm ownership verification via `mcpName`: https://modelcontextprotocol.io/registry/package-types
- Version rules (unique, immutable, no ranges): https://modelcontextprotocol.io/registry/versioning
- server.json schema (current: 2025-12-11): https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json
  and its changelog: https://github.com/modelcontextprotocol/registry/blob/main/docs/reference/server-json/CHANGELOG.md
- npm `files`, always-included README/LICENSE, `publishConfig`, `repository.directory`:
  https://docs.npmjs.com/cli/v11/configuring-npm/package-json
- npm lifecycle order (`prepack` runs on `npm pack` and `npm publish`):
  https://docs.npmjs.com/cli/v11/using-npm/scripts
- Publishing scoped public packages: https://docs.npmjs.com/creating-and-publishing-scoped-public-packages
- npm 2-hour login sessions and enforced 2FA for publishing:
  https://github.blog/changelog/2025-12-09-npm-classic-tokens-revoked-session-based-auth-and-cli-token-management-now-available/
