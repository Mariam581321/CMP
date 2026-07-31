#!/usr/bin/env node
// Persistent Lean REPL pool behind a tiny local HTTP API. Loads Mathlib once per
// worker (sequentially — the second worker's import rides the first one's warm page
// cache; the ~4.6 GB of .olean mmaps are clean file-backed pages the kernel shares
// physically between workers, so an extra worker costs ~1 GB, not another 6 GB).
// One REPL command runs at a time PER WORKER; queued requests are served round-robin
// across clients (body.client) so one busy attempt can't starve the rest, and
// whichever worker frees up first takes the next job. Checks are bounded by CPU time,
// not wall time (see CHECK_CPU_MS). A watchdog kills and respawns a worker's REPL on
// hang/crash. If CMP_REPL_MAX_RSS_MB is set, an RSS monitor kills a worker whose
// process group balloons past the cap (pathological checks — huge kernel reductions —
// have OOM'd the whole box before; better one worker respawns in ~10 s than the kernel
// picks a victim). A resource kill is a fact about the machine, not the file, so it is
// never reported: the check is silently requeued and the client waits for a real
// verdict (runCheck). Results are memoized by code hash; among the failures only a
// verdict about the file is. Memo hits skip the queue.
//
//   GET  /health           -> {ready, recycling, queued: {client: n}, workers: [{id, ready, busy}]}
//   POST /check {code, cpuMs?, client?, force?}
//        -> {ok, pretty, messages, sorries, wall_ms, cpu_ms, error?, kind?, bound?}
//           kind:  check_timeout | crash | error | bad_request
//           bound: cpu | wall | rss | mem  — which limit fired (absent if none did)
//           wall_ms/cpu_ms: this check's own resource use; ABSENT on memo hits, so
//           analysis can separate measured checks from replayed verdicts.
//   POST /recycle          -> 202 {ok} and restarts every worker in the background;
//                             409 if any worker is mid-check or anything is queued.
//                             Poll /health for {recycling: false, ready: true}.
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
// THE check budget, in CPU-seconds of the worker's process group (see runner/stmt.js).
// It was wall-clock until 2026-07-31. Wall clock measures "how long this file took given
// whatever else the box was doing", which is the file's cost plus an exogenous load term
// compared against a hard threshold — so borderline files flip. Measured on 0730b: of 31
// files the run declared too expensive, 16 (52%) compiled fine when replayed on an idle
// server, all 16 from one problem whose proofs happened to sit near the line.
// CPU-seconds separates the two populations by construction: a genuinely expensive check
// (kernel reduction, big simp/interval_cases search) is CPU-bound and burns its budget at
// the same point under any load, while a starved check is starved precisely because it is
// NOT getting CPU, so it keeps running and returns its real errors.
const DEFAULT_CHECK_CPU_MS = 120_000;
// Wall-clock backstop, NOT the budget. A check consuming no CPU at all (true hang, or
// .olean page-fault thrash under memory pressure) can never reach the CPU budget, so
// something has to break it. Set far from the CPU budget: it should essentially never
// fire, and when it does the file is not what went wrong.
const WALL_FUSE_MS = parseInt(process.env.CMP_WALL_FUSE_MS ?? "600000");
// CPU budget and memory fuses share one /proc sweep. The sweep period is also the
// budget's granularity — a check can overshoot by up to one tick (~4% of 120 s), which
// is uniform across every check and so cannot bias a comparison between arms.
const MONITOR_MS = 5000;
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

// budget: {cpuMs?, wallMs}. cpuMs absent = no CPU cap (the Mathlib import, which is
// I/O-bound and one-time). The CPU bound itself is enforced by the monitor sweep below.
function sendToRepl(w, obj, budget) {
  return new Promise((res, rej) => {
    // Snapshot the group's CPU so the bound applies to THIS command's own work — a
    // worker serves hundreds of checks between restarts, so its lifetime total is
    // meaningless here.
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

async function startRepl(w) {
  w.ready = false;
  // proc identity guard: after a restart, a half-dead old REPL can still emit
  // output/close events; those must never reach the current onResponse resolver
  // (seen in practice: a stale check response consumed as the import response).
  // detached => repl gets its own process group, so killing -pid takes down the
  // lake wrapper AND the repl binary (otherwise restarts leak 6 GB orphans)
  const proc = spawn("lake", ["env", REPL_BIN], { cwd: LEAN_ENV, env: process.env, stdio: ["pipe", "pipe", "pipe"], detached: true });
  // Without these two handlers an unhandled 'error' event is an uncaught exception
  // that kills the WHOLE server: (a) spawn failure (broken PATH — a session-spawned
  // server does not get the watchdog's exports); (b) EPIPE on stdin when a check is
  // dispatched in the ms between an OOM-killed repl dying and its 'close' event being
  // processed. Both reject the in-flight command as a crash; 'close' handles restart.
  proc.on("error", (e) => {
    if (w.repl !== proc) return;
    log(`w${w.id} repl process error:`, e.message);
    w.pending?.reject(Object.assign(new Error(`REPL process error: ${e.message}`), { kind: "crash" }));
  });
  proc.stdin.on("error", (e) => log(`w${w.id} repl stdin error (${e.code ?? e.message}) — close event will handle it`));
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
  // No CPU cap on the import: it is I/O-bound, one-time, and its own wall bound already
  // accounts for the slow case (see IMPORT_TIMEOUT_MS).
  const resp = await sendToRepl(w, { cmd: "import Mathlib" }, { wallMs: IMPORT_TIMEOUT_MS });
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

// ---------- recycle ----------
// Deliberate, all-workers restart for the gap BETWEEN runs. A server the watchdog has
// kept alive for hours carries ~2.5 GB of accumulated Lean heap per worker (it grows
// ~4 MB/check and only a crash or watchdog restart has ever reset it), part of it
// swapped out, and the workers have drifted onto different slices of the .olean page
// cache — measured 2026-07-31, two idle workers shared only ~1.1 GB where a fresh pair
// shares several. Restarting is sequential exactly as at boot, so worker 0 pays the
// import and the rest ride its warm cache. Callers must poll /health: holding an HTTP
// response open across a slow import trips undici's 5-minute header limit.
// The memo is deliberately NOT cleared. Measured 2026-07-31: agents essentially never
// resubmit a byte-identical file (94 distinct md5s across 95 checks in one attempt), so
// memoized failure verdicts almost never fire and cross-run contamination through a
// reused server is theoretical.
let recycling = false;
async function recycleAll() {
  recycling = true;
  const t0 = Date.now();
  log(`recycle: restarting ${workers.length} worker(s)`);
  try {
    for (const w of workers) {
      if (w.restarting) continue; // already getting a fresh REPL; nothing to gain
      w.restarting = true;
      // ready=false BEFORE the kill: it stops dispatch handing this worker a job, and
      // stops the close handler treating our own kill as a crash worth restarting.
      w.ready = false;
      killRepl(w);
      try {
        await startRepl(w);
        w.restarting = false;
      } catch (e) {
        log(`w${w.id} recycle failed:`, e.message);
        w.restarting = false;
        void restartRepl(w, "recycle failed, retrying"); // has its own retry loop
      }
    }
    log(`recycle: done in ${Math.round((Date.now() - t0) / 1000)}s`);
  } finally {
    recycling = false;
    dispatch();
  }
}

// ---------- RSS fuse ----------
// Sum resident memory over a worker's process group (lake wrapper + repl binary).
// RSS double-counts the clean shared .olean pages across workers, so per-worker
// caps summed overstate the true physical worst case by ~4.6 GB — the cap is a
// blunt fuse against multi-GB heap balloons, not an exact budget.
const PAGE = 4096;
const CLK_TCK = 100; // sysconf(_SC_CLK_TCK) — 100 on every Linux we run on
// One sweep, both numbers: RSS for the balloon fuses, CPU for the check budget.
// /proc/<pid>/stat fields are 1-based and the comm field contains parens, so slicing
// past the LAST ")" makes f[0] = field 3: ppid=f[1], pgrp=f[2], utime=f[11], stime=f[12].
// cutime/cstime (f[13]/f[14]) are deliberately excluded — we sweep the whole process
// group, so live children are already counted in their own right.
function groupStats(pgid) {
  let pages = 0;
  let ticks = 0;
  for (const d of readdirSync("/proc")) {
    if (!/^\d+$/.test(d)) continue;
    try {
      const stat = readFileSync(`/proc/${d}/stat`, "utf8");
      const f = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      if (parseInt(f[2]) !== pgid) continue;
      pages += parseInt(readFileSync(`/proc/${d}/statm`, "utf8").split(" ")[1]);
      ticks += parseInt(f[11]) + parseInt(f[12]);
    } catch {} // process exited mid-scan
  }
  return { rssMB: Math.round((pages * PAGE) / 1e6), cpuMs: (ticks / CLK_TCK) * 1000 };
}

// This command's own resource use so far. Read while the process group is still alive
// (every kill path reads it BEFORE killing), so a dead group scanning to 0 can never
// turn into a bogus negative.
function usage(w) {
  const c = w.check;
  if (!c) return {};
  // Clamped: on the crash path the group is already gone, so the sweep finds no pids
  // and would otherwise report the negative of the starting snapshot.
  return { wall_ms: Date.now() - c.t0, cpu_ms: Math.max(0, Math.round(groupStats(c.pgid).cpuMs - c.cpu0)) };
}
function memAvailableMB() {
  try {
    return Math.round(parseInt(/MemAvailable:\s+(\d+)/.exec(readFileSync("/proc/meminfo", "utf8"))[1]) / 1024);
  } catch { return Infinity; }
}
// Every bound ends here: fail the in-flight command with the limit that fired, then
// respawn — the REPL protocol has no interrupt, so breaking a check means killing it
// (and paying a fresh Mathlib import, which is why kills are not cheap). `bound` travels
// with the error so the client can word it honestly and handleCheck can decide whether
// the verdict is about the FILE (cpu) or about the MACHINE (wall/rss/mem).
function killCheck(w, bound, why, msg) {
  const u = usage(w);
  log(`w${w.id} ${why} — killing REPL (wall ${Math.round((u.wall_ms ?? 0) / 1000)}s, cpu ${Math.round((u.cpu_ms ?? 0) / 1000)}s)`);
  w.pending?.reject(Object.assign(new Error(msg), { kind: "check_timeout", bound, usage: u }));
  restartRepl(w, why);
}
// One sweep enforces the CPU budget and both memory fuses. Always on — unlike the
// fuses, the CPU budget is the metric itself, not an optional safety net. Each loop
// re-tests w.restarting because a kill earlier in the same tick sets it synchronously.
setInterval(() => {
  const sized = workers
    .filter((w) => w.repl && !w.restarting)
    .map((w) => ({ w, ...groupStats(w.repl.pid) }))
    .sort((a, b) => b.rssMB - a.rssMB);
  for (const { w, cpuMs } of sized) {
    const c = w.check;
    if (w.restarting || !w.pending || !c || c.cpuMs == null) continue;
    const used = cpuMs - c.cpu0;
    if (used > c.cpuMs)
      killCheck(w, "cpu", `cpu budget (${Math.round(used / 1000)}s > ${Math.round(c.cpuMs / 1000)}s CPU)`,
        `check exceeded its ${Math.round(c.cpuMs / 1000)} CPU-second budget`);
  }
  if (MAX_RSS_MB > 0)
    for (const { w, rssMB } of sized)
      if (!w.restarting && rssMB > MAX_RSS_MB)
        killCheck(w, "rss", `rss cap (${rssMB}MB > ${MAX_RSS_MB}MB)`,
          `REPL exceeded the ${MAX_RSS_MB}MB memory cap while this check was running`);
  // System fuse: fire before the kernel OOM-killer picks a victim for us. Kill
  // only the FATTEST worker per tick — availability usually recovers immediately.
  if (MIN_AVAIL_MB > 0 && sized.length) {
    const avail = memAvailableMB();
    if (avail < MIN_AVAIL_MB && !sized[0].w.restarting)
      killCheck(sized[0].w, "mem",
        `system memory low (${avail}MB available < ${MIN_AVAIL_MB}MB floor, this worker largest at ${sized[0].rssMB}MB)`,
        `REPL killed: the machine ran low on memory while this check was running`);
  }
}, MONITOR_MS).unref();

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
    const resp = await sendToRepl(w, { cmd: prep.text, env: 0 }, { cpuMs: body.cpuMs ?? DEFAULT_CHECK_CPU_MS, wallMs: WALL_FUSE_MS });
    const result = render(resp, prep.shifted);
    memoPut(prep.key, result);
    // Timings stay OUT of the memo: a replayed verdict must never report the original
    // check's wall/cpu as though it had been measured again.
    return { ...result, ...usage(w) };
  } catch (e) {
    const kind = e.kind ?? "error";
    const bound = e.bound ?? null;
    const result = {
      ok: false, error: e.message, kind, bound,
      pretty:
        kind === "check_timeout" && bound === "cpu"
          ? `lean check failed: ${e.message} — this file needs more CPU than the check budget allows.`
          : `lean check failed: ${e.message}`,
      messages: [], sorries: [],
    };
    // Only a CPU verdict is about the file, so only it is memoized here. Resource kills
    // go back to runCheck unmemoized, for a retry the caller never learns about.
    if (kind === "check_timeout" && bound === "cpu") memoPut(prep.key, result);
    return { ...result, ...(e.usage ?? usage(w)) };
  }
}

// Timings describe one measurement, so they never enter the memo.
const withoutUsage = ({ wall_ms, cpu_ms, ...rest }) => rest;

// A resource kill (wall/rss/mem) says the machine faltered, not that the file is
// expensive — the MIN_AVAIL fuse does not even pick its victim by what the victim is
// doing. Handing that to a client would teach an agent about our REPL and cost a whole
// turn, with the growing context re-billed as input, to say "try again" (the same
// argument that keeps connection retries inside the tools). So swallow it: requeue and
// answer only once there is a real verdict.
//
// The retry always runs on a DIFFERENT REPL process, because killCheck sets ready=false
// before the requeue can reach dispatch(): with one worker it waits out that worker's
// reimport and gets the fresh instance, with several it goes to a sibling. Either way
// the second measurement is taken under different machine state, which is what makes it
// informative — not that the REPL is pristine (with siblings it is warm and carrying its
// own heap). A check that really IS the balloon would otherwise re-kill a worker on
// every attempt, the exact starvation the fuses exist to stop, so a second consecutive
// resource kill is accepted as the file's own cost. Two also keeps the worst case
// (fuse + restart + fuse) inside the client's CLIENT_WAIT_MS socket budget.
//
// EXCEPT `mem`. The MIN_AVAIL fuse picks its victim by worker SIZE, not by what the
// victim is doing, so its casualty is whatever check happened to be in flight — the one
// bound carrying no evidence whatsoever about the file. It is never charged, so it can
// never convict; `wall` and `rss` at least implicate the check that was running. That
// leaves nothing bounding a box stuck under its memory floor, hence the deadline: past
// it the answer is "unavailable" (not a verdict, never memoized), which is honest —
// the machine could not run this check at all.
const MAX_CHARGED_KILLS = 2;
const RETRY_DEADLINE_MS = parseInt(process.env.CMP_RETRY_DEADLINE_MS ?? "1200000"); // < CLIENT_WAIT_MS
async function runCheck(client, prep, body) {
  const deadline = Date.now() + RETRY_DEADLINE_MS;
  let charged = 0;
  for (let attempt = 1; ; attempt++) {
    // Requeue rather than retry in place: the job must RETURN so its worker is released
    // (holding it would deadlock a 1-worker pool against its own restart), and the new
    // job waits behind this client's own queue, never in front of anyone else's.
    const r = await new Promise((resolve) => enqueue(client, async (w) => resolve(await handleCheck(w, prep, body))));
    if (!(r.kind === "check_timeout" && r.bound !== "cpu")) return r;
    if (r.bound !== "mem") charged++;
    if (charged >= MAX_CHARGED_KILLS) {
      const verdict = {
        ...r,
        pretty: `lean check failed: ${r.error} — killed for resources ${charged}x, each on a different REPL instance, so the cost is the file's own.`,
      };
      memoPut(prep.key, withoutUsage(verdict));
      return verdict;
    }
    if (Date.now() >= deadline)
      return {
        ok: false, kind: "unavailable", bound: r.bound,
        error: `${r.error} — still failing after ${Math.round(RETRY_DEADLINE_MS / 60_000)} min of retries`,
        pretty: `lean check unavailable: the machine could not run this check`,
        messages: [], sorries: [],
      };
    log(`requeueing ${client} after ${r.bound} kill (attempt ${attempt}, charged ${charged}/${MAX_CHARGED_KILLS}) — client not told`);
    // Give the monitor one full sweep to re-read MemAvailable before dispatching into
    // what may still be a starved box: retrying instantly fights the condition we are
    // waiting out, and each attempt costs another worker restart.
    if (r.bound === "mem") await new Promise((res) => setTimeout(res, MONITOR_MS));
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
      recycling,
      queued: Object.fromEntries([...queues].map(([k, v]) => [k, v.length])),
      workers: workers.map((w) => ({ id: w.id, ready: w.ready, busy: w.busy })),
    });
  }
  if (req.method === "POST" && req.url === "/recycle") {
    if (recycling) return respond(409, { ok: false, error: "recycle already in progress" });
    // Refusing while anything is in flight keeps a recycle from killing a live check —
    // and a refusal is itself the signal that something else is using this server,
    // which is the situation the one-server / one-run rule exists to catch.
    const busy = workers.filter((w) => w.busy).length;
    const queued = [...queues.values()].reduce((n, q) => n + q.length, 0);
    if (busy || queued)
      return respond(409, { ok: false, error: `server in use: ${busy} worker(s) mid-check, ${queued} queued`, busy, queued });
    void recycleAll();
    return respond(202, { ok: true, workers: workers.length });
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
      // Memo hits (including memoized CPU verdicts) skip the queue entirely —
      // re-verification of an unchanged file must never wait behind live checks.
      // force=true (the grader) skips the lookup: the recorded verdict must come
      // from a real compile. The fresh result still lands in the memo.
      if (!body.force && memo.has(prep.key)) return respond(200, { ...memo.get(prep.key), cached: true });
      void runCheck(String(body.client ?? "anon"), prep, body).then((r) => respond(200, r));
    });
    return;
  }
  res.writeHead(404).end();
});

process.on("exit", () => workers.forEach(killRepl));
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => process.exit(0));

server.listen(PORT, "127.0.0.1", () => log(`lean server on 127.0.0.1:${PORT} (${WORKERS} worker${WORKERS > 1 ? "s" : ""}, check budget ${DEFAULT_CHECK_CPU_MS / 1000}s CPU, wall fuse ${WALL_FUSE_MS / 1000}s, rss cap ${MAX_RSS_MB > 0 ? `${MAX_RSS_MB}MB` : "off"}, avail floor ${MIN_AVAIL_MB > 0 ? `${MIN_AVAIL_MB}MB` : "off"})`));
// Sequential imports: worker 0 pays the cold import; later workers reuse its warm
// page cache. The pool starts serving as soon as the FIRST worker is ready.
(async () => {
  for (const w of workers) await startRepl(w);
})().catch((e) => { log("fatal:", e.message); process.exit(1); });
