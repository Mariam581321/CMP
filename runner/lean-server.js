#!/usr/bin/env node
// Persistent Lean REPL pool behind a tiny local HTTP API. Loads Mathlib once per
// worker (sequentially — the second worker's import rides the first one's warm page
// cache; the ~4.6 GB of .olean mmaps are clean file-backed pages the kernel shares
// physically between workers, so an extra worker costs ~1 GB, not another 6 GB).
// One REPL command runs at a time PER WORKER; queued requests are served round-robin
// across clients (body.client) so one busy attempt can't starve the rest, and
// whichever worker frees up first takes the next job.
//
// THE VERDICT IS DETERMINISTIC (2026-08-01): what decides "compiles" is a per-declaration
// `maxHeartbeats` cap (MAX_HEARTBEATS in common.js), enforced by Lean and returned as an
// ordinary compile error in `messages`. Every RESOURCE bound here — cpu, wall, rss, mem —
// is machine protection only and can never produce a verdict: a kill is swallowed, the
// check requeued, and past the retry cap the client is told the check is `unavailable`,
// which records nothing about the file (runCheck). A watchdog kills and respawns a
// worker's REPL on hang/crash. If CMP_REPL_MAX_RSS_MB is set, an RSS monitor kills a
// worker whose process group balloons past the cap (pathological checks — huge kernel
// reductions — have OOM'd the whole box before; better one worker respawns in ~10 s than
// the kernel picks a victim). Results are memoized by code hash — only real verdicts,
// never a resource outcome. Memo hits skip the queue.
//
//   GET  /health           -> {ready, recycling, check_sha, check_env, max_heartbeats,
//                              library_sha256, cpu_fuse_s,
//                              queued: {client: n}, workers: [{id, ready, busy}]}
//        check_sha/check_env: everything this server ENFORCES — the heartbeat cap, the
//        `set_option` head injected into every file, and the fuses (runner/check-env.js).
//        run.js records it and refuses to launch against a server whose fingerprint
//        differs from the checkout's, so the harness of record is always the one that
//        decided the verdicts.
//   POST /check {code, client?, force?}
//        -> {ok, pretty, messages, sorries, wall_ms, cpu_ms, error?, kind?, bound?}
//           kind:  unavailable | crash | error | bad_request
//                  unavailable = resource kills exhausted their retries; NOT a verdict,
//                  never memoized, says nothing about the file.
//           bound: cpu | wall | rss | mem  — which fuse fired (absent if none did)
//           wall_ms/cpu_ms: this check's own resource use; ABSENT on memo hits, so
//           analysis can separate measured checks from replayed verdicts.
//   POST /recycle          -> 202 {ok} and restarts every worker in the background;
//                             409 if any worker is mid-check or anything is queued.
//                             Poll /health for {recycling: false, ready: true}.
//
// Env: CMP_LEAN_ENV, CMP_REPL_BIN, CMP_LEAN_PORT (default 8787)
//      CMP_REPL_WORKERS (default 8 — sized for the 64 GB Ryzen 3600 server, 2026-08-01)
//        Measured on this box with one worker serving: RSS 7.2 GB, of which 5.3 GB is
//        CLEAN file-backed .olean mapping (private only because nobody else maps it yet;
//        a second worker shares those pages physically) and ~1.25 GB is dirty heap. So
//        the pool costs ~6 GB once plus ~1.5-3 GB per worker as heap accumulates between
//        watchdog restarts: 8 workers ≈ 18-30 GB, comfortable in 64 GB. The CPU is
//        6 cores / 12 threads; a check is one busy thread, so 8 concurrent checks
//        oversubscribe physical cores under full load — which since the heartbeat
//        verdict (2026-08-01) costs only wall time, never a verdict flip, and full
//        occupancy is rare (checks arrive bursty between LLM turns). 8 of 12 threads
//        leaves room for the runner, the pi children and a Claude session.
//      CMP_REPL_MAX_RSS_MB (default 13000; 0 = off) — per-worker balloon fuse.
//        Raised from 9000 on 2026-08-06, with the snapshot-retention fix below; the
//        two are one change. 9000 was calibrated 2026-07-26 against a pool whose heap
//        grew per check, where "a healthy worker reaches ~7.1 GB in 10 min" made 8.5 GB
//        the highest non-false-firing line. It fired 234 times in grep-fatex87-0805 —
//        every worker every ~16 min, median 12 MB past the line, i.e. workers parked
//        under the cap and drifting across it, not checks demanding memory. Two of
//        those cost an attempt its verdict (fatex_19, fatex_31).
//        With retention capped a fresh worker sits at 6.35 GB RSS and stays there, and
//        the heaviest file in FATE-X (fatex_19: 2113 lines, 272 decls) adds ~2 GB of
//        its own — which 9000 did not clear even on a pristine worker. 13000 leaves
//        that file ~4.5 GB of margin and still catches the balloon class this fuse
//        exists for (the Jul-25 OOM, tens of GB in one check).
//      CMP_MIN_AVAIL_MB (default 6000; 0 = off) — system fuse: when /proc/meminfo
//        MemAvailable drops below this, kill the fattest worker. Self-adjusting
//        (page sharing between workers, cache eviction) where RSS math is not.
//        This is the fuse that actually protects a multi-worker box: 8 x the 13 GB RSS
//        cap is more memory than exists, so the per-worker cap alone stops nothing.
//        Raised 4000 -> 6000 with the RSS cap: the floor is what a single ballooning
//        worker now has to cross before its OWN cap fires, so it needs more room than
//        when the per-worker line sat at 9000. It doubles as the load governor: if it
//        fires more than occasionally (see "system memory low" log lines), run fewer
//        workers.
//
// WHY RSS OVERSTATES THE COST (it is a fuse, not a budget): the number swept here
// counts each worker's ~5.2 GB .olean mapping in full, and those are clean file-backed
// pages the kernel holds ONCE for the whole pool. Measured 2026-08-06 on 8 live
// workers: 6.35-7.7 GB RSS each but 1.16-2.56 GB PSS each — ~17 GB of real memory for
// a pool whose RSS sums to ~60. Any per-worker RSS line is therefore ~5 GB higher than
// the memory it is protecting; CMP_MIN_AVAIL_MB is the number that tracks reality.

import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { LEAN_PORT, MAX_HEARTBEATS } from "./common.js";
// What a check IS — the injected `set_option` head, the clamp, and the bound chain —
// lives in check-env.js because run.js has to verify that the server it is about to
// launch a run against is enforcing THIS checkout's version of it. CHECK_SHA is that
// verification; see the module header.
import { prepare, CPU_FUSE_MS, WALL_FUSE_MS, MAX_KILLS, RETRY_DEADLINE_MS, CHECK_SHA, checkEnv } from "./check-env.js";
import { renderCheck } from "./render.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const LEAN_ENV = process.env.CMP_LEAN_ENV ?? join(ROOT, "lean-env");
const REPL_BIN = process.env.CMP_REPL_BIN ?? join(ROOT, "vendor/repl/.lake/build/bin/repl");
const PORT = parseInt(LEAN_PORT);
// 6, not 8: one worker per PHYSICAL core (Ryzen 5 3600, 6C/12T). A check is
// single-threaded and CPU-bound, so the pool's ceiling is 6 checks' worth of compute per
// wall second no matter how many workers exist — measured 2026-08-11 with three cells
// live: 6 repls pinned at ~100% (595% total), 2 sitting at 0.0%, and /health reporting
// ZERO queued checks. The two extra workers were not adding throughput; they were adding
// ~7 GB of RSS each to a box whose RSS fuse fired 579 times in the preceding 3.6 days
// (each kill discards a partly-computed check and pays a fresh Mathlib import) plus two
// "system memory low" sweeps. Not part of CHECK_SHA (check-env.js hashes the set_option
// head, the fuses, max_kills, retry_deadline — not the pool size), so this cannot move a
// verdict or break comparability with an earlier cell; it changes throughput only.
// Takes effect on the next server start.
const WORKERS = Math.max(1, parseInt(process.env.CMP_REPL_WORKERS ?? "6"));
const MAX_RSS_MB = parseInt(process.env.CMP_REPL_MAX_RSS_MB ?? "13000");
const MIN_AVAIL_MB = parseInt(process.env.CMP_MIN_AVAIL_MB ?? "6000");
// CPU fuse and memory fuses share one /proc sweep. The sweep period is also the fuse's
// granularity — a check can overshoot by up to one tick — which no longer matters to any
// verdict now that no measured bound decides anything.
const MONITOR_MS = 5000;
// Importing Mathlib is ~1.8 GB of .olean reads. Warm it takes 20-60 s, but under WSL2
// balloon pressure the kernel drops the pages as fast as they load (measured 2026-07-30:
// reading all 7878 oleans grew the page cache by 121 MB, with 6.4 GB free) and the same
// import crawls past several minutes. That is slow, not hung — and run.js aborts the
// WHOLE run when the server fails to come up, so this bound must sit above the slow case
// or a memory-pressure blip costs a launch. Overridable for a laptop having a bad day.
const IMPORT_TIMEOUT_MS = parseInt(process.env.CMP_IMPORT_TIMEOUT_MS ?? "900000");
const MEMO_MAX = 2000;

// Block D library baking: CMP_LIB_FILE names a gate-verified library (a frozen
// add_fact bank) that every worker elaborates ON TOP of Mathlib at startup; checks
// then run against that env, so library names are ambient exactly like Mathlib names
// — for agents and the grader alike, one definition of compiles. The file is read
// ONCE at boot and its sha travels in /health (run.js refuses to launch a library
// cell against the wrong env) and in every memo key (the same bytes compile
// differently under different envs, so the env identity is part of the verdict's
// identity). A library that fails to elaborate is fatal: serving without it would
// silently change every verdict the run is about to record.
const LIB_FILE = process.env.CMP_LIB_FILE || null;
let LIB_SOURCE = null, LIB_SHA = null;
if (LIB_FILE) {
  LIB_SOURCE = readFileSync(LIB_FILE, "utf8");
  LIB_SHA = createHash("sha256").update(LIB_SOURCE).digest("hex");
}

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

// budget: {cpuMs?, wallMs}. cpuMs absent = no CPU fuse (the Mathlib import, which is
// I/O-bound and one-time). The CPU fuse itself is enforced by the monitor sweep below.
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

let retentionWarned = false;

async function startRepl(w) {
  w.ready = false;
  w.lastCheckEnv = null; // ids restart with the process; see the retention guard below
  // proc identity guard: after a restart, a half-dead old REPL can still emit
  // output/close events; those must never reach the current onResponse resolver
  // (seen in practice: a stale check response consumed as the import response).
  // detached => repl gets its own process group, so killing -pid takes down the
  // lake wrapper AND the repl binary (otherwise restarts leak 6 GB orphans)
  // Snapshot retention: the REPL stores every environment it produces so a client can
  // resume from it (`{"cmd": ..., "env": 17}`), and the arrays only ever grow. We never
  // resume — every check is sent against baseEnv and the returned id is discarded (see
  // handleCheck) — so past the base envs each snapshot is garbage that pins the whole
  // elaborated environment of a 2000-line proof file. That was ~1.4 GB per worker per
  // 10 min of serving, and it is what walked the pool into the RSS fuse 234 times in
  // grep-fatex87-0805. Keep exactly the base envs (import, then the baked library if
  // there is one) and drop the rest; proof snapshots, one per `sorry`, we never name at
  // all. Stock upstream repl ignores both variables, so an unpatched binary still runs —
  // it just leaks again, visibly, in the rss cap log lines.
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
  // UTF-8 across chunk boundaries: `buf += d` on raw Buffers turns any multi-byte char
  // split by a 64 KB pipe chunk into U+FFFD, and Lean output is unicode-dense (ℕ → ∀ ≤).
  // The damage is silent — the JSON still parses — and lands in the messages and probe
  // lines every verdict is read from.
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
    // fail the in-flight command immediately (e.g. stack-overflow abort) instead of
    // letting it stall the worker until the watchdog fires
    w.pending?.reject(Object.assign(new Error(`REPL crashed while checking (exit ${code})`), { kind: "crash" }));
    if (w.ready) restartRepl(w, `repl exited (code ${code})`);
  });
  log(`w${w.id} importing Mathlib...`);
  const t0 = Date.now();
  // No CPU fuse on the import: it is I/O-bound, one-time, and its own wall bound already
  // accounts for the slow case (see IMPORT_TIMEOUT_MS).
  const resp = await sendToRepl(w, { cmd: "import Mathlib" }, { wallMs: IMPORT_TIMEOUT_MS });
  if (resp.env !== 0) throw new Error(`unexpected import response: ${JSON.stringify(resp)}`);
  w.baseEnv = 0;
  if (LIB_SOURCE != null) {
    // Elaborate the library on top of Mathlib; every check then runs against the
    // resulting env. The library passed the add_fact gate under the same heartbeat
    // cap, so the cap line is policy restated, not a new constraint. Any error is
    // fatal for this worker (throw → the startup/restart retry path owns it).
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
// One sweep, both numbers, ALL groups: RSS for the balloon fuses, CPU for the CPU fuse.
// Bucketed by pgid in a single /proc pass because the monitor asks about every worker on
// every tick — a scan per worker re-read every pid's stat and statm 8 times per sweep.
// /proc/<pid>/stat fields are 1-based and the comm field contains parens, so slicing
// past the LAST ")" makes f[0] = field 3: ppid=f[1], pgrp=f[2], utime=f[11], stime=f[12].
// cutime/cstime (f[13]/f[14]) are deliberately excluded — we sweep the whole process
// group, so live children are already counted in their own right.
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
    } catch {} // process exited mid-scan
  }
  return new Map(
    [...acc].map(([p, { pages, ticks }]) => [p, { rssMB: Math.round((pages * PAGE) / 1e6), cpuMs: (ticks / CLK_TCK) * 1000 }]),
  );
}
const groupStats = (pgid) => sweepGroups([pgid]).get(pgid);

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
// Every fuse ends here: fail the in-flight command with the limit that fired, then
// respawn — the REPL protocol has no interrupt, so breaking a check means killing it
// (and paying a fresh Mathlib import, which is why kills are not cheap). `bound` travels
// with the error so runCheck can word the eventual `unavailable` honestly. No bound is
// ever a verdict: all four say something about this machine, and the file is judged by
// Lean's own messages alone.
function killCheck(w, bound, why, msg) {
  const u = usage(w);
  log(`w${w.id} ${why} — killing REPL (wall ${Math.round((u.wall_ms ?? 0) / 1000)}s, cpu ${Math.round((u.cpu_ms ?? 0) / 1000)}s)`);
  w.pending?.reject(Object.assign(new Error(msg), { kind: "fuse", bound, usage: u }));
  restartRepl(w, why);
}
// One sweep enforces the CPU fuse and both memory fuses. The CPU fuse is always on
// (it is what bounds a worker's occupancy); the memory fuses are configurable. Each loop
// re-tests w.restarting because a kill earlier in the same tick sets it synchronously.
setInterval(() => {
  const live = workers.filter((w) => w.repl && !w.restarting);
  const stats = sweepGroups(live.map((w) => w.repl.pid));
  // Zero defaults, not undefined: a worker whose process exited between `live` and the
  // sweep has no entry, and NaN sizes make the sort order arbitrary and the comparisons
  // below silently false.
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
  // System fuse: fire before the kernel OOM-killer picks a victim for us. One worker per
  // tick — availability usually recovers immediately — and an IDLE one by preference:
  // this fuse selects by size, not by blame, so its casualty used to be whichever check
  // happened to be in flight on the fattest worker. A parked worker holds just as much
  // memory and costs only a reimport to release, so it is strictly the better victim;
  // only when every worker is mid-check does a check have to pay.
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

// The heartbeat NOTE used to be appended to every timeout MESSAGE here, so that the
// server's `pretty` and the agent-facing rebuild (stmt.js) would say the same thing.
// Both now go through renderCheck, which emits it once per check instead of once per
// message — same words, in one place, 1.72 MB less of them across a cell pair.
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

// `pretty` is capped by render(), but `messages` and `sorries` are not, and a
// sorry goal in a big context pretty-prints to a lot of text. The watchdog keeps this
// server alive for days across runs, so MEMO_MAX entries of unbounded size is a slow
// leak with no ceiling. Skip memoizing the outliers rather than truncating them: a
// truncated entry would be a DIFFERENT answer served under the same key, and the memo's
// whole contract is that a hit is byte-identical to the compile it replaces.
const MEMO_MAX_ENTRY_BYTES = 256 * 1024;
function memoPut(key, result) {
  let size;
  try { size = JSON.stringify(result).length; } catch { return; }
  if (size > MEMO_MAX_ENTRY_BYTES) return;
  if (memo.size >= MEMO_MAX) memo.delete(memo.keys().next().value); // bounded, oldest-first
  memo.set(key, result);
}

async function handleCheck(w, prep) {
  // dispatch only hands jobs to ready workers, but readiness can be lost between
  // assignment and send (concurrent watchdog restart) — wait it out; the job
  // belongs to this worker either way.
  //
  // Bounded: this runs with w.busy already true, so a worker whose REPL cannot come back
  // (broken binary, disk full — restartRepl retries forever by design) would otherwise
  // spin here for the client's whole 30 min socket wait while looking merely busy, and
  // with every worker in that state the pool wedges silently. Give up well inside the
  // import bound and report a crash, which runCheck requeues onto a sibling.
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
    // Retention guard. The REPL_*_SNAPSHOT_LIMIT vars startRepl passes are silently
    // ignored by a stock repl, so pointing CMP_REPL_BIN at one — or rebuilding
    // vendor/repl from upstream — brings the leak back with nothing to see until the
    // rss cap starts firing hours into a run. The tell is free: a capped repl hands
    // back the SAME env id every check (the index the dropped snapshot would have had),
    // a stock one hands back an increasing id. Warn once per server, not per check.
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
    // Timings stay OUT of the memo: a replayed verdict must never report the original
    // check's wall/cpu as though it had been measured again.
    return { ...result, ...usage(w) };
  } catch (e) {
    // Nothing here is memoized. A crash and every fuse kill are events on this machine;
    // the memo holds verdicts, which since 2026-08-01 come only from Lean's own output.
    return {
      ok: false, error: e.message, kind: e.kind ?? "error", bound: e.bound ?? null,
      pretty: `lean check failed: ${e.message}`,
      messages: [], sorries: [],
      ...(e.usage ?? usage(w)),
    };
  }
}

// A fuse kill says the machine faltered or the file is unaffordable HERE — never that
// the proof is wrong, and never anything a re-run would have to reproduce. Handing one to
// a client would teach an agent about our REPL and cost a whole turn, with the growing
// context re-billed as input, to say "try again" (the same argument that keeps connection
// retries inside the tools). So swallow it: requeue and answer only once Lean itself has
// answered.
//
// The retry always runs on a DIFFERENT REPL process, because killCheck sets ready=false
// before the requeue can reach dispatch(): with one worker it waits out that worker's
// reimport and gets the fresh instance, with several it goes to a sibling. Either way
// the second measurement is taken under different machine state, which is what makes it
// informative — not that the REPL is pristine (with siblings it is warm and carrying its
// own heap).
//
// `mem` kills are not counted against MAX_KILLS — the MIN_AVAIL fuse picks its victim by
// worker SIZE, so its casualty is whatever check happened to be in flight and the kill
// implicates nobody; RETRY_DEADLINE_MS is what bounds a box stuck under its memory floor.
//
// Past either limit the answer is `unavailable`: not a verdict, never memoized, nothing
// recorded about the file. Until 2026-08-01 a second cpu/wall/rss kill was instead
// "accepted as the file's own cost" and became a charged, memoized failure — a verdict
// decided by a measurement, which is exactly the coin-flip that change removed. What a
// file costs is now unjudged; what it elaborates to is judged by the heartbeat cap.
// MAX_KILLS and the deadline live in check-env.js, where the whole bound chain is
// derived so the retry can never outlast the client that is waiting for it.
const unavailable = (r, kills) => ({
  ok: false, kind: "unavailable", bound: r.bound, error: r.error,
  pretty:
    r.bound === "cpu"
      ? `lean check unavailable: this file burned the ${Math.round(CPU_FUSE_MS / 1000)} CPU-second machine fuse ` +
        `${kills}x, each time on a different REPL instance. Nothing was recorded about your proof — but this ` +
        `machine cannot compile the file as written, so it has to get dramatically cheaper.`
      // No fuse names here. `rss`/`wall`/`mem` are facts about our REPL pool, and an
      // agent cannot act on any of them — naming them spends a turn teaching it about
      // infrastructure. What it CAN act on is the two possibilities, so say both:
      // retry, and if it keeps happening the file is the problem.
      : `lean check unavailable: this machine could not run the check. Nothing was recorded about your ` +
        `file — the check did not happen, so this says nothing about whether your proof is correct. Try ` +
        `again; if it keeps happening, the file is too expensive to compile here and has to get much cheaper.`,
  messages: [], sorries: [],
  ...(r.wall_ms != null ? { wall_ms: r.wall_ms, cpu_ms: r.cpu_ms } : {}),
});
async function runCheck(client, prep) {
  const deadline = Date.now() + RETRY_DEADLINE_MS;
  let kills = 0;
  for (let attempt = 1; ; attempt++) {
    // Requeue rather than retry in place: the job must RETURN so its worker is released
    // (holding it would deadlock a 1-worker pool against its own restart), and the new
    // job waits behind this client's own queue, never in front of anyone else's.
    const r = await new Promise((resolve) => enqueue(client, async (w) => resolve(await handleCheck(w, prep))));
    if (r.kind !== "fuse") return r; // a real verdict, or a crash the client must see
    if (r.bound !== "mem") kills++;
    if (kills >= MAX_KILLS || Date.now() >= deadline) return unavailable(r, kills);
    log(`requeueing ${client} after ${r.bound} kill (attempt ${attempt}, kills ${kills}/${MAX_KILLS}) — client not told`);
    // Give the monitor one full sweep to re-read MemAvailable before dispatching into
    // what may still be a starved box: retrying instantly fights the condition we are
    // waiting out, and each attempt costs another worker restart.
    if (r.bound === "mem") await new Promise((res) => setTimeout(res, MONITOR_MS));
  }
}

// ---------- shared rate slots for the external search API ----------
// A pure ticket dispenser: a client asks for a slot, and the answer arrives when it is
// that client's turn AND a token is available. No search traffic passes through here —
// the caller makes its own request afterwards — so this daemon gains a timer, not a
// network dependency, and an upstream that hangs or changes shape is still entirely the
// extension's problem.
//
// Why it has to live in a shared process at all: the failures are BURSTS, not volume.
// Measured over semantic-fatex87-0805 — 6,314 searches in 13.1 h, 8.0/min average, p90
// 23/min — every one of the 69 HTTP 429s falls inside SIX minutes of 569, each carrying
// 65-99 calls. Those spikes are 25 pi processes searching at the same moment, so no
// per-process limiter can see them, and a retry (even a jittered one) only spreads a
// burst that has already been sent and refused. This stops it being sent.
//
// Token bucket, not a fixed spacing, because the traffic is legitimately bursty and
// mostly harmless: an idle pool banks SEARCH_BURST slots, so a handful of simultaneous
// searches go straight through, and only sustained pressure is paced.
//
// The numbers are measured, not picked. Bucketing that cell's 6,314 searches by minute
// brackets the endpoint's limit tightly: the highest CLEAN minute is 50 requests and the
// lowest FAILING one is 52, over 563 clean minutes against 6 failing (52, 64, 65, 65,
// 69, 99). So the rule is ~50/min per IP.
// 30 + 8 leaves 24% of margin under that, and the margin is the point rather than
// timidity: those per-minute buckets are FIXED windows, while a Cloudflare limiter
// slides — 30 requests either side of a minute boundary is 60 in a sliding window while
// both fixed buckets read 30, so the measurement understates the instantaneous rate. A
// token bucket is what closes that gap: it paces emission continuously, so no sliding
// 60 s window can ever contain more than SEARCH_RATE_PER_MIN + SEARCH_BURST = 38. The
// price is small and bounded — replayed against the cell, a 30/min cap would have paced
// 16 of 563 clean minutes (2.8%) and all 6 failing ones, and pacing costs wall clock
// only.
// Round-robin across clients for the same reason checks are: one search-happy attempt
// must wait behind itself, not in front of the run.
const SEARCH_RATE_PER_MIN = parseInt(process.env.CMP_SEARCH_RATE_PER_MIN ?? "30");
const SEARCH_BURST = parseInt(process.env.CMP_SEARCH_BURST ?? "8");
// A backstop on the queue, not a policy: past this the caller is told to go ahead
// unpaced rather than be parked, because a stuck dispenser must never be able to hold
// up a run. Sized far above anything the measured traffic can produce.
const SEARCH_QUEUE_MAX = 500;
let slotTokens = SEARCH_BURST;
let slotLast = Date.now();
const slotQueues = new Map();
const slotRr = [];
let slotTimer = null;
let slotsGranted = 0, slotsPaced = 0;
// Lazy refill: the bucket has no ticking clock of its own, it just accrues since the
// last time anyone looked. Shared with /health so an operator (and the probe) can see
// the live token count rather than a value stale since the last grant.
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
    // Next token is due in (1 - tokens) / rate minutes; wake then, not on a poll.
    slotTimer = setTimeout(slotPump, Math.max(50, Math.ceil(((1 - slotTokens) / SEARCH_RATE_PER_MIN) * 60_000)));
    slotTimer.unref();
  }
}
// `grant(waitedMs)` — the wait is measured here rather than inferred, because the only
// question this telemetry has to answer after a run is "did pacing actually bind", and
// counting queue ENTRIES answers a different one: every request enters the queue, even
// the ones a full bucket releases in the same tick.
function slotRequest(client, grant) {
  const t0 = Date.now();
  const done = () => {
    const waited = Date.now() - t0;
    slotsGranted++;
    if (waited > 50) slotsPaced++;
    grant(waited);
  };
  const queued = [...slotQueues.values()].reduce((n, q) => n + q.length, 0);
  if (queued >= SEARCH_QUEUE_MAX) return done(); // backstop: never park a run
  if (!slotQueues.has(client)) { slotQueues.set(client, []); slotRr.push(client); }
  slotQueues.get(client).push(done);
  slotPump();
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
      // EVERYTHING this server decides, so a client can check it is the one it thinks it
      // is. The watchdog keeps a server alive for days, across git pulls, so the code on
      // disk and the code deciding today's checks are not necessarily the same — and
      // `max_heartbeats` alone did not notice, because it is the one number that has not
      // moved since July. check_sha covers the injected `set_option` head (linters,
      // typeclass budget) and the fuses too; run.js refuses to launch on a mismatch and
      // prints check_env field by field to say what moved.
      check_sha: CHECK_SHA,
      check_env: checkEnv(),
      max_heartbeats: MAX_HEARTBEATS,
      // Which library (if any) is baked into the env — the other half of the verdict's
      // identity. run.js refuses to launch when this does not match what the run
      // expects, exactly like check_sha.
      library_sha256: LIB_SHA,
      cpu_fuse_s: CPU_FUSE_MS / 1000,
      // The external-search rate slots (see slotPump). Informational, deliberately NOT
      // in check_sha: pacing costs wall clock and nothing else — it cannot move a
      // verdict or change one byte the agent sees — and a server without it degrades to
      // the extension calling out directly, which is what happened before it existed.
      search_slots: { rate_per_min: SEARCH_RATE_PER_MIN, burst: SEARCH_BURST, tokens: +slotRefill().toFixed(2), granted: slotsGranted, paced: slotsPaced, queued: [...slotQueues.values()].reduce((n, q) => n + q.length, 0) },
      queued: Object.fromEntries([...queues].map(([k, v]) => [k, v.length])),
      workers: workers.map((w) => ({ id: w.id, ready: w.ready, busy: w.busy })),
    });
  }
  // Wait here until this client may make one external search request. Answers
  // {waited_ms}; the caller does its own HTTP afterwards. A client that dies while
  // waiting just drops its callback — the token it was granted is spent, which is the
  // conservative direction.
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
    // UTF-8 across chunk boundaries — this body is the agent's Lean SOURCE. Corrupting a
    // char here does not garble a report, it compiles a file the agent never wrote.
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
      // The memo key is the PREPARED text, so it already carries the heartbeat cap and
      // the clamp — the only inputs a verdict depends on. (It used to omit the caller's
      // cpuMs, which was a real hole while clients could ask for different budgets;
      // clients no longer set any bound at all.)
      const prep = prepare(body.code);
      // The env identity is part of the key: the same bytes compile differently with a
      // library baked in, and a memo entry must never cross that boundary (the memo
      // survives recycles and, in principle, a future durable store).
      prep.key = createHash("sha256").update(`${prep.text} ${LIB_SHA ?? ""}`).digest("hex");
      // Memo hits skip the queue entirely — re-verification of an unchanged file must
      // never wait behind live checks. force=true (the grader) skips the lookup: the
      // recorded verdict must come from a real compile. The fresh result still lands in
      // the memo, and is byte-identical to the cached one by construction.
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
// Sequential imports: worker 0 pays the cold import; later workers reuse its warm
// page cache. The pool starts serving as soon as the FIRST worker is ready.
(async () => {
  for (const w of workers) await startRepl(w);
})().catch((e) => { log("fatal:", e.message); process.exit(1); });
