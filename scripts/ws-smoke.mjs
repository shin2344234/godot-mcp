#!/usr/bin/env node
// End-to-end smoke test for the editor bridge (docs/bridge-protocol.md section 1).
//
// Usage: node scripts/ws-smoke.mjs <project_dir>
//
// Expects a Godot editor already running on <project_dir> with the Godot MCP plugin
// enabled. Reads .godot/godot_mcp/session.json, connects with Node 22's built-in
// WebSocket, and checks: auth failures (4001 / 4002), hello/welcome, editor.status,
// node.add, node.set, scene.tree, scene.save (file on disk), logs.read, error responses.
// Exits 0 when every check passes, 1 otherwise.

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const projectDir = process.argv[2];
if (!projectDir) {
  console.error("usage: node scripts/ws-smoke.mjs <project_dir>");
  process.exit(2);
}
if (typeof WebSocket === "undefined") {
  console.error("ws-smoke: global WebSocket is missing; Node 22+ is required.");
  process.exit(2);
}

const session = JSON.parse(readFileSync(join(projectDir, ".godot/godot_mcp/session.json"), "utf8"));
const url = `ws://127.0.0.1:${session.port}`;
// The version the running addon should report: its plugin.cfg, which check-versions.mjs
// keeps equal to core/constants.gd PLUGIN_VERSION. Read, not hardcoded, so a release bump
// doesn't break this smoke test.
const pluginVersion = /^\s*version\s*=\s*"([^"]+)"/m.exec(readFileSync(join(projectDir, "addons/godot_mcp/plugin.cfg"), "utf8"))?.[1];
let failures = 0;

function check(cond, label, detail) {
  if (cond) {
    console.log(`  ok   ${label}`);
  } else {
    failures++;
    console.log(`  FAIL ${label}${detail !== undefined ? ": " + JSON.stringify(detail) : ""}`);
  }
}

// Opens a socket and resolves once it is open. Collects incoming frames and close info.
function connect() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const state = { ws, frames: [], waiters: [], closed: null };
    ws.addEventListener("message", (ev) => {
      const msg = JSON.parse(ev.data);
      const waiter = state.waiters.shift();
      if (waiter) waiter(msg);
      else state.frames.push(msg);
    });
    ws.addEventListener("close", (ev) => {
      state.closed = { code: ev.code, reason: ev.reason };
      for (const w of state.waiters.splice(0)) w(null);
    });
    ws.addEventListener("open", () => resolve(state));
    ws.addEventListener("error", (e) => reject(new Error(`websocket error: ${e.message ?? e}`)));
  });
}

function nextFrame(state, timeoutMs = 10000) {
  if (state.frames.length) return Promise.resolve(state.frames.shift());
  if (state.closed) return Promise.resolve(null);
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("timed out waiting for a frame")), timeoutMs);
    state.waiters.push((m) => {
      clearTimeout(t);
      resolve(m);
    });
  });
}

function waitClose(state, timeoutMs = 10000) {
  return new Promise((resolve) => {
    const start = Date.now();
    const tick = () => {
      if (state.closed || Date.now() - start > timeoutMs) resolve(state.closed);
      else setTimeout(tick, 50);
    };
    tick();
  });
}

let nextId = 1;
async function call(state, method, params = {}) {
  const id = nextId++;
  state.ws.send(JSON.stringify({ type: "request", id, method, params }));
  const resp = await nextFrame(state);
  if (!resp || resp.type !== "response" || resp.id !== id) {
    throw new Error(`unexpected reply to ${method}: ${JSON.stringify(resp)}`);
  }
  return resp;
}

async function main() {
  console.log(`ws-smoke: connecting to ${url} (pid ${session.pid})`);

  // 1. Wrong token -> 4001.
  {
    const s = await connect();
    s.ws.send(JSON.stringify({ type: "hello", protocol: 1, token: "0".repeat(64), client: "ws-smoke" }));
    const closed = await waitClose(s);
    check(closed && closed.code === 4001, "wrong token is closed with 4001", closed);
  }
  // 2. First frame not a hello -> 4001.
  {
    const s = await connect();
    s.ws.send(JSON.stringify({ type: "request", id: 1, method: "ping", params: {} }));
    const closed = await waitClose(s);
    check(closed && closed.code === 4001, "request before hello is closed with 4001", closed);
  }
  // 3. No hello at all -> 4002 after ~5 s.
  const silent = await connect();

  // 4. Proper session.
  const s = await connect();
  s.ws.send(JSON.stringify({ type: "hello", protocol: 1, token: session.token, client: "godot-mcp-server", client_version: pluginVersion }));
  const welcome = await nextFrame(s);
  check(welcome && welcome.type === "welcome" && welcome.protocol === 1, "hello -> welcome", welcome);
  check(welcome && welcome.godot_version === session.godot_version, "welcome.godot_version matches session file", welcome);
  check(welcome && welcome.project_name === "Godot MCP Sample", "welcome.project_name", welcome);

  // A second, concurrent authenticated client.
  const s2 = await connect();
  s2.ws.send(JSON.stringify({ type: "hello", protocol: 1, token: session.token, client: "second" }));
  const welcome2 = await nextFrame(s2);
  check(welcome2 && welcome2.type === "welcome", "second client authenticates independently", welcome2);
  const ping2 = await call(s2, "ping");
  check(ping2.result && ping2.result.pong === true, "second client ping", ping2);
  s2.ws.close();

  const status = await call(s, "editor.status");
  check(status.result && status.result.plugin_version === pluginVersion, `editor.status reports plugin ${pluginVersion}`, status);
  check(status.result && typeof status.result.is_playing === "boolean", "editor.status.is_playing is boolean", status);

  const unknown = await call(s, "node.ad", {});
  check(unknown.error && unknown.error.code === "UNKNOWN_METHOD" && unknown.error.message.includes("node.add"), "unknown method suggests node.add", unknown);

  const add = await call(s, "node.add", { scene: "res://main.tscn", parent: "Enemies", type: "Sprite2D", name: "SmokeSprite", properties: { texture: "res://icon.svg" } });
  check(add.result && add.result.path === "Enemies/SmokeSprite" && add.result.type === "Sprite2D", "node.add (opens main.tscn)", add);
  check(add.result && add.result.saved === false, "node.add reports unsaved editor change", add);

  const set = await call(s, "node.set", { path: "Enemies/SmokeSprite", properties: { position: [12, 34], modulate: "#00ff00" } });
  check(set.result && set.result.changed && set.result.changed.position === "Vector2(12, 34)", "node.set position", set);
  check(set.result && set.result.changed && set.result.changed.modulate === "Color(0, 1, 0, 1)", "node.set modulate from #hex", set);

  const badProp = await call(s, "node.set", { path: "Enemies/SmokeSprite", properties: { postion: [1, 2] } });
  check(badProp.error && badProp.error.code === "NOT_FOUND" && badProp.error.message.includes("position"), "unknown property suggests 'position'", badProp);

  const badType = await call(s, "node.add", { parent: ".", type: "Sprit2D" });
  check(badType.error && badType.error.code === "BAD_PARAMS" && badType.error.message.includes("Sprite2D"), "unknown type suggests Sprite2D", badType);

  const tree = await call(s, "scene.tree", { root: "Enemies" });
  const names = tree.result ? tree.result.root.children.map((c) => c.name) : [];
  check(names.includes("SmokeSprite"), "scene.tree shows the new node", tree);

  const status2 = await call(s, "editor.status");
  check(status2.result && status2.result.edited_scene === "res://main.tscn", "edited_scene is main.tscn", status2.result);
  check(status2.result && status2.result.unsaved_scenes.includes("res://main.tscn"), "main.tscn is marked unsaved (undo action committed)", status2.result);

  const save = await call(s, "scene.save");
  check(save.result && save.result.saved === "res://main.tscn", "scene.save", save);
  const onDisk = readFileSync(join(projectDir, "main.tscn"), "utf8");
  check(onDisk.includes('name="SmokeSprite"') && onDisk.includes("Vector2(12, 34)"), "saved main.tscn contains the node and position");

  const status3 = await call(s, "editor.status");
  check(status3.result && !status3.result.unsaved_scenes.includes("res://main.tscn"), "main.tscn no longer unsaved after save", status3.result);

  const logs = await call(s, "logs.read", { since: 0, limit: 500 });
  check(logs.result && Array.isArray(logs.result.entries) && logs.result.entries.length > 0, "logs.read returns entries", logs.result && logs.result.entries.length);
  check(logs.result && logs.result.entries.some((e) => String(e.message).includes("Godot MCP: bridge listening")), "logs.read contains the plugin's startup line");
  const logs2 = await call(s, "logs.read", { since: logs.result.next });
  check(logs2.result && logs2.result.entries.every((e) => e.seq >= logs.result.next), "logs.read 'since' pagination", logs2.result);

  const created = await call(s, "scene.create", { path: "res://levels/smoke_level.tscn", root_type: "Node3D" });
  check(created.result && created.result.path === "res://levels/smoke_level.tscn" && created.result.opened === true, "scene.create opens new scene", created);
  check(existsSync(join(projectDir, "levels/smoke_level.tscn")), "scene.create wrote the file");

  const open = await call(s, "scene.open", { path: "res://main.tscn" });
  check(open.result && open.result.edited_scene === "res://main.tscn", "scene.open", open);

  const refresh = await call(s, "filesystem.refresh", { paths: ["res://player.gd"] });
  check(refresh.result && refresh.result.refreshed === 1, "filesystem.refresh", refresh);

  const validate = await call(s, "script.validate", { source: "extends Node\nfunc _ready():\n\tprint(undefined_thing)\n" });
  check(validate.result && validate.result.valid === false && validate.result.errors[0].line === 3, "script.validate in editor", validate);

  // The silent client should have been closed with 4002 by now (5 s handshake timeout).
  const silentClosed = await waitClose(silent, 8000);
  check(silentClosed && silentClosed.code === 4002, "client without hello is closed with 4002", silentClosed);

  s.ws.close();
  console.log(failures === 0 ? "ws-smoke: all checks passed" : `ws-smoke: ${failures} check(s) failed`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("ws-smoke: error:", e);
  process.exit(1);
});
