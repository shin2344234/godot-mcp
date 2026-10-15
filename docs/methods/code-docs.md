# Code intelligence (LSP) and offline docs

Groups `code` and `docs`. Unlike most areas these tools add **no bridge-protocol methods**:
the server talks to Godot's GDScript language server directly (TCP, JSON-RPC) and builds
the docs index itself from the Godot binary. This file documents the tools, the small
plugin additions they rely on, and the Godot behaviour they work around (all verified
against Godot 4.7.2).

Server code: `server/src/lsp/` (client, framing, URIs, lifecycle), `server/src/docs/`
(index builder, BBCode -> Markdown, search, project-class docs), `server/src/ops/code.ts`,
`server/src/ops/docs.ts`.

## 1. Which language server

The language server exists only inside a Godot **editor** process.

1. **Editor connected through the bridge** -> use its language server on
   `127.0.0.1:<lsp_port>`. `lsp_port` comes from the welcome payload / session.json (see
   section 4), else `GODOT_MCP_LSP_PORT`, else 6005. If `initialize` reveals that the port
   belongs to a different project (Godot pushes `gdscript_client/changeWorkspace`, which
   happens when two editors are open and the second could not bind the port), the tools
   fail with `CONFLICT` and explain how to fix it.
2. **No editor** -> a private headless editor is started lazily on the first `code.*` call:

   ```
   godot --headless --editor --path <project realpath> --lsp-port <free port> \
         -- --godot-mcp-lsp-only --godot-mcp-lsp-port=<port>
   ```

   Readiness = TCP connect succeeds (5-7 s; up to 60 s, 180 s for a never-imported
   project). Stopped after `GODOT_MCP_LSP_IDLE_MS` (default 10 min) without code calls,
   when the user's editor connects, and on server exit (SIGKILL from a `process.on('exit')`
   hook). Restarted on the next call if it died.
   In LSP-only mode the plugin writes `lsp_session.json` instead of `session.json`, so
   the main bridge never routes scene edits into the invisible editor. The server keeps a
   bridge connection to it (pid-checked) and uses `filesystem.refresh` on it when scripts
   change on disk (a new `class_name` is registered only by an EditorFileSystem update;
   added/removed files need a full `scan()` because `update_file()` ignores files in
   folders it doesn't know yet). The plugin quits that editor when no bridge client has
   been connected for 15 s (120 s before the first connection), so even a SIGKILLed
   server leaves no orphan. Without the addon the LSP still works; a changed `class_name`
   script then restarts the private editor.

Settings (env): `GODOT_MCP_LSP_PORT`, `GODOT_MCP_LSP_TIMEOUT_MS` (per request, default
15000), `GODOT_MCP_LSP_IDLE_MS`.

## 2. Language server facts the client relies on

* Framing: send **only** `Content-Length: N\r\n\r\n`. Godot parses the length with
  `header.substr(16).to_int()`, which collects every digit of the header block, so a
  `Content-Type: ...; charset=utf-8` header corrupts it. Messages are capped at 4 MiB
  (Godot's `LSP_MAX_BUFFER_SIZE`).
* `initialize` needs `rootUri` and `rootPath` equal to the editor's project path. No
  `shutdown`/`exit` (they return -32601): close the socket. No `workspace/*` methods.
* URIs: `file:///` + each path segment `uri_encode`d with uppercase hex (Godot's
  `uri_file_decode` ignores lowercase `%3a`), Windows drive as `file:///C%3A/...`.
  `res://` URIs are rejected by Godot.
* Diagnostics are pushed only for documents the client opened (didOpen/didChange) and
  only to that client: `code.diagnostics` does didOpen(on-disk text) -> wait for
  `textDocument/publishDiagnostics` (10 s) -> didClose. Warnings are severity 2 with the
  warning code in the message, e.g. `(UNUSED_VARIABLE): ...`.
* Server-to-client requests (`workspace/applyEdit`) are answered (`applied: false`);
  notifications `gdscript/capabilities`, `window/showMessage`, `gdscript_client/changeWorkspace`
  are handled.
* `definition` returns `[]` for engine symbols; `declaration` would push
  `gdscript/show_native_symbol` but can open the help page in a user's editor
  (`show_native_symbols_in_editor`), so `code.lookup` uses `hover` for native docs.
* `references` and `rename` text-search every `.gd` file and resolve each hit, so matches
  inside comments/strings can be returned. `code.lookup` marks them (`in_comment`,
  `in_string`); `code.rename` drops them unless `include_comments: true`
  (`server/src/lsp/gdscriptText.ts` masks comments and strings, including triple-quoted
  and prefixed literals).
* Completion returns everything in scope (2000+ items on a blank line); we filter by the
  identifier prefix before the cursor and cap the list.

## 3. Tools

All `code.*` paths are res:// (project-relative; absolute paths and `..` escapes are
rejected), lines/columns are 1-based.

### code.diagnostics (read)

`{ paths: string[] }` — .gd files or folders (folders recurse, skip `addons/` unless
asked, cap 50 files). Result: `{ source, checked, errors, warnings, files: [{ path,
diagnostics: [{ line, column, severity, message }] }], clean: [path], unchecked?, note?,
truncated? }`. `source` is `lsp (connected editor)`, `lsp (private headless editor)`, or
`script.validate (...)` when no language server could be reached (fallback through the
existing `script.validate` method, first 20 files, errors only, no columns).

### code.symbols (read)

`{ path = "res://", query? }`. A file without `query` -> `{ path, class, doc?, symbols:
["4: @export var speed: float = 200.0", "10: func _physics_process(delta: float) -> void",
...] }` (inner classes indented). With `query` (file or folder) -> documentSymbol outlines
of up to 500 scripts (cached by mtime) filtered by name substring: `{ query, searched,
count, matches: [{ name, kind, line, decl, container?, path }] }` (max 50).

### code.lookup (read)

`{ path, line, column? | symbol?, kind = hover|definition|references|signature|completion|highlight,
limit = 30 }`. `symbol` locates the identifier on the line (nearest to `column` if both;
for `completion` it may be a prefix, for `signature` the cursor goes after the following
`(`). Results: hover `{ markdown }`; definition `{ locations: [{ path, line, column, text }] }`
or `{ native: true, signature, docs, hint }`; references `{ count, locations, note? }`;
highlight `{ positions }`; signature `{ signatures: [{ label, doc? }], active_parameter }`;
completion `{ prefix?, total, matching, items: [{ label, kind }] }`.

### code.rename (write, not destructive, not idempotent)

`{ path, line, column? | symbol?, new_name, dry_run = false, include_comments = false }`.
`prepareRename` first (engine symbols -> BAD_PARAMS), then `rename`; every edit is checked
against the current file text (must equal the old name) and comment/string hits are
skipped. Applied with the same sandbox as the files tools (res:// only, never `.godot/`),
then `filesystem.refresh` on the connected editor and `didSave` (+ refresh) on the private
one. Result: `{ applied | dry_run, old_name, new_name, files: [{ path, edits, lines,
preview? }], skipped?: [{ path, line, reason, text }], editor_refreshed? }`.

### docs.search (read)

`{ query, kind?: class|method|property|signal|constant|enum|annotation|utility, limit = 20 }`
-> `{ godot_version, count, hits: [{ class, member?, kind, brief }] }`. Ranking: exact
name > prefix > substring > all words in name/brief; project classes up, editor-only
classes down. `"Class.fragment"` searches that class and its ancestors.

### docs.class (read)

`{ name, members = false, inherited = false, max_chars = 4000 (12000 with members/inherited) }`. `name` is a class
(engine, builtin, `@GlobalScope`, `@GDScript`, project `class_name` or autoload) or
`"Class.member"` (inherited members resolve to their declaring class: `declared_in`).
Class result: `{ name, kind, path?, inherits: [...chain], brief, description,
member_counts | members: { methods: ["rotate(radians: float) -> void -- Applies a
rotation..."], ... }, inherited?: { Node: "add_child(), ..." } }`. Member result:
`{ class, member, kind, signature, description, values? }`. Descriptions are BBCode
converted to Markdown. `max_chars` caps the whole result text: the description gets at
most a third of it when member lists follow, then members, then inherited names
(`members_truncated` / `inherited_truncated` say when something was cut). `set_x` /
`get_x` / `is_x` methods of a listed property `x` are folded into it (`members_note`).
Unknown names get did-you-mean hints.

## 4. Plugin additions (plugin 0.1.0)

* session.json (and lsp_session.json) gain `"lsp_port"` and `"lsp_only"`; the `welcome`
  payload gains the same two fields. `lsp_port` = the `--godot-mcp-lsp-port=` user
  argument if given (Godot consumes `--lsp-port` and doesn't expose it to scripts), else
  the `network/language_server/remote_port` editor setting, else 6005.
* User argument `--godot-mcp-lsp-only`: write `res://.godot/godot_mcp/lsp_session.json`
  instead of session.json, and quit the editor when no bridge client has been connected
  for 15 s (120 s before the first). `OS.is_process_running()` can't watch the parent
  instead: on Unix it only works for child processes.
* `SessionFile.write(port, token, file = SESSION_FILE, extra = {})` and
  `SessionFile.remove(file = SESSION_FILE)` take the file to use.

## 5. Docs index

Built on first use per Godot version: `godot --headless --dump-extension-api-with-docs`
in a temp dir (~3 s), converted to a compact index (`server/src/docs/model.ts`: classes
with BBCode briefs/descriptions and members with GDScript-style signatures; enum values
as constants tagged with their enum), gzip-cached (~1.3 MB) at
`<cache>/godot-mcp/docs/<version>/index-v1.json.gz` (`$XDG_CACHE_HOME` or `~/.cache`,
`~/Library/Caches`, `%LOCALAPPDATA%`; override `GODOT_MCP_CACHE_DIR`). Nothing is
downloaded at runtime.

* `@GlobalScope` is synthesised from the dump's utility functions, global enums/constants
  and singletons.
* `@GDScript` is not in the dump, and `--doctool` writes empty descriptions, so it is
  bundled: `server/src/docs/gdscriptBuiltin.generated.ts`, generated at build time by
  `server/scripts/gen-gdscript-docs.mjs` from `modules/gdscript/doc_classes/@GDScript.xml`
  at tag 4.7.2-stable. That XML is part of the MIT-licensed engine repository (the
  godot-docs README: the class reference is MIT, unlike the CC-BY-3.0 manual); the
  generated file carries the copyright and MIT notice. Re-run the script for a new engine
  version (`node scripts/gen-gdscript-docs.mjs [path/to/@GDScript.xml] [tag]`).
* Project classes (`class_name` scripts and `.gd` autoloads) are parsed from their `##`
  doc comments in TypeScript (no Godot process; cached by mtime), and inherit into the
  engine classes for `inherited`/`Class.member` lookups.
