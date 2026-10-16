# Methods: test runs and editor UI helpers

Two MCP tools from `server/src/ops/testing.ts`:

- `godot_test_run` (group `test`) runs GUT or GdUnit4 tests in a **separate headless Godot
  process** started by the server (`server/src/testing/`). It is not a bridge method and works
  with or without the editor open.
- `godot_editor_ui` (group `editor`) is the bridge method `editor.ui` **(E)**, implemented by
  `addons/godot_mcp/ops/editor_ui_ops.gd` (kind `project`, `editor_only`). Without the editor
  the tool answers `EDITOR_NOT_CONNECTED`; the headless runner answers `UNSUPPORTED`.

Conventions are those of section 5 of [bridge-protocol.md](../bridge-protocol.md); node paths
are relative to the scene root (section 4).

## test.run

params: `{ "path"?: "res://test" | "res://test/test_player.gd", "test"?: "jump", "framework"?: "auto" | "gut" | "gdunit4", "timeout_s"?: 600 }`

- **Framework.** Detected from `addons/gut/gut_cmdln.gd` (GUT) and
  `addons/gdUnit4/bin/GdUnitCmdTool.gd` (GdUnit4); folder names match case-insensitively and the
  on-disk spelling is used. With both installed, `auto` picks the one whose test scripts exist in
  the selection, otherwise `BAD_PARAMS` asks for `framework`. With neither, `NOT_FOUND` names
  the supported addons, the versions for Godot 4.7 (GUT 9.7.x, GdUnit4 6.2.x or newer) and how
  to install them (AssetLib, or copy `addons/<name>` from a release and enable the plugin).
  Nothing is downloaded or installed by the server.
- **Selection.** No `path`: all tests. A folder or a `.gd` file (res://, relative, inside the
  project). `test`: run only test functions whose name contains this text (GUT's
  `-gunit_test_name` semantics, applied to GdUnit4 too). The server reads test scripts
  (`func test_*` in files that `extends GutTest` / `GdUnitTestSuite`, outside `addons/`,
  hidden folders and folders with `.gdignore`) to check `path` and `test` up front:
  a missing path or an unknown test name → `NOT_FOUND`, the latter with "did you mean".
- **"All tests".** GUT: `res://.gutconfig.json` decides when it exists; otherwise `res://test`
  and `res://tests` (with subfolders) plus GUT scripts found elsewhere. GdUnit4: the same folders
  plus suites found elsewhere (GdUnit4 loads every script in the folders it scans).
- **First run.** Both frameworks need their `class_name`s in Godot's class cache (GUT refuses to
  run otherwise). When `.godot/global_script_class_cache.cfg` lacks `GutTest` /
  `GdUnitTestSuite`, the server runs `godot --headless --import` first (up to 300 s, reported as
  progress). The live editor's session file is restored if that import touched it.
- **Progress and cancellation.** One progress notification per started test
  (`"test 3: test/unit/test_math.gd > test_fails"`; the total is unknown up front). Cancelling
  the request or hitting `timeout_s` (10..3600) kills the process (SIGTERM, SIGKILL after 5 s);
  the result is `CANCELLED` / `TIMEOUT` with `data` holding `tests_started`, `script_errors` and
  the output tail.
- **Reports.** JUnit XML is written under `res://.godot/godot_mcp/test_runs/<id>/` and deleted
  after parsing, so `test.run` is not read-only (it also runs project code).

Command lines (verified against the frameworks' sources and run on Godot 4.7.2):

```
GUT 9.7.1:      godot --headless --path P -s res://addons/gut/gut_cmdln.gd
                  [-gdir=<dir> -ginclude_subdirs -gtest=] | [-gtest=<file> -gdir=]
                  [-gunit_test_name=<text>] -gexit -gdisable_colors -gjunit_xml_file=<res://...xml>
GdUnit4 6.2.2:  godot --headless --path P -s -d --remote-debug tcp://127.0.0.1:0
                  res://addons/gdUnit4/bin/GdUnitCmdTool.gd --ignoreHeadlessMode -c
                  -a <dir|suite> ... [-i <suite>:<test> ...] -rd <res://dir> -rc 1
```

The empty `-gdir=` / `-gtest=` override lists from `.gutconfig.json`. GdUnit4 has no "run one
test" option: a `test` run adds only suites with a matching function and `-i`gnores their other
tests; `-c` turns off its default fail-fast; `-rd` must be a res:// path (6.2.2 rewrites
`/abs/path` to `res://abs/path`); `--ignoreHeadlessMode` is required under `--headless`; the
remote-debug flags are what upstream `runtest.sh` passes to keep Godot's stdin debugger from
looping on script errors. GdUnit4 exit codes: 0 ok, 100 failures, 101 orphan nodes only,
103 headless refused, 104 Godot too old, 105 compile errors during discovery.

Result (failing tests are a normal result, not a tool error):

```json
{
  "framework": "gut", "version": "9.7.1", "path": "res://test", "test": "jump",
  "exit_code": 1, "wall_s": 3.4,
  "status": "failed",
  "totals": { "tests": 7, "passed": 3, "failed": 3, "errors": 0, "skipped": 1, "duration_s": 0.004 },
  "failures": [
    { "test": "test_inner_bad", "class": "TestInner", "file": "res://test/unit/test_math.gd", "line": 17, "message": "inner broken" },
    { "test": "test_runtime_error", "file": "res://test/other_test.gd", "line": 8, "error": true, "message": "Godot Runtime Error !\n..." }
  ],
  "failures_not_shown": 0,
  "skipped": [ { "test": "test_pending_one", "file": "res://test/unit/test_math.gd", "reason": "later" } ],
  "script_errors": [ { "file": "res://broken/test_broken.gd", "line": 4, "message": "Expected closing \")\" after call arguments." } ],
  "note": "..."
}
```

- `status`: `passed`, `failed` (a failure, error or compile error) or `no_tests`.
- `failures` (at most 30; `failures_not_shown` counts the rest): `class` = GUT inner test class;
  `error: true` = GdUnit4 `<error>` (engine error / abort) rather than an assertion failure;
  `message` trimmed to 600 characters, without the location lines both frameworks append.
  `line`: from the report (GUT `at line N`, GdUnit4 `message="FAILED: res://x.gd:7"`), or for
  GUT engine errors (`at line -1`) from Godot's own `at: test_x (res://x.gd:5)` output.
- `skipped`: GUT `pending()` / GdUnit4 skipped tests (at most 10), `reason` = last line.
- `script_errors`: compile errors Godot printed (`SCRIPT ERROR: Parse Error` + `at:
  GDScript::reload (res://...:N)`). GUT skips such scripts with only a warning; GdUnit4 aborts
  (exit 105, then the tool returns `GODOT_ERROR` listing them).
- Totals are counted from the test cases (GUT's report has no skipped/error totals; GdUnit4's
  has no error total and a zero time); `duration_s` sums suite times.
- No report and no compile errors → `GODOT_ERROR` with the exit code and output tail.

## editor.ui (E)

params: `{ "action": "get_selection" | "select" | "open_script" | "save_all" | "toast", ... }`

### get_selection

`{ "action": "get_selection", "scene"? }` → `{ "scene": "res://main.tscn", "selected": ["Player", "Timer"], "count": 2 }`
(`EditorInterface.get_selection().get_selected_nodes()`, as scene-relative paths; `scene` opens
or switches to that scene first.)

### select

`{ "action": "select", "paths": ["Player", "Player/Sprite2D"], "scene"? }` → same shape as
`get_selection`, read back after the change. All paths are resolved first (tolerant forms of
section 4: leading `/root/`, the root's own name); a wrong one → `NOT_FOUND` listing the
children of the deepest existing node plus "Did you mean" over every node path in the scene
(`data.close_matches`), and the selection is left unchanged. `[]` clears the selection. Uses
`EditorSelection.clear()` + `add_node()`; with exactly one node, `EditorInterface.edit_node()`
also shows it in the Inspector.

### open_script

`{ "action": "open_script", "script": "res://player.gd", "line"?: 1, "column"?: 1 }` →
`{ "script", "line", "column", "current_script": "res://player.gd", "caret"?: { "line", "column" } }`

`EditorInterface.edit_script(script, line, column)`: line and column are **1-based** (the engine
passes `line - 1` / `column - 1` to `ScriptEditor.edit`). Then the main screen switches to
Script and the result reads back the current script and the caret of its `CodeEdit`. A missing
file → `NOT_FOUND` with similar script paths; not a Script → `BAD_PARAMS`; a line past the end
→ `BAD_PARAMS` with the line count. When Editor Settings > Text Editor > External is on, the
script opens in the external editor and the result says `"external_editor": true`.
`TextEdit.set_caret_column` clamps to the line's length, so a column past the end of the line
(any column on an empty line) puts the caret at the line's end; the result then has a `note`
("Line 40 has 0 characters, so the caret was placed at its end (column 1).").

### save_all

`{ "action": "save_all" }` →
`{ "saved_scenes": ["res://main.tscn"], "saved_scripts": ["res://player.gd"], "nothing_to_save": false, "skipped"?: [...], "failed"?: [...], "scripts_still_unsaved"?: [...], "edited_scene": "res://main.tscn" }`

Saves every scene in `EditorInterface.get_unsaved_scenes()` one by one (switch to its tab,
`EditorInterface.save_scene()`), returns to the tab that was active, then
`ScriptEditor.save_all_scripts()` and compares `ScriptEditor.get_unsaved_files()` before and
after. `EditorInterface.save_all_scenes()` is deliberately not used: in 4.7.2 it stops the
running game and opens a Save As dialog for never-saved scenes. Never-saved scenes are listed in
`skipped` (use `scene.save_as`).

### toast

`{ "action": "toast", "message": "Build finished", "severity"?: "info" | "warning" | "error" }` →
`{ "shown": true, "message", "severity", "truncated"? }`

`EditorInterface.get_editor_toaster().push_toast(message, severity)` (EditorToaster exists in
4.7.2; severities 0/1/2). Messages are capped at 500 characters. A headless editor accepts the
call but has no window to show it in.
