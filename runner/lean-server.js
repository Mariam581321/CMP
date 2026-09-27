#!/usr/bin/env node
// Pool of persistent Lean REPLs (Mathlib preloaded) behind a local HTTP API.

import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { LEAN_PORT, MAX_HEARTBEATS } from "./common.js";
import { prepare, CPU_FUSE_MS, WALL_FUSE_MS, MAX_KILLS, RETRY_DEADLINE_MS, CHECK_SHA, checkEnv } from "./check-env.js";
import { renderCheck } from "./render.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const LEAN_ENV = process.env.CMP_LEAN_ENV ?? join(ROOT, "lean-env");
const REPL_BIN = process.env.CMP_REPL_BIN ?? join(ROOT, "vendor/repl/.lake/build/bin/repl");
const PORT = parseInt(LEAN_PORT);
const WORKERS = Math.max(1, parseInt(process.env.CMP_REPL_WORKERS ?? "6"));
const MAX_RSS_MB = parseInt(process.env.CMP_REPL_MAX_RSS_MB ?? "13000");
const MIN_AVAIL_MB = parseInt(process.env.CMP_MIN_AVAIL_MB ?? "6000");
const MONITOR_MS = 5000;
const IMPORT_TIMEOUT_MS = parseInt(process.env.CMP_IMPORT_TIMEOUT_MS ?? "900000");
const MEMO_MAX = 2000;

// Optional library elaborated on top of Mathlib in every worker.
const LIB_FILE = process.env.CMP_LIB_FILE || null;
let LIB_SOURCE = null, LIB_SHA = null;
if (LIB_FILE) {
  LIB_SOURCE = readFileSync(LIB_FILE, "utf8");
  LIB_SHA = createHash("sha256").update(LIB_SOURCE).digest("hex");
}

const memo = new Map();

const log = (...a) => console.error(new Date().toISOString(), ...a);

// Pull the first complete top-level JSON object off buf; returns [obj, rest] or null.
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

const workers = Array.from({ length: WORKERS }, (_, id) => ({
  id, repl: null, ready: false, pending: null, restarting: false, busy: false,
}));

function sendToRepl(w, obj, budget) {
  return new Promise((res, rej) => {
    w.check = { cpuMs: budget.cpuMs ?? null, cpu0: groupStats(w.repl.pid).cpuMs, t0: Date.now(), pgid: w.repl.pid };
    const t = setTimeout(
      () =>
        killCheck(w, "wall", "wall-clock hang fuse",
          `REPL made no progress for ${Math.round(budget.wallMs / 1000)}s of wall clock`),
      budget.wallMs,
    );
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

let retentionWarned = false;

async function startRepl(w) {
  w.ready = false;
  w.lastCheckEnv = null;
  const proc = spawn("lake", ["env", REPL_BIN], {
    cwd: LEAN_ENV,
    env: {
      ...process.env,
      REPL_CMD_SNAPSHOT_LIMIT: String(LIB_SOURCE != null ? 2 : 1),
      REPL_PROOF_SNAPSHOT_LIMIT: "0",
    },
    stdio: ["pipe", "pipe", "pipe"],
    detached: true,
  });
  proc.on("error", (e) => {
    if (w.repl !== proc) return;
    log(`w${w.id} repl process error:`, e.message);
    w.pending?.reject(Object.assign(new Error(`REPL process error: ${e.message}`), { kind: "crash" }));
  });
  proc.stdin.on("error", (e) => log(`w${w.id} repl stdin error (${e.code ?? e.message}) — close event will handle it`));
  w.repl = proc;
  let buf = "";
  proc.stdout.setEncoding("utf8");
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
    w.pending?.reject(Object.assign(new Error(`REPL crashed while checking (exit ${code})`), { kind: "crash" }));
    if (w.ready) restartRepl(w, `repl exited (code ${code})`);
  });
  log(`w${w.id} importing Mathlib...`);
  const t0 = Date.now();
  const resp = await sendToRepl(w, { cmd: "import Mathlib" }, { wallMs: IMPORT_TIMEOUT_MS });
  if (resp.env !== 0) throw new Error(`unexpected import response: ${JSON.stringify(resp)}`);
  w.baseEnv = 0;
  if (LIB_SOURCE != null) {
    log(`w${w.id} elaborating library (${LIB_SHA.slice(0, 12)}…, ${Buffer.byteLength(LIB_SOURCE)} bytes)...`);
    const lib = await sendToRepl(
      w,
      { cmd: `set_option maxHeartbeats ${MAX_HEARTBEATS}\n${LIB_SOURCE}`, env: 0 },
      { wallMs: IMPORT_TIMEOUT_MS },
    );
    const errs = (lib.messages ?? []).filter((m) => m.severity === "error");
    if (typeof lib.env !== "number" || errs.length)
      throw new Error(`library failed to elaborate: ${errs[0]?.data?.slice(0, 300) ?? JSON.stringify(lib).slice(0, 300)}`);
    w.baseEnv = lib.env;
  }
  w.ready = true;
  log(`w${w.id} ready in ${Math.round((Date.now() - t0) / 1000)}s${LIB_SHA ? " (library baked)" : ""}`);
  dispatch();
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

let recycling = false;
async function recycleAll() {
  recycling = true;
  const t0 = Date.now();
  log(`recycle: restarting ${workers.length} worker(s)`);
  try {
    for (const w of workers) {
      if (w.restarting) continue;
      w.restarting = true;
      w.ready = false;
      killRepl(w);
      try {
        await startRepl(w);
        w.restarting = false;
      } catch (e) {
        log(`w${w.id} recycle failed:`, e.message);
        w.restarting = false;
        void restartRepl(w, "recycle failed, retrying");
      }
    }
    log(`recycle: done in ${Math.round((Date.now() - t0) / 1000)}s`);
  } finally {
    recycling = false;
    dispatch();
  }
}

const PAGE = 4096;
const CLK_TCK = 100;
// RSS and CPU time per process group, from one /proc scan.
function sweepGroups(pgids) {
  const acc = new Map(pgids.map((p) => [p, { pages: 0, ticks: 0 }]));
  for (const d of readdirSync("/proc")) {
    if (!/^\d+$/.test(d)) continue;
    try {
      const stat = readFileSync(`/proc/${d}/stat`, "utf8");
      const f = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      const g = acc.get(parseInt(f[2]));
      if (!g) continue;
      g.pages += parseInt(readFileSync(`/proc/${d}/statm`, "utf8").split(" ")[1]);
      g.ticks += parseInt(f[11]) + parseInt(f[12]);
    } catch {}
  }
  return new Map(
    [...acc].map(([p, { pages, ticks }]) => [p, { rssMB: Math.round((pages * PAGE) / 1e6), cpuMs: (ticks / CLK_TCK) * 1000 }]),
  );
}
const groupStats = (pgid) => sweepGroups([pgid]).get(pgid);

function usage(w) {
  const c = w.check;
  if (!c) return {};
  return { wall_ms: Date.now() - c.t0, cpu_ms: Math.max(0, Math.round(groupStats(c.pgid).cpuMs - c.cpu0)) };
}
function memAvailableMB() {
  try {
    return Math.round(parseInt(/MemAvailable:\s+(\d+)/.exec(readFileSync("/proc/meminfo", "utf8"))[1]) / 1024);
  } catch { return Infinity; }
}
function killCheck(w, bound, why, msg) {
  const u = usage(w);
  log(`w${w.id} ${why} — killing REPL (wall ${Math.round((u.wall_ms ?? 0) / 1000)}s, cpu ${Math.round((u.cpu_ms ?? 0) / 1000)}s)`);
  w.pending?.reject(Object.assign(new Error(msg), { kind: "fuse", bound, usage: u }));
  restartRepl(w, why);
}
// Fuse monitor: CPU per check, RSS per worker, system MemAvailable floor.
setInterval(() => {
  const live = workers.filter((w) => w.repl && !w.restarting);
  const stats = sweepGroups(live.map((w) => w.repl.pid));
  const sized = live
    .map((w) => ({ w, rssMB: 0, cpuMs: 0, ...(stats.get(w.repl.pid) ?? {}) }))
    .sort((a, b) => b.rssMB - a.rssMB);
  for (const { w, cpuMs } of sized) {
    const c = w.check;
    if (w.restarting || !w.pending || !c || c.cpuMs == null) continue;
    const used = cpuMs - c.cpu0;
    if (used > c.cpuMs)
      killCheck(w, "cpu", `cpu fuse (${Math.round(used / 1000)}s > ${Math.round(c.cpuMs / 1000)}s CPU)`,
        `check burned the ${Math.round(c.cpuMs / 1000)} CPU-second machine fuse`);
  }
  if (MAX_RSS_MB > 0)
    for (const { w, rssMB } of sized)
      if (!w.restarting && rssMB > MAX_RSS_MB)
        killCheck(w, "rss", `rss cap (${rssMB}MB > ${MAX_RSS_MB}MB)`,
          `REPL exceeded the ${MAX_RSS_MB}MB memory cap while this check was running`);
  if (MIN_AVAIL_MB > 0 && sized.length) {
    const avail = memAvailableMB();
    if (avail < MIN_AVAIL_MB) {
      const live = sized.filter((s) => !s.w.restarting);
      const victim = live.find((s) => !s.w.pending) ?? live[0];
      if (victim)
        killCheck(victim.w, "mem",
          `system memory low (${avail}MB available < ${MIN_AVAIL_MB}MB floor, killing ${victim.w.pending ? "busy" : "idle"} worker at ${victim.rssMB}MB)`,
          `REPL killed: the machine ran low on memory while this check was running`);
    }
  }
}, MONITOR_MS).unref();

function render(resp, shifted) {
  const messages = (resp.messages ?? []).map((m) => ({
    severity: m.severity,
    line: (m.pos?.line ?? 0) - shifted,
    column: m.pos?.column ?? 0,
    text: m.data,
  }));
  const sorries = (resp.sorries ?? []).map((s) => ({ line: (s.pos?.line ?? 0) - shifted, goal: s.goal }));
  const { ok, pretty } = renderCheck({ messages, sorries, maxHeartbeats: MAX_HEARTBEATS });
  return { ok, pretty, messages, sorries };
}

const MEMO_MAX_ENTRY_BYTES = 256 * 1024;
function memoPut(key, result) {
  let size;
  try { size = JSON.stringify(result).length; } catch { return; }
  if (size > MEMO_MAX_ENTRY_BYTES) return;
  if (memo.size >= MEMO_MAX) memo.delete(memo.keys().next().value);
  memo.set(key, result);
}

async function handleCheck(w, prep) {
  const readyDeadline = Date.now() + IMPORT_TIMEOUT_MS;
  while (!w.ready) {
    if (Date.now() > readyDeadline) {
      return {
        ok: false, error: `worker ${w.id} did not become ready within ${Math.round(IMPORT_TIMEOUT_MS / 1000)}s`,
        kind: "crash", bound: null,
        pretty: "lean check failed: no REPL became available for this check",
        messages: [], sorries: [],
      };
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  try {
    const resp = await sendToRepl(w, { cmd: prep.text, env: w.baseEnv ?? 0 }, { cpuMs: CPU_FUSE_MS, wallMs: WALL_FUSE_MS });
    if (typeof resp.env === "number") {
      if (w.lastCheckEnv != null && resp.env !== w.lastCheckEnv && !retentionWarned) {
        retentionWarned = true;
        log(
          `WARNING: repl is retaining command snapshots (env id ${w.lastCheckEnv} -> ${resp.env}). ` +
            `This binary is not the retention-capped build (${REPL_BIN}); the pool will grow into ` +
            `the ${MAX_RSS_MB}MB rss cap and checks will be killed and requeued.`,
        );
      }
      w.lastCheckEnv = resp.env;
    }
    const result = render(resp, prep.shifted);
    memoPut(prep.key, result);
    return { ...result, ...usage(w) };
  } catch (e) {
    return {
      ok: false, error: e.message, kind: e.kind ?? "error", bound: e.bound ?? null,
      pretty: `lean check failed: ${e.message}`,
      messages: [], sorries: [],
      ...(e.usage ?? usage(w)),
    };
  }
}

const unavailable = (r, kills) => ({
  ok: false, kind: "unavailable", bound: r.bound, error: r.error,
  pretty:
    r.bound === "cpu"
      ? `lean check unavailable: this file burned the ${Math.round(CPU_FUSE_MS / 1000)} CPU-second machine fuse ` +
        `${kills}x, each time on a different REPL instance. Nothing was recorded about your proof — but this ` +
        `machine cannot compile the file as written, so it has to get dramatically cheaper.`
      : `lean check unavailable: this machine could not run the check. Nothing was recorded about your ` +
        `file — the check did not happen, so this says nothing about whether your proof is correct. Try ` +
        `again; if it keeps happening, the file is too expensive to compile here and has to get much cheaper.`,
  messages: [], sorries: [],
  ...(r.wall_ms != null ? { wall_ms: r.wall_ms, cpu_ms: r.cpu_ms } : {}),
});
// Run a check, requeueing on fuse kills up to MAX_KILLS or RETRY_DEADLINE_MS.
async function runCheck(client, prep) {
  const deadline = Date.now() + RETRY_DEADLINE_MS;
  let kills = 0;
  for (let attempt = 1; ; attempt++) {
    const r = await new Promise((resolve) => enqueue(client, async (w) => resolve(await handleCheck(w, prep))));
    if (r.kind !== "fuse") return r;
    if (r.bound !== "mem") kills++;
    if (kills >= MAX_KILLS || Date.now() >= deadline) return unavailable(r, kills);
    log(`requeueing ${client} after ${r.bound} kill (attempt ${attempt}, kills ${kills}/${MAX_KILLS}) — client not told`);
    if (r.bound === "mem") await new Promise((res) => setTimeout(res, MONITOR_MS));
  }
}

// Token-bucket rate slots for the external search API, round-robin across clients.
const SEARCH_RATE_PER_MIN = parseInt(process.env.CMP_SEARCH_RATE_PER_MIN ?? "30");
const SEARCH_BURST = parseInt(process.env.CMP_SEARCH_BURST ?? "8");
const SEARCH_QUEUE_MAX = 500;
let slotTokens = SEARCH_BURST;
let slotLast = Date.now();
const slotQueues = new Map();
const slotRr = [];
let slotTimer = null;
let slotsGranted = 0, slotsPaced = 0;
function slotRefill() {
  const now = Date.now();
  slotTokens = Math.min(SEARCH_BURST, slotTokens + ((now - slotLast) / 60_000) * SEARCH_RATE_PER_MIN);
  slotLast = now;
  return slotTokens;
}
function slotPump() {
  slotRefill();
  while (slotTokens >= 1 && slotRr.length) {
    slotTokens -= 1;
    const client = slotRr.shift();
    const q = slotQueues.get(client);
    const grant = q.shift();
    if (q.length) slotRr.push(client); else slotQueues.delete(client);
    grant();
  }
  clearTimeout(slotTimer);
  slotTimer = null;
  if (slotRr.length) {
    slotTimer = setTimeout(slotPump, Math.max(50, Math.ceil(((1 - slotTokens) / SEARCH_RATE_PER_MIN) * 60_000)));
    slotTimer.unref();
  }
}
function slotRequest(client, grant) {
  const t0 = Date.now();
  const done = () => {
    const waited = Date.now() - t0;
    slotsGranted++;
    if (waited > 50) slotsPaced++;
    grant(waited);
  };
  const queued = [...slotQueues.values()].reduce((n, q) => n + q.length, 0);
  if (queued >= SEARCH_QUEUE_MAX) return done();
  if (!slotQueues.has(client)) { slotQueues.set(client, []); slotRr.push(client); }
  slotQueues.get(client).push(done);
  slotPump();
}

// Per-client check queues, served round-robin to free workers.
const queues = new Map();
const rr = [];
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
      .catch((e) => log("job error:", e.message))
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
      recycling,
      check_sha: CHECK_SHA,
      check_env: checkEnv(),
      max_heartbeats: MAX_HEARTBEATS,
      library_sha256: LIB_SHA,
      cpu_fuse_s: CPU_FUSE_MS / 1000,
      search_slots: { rate_per_min: SEARCH_RATE_PER_MIN, burst: SEARCH_BURST, tokens: +slotRefill().toFixed(2), granted: slotsGranted, paced: slotsPaced, queued: [...slotQueues.values()].reduce((n, q) => n + q.length, 0) },
      queued: Object.fromEntries([...queues].map(([k, v]) => [k, v.length])),
      workers: workers.map((w) => ({ id: w.id, ready: w.ready, busy: w.busy })),
    });
  }
  if (req.method === "POST" && req.url === "/search-slot") {
    let data = "";
    req.setEncoding("utf8");
    req.on("data", (d) => (data += d));
    req.on("end", () => {
      let client = "anon";
      try { client = String(JSON.parse(data || "{}").client ?? "anon"); } catch {}
      slotRequest(client, (waited) => respond(200, { ok: true, waited_ms: waited }));
    });
    return;
  }
  if (req.method === "POST" && req.url === "/recycle") {
    if (recycling) return respond(409, { ok: false, error: "recycle already in progress" });
    const busy = workers.filter((w) => w.busy).length;
    const queued = [...queues.values()].reduce((n, q) => n + q.length, 0);
    if (busy || queued)
      return respond(409, { ok: false, error: `server in use: ${busy} worker(s) mid-check, ${queued} queued`, busy, queued });
    void recycleAll();
    return respond(202, { ok: true, workers: workers.length });
  }
  if (req.method === "POST" && req.url === "/check") {
    let data = "";
    req.setEncoding("utf8");
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
      // Memo key: prepared text plus library identity.
      prep.key = createHash("sha256").update(`${prep.text}\0${LIB_SHA ?? ""}`).digest("hex");
      if (!body.force && memo.has(prep.key)) return respond(200, { ...memo.get(prep.key), cached: true });
      void runCheck(String(body.client ?? "anon"), prep).then((r) => respond(200, r));
    });
    return;
  }
  res.writeHead(404).end();
});

process.on("exit", () => workers.forEach(killRepl));
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => process.exit(0));

server.listen(PORT, "127.0.0.1", () => log(`lean server on 127.0.0.1:${PORT} (${WORKERS} worker${WORKERS > 1 ? "s" : ""}, check ${CHECK_SHA}: maxHeartbeats ${MAX_HEARTBEATS}/decl${LIB_SHA ? `, library ${LIB_SHA.slice(0, 12)}…` : ""}; fuses: ${CPU_FUSE_MS / 1000}s CPU, ${WALL_FUSE_MS / 1000}s wall, ${MAX_KILLS} kills / ${Math.round(RETRY_DEADLINE_MS / 60000)}min retry, rss cap ${MAX_RSS_MB > 0 ? `${MAX_RSS_MB}MB` : "off"}, avail floor ${MIN_AVAIL_MB > 0 ? `${MIN_AVAIL_MB}MB` : "off"})`));
(async () => {
  for (const w of workers) await startRepl(w);
})().catch((e) => { log("fatal:", e.message); process.exit(1); });
