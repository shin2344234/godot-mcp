#!/usr/bin/env node
// Exercises the headless runner (docs/bridge-protocol.md section 2) for every (E/H)
// method, on a *copy* of the sample project (the copy is modified).
//
// Usage: node scripts/headless-smoke.mjs <godot_binary> <project_copy_dir>
//
// Each call writes a request JSON file, runs
//   godot --headless --path <project> --script res://addons/godot_mcp/headless/runner.gd -- <request.json>
// and parses the single "@@GODOT_MCP_RESULT@@" line. Exits 0 when all checks pass.

import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const [godot, project] = process.argv.slice(2);
if (!godot || !project) {
  console.error("usage: node scripts/headless-smoke.mjs <godot_binary> <project_copy_dir>");
  process.exit(2);
}

const MARKER = "@@GODOT_MCP_RESULT@@";
const reqDir = mkdtempSync(join(tmpdir(), "godot-mcp-req-"));
let failures = 0;
let reqCount = 0;

function check(cond, label, detail) {
  if (cond) {
    console.log(`  ok   ${label}`);
  } else {
    failures++;
    console.log(`  FAIL ${label}${detail !== undefined ? ": " + JSON.stringify(detail).slice(0, 1500) : ""}`);
  }
}

// Runs one request through the runner; returns {response, exitCode, stdout, stderr}.
function run(method, params = {}) {
  const file = join(reqDir, `req${++reqCount}.json`);
  writeFileSync(file, JSON.stringify({ method, params }));
  const p = spawnSync(godot, ["--headless", "--path", project, "--script", "res://addons/godot_mcp/headless/runner.gd", "--", file], {
    encoding: "utf8",
    timeout: 60000,
  });
  const lines = (p.stdout || "").split("\n").filter((l) => l.startsWith(MARKER));
  if (lines.length !== 1) {
    failures++;
    console.log(`  FAIL ${method}: expected exactly one result line, got ${lines.length}\n--- stdout ---\n${p.stdout}\n--- stderr ---\n${p.stderr}`);
    return { response: {}, exitCode: p.status };
  }
  const response = JSON.parse(lines[0].slice(MARKER.length));
  const expectedExit = response.error ? 1 : 0;
  if (p.status !== expectedExit) {
    failures++;
    console.log(`  FAIL ${method}: exit code ${p.status}, expected ${expectedExit}`);
  }
  // The addon must not make Godot print warnings/errors (e.g. inconsistent owners, leaks)
  // during normal operation. script.validate is exempt: compile errors are its output.
  if (method !== "script.validate") {
    const noise = `${p.stdout}\n${p.stderr}`.split("\n").filter((l) => /^(WARNING|ERROR|SCRIPT ERROR):/.test(l));
    if (noise.length) {
      failures++;
      console.log(`  FAIL ${method} ${JSON.stringify(params).slice(0, 200)}: Godot printed warnings/errors:\n    ${noise.join("\n    ")}`);
    }
  }
  return { response, exitCode: p.status, stdout: p.stdout, stderr: p.stderr };
}

const ok = (method, params) => run(method, params).response.result;
const err = (method, params) => run(method, params).response.error || {};
const S = "res://main.tscn";

function findNode(node, name) {
  if (node.name === name) return node;
  for (const c of node.children || []) {
    const f = findNode(c, name);
    if (f) return f;
  }
  return null;
}

// ---- ping / dispatch errors -------------------------------------------------------------
let r = ok("ping");
check(r && r.pong === true && r.backend === "headless", "ping", r);
let e = err("run.play", {});
check(e.code === "UNSUPPORTED" && e.message.includes("editor"), "editor-only method -> UNSUPPORTED", e);
e = err("logs.read", {});
check(e.code === "UNSUPPORTED", "logs.read headless -> UNSUPPORTED", e);
e = err("node.ad", {});
check(e.code === "UNKNOWN_METHOD" && e.message.includes("node.add"), "unknown method suggests node.add", e);
e = err("scene.tree", {});
check(e.code === "BAD_PARAMS" && e.message.includes("scene"), "missing scene param -> BAD_PARAMS", e);
e = err("scene.tree", { scene: "res://nope.tscn" });
check(e.code === "NOT_FOUND" && e.message.includes("res://main.tscn"), "missing scene lists existing scenes", e);

// ---- scene.tree --------------------------------------------------------------------------
r = ok("scene.tree", { scene: S });
check(r && r.scene === S && r.root.name === "Main" && r.root.path === "." && r.root.script === "res://main.gd", "scene.tree root", r && r.root);
const player = r && findNode(r.root, "Player");
check(player && player.instance === "res://player.tscn" && player.children.length === 0, "instanced Player shown with instance, internals hidden", player);
const timer = r && findNode(r.root, "Timer");
check(timer && timer.groups.includes("timers"), "groups reported", timer);
check(r && r.node_count === 6 && r.truncated === false, "node_count", r && r.node_count);
r = ok("scene.tree", { scene: S, depth: 0 });
check(r && r.root.children.length === 0 && r.root.child_count === 5 && r.root.truncated === true, "depth 0 keeps child_count", r && r.root);
r = ok("scene.tree", { scene: S, max_nodes: 2 });
check(r && r.truncated === true && r.node_count === 2, "max_nodes truncates", r);
r = ok("scene.tree", { scene: S, root: "Label", include_properties: true });
check(r && r.root.properties && r.root.properties.text === "Score: 0", "include_properties shows non-default values", r && r.root);
r = ok("scene.tree", { scene: "res://player.tscn" });
check(r && r.root.children.map((c) => c.name).join(",") === "Sprite2D,CollisionShape2D", "player.tscn tree", r && r.root);

// ---- node.get ----------------------------------------------------------------------------
r = ok("node.get", { scene: S, path: "Timer" });
check(r && r.type === "Timer" && r.properties.autostart === true, "node.get Timer properties", r && r.properties && r.properties.autostart);
check(r && r.signals_connected.some((s) => s.signal === "timeout" && s.method === "_on_timer_timeout" && s.target === "."), "node.get signals_connected", r && r.signals_connected);
r = ok("node.get", { scene: S, path: "Player/CollisionShape2D", properties: ["shape", "position"] });
check(r && r.properties.shape && r.properties.shape.class === "RectangleShape2D" && r.properties.shape.embedded === true, "embedded resource encoding", r && r.properties);
check(r && r.properties.shape && r.properties.shape.properties && r.properties.shape.properties.size === "Vector2(28, 28)", "embedded resource properties", r && r.properties);
r = ok("node.get", { scene: S, path: "/root/Main/Player/Sprite2D", properties: ["texture"] });
check(r && r.path === "Player/Sprite2D" && r.properties.texture.resource === "res://icon.svg", "/root/Main prefix stripped; external resource encoding", r);
e = err("node.get", { scene: S, path: "Player/Gun" });
check(e.code === "NOT_FOUND" && e.data && e.data.children.includes("Sprite2D"), "missing node lists children", e);
e = err("node.get", { scene: S, path: "Timer", properties: ["wait_tim"] });
check(e.code === "NOT_FOUND" && e.message.includes("wait_time"), "unknown property suggests wait_time", e);

// ---- node.add ----------------------------------------------------------------------------
r = ok("node.add", { scene: S, parent: "Enemies", type: "Sprite2D", name: "Marker", properties: { position: [10, 20], modulate: "#ff8800", texture: "res://icon.svg" } });
check(r && r.path === "Enemies/Marker" && r.type === "Sprite2D" && r.saved === true, "node.add Sprite2D", r);
r = ok("node.add", { scene: S, parent: "Enemies", type: "Enemy", name: "Bat", properties: { kind: "BAT", damage: 7, target: "Player", position: { x: 50, y: 60 } } });
check(r && r.path === "Enemies/Bat" && r.type === "Area2D", "node.add global script class Enemy", r);
r = ok("node.add", { scene: S, parent: "Enemies/Bat", type: "CollisionShape2D", properties: { shape: { new: "CircleShape2D", properties: { radius: 12 } } } });
check(r && r.path === "Enemies/Bat/CollisionShape2D", "node.add with {new: CircleShape2D}", r);
r = ok("node.add", { scene: S, parent: ".", instance: "res://player.tscn", properties: { position: "Vector2(300, 40)" }, index: 1 });
check(r && r.name === "Player2" && r.renamed_from === "Player" && r.instance === "res://player.tscn", "node.add instance auto-renames to Player2", r);
r = ok("node.get", { scene: S, path: "Enemies/Bat", properties: ["kind", "damage", "target", "position"] });
check(r && r.properties.kind === 1 && r.properties.damage === 7 && r.properties.position === "Vector2(50, 60)", "enum by name + int + vector dict decoded", r && r.properties);
check(r && r.properties.target && r.properties.target.node === "Player", "Node-typed export stored as node reference", r && r.properties);
r = ok("scene.tree", { scene: S });
check(r && r.root.children[1].name === "Player2", "index places new node", r && r.root.children.map((c) => c.name));
e = err("node.add", { scene: S, parent: ".", type: "Sprit2D" });
check(e.code === "BAD_PARAMS" && e.data && e.data.suggestions.includes("Sprite2D"), "unknown type suggests Sprite2D", e);
e = err("node.add", { scene: S, parent: ".", type: "Texture2D" });
check(e.code === "BAD_PARAMS" && e.message.includes("not a Node"), "non-Node type rejected", e);
e = err("node.add", { scene: S, parent: ".", type: "Node2D", instance: "res://player.tscn" });
check(e.code === "BAD_PARAMS" && e.message.includes("exactly one"), "type + instance rejected", e);
e = err("node.add", { scene: S, parent: "Player/Sprite2D", type: "Node2D" });
check(e.code === "BAD_PARAMS" && e.message.includes("res://player.tscn"), "adding under instance internals explains sub-scene", e);
e = err("node.add", { scene: S, parent: ".", type: "Node2D", properties: { position: [1, 2, 3] } });
check(e.code === "BAD_PARAMS" && e.message.includes("Vector2") && e.message.includes("[10, 20]"), "bad vector value shows expected type and example", e);
e = err("node.add", { scene: S, parent: ".", type: "Node2D", name: "Bad/Name" });
check(e.code === "BAD_PARAMS" && e.message.includes("Invalid node name"), "invalid node name rejected", e);

// ---- node.set ----------------------------------------------------------------------------
r = ok("node.set", { scene: S, path: "Label", properties: { text: "Hello", modulate: "red", position: "Vector2(5, 6)", horizontal_alignment: "Center" } });
check(r && r.changed.text === "Hello" && r.changed.modulate === "Color(1, 0, 0, 1)" && r.changed.position === "Vector2(5, 6)" && r.changed.horizontal_alignment === 1, "node.set mixed values", r);
r = ok("node.set", { scene: S, path: "Player", properties: { position: [1, 2], "metadata/note": "hi", speed: 321 } });
check(r && r.changed.position === "Vector2(1, 2)" && r.changed["metadata/note"] === "hi" && r.changed.speed === 321, "node.set on instance root incl. script var and metadata", r);
e = err("node.set", { scene: S, path: "Label", properties: { txt: "x" } });
check(e.code === "NOT_FOUND" && e.message.includes("text"), "node.set unknown property suggests text", e);
e = err("node.set", { scene: S, path: "Player/Sprite2D", properties: { visible: false } });
check(e.code === "BAD_PARAMS" && e.data && e.data.instance_scene === "res://player.tscn", "node.set on instance internals rejected", e);
e = err("node.set", { scene: S, path: "Timer", properties: { wait_time: "soon" } });
check(e.code === "BAD_PARAMS" && e.message.includes("float"), "bad float rejected", e);
e = err("node.set", { scene: S, path: "Label", properties: { horizontal_alignment: "Middle" } });
check(e.code === "BAD_PARAMS" && e.message.includes("Center"), "bad enum name lists valid names", e);

// ---- node.rename / reparent / duplicate / remove ----------------------------------------
e = err("node.rename", { scene: S, path: "Enemies/Marker", name: "Bat" });
check(e.code === "CONFLICT" && e.data && e.data.suggestion === "Bat2", "rename conflict suggests Bat2", e);
r = ok("node.rename", { scene: S, path: "Enemies/Marker", name: "Flag" });
check(r && r.path === "Enemies/Flag", "node.rename", r);
r = ok("node.reparent", { scene: S, path: "Enemies/Flag", new_parent: "Player" });
check(r && r.path === "Player/Flag", "node.reparent", r);
r = ok("node.get", { scene: S, path: "Player/Flag", properties: ["position"] });
check(r && r.properties.position === "Vector2(9, 18)", "reparent keeps global position (10,20) under Player at (1,2)", r && r.properties);
r = ok("node.reparent", { scene: S, path: "Player/Flag", new_parent: ".", keep_global_transform: false, index: 0 });
check(r && r.path === "Flag", "reparent to root at index 0", r);
r = ok("node.get", { scene: S, path: "Flag", properties: ["position"] });
check(r && r.properties.position === "Vector2(9, 18)", "keep_global_transform false keeps local position", r && r.properties);
e = err("node.reparent", { scene: S, path: "Enemies", new_parent: "Enemies/Bat" });
check(e.code === "BAD_PARAMS" && e.message.includes("descendant"), "reparent under own descendant rejected", e);
r = ok("node.duplicate", { scene: S, path: "Enemies/Bat" });
check(r && r.path === "Enemies/Bat2", "node.duplicate auto-names Bat2", r);
r = ok("node.duplicate", { scene: S, path: "Player2", name: "Player3" });
check(r && r.path === "Player3", "node.duplicate instance with name", r);
r = ok("scene.tree", { scene: S, root: "Enemies/Bat2" });
check(r && r.root.children.length === 1 && r.root.children[0].name === "CollisionShape2D", "duplicate copies root-owned children", r && r.root);
r = ok("node.remove", { scene: S, path: "Camera2D" });
check(r && r.removed === "Camera2D", "node.remove", r);
e = err("node.remove", { scene: S, path: "." });
check(e.code === "BAD_PARAMS" && e.message.includes("root"), "removing root rejected", e);

// ---- script.attach -----------------------------------------------------------------------
r = ok("script.attach", { scene: S, path: "Label", script: null });
check(r && r.script === null, "script.attach null on node without script", r);
r = ok("script.attach", { scene: S, path: "Enemies/Bat2", script: "res://enemy.gd" });
check(r && r.script === "res://enemy.gd", "script.attach", r);
r = ok("script.attach", { scene: S, path: ".", script: null });
check(r && r.script === null, "script.attach null detaches root script", r);
e = err("script.attach", { scene: S, path: "Enemies", script: "res://player.gd" });
check(e.code === "BAD_PARAMS" && e.message.includes("CharacterBody2D"), "script base type mismatch explained", e);
e = err("script.attach", { scene: S, path: "Enemies", script: "res://missing.gd" });
check(e.code === "NOT_FOUND", "missing script -> NOT_FOUND", e);

// ---- saved file sanity --------------------------------------------------------------------
const tscn = readFileSync(join(project, "main.tscn"), "utf8");
check(!/name="Sprite2D" type="Sprite2D" parent="Player"/.test(tscn), "instanced Player internals not inlined into main.tscn");
check(tscn.includes('instance=ExtResource') && tscn.includes('name="Player2"') && tscn.includes('name="Player3"'), "instances saved as instance=ExtResource");
check(!tscn.includes('script = ExtResource("1_main")'), "root script detached in file");
r = ok("scene.tree", { scene: S });
check(r && r.node_count === 12, "edited main.tscn reloads cleanly", r && r.node_count);

// ---- scene.create / scene.save ----------------------------------------------------------
r = ok("scene.create", { path: "res://levels/level1.tscn", root_type: "Node3D" });
check(r && r.path === "res://levels/level1.tscn" && r.root_name === "Level1", "scene.create", r);
check(existsSync(join(project, "levels/level1.tscn")), "scene.create wrote file");
e = err("scene.create", { path: "res://levels/level1.tscn", root_type: "Node3D" });
check(e.code === "CONFLICT", "scene.create existing -> CONFLICT", e);
e = err("scene.create", { path: "res://levels/x.tscn", root_type: "Nod3D" });
check(e.code === "BAD_PARAMS" && e.message.includes("Node3D"), "scene.create bad type suggests Node3D", e);
r = ok("node.add", { scene: "levels/level1.tscn", parent: ".", type: "MeshInstance3D", properties: { mesh: { new: "BoxMesh" }, position: [0, 1, 0] } });
check(r && r.path === "MeshInstance3D", "node.add into created 3D scene (path without res://)", r);
r = ok("node.add", { scene: "res://levels/level1.tscn", parent: ".", type: "Node3D", name: "Pivot", properties: { position: [10, 0, 0] } });
r = ok("node.reparent", { scene: "res://levels/level1.tscn", path: "MeshInstance3D", new_parent: "Pivot" });
r = ok("node.get", { scene: "res://levels/level1.tscn", path: "Pivot/MeshInstance3D", properties: ["position"] });
check(r && r.properties.position === "Vector3(-10, 1, 0)", "3D reparent keeps global transform", r && r.properties);
r = ok("scene.save", {});
check(r && r.saved === null, "scene.save headless is a no-op", r);
r = ok("scene.save", { path: S });
check(r && r.saved === S, "scene.save with path", r);

// ---- script.validate -----------------------------------------------------------------------
r = ok("script.validate", { path: "res://player.gd" });
check(r && r.valid === true && r.errors.length === 0, "script.validate valid file", r);
r = ok("script.validate", { source: "extends Node\nfunc _ready():\n\tprint(foo)\n\tvar x: int = \"a\"\n" });
check(r && r.valid === false && r.errors.some((x) => x.line === 3 && x.message.includes("foo")) && r.errors.some((x) => x.line === 4), "script.validate reports analyzer errors with lines", r);
r = ok("script.validate", { source: "extends Node\nfunc f(:\n" });
check(r && r.valid === false && r.errors[0].line === 2, "script.validate syntax error", r);
r = ok("script.validate", { path: "res://enemy.gd", source: readFileSync(join(project, "enemy.gd"), "utf8") + "\nfunc extra() -> int:\n\treturn damage\n" });
check(r && r.valid === true, "validating source at its own path keeps class_name valid", r);
e = err("script.validate", { path: "res://nope.gd" });
check(e.code === "NOT_FOUND", "script.validate missing file", e);
e = err("script.validate", {});
check(e.code === "BAD_PARAMS", "script.validate needs path or source", e);

console.log(failures === 0 ? `headless-smoke: all checks passed (${reqCount} runner invocations)` : `headless-smoke: ${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
