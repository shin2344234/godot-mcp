# Publishing the addon on the Godot Asset Store

This page has the listing text for the editor addon (`addons/godot_mcp`) and the steps to
submit it to the Godot Asset Store. Everything about the store below was checked against
the sources linked in [Sources](#sources) on 2026-10-15. The store is still marked
**beta**, so re-check the guidelines page before each submission.

## Read first: minimum Godot version

**As the code stands, the addon only loads on Godot 4.7 or later.** On 4.5.1 and 4.6.3 the
plugin fails to compile:

```
SCRIPT ERROR: Parse Error: Static function "get_unsaved_scenes()" not found in base "GDScriptNativeClass".
          at: GDScript::reload (res://addons/godot_mcp/editor/editor_backend.gd:167)
```

`EditorInterface.get_unsaved_scenes()` was added in 4.7, and `editor_backend.gd` calls it
directly. Other files already call it through `call(&"get_unsaved_scenes")`. The store
rejects assets that don't work in the Godot version given on the listing, so:

- **Either** enter **4.7** as the minimum Godot version (the listing text below assumes this),
- **or** first change that one line so it's only called when it exists, the way
  `ops/editor_ui_ops.gd` does. With that change, all 46 addon scripts compiled and the
  bridge started on 4.5.1 and 4.6.3 (the plugin loaded; the tools were not tested on those
  versions). Then the minimum can be 4.5, which matches the top-level README.

## What the store is (verified)

- The Godot Asset Store is at <https://store.godotengine.org/>. It is run by the Godot
  Foundation and replaces the old Asset Library. Assets were not moved over automatically;
  authors re-upload them. The 2025 beta was at `store-beta.godotengine.org`; the site now
  points to `store.godotengine.org`.
- Godot **4.7 and later** have the store built in: an **Asset Store** main-screen tab in the
  editor (templates appear in the Project Manager instead). Older versions only have the
  legacy AssetLib tab (the help page says this for Godot 3; the store arrived in 4.7), so
  their users download the zip from the website and install it by hand.
- You log in with a Godot shared account (the same one used by the forum, chat and the
  development fund). Anyone can create one for free.
- Free assets only for now. Paid assets are on the roadmap; you can add a donation link.

## How the upload works (verified)

- **You upload a file per version.** The store does not pull from a git repository or a
  tag. On the asset's **Versions** tab you upload the files, give the version a name, write a
  changelog, and set the minimum Godot version (and a maximum if needed). Each version can be
  up to 1 GB.
- **Layout.** Plugins must use the `addons/asset_name/` structure. The installer does not
  create that folder for you, so it has to be in the zip.
- **License.** The license on the listing must match the repository, and a license file
  (`LICENSE` or `LICENSE.md`, with the license text and a copyright line with year and
  holder) must come with the downloaded asset. The docs also recommend a copy of the
  license and readme inside the plugin folder. Our zip has `addons/godot_mcp/LICENSE` and
  `addons/godot_mcp/README.md`.
- **Clean zip.** Leave out `.gitignore`, `.gitattributes`, `.github/`, `Thumbs.db`,
  `.DS_Store` and `__MACOSX`. Zips that contain only instructions are rejected, as are
  standalone compiled executables.
- **How the editor installs it.** The editor downloads the zip, lists every file that will
  be installed (files that can't be installed are shown in red), and on **Install** unzips
  into the project and imports. Archives downloaded from the website can be installed the
  same way with the **Import** button. Godot's installer strips a single shared top-level
  folder, but never one named `addons/` (`editor/asset_library/editor_asset_installer.cpp`),
  so our zip, whose only top-level folder is `addons/`, installs to `res://addons/godot_mcp/`.
- **Network ports and external programs.** The guidelines and terms have no rule about
  addons that open network ports or need an external program. The terms ban "viruses,
  malicious code, junk, spam and unsolicited content", and the store may remove content at
  its discretion. Other MCP addons that need an outside server are already listed (for
  example "Funplay MCP for Godot", which needs Node.js, and "Godot AI", which needs `uv`), so
  this kind of addon is accepted. Say clearly in the description that the server is needed.
- **AI disclosure.** If AI was used to make the asset, the **AI usage disclosure** field is
  mandatory. This project was written with Claude Code, so fill it in (suggested text below).

### Not confirmed

- **Image sizes.** The only published rule is that the thumbnail must be **16:9**. No pixel
  size is given for the thumbnail, screenshots or the featured image. We use 1280x720.
- **Accepted upload formats.** The docs say "upload the actual asset files" without naming
  a format; the guidelines talk about "the ZIP", and existing listings serve zips. We upload a
  zip.
- **Categories.** There is no category field in the documented form; the asset type is
  **Addon** or **Full Project**, and the rest is done with tags. The live form may differ.

## Build the upload

```bash
node scripts/build-addon-zip.mjs
# -> dist-addon/godot_mcp-<version>.zip   (version read from addons/godot_mcp/plugin.cfg)
```

The zip contains only `addons/godot_mcp/` (scripts, `.uid` files, `plugin.cfg`, `LICENSE`,
`README.md`). For a byte-identical rebuild set `SOURCE_DATE_EPOCH`. To check it:

```bash
unzip -l dist-addon/godot_mcp-0.1.0.zip | head
```

Before each upload, also run the test suites (`scripts/test-gdscript.sh`, and
`npx tsc --noEmit && npx vitest run test/unit` in `server/`), and make sure the npm package
of the same version is published, because the addon README tells people to run
`npx -y @shin2344234/godot-mcp init`.

The thumbnail is `docs/asset-store/thumbnail.png` (1280x720). Its source is
`docs/asset-store/thumbnail.svg`; re-render with `scripts/render-store-thumbnail.sh`.

## Listing text

Paste these into the store forms.

| Field | Value |
|---|---|
| Publisher Name | `shin2344234` (decide: or your real name / a studio name) |
| Publisher URL Slug | `shin2344234` |
| Asset Name | `Godot MCP` (see [Decisions](#decisions-for-seth)) |
| Asset URL | `godot-mcp` |
| Asset type | **Addon** |
| License | **MIT** |
| Link to source code | <https://github.com/shin2344234/godot-mcp> |
| Tags | `AI`, `MCP`, `LLM`, `Claude`, `Editor`, `Automation` |
| Version name | `0.1.0` |
| Minimum Godot version | **4.7** (4.5 only after the fix above) |
| Maximum Godot version | leave empty |

Tag rules: a tag can't be the asset's name, and don't add both the singular and the plural of
a tag.

### Asset Summary

> Lets AI agents such as Claude Code, Cursor and Codex inspect and edit your project through the open Godot editor. Needs the free godot-mcp server (Node.js).

### Detailed description

> Godot MCP is the editor half of godot-mcp, an MCP (Model Context Protocol) server for Godot 4. It lets AI coding agents such as Claude Code, Cursor, Codex, VS Code Copilot and Gemini CLI work on your project through the editor you have open.
>
> **This addon needs the godot-mcp server.** The server is a separate, free Node.js program (Node.js 22 or later) that your agent talks to. The addon is the bridge the server connects to; on its own it does nothing useful.
>
> **Setup**
>
> 1. Install this addon.
> 2. In a terminal, go to your project folder and run `npx -y @shin2344234/godot-mcp init`. It shows what it will change and asks first. It enables the plugin and registers the server with your agents.
> 3. Open the project in Godot and start a new agent session.
>
> **What your agent can do**
>
> - Inspect and edit scenes, nodes, signals and resources. Every scene edit goes through the editor's undo history, so you can undo it with Ctrl+Z.
> - Author animations, AnimationTrees, tile maps, navigation, audio buses and visual shaders.
> - Change project settings, input actions, autoloads, import options and export presets.
> - Write scripts with GDScript language-server diagnostics, symbols and renames.
> - Run the game and work on it live: inspect nodes, send input, take screenshots and profile.
> - Debug with breakpoints and stepping, and run GUT or GdUnit4 tests.
>
> When the editor is closed, the server makes the same edits with headless Godot.
>
> **Security**
>
> - The bridge listens on 127.0.0.1 only, so other machines can't reach it.
> - Every connection needs a fresh random token, stored in `.godot/godot_mcp/session.json` each time the editor starts.
> - The small runtime the server adds to games it runs only works while a debugger is attached, so it does nothing in exported games.
> - Running code inside the game is off unless you start the server with `--allow-eval`.
> - The addon never connects to the internet.
>
> Requires Godot 4.7 or later. Documentation and source code: https://github.com/shin2344234/godot-mcp

(If the minimum becomes 4.5, change the last line to "Godot 4.5 or later (4.7 recommended)".)

### AI usage disclosure (suggested)

> The code and documentation were written with the help of an AI coding assistant (Anthropic's Claude, through Claude Code), with human direction and review, and checked by automated tests against real Godot. The addon contains no AI-generated art or other assets. Its purpose is to connect AI coding agents to the Godot editor.

Edit this so it's accurate for how you worked.

### Version changelog (0.1.0)

> First release. Editor bridge for the godot-mcp server: scene, node, signal, resource, animation, tile map, navigation, audio, visual shader, project and export tools; live game inspection, input, screenshots and profiling; debugging and test running.

### Version "additional information"

> Needs the godot-mcp server 0.1.0: run `npx -y @shin2344234/godot-mcp init` in your project folder.

## Screenshots to capture

The guidelines reject thumbnails or screenshots that show things the asset can't do, or
made-up interfaces, so use real captures. 16:9 at 1920x1080 or 1280x720 is a safe choice
(no size is published). Put the files somewhere outside the addon folder (they must not end
up in the zip).

1. **Editor with the bridge running.** Project Settings > Plugins with **Godot MCP**
   enabled, and the Output panel showing `Godot MCP: bridge listening on 127.0.0.1:6520`.
2. **An agent editing a scene.** An agent (for example Claude Code in a terminal) next to the
   editor, after asking it to add a node; the new node is visible in the Scene dock and viewport.
3. **Undo history.** The History dock listing the agent's edits, showing they can be undone.
4. **Live game.** A game started by the agent, with the agent's reply showing the live node
   tree or a screenshot it took.
5. **Setup.** Terminal output of `npx -y @shin2344234/godot-mcp init` showing its plan.

Optional: a short screen recording on YouTube for the video field.

## Submission steps

1. **Account.** Go to <https://store.godotengine.org/login> and log in with your Godot
   account. If you don't have one yet, create one; it's free.
2. **Create the asset.** Open <https://store.godotengine.org/asset/new/>. Fill in Publisher,
   Publisher Name, Publisher URL Slug, Asset Name and Asset URL from the table above, accept
   the terms of service, and click **Continue**.
3. **Settings tab.** Enter the Asset Summary, the Detailed description, the tags, asset type
   **Addon**, license **MIT**, the source code link, and the AI usage disclosure.
4. **Media tab.** Upload `docs/asset-store/thumbnail.png` as the thumbnail and the
   screenshots. A featured image and a YouTube link are optional.
5. **Versions tab.** Build the zip (`node scripts/build-addon-zip.mjs`), then add a version:
   name `0.1.0`, the changelog, minimum Godot version (see the top of this page), no maximum,
   the additional information, and upload `dist-addon/godot_mcp-0.1.0.zip`.
6. **Pricing tab.** Leave it free. Add a donation link if you want one.
7. **Test before submitting.** Download the zip back from the listing page and install it in
   a new, empty Godot 4.7 project with the editor's Asset Store tab > **Import**. Check that
   the files land in `res://addons/godot_mcp/`, enable the plugin, and look for
   `bridge listening on 127.0.0.1` in the Output panel.
8. **Submit.** On the **Overview** tab click **Submit for review**. You'll be told the result;
   a rejection comes with reasons, and you can fix them and submit again.

### Later versions

Bump `version` in `addons/godot_mcp/plugin.cfg` and `PLUGIN_VERSION` in
`addons/godot_mcp/core/constants.gd` together (the build script refuses to run if they
differ), keep the npm package version in step (`init` only copies the addon when the
versions differ), rebuild the zip, and add a new version on the **Versions** tab.

## Decisions for Seth

- **Minimum Godot version:** 4.7 as-is, or fix the one line and list 4.5.
- **Asset name:** "Godot MCP" is generic, and similar names exist (for example "Funplay MCP
  for Godot" and "Godot AI" on the store, "Godot MCP Pro" and "Godot-MCP" on the legacy
  Asset Library). A more distinctive name may avoid confusion.
- **Publisher name:** `shin2344234` (matches `plugin.cfg` and the npm scope) or a real name.
- **Legacy Asset Library:** only needed for Godot 4.6 and older, and only works if the
  minimum version becomes 4.5. It installs a GitHub archive of a commit; to make that archive
  contain only `addons/`, enable the commented `export-ignore` block in `.gitattributes`
  (this also strips the server from GitHub's source downloads).
- **AI disclosure wording.**

## Sources

- Submitting to the Asset Store (requirements, recommendations, forms, tabs):
  <https://docs.godotengine.org/en/stable/community/asset_store/submitting_to_asset_store.html>
  (source: <https://github.com/godotengine/godot-docs/blob/master/community/asset_store/submitting_to_asset_store.rst>)
- About the Asset Store:
  <https://docs.godotengine.org/en/stable/community/asset_store/what_is_asset_store.html>
- Using the Asset Store in the engine (download, install, Import button):
  <https://docs.godotengine.org/en/4.7/community/asset_store/using_in_editor.html>
- Store guidelines (addons/asset_name, 16:9 thumbnail, tags, clean zip, rejections):
  <https://store.godotengine.org/guidelines/>
- Store help (1 GB per version, AI disclosure, pre-1.0 addons, Godot 3):
  <https://store.godotengine.org/help/>
- Store terms: <https://store.godotengine.org/terms/>
- Store home and upload page: <https://store.godotengine.org/>, <https://store.godotengine.org/asset/new/>
- Announcement (Godot account, 4.7 integration, Asset Library deprecation):
  <https://godotengine.org/article/introducing-the-godot-asset-store/>
- Editor asset installer (top-level folder handling):
  <https://github.com/godotengine/godot/blob/master/editor/asset_library/editor_asset_installer.cpp>
- `plugin.cfg` keys: <https://docs.godotengine.org/en/stable/tutorials/plugins/editor/making_plugins.html>
- Existing MCP listings: <https://store.godotengine.org/asset/funplay/funplay-godot-mcp>,
  <https://store.godotengine.org/asset/dlight/godot-ai/>
