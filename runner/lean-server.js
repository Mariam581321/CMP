#!/usr/bin/env node
// Persistent Lean REPL pool behind a tiny local HTTP API. Loads Mathlib once per
// worker (sequentially — the second worker's import rides the first one's warm page
// cache; the ~4.6 GB of .olean mmaps are clean file-backed pages the kernel shares
// physically between workers, so an extra worker costs ~1 GB, not another 6 GB).
// One REPL command runs at a time PER WORKER; queued requests are served round-robin
// across clients (body.client) so one busy attempt can't starve the rest, and
// whichever worker frees up first takes the next job. A watchdog kills and respawns
// a worker's REPL on hang/crash. If CMP_REPL_MAX_RSS_MB is set, an RSS monitor kills
// a worker whose process group balloons past the cap (pathological checks — huge
// kernel reductions — have OOM'd the whole box before; better one worker respawns in
// ~10 s than the kernel picks a victim). Results are memoized by code hash —
// including watchdog timeouts and balloon kills, which are deterministic per file;
// memo hits skip the queue.
//
//   GET  /health           -> {ready, queued: {client: n}, workers: [{id, ready, busy}]}
//   POST /check {code, timeoutMs?, client?} -> {ok, pretty, messages, sorries, error?, kind?}
//                                              kind: check_timeout | crash | error | bad_request
//
// Env: CMP_LEAN_ENV, CMP_REPL_BIN, CMP_LEAN_PORT (default 8787)
//      CMP_REPL_WORKERS (default 1)
//      CMP_REPL_MAX_RSS_MB (default 9000; 0 = off) — per-worker balloon fuse.
//        Measured 2026-07-26: a HEALTHY worker group idles ~5.9 GB post-import and
//        reaches ~7.1 GB within 10 min of serving (heap grows per check until the
//        REPL watchdog's ~5-min restart churn resets it), so anything below
//        ~8.5 GB false-fires; 9000 catches only true balloons (the Jul-25 OOM class).
//      CMP_MIN_AVAIL_MB (default 1200; 0 = off) — system fuse: when /proc/meminfo
//        MemAvailable drops below this, kill the fattest worker. Self-adjusting
//        (page sharing between workers, cache eviction) where RSS math is not.
//        On 2-worker nights this doubles as the load governor: if it fires more
//        than occasionally (see "system memory low" log lines), run 1 worker.

import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { LEAN_PORT } from "./common.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const LEAN_ENV = process.env.CMP_LEAN_ENV ?? join(ROOT, "lean-env");
const REPL_BIN = process.env.CMP_REPL_BIN ?? join(ROOT, "vendor/repl/.lake/build/bin/repl");
const PORT = parseInt(LEAN_PORT);
const WORKERS = Math.max(1, parseInt(process.env.CMP_REPL_WORKERS ?? "1"));
const MAX_RSS_MB = parseInt(process.env.CMP_REPL_MAX_RSS_MB ?? "9000");
const MIN_AVAIL_MB = parseInt(process.env.CMP_MIN_AVAIL_MB ?? "1200");
const DEFAULT_TIMEOUT_MS = 120_000; // = the one check budget (see runner/stmt.js)
// Importing Mathlib is ~1.8 GB of .olean reads. Warm it takes 20-60 s, but under WSL2
// balloon pressure the kernel drops the pages as fast as they load (measured 2026-07-30:
// reading all 7878 oleans grew the page cache by 121 MB, with 6.4 GB free) and the same
// import crawls past several minutes. That is slow, not hung — and run.js aborts the
// WHOLE run when the server fails to come up, so this bound must sit above the slow case
// or a memory-pressure blip costs a launch. Overridable for a laptop having a bad day.
const IMPORT_TIMEOUT_MS = parseInt(process.env.CMP_IMPORT_TIMEOUT_MS ?? "900000");
const MAX_HEARTBEATS = 400_000; // 2x lean default; bounds runaway tactic searches
const MEMO_MAX = 2000;

const memo = new Map();

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

// ---------- worker pool ----------
// Each worker owns one REPL process (plus its lake wrapper — one process group),
// its own in-flight command slot, and its own restart lifecycle. Everything else
// (memo, queue, fairness) is shared across the pool.
const workers = Array.from({ length: WORKERS }, (_, id) => ({
  id, repl: null, ready: false, pending: null, restarting: false, busy: false,
}));

function sendToRepl(w, obj, timeoutMs) {
  return new Promise((res, rej) => {
    const t = setTimeout(() => {
      w.pending = null;
      // check_timeout is DETERMINISTIC for a given file (the watchdog bound is on
      // REPL execution, not queueing) — clients use the kind to stop agents from
      // retrying a doomed file, and handleCheck memoizes it like any verdict.
      rej(Object.assign(new Error(`REPL timed out after ${Math.round(timeoutMs / 1000)}s`), { kind: "check_timeout" }));
      restartRepl(w, "watchdog timeout");
    }, timeoutMs);
    w.pending = {
      resolve: (json) => {
        clearTimeout(t);
        w.pending = null;
        res(json);
      },
      reject: (err) => {
        clearTimeout(t);
        w.pending = null;
        rej(err);
      },
    };
    w.repl.stdin.write(JSON.stringify(obj) + "\n\n");
  });
}

async function startRepl(w) {
  w.ready = false;
  // proc identity guard: after a restart, a half-dead old REPL can still emit
  // output/close events; those must never reach the current onResponse resolver
  // (seen in practice: a stale check response consumed as the import response).
  // detached => repl gets its own process group, so killing -pid takes down the
  // lake wrapper AND the repl binary (otherwise restarts leak 6 GB orphans)
  const proc = spawn("lake", ["env", REPL_BIN], { cwd: LEAN_ENV, env: process.env, stdio: ["pipe", "pipe", "pipe"], detached: true });
  w.repl = proc;
  let buf = "";
  proc.stdout.on("data", (d) => {
    if (w.repl !== proc) return;
    buf += d;
    let hit;
    while ((hit = extractJson(buf)) !== null) {
      buf = hit[1];
      w.pending?.resolve(hit[0]);
    }
  });
  proc.stderr.on("data", (d) => log(`w${w.id} repl stderr:`, String(d).trim().slice(0, 300)));
  proc.on("close", (code) => {
    if (w.repl !== proc) return;
    // fail the in-flight command immediately (e.g. stack-overflow abort) instead of
    // letting it stall the worker until the watchdog fires
    w.pending?.reject(Object.assign(new Error(`REPL crashed while checking (exit ${code})`), { kind: "crash" }));
    if (w.ready) restartRepl(w, `repl exited (code ${code})`);
  });
  log(`w${w.id} importing Mathlib...`);
  const t0 = Date.now();
  const resp = await sendToRepl(w, { cmd: "import Mathlib" }, IMPORT_TIMEOUT_MS);
  if (resp.env !== 0) throw new Error(`unexpected import response: ${JSON.stringify(resp)}`);
  w.ready = true;
  log(`w${w.id} ready in ${Math.round((Date.now() - t0) / 1000)}s`);
  dispatch(); // jobs may have queued while this worker was importing
}

function killRepl(w) {
  if (!w.repl) return;
  try { process.kill(-w.repl.pid, "SIGKILL"); } catch {}
}

async function restartRepl(w, why) {
  if (w.restarting) return;
  w.restarting = true;
  w.ready = false;
  log(`w${w.id} restarting REPL: ${why}`);
  killRepl(w);
  try {
    await startRepl(w);
  } catch (e) {
    log(`w${w.id} restart failed, retrying in 10s:`, e.message);
    setTimeout(() => { w.restarting = false; restartRepl(w, "retry"); }, 10_000);
    return;
  }
  w.restarting = false;
}

// ---------- RSS fuse ----------
// Sum resident memory over a worker's process group (lake wrapper + repl binary).
// RSS double-counts the clean shared .olean pages across workers, so per-worker
// caps summed overstate the true physical worst case by ~4.6 GB — the cap is a
// blunt fuse against multi-GB heap balloons, not an exact budget.
const PAGE = 4096;
function groupRssMB(pgid) {
  let pages = 0;
  for (const d of readdirSync("/proc")) {
    if (!/^\d+$/.test(d)) continue;
    try {
      const stat = readFileSync(`/proc/${d}/stat`, "utf8");
      const f = stat.slice(stat.lastIndexOf(")") + 2).split(" "); // [0]=state [1]=ppid [2]=pgrp
      if (parseInt(f[2]) !== pgid) continue;
      pages += parseInt(readFileSync(`/proc/${d}/statm`, "utf8").split(" ")[1]);
    } catch {} // process exited mid-scan
  }
  return Math.round((pages * PAGE) / 1e6);
}
function memAvailableMB() {
  try {
    return Math.round(parseInt(/MemAvailable:\s+(\d+)/.exec(readFileSync("/proc/meminfo", "utf8"))[1]) / 1024);
  } catch { return Infinity; }
}
function blowFuse(w, why, errMsg) {
  log(`w${w.id} ${why} — killing REPL`);
  // A balloon is deterministic for the file being checked, like a watchdog
  // timeout — reject with that kind so the verdict is memoized and the agent
  // is told resubmitting the identical file is pointless.
  w.pending?.reject(Object.assign(new Error(errMsg), { kind: "check_timeout" }));
  restartRepl(w, why);
}
if (MAX_RSS_MB > 0 || MIN_AVAIL_MB > 0)
  setInterval(() => {
    const sized = workers
      .filter((w) => w.repl && !w.restarting)
      .map((w) => ({ w, mb: groupRssMB(w.repl.pid) }))
      .sort((a, b) => b.mb - a.mb);
    if (MAX_RSS_MB > 0)
      for (const { w, mb } of sized)
        if (mb > MAX_RSS_MB)
          blowFuse(w, `rss cap (${mb}MB > ${MAX_RSS_MB}MB)`, `REPL exceeded the ${MAX_RSS_MB}MB memory cap on this check`);
    // System fuse: fire before the kernel OOM-killer picks a victim for us. Kill
    // only the FATTEST worker per tick — availability usually recovers immediately.
    if (MIN_AVAIL_MB > 0 && sized.length) {
      const avail = memAvailableMB();
      if (avail < MIN_AVAIL_MB && !sized[0].w.restarting)
        blowFuse(sized[0].w, `system memory low (${avail}MB available < ${MIN_AVAIL_MB}MB floor, this worker largest at ${sized[0].mb}MB)`,
          `REPL killed: system memory ran low during this check`);
    }
  }, 5000).unref();

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

function memoPut(key, result) {
  if (memo.size >= MEMO_MAX) memo.delete(memo.keys().next().value); // bounded, oldest-first
  memo.set(key, result);
}

async function handleCheck(w, prep, body) {
  // dispatch only hands jobs to ready workers, but readiness can be lost between
  // assignment and send (concurrent watchdog restart) — wait it out; the job
  // belongs to this worker either way.
  while (!w.ready) await new Promise((r) => setTimeout(r, 2000));
  try {
    const resp = await sendToRepl(w, { cmd: prep.text, env: 0 }, body.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    const result = render(resp, prep.shifted);
    memoPut(prep.key, result);
    return result;
  } catch (e) {
    const kind = e.kind ?? "error";
    const result = {
      ok: false, error: e.message, kind,
      pretty:
        kind === "check_timeout"
          ? `lean check failed: ${e.message} — this file is too expensive to check; retrying it unchanged will fail the same way`
          : `lean check failed: ${e.message} (transient - try again)`,
      messages: [], sorries: [],
    };
    // A watchdog/rss kill is deterministic for this exact file — memoize it so a
    // client that resubmits the identical file gets the verdict for free instead of
    // burning another timeout's worth of a worker. Crashes stay unmemoized.
    if (kind === "check_timeout") memoPut(prep.key, result);
    return result;
  }
}

// Requests are served round-robin across clients (body.client, e.g. the problem
// name; the grader is just another client) — an attempt with many queued checks
// waits behind itself, not in front of everyone else (seen: one check-spamming
// attempt starving a whole run's checks). Any idle ready worker takes the next job.
const queues = new Map(); // client -> FIFO of jobs
const rr = []; // clients with pending jobs, in service order
function enqueue(client, job) {
  if (!queues.has(client)) { queues.set(client, []); rr.push(client); }
  queues.get(client).push(job);
  dispatch();
}
function dispatch() {
  for (const w of workers) {
    if (w.busy || !w.ready || !rr.length) continue;
    const client = rr.shift();
    const q = queues.get(client);
    const job = q.shift();
    if (q.length) rr.push(client);
    else queues.delete(client);
    w.busy = true;
    void job(w)
      .catch((e) => log("job error:", e.message)) // a dead client socket must not wedge the pool
      .finally(() => { w.busy = false; dispatch(); });
  }
}

const server = createServer((req, res) => {
  const respond = (status, obj) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(obj));
  };
  if (req.method === "GET" && req.url === "/health") {
    return respond(200, {
      ready: workers.some((w) => w.ready),
      queued: Object.fromEntries([...queues].map(([k, v]) => [k, v.length])),
      workers: workers.map((w) => ({ id: w.id, ready: w.ready, busy: w.busy })),
    });
  }
  if (req.method === "POST" && req.url === "/check") {
    let data = "";
    req.on("data", (d) => (data += d));
    req.on("end", () => {
      let body;
      try {
        body = JSON.parse(data);
        if (typeof body.code !== "string") throw new Error("no code");
      } catch {
        return respond(400, { ok: false, error: "invalid request body", kind: "bad_request", messages: [], sorries: [] });
      }
      const prep = prepare(body.code);
      prep.key = createHash("sha256").update(prep.text).digest("hex");
      // Memo hits (including memoized check-timeouts) skip the queue entirely —
      // re-verification of an unchanged file must never wait behind live checks.
      // force=true (the grader) skips the lookup: the recorded verdict must come
      // from a real compile. The fresh result still lands in the memo.
      if (!body.force && memo.has(prep.key)) return respond(200, { ...memo.get(prep.key), cached: true });
      enqueue(String(body.client ?? "anon"), async (w) => respond(200, await handleCheck(w, prep, body)));
    });
    return;
  }
  res.writeHead(404).end();
});

process.on("exit", () => workers.forEach(killRepl));
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => process.exit(0));

server.listen(PORT, "127.0.0.1", () => log(`lean server on 127.0.0.1:${PORT} (${WORKERS} worker${WORKERS > 1 ? "s" : ""}, rss cap ${MAX_RSS_MB > 0 ? `${MAX_RSS_MB}MB` : "off"}, avail floor ${MIN_AVAIL_MB > 0 ? `${MIN_AVAIL_MB}MB` : "off"})`));
// Sequential imports: worker 0 pays the cold import; later workers reuse its warm
// page cache. The pool starts serving as soon as the FIRST worker is ready.
(async () => {
  for (const w of workers) await startRepl(w);
})().catch((e) => { log("fatal:", e.message); process.exit(1); });
