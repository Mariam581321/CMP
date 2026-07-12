#!/usr/bin/env node
// Persistent Lean REPL behind a tiny local HTTP API. Loads Mathlib once (~1-2 min,
// ~6 GB resident), then each check evaluates against that immutable env in seconds.
// Requests are serialized through the REPL; a watchdog kills and respawns it on
// hang/crash. Results are memoized by code hash.
//
//   GET  /health           -> {ready}
//   POST /check {code, timeoutMs?} -> {ok, pretty, messages, sorries, error?}
//
// Env: CMP_LEAN_ENV, CMP_REPL_BIN, CMP_LEAN_PORT (default 8787)

import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { LEAN_PORT } from "./common.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const LEAN_ENV = process.env.CMP_LEAN_ENV ?? join(ROOT, "lean-env");
const REPL_BIN = process.env.CMP_REPL_BIN ?? join(ROOT, "vendor/repl/.lake/build/bin/repl");
const PORT = parseInt(LEAN_PORT);
const DEFAULT_TIMEOUT_MS = 240_000;
const IMPORT_TIMEOUT_MS = 420_000;
const MAX_HEARTBEATS = 400_000; // 2x lean default; bounds runaway tactic searches
const MEMO_MAX = 2000;

let repl = null;
let ready = false;
let pending = null; // {resolve, reject} for the in-flight REPL command
const memo = new Map();
let queue = Promise.resolve();

const log = (...a) => console.error(new Date().toISOString(), ...a);

// Extract complete top-level JSON objects from a buffer (brace-depth scan,
// string-aware — the REPL pretty-prints multi-line JSON). Returns [json, rest].
function extractJson(buf) {
  const start = buf.indexOf("{");
  if (start < 0) return null;
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < buf.length; i++) {
    const ch = buf[i];
    if (esc) { esc = false; continue; }
    if (ch === "\\") { esc = inStr; continue; }
    if (ch === '"') inStr = !inStr;
    if (inStr) continue;
    if (ch === "{") depth++;
    if (ch === "}" && --depth === 0) {
      return [JSON.parse(buf.slice(start, i + 1)), buf.slice(i + 1)];
    }
  }
  return null;
}

function sendToRepl(obj, timeoutMs) {
  return new Promise((res, rej) => {
    const t = setTimeout(() => {
      pending = null;
      rej(new Error(`REPL timed out after ${Math.round(timeoutMs / 1000)}s`));
      restartRepl("watchdog timeout");
    }, timeoutMs);
    pending = {
      resolve: (json) => {
        clearTimeout(t);
        pending = null;
        res(json);
      },
      reject: (err) => {
        clearTimeout(t);
        pending = null;
        rej(err);
      },
    };
    repl.stdin.write(JSON.stringify(obj) + "\n\n");
  });
}

async function startRepl() {
  ready = false;
  // proc identity guard: after a restart, a half-dead old REPL can still emit
  // output/close events; those must never reach the current onResponse resolver
  // (seen in practice: a stale check response consumed as the import response).
  const proc = spawn("lake", ["env", REPL_BIN], { cwd: LEAN_ENV, env: process.env, stdio: ["pipe", "pipe", "pipe"] });
  repl = proc;
  let buf = "";
  proc.stdout.on("data", (d) => {
    if (repl !== proc) return;
    buf += d;
    let hit;
    while ((hit = extractJson(buf)) !== null) {
      buf = hit[1];
      pending?.resolve(hit[0]);
    }
  });
  proc.stderr.on("data", (d) => log("repl stderr:", String(d).trim().slice(0, 300)));
  proc.on("close", (code) => {
    if (repl !== proc) return;
    // fail the in-flight command immediately (e.g. stack-overflow abort) instead of
    // letting it stall the queue until the watchdog fires
    pending?.reject(new Error(`REPL crashed while checking (exit ${code})`));
    if (ready) restartRepl(`repl exited (code ${code})`);
  });
  log("importing Mathlib...");
  const t0 = Date.now();
  const resp = await sendToRepl({ cmd: "import Mathlib" }, IMPORT_TIMEOUT_MS);
  if (resp.env !== 0) throw new Error(`unexpected import response: ${JSON.stringify(resp)}`);
  ready = true;
  log(`ready in ${Math.round((Date.now() - t0) / 1000)}s`);
}

let restarting = false;
async function restartRepl(why) {
  if (restarting) return;
  restarting = true;
  ready = false;
  log(`restarting REPL: ${why}`);
  try { repl?.kill("SIGKILL"); } catch {}
  try {
    await startRepl();
  } catch (e) {
    log("restart failed, retrying in 10s:", e.message);
    setTimeout(() => { restarting = false; restartRepl("retry"); }, 10_000);
    return;
  }
  restarting = false;
}

// Replace import lines (Mathlib is already in the env); the first one becomes the
// heartbeat cap so line numbers in errors stay aligned with the agent's file.
function prepare(code) {
  const lines = code.split("\n");
  let capPlaced = false;
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*import\s/.test(lines[i])) {
      lines[i] = capPlaced ? "" : `set_option maxHeartbeats ${MAX_HEARTBEATS}`;
      capPlaced = true;
    }
  }
  let shifted = 0;
  if (!capPlaced) {
    lines.unshift(`set_option maxHeartbeats ${MAX_HEARTBEATS}`);
    shifted = 1;
  }
  return { text: lines.join("\n"), shifted };
}

function render(resp, shifted) {
  const messages = (resp.messages ?? []).map((m) => ({
    severity: m.severity,
    line: (m.pos?.line ?? 0) - shifted,
    column: m.pos?.column ?? 0,
    text: m.data,
  }));
  const sorries = (resp.sorries ?? []).map((s) => ({ line: (s.pos?.line ?? 0) - shifted, goal: s.goal }));
  const errors = messages.filter((m) => m.severity === "error");
  const parts = [];
  for (const m of messages) parts.push(`${m.severity}: problem.lean:${m.line}:${m.column}: ${m.text}`);
  for (const s of sorries) parts.push(`sorry at line ${s.line}, goal:\n  ${s.goal}`);
  const ok = errors.length === 0;
  let pretty = parts.join("\n\n") || "compiled successfully: no errors, no warnings";
  if (ok && parts.length) pretty = `compiled with output:\n${pretty}`;
  if (!ok) pretty = `compilation FAILED:\n${pretty}`;
  if (pretty.length > 8000) pretty = pretty.slice(0, 8000) + "\n... (truncated)";
  return { ok, pretty, messages, sorries };
}

async function handleCheck(body) {
  const { text, shifted } = prepare(body.code);
  const key = createHash("sha256").update(text).digest("hex");
  if (memo.has(key)) return { ...memo.get(key), cached: true };
  while (!ready) await new Promise((r) => setTimeout(r, 2000));
  try {
    const resp = await sendToRepl({ cmd: text, env: 0 }, body.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    const result = render(resp, shifted);
    if (memo.size >= MEMO_MAX) memo.delete(memo.keys().next().value); // bounded, oldest-first
    memo.set(key, result);
    return result;
  } catch (e) {
    return { ok: false, error: e.message, pretty: `lean check failed: ${e.message} (transient - try again)`, messages: [], sorries: [] };
  }
}

const server = createServer((req, res) => {
  if (req.method === "GET" && req.url === "/health") {
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify({ ready }));
  }
  if (req.method === "POST" && req.url === "/check") {
    let data = "";
    req.on("data", (d) => (data += d));
    req.on("end", () => {
      const body = JSON.parse(data);
      queue = queue.then(async () => {
        const result = await handleCheck(body);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(result));
      });
    });
    return;
  }
  res.writeHead(404).end();
});

process.on("exit", () => { try { repl?.kill("SIGKILL"); } catch {} });
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => process.exit(0));

server.listen(PORT, "127.0.0.1", () => log(`lean server on 127.0.0.1:${PORT}`));
startRepl().catch((e) => { log("fatal:", e.message); process.exit(1); });
