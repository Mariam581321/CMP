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
//   GET  /health           -> {ready, recycling, max_heartbeats, cpu_fuse_s,
//                              queued: {client: n}, workers: [{id, ready, busy}]}
//        max_heartbeats: the cap this server ENFORCES. run.js records it and refuses to
//        launch against a server whose cap differs from the checkout's, so the number of
//        record is always the one that decided the verdicts.
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
//      CMP_REPL_MAX_RSS_MB (default 9000; 0 = off) — per-worker balloon fuse.
//        Measured 2026-07-26: a HEALTHY worker group idles ~5.9 GB post-import and
//        reaches ~7.1 GB within 10 min of serving (heap grows per check until the
//        REPL watchdog's ~5-min restart churn resets it), so anything below
//        ~8.5 GB false-fires; 9000 catches only true balloons (the Jul-25 OOM class).
//      CMP_MIN_AVAIL_MB (default 4000; 0 = off) — system fuse: when /proc/meminfo
//        MemAvailable drops below this, kill the fattest worker. Self-adjusting
//        (page sharing between workers, cache eviction) where RSS math is not.
//        This is the fuse that actually protects a multi-worker box: 8 x the 9 GB RSS
//        cap is more memory than exists, so the per-worker cap alone stops nothing.
//        Raised from 1200 with the worker count — the floor has to be crossable before
//        the pool can allocate its way past it, and 8 workers can claim 1.2 GB between
//        two sweeps. It doubles as the load governor: if it fires more than
//        occasionally (see "system memory low" log lines), run fewer workers.

import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { LEAN_PORT, MAX_HEARTBEATS } from "./common.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const LEAN_ENV = process.env.CMP_LEAN_ENV ?? join(ROOT, "lean-env");
const REPL_BIN = process.env.CMP_REPL_BIN ?? join(ROOT, "vendor/repl/.lake/build/bin/repl");
const PORT = parseInt(LEAN_PORT);
const WORKERS = Math.max(1, parseInt(process.env.CMP_REPL_WORKERS ?? "8"));
const MAX_RSS_MB = parseInt(process.env.CMP_REPL_MAX_RSS_MB ?? "9000");
const MIN_AVAIL_MB = parseInt(process.env.CMP_MIN_AVAIL_MB ?? "4000");
// CPU fuse — machine protection, NOT a budget and never a verdict (2026-08-01). It was
// THE check budget (120 CPU-s) until the fateh_32 incident: any verdict defined by a
// measured quantity has a noise band around its threshold, and the same 49 KB file
// measured four times landed on both sides twice. Deciding is now the heartbeat cap's
// job (MAX_HEARTBEATS), so this exists only to stop one check from occupying a worker
// indefinitely — set far from the action, where tripping it says "this file cannot be
// compiled on this machine at all", not "this file fails".
const CPU_FUSE_MS = parseInt(process.env.CMP_CPU_FUSE_MS ?? "600000");
// Wall-clock backstop. A check consuming no CPU at all (true hang, or .olean page-fault
// thrash under memory pressure) can never reach the CPU fuse, so something has to break
// it. Kept ABOVE the CPU fuse so that a CPU-bound check trips the bound that describes
// it: on a busy box wall ≥ cpu always, and a wall kill on a file that was in fact
// burning CPU would log the less informative of the two.
const WALL_FUSE_MS = parseInt(process.env.CMP_WALL_FUSE_MS ?? "900000");
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
  const sized = live
    .map((w) => ({ w, ...stats.get(w.repl.pid) }))
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

// A file that could set its own `maxHeartbeats` would be writing its own verdict, so any
// value it asks for is clamped to the harness cap (0 means "no limit" in Lean and is the
// obvious way out, hence the explicit case). LOWERING is left alone: it can only make the
// file fail sooner, which is the file's business, and `set_option maxHeartbeats 200 in`
// is a legitimate way to keep a `decide` honest. The rewrite is textual and per line, so
// error line numbers stay aligned with the file the agent is looking at; it therefore
// also rewrites the option inside comments and strings, which is the harmless direction.
// `synthInstance.maxHeartbeats` and friends match too — same argument, same clamp.
// Not covered: setting the option from metaprogramming (`run_cmd modifyEnv ...`). Nothing
// lexical can be; that is what the grader's axiom check and the suspicious-keyword
// tripwire are for, and an honest proof contains no metaprogramming at all.
// The numeral matches every form Lean accepts — plain, `_` separators, 0x/0b/0o — or the
// clamp is a lexical gate an agent can walk around with `400_000_000`. Number() parses
// all of those once the underscores are stripped; anything it cannot parse is clamped
// too (a numeral we cannot read must not be one we wave through).
const HEARTBEAT_OPTION = /(\bset_option\s+(?:\w+\.)*maxHeartbeats\s+)((?:0[xXbBoO])?[0-9a-fA-F_]+)/g;
const clampHeartbeats = (line) =>
  line.replace(HEARTBEAT_OPTION, (whole, head, n) => {
    const v = Number(n.replace(/_/g, ""));
    return Number.isFinite(v) && v > 0 && v <= MAX_HEARTBEATS ? whole : `${head}${MAX_HEARTBEATS}`;
  });

// Replace import lines (Mathlib is already in the env); the first one becomes the
// heartbeat cap so line numbers in errors stay aligned with the agent's file. The cap is
// a file-level `set_option`, so it applies to every declaration BELOW it and each one
// gets the full allowance — the bound is per declaration, not per file (a file with many
// expensive declarations can still cost arbitrarily much CPU in total; that is the CPU
// fuse's business, and no longer any verdict's).
function prepare(code) {
  const lines = code.split("\n").map(clampHeartbeats);
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

// Lean's own advice when a declaration runs out of heartbeats is "use `set_option
// maxHeartbeats <num>` to set the limit" — the one move this harness makes impossible
// (prepare() clamps it). An agent that follows it re-checks a file whose verdict cannot
// change and burns turns on it, so the note travels with the message. Attached to the
// MESSAGE, not to `pretty`, because the agent-facing text is rebuilt from messages
// (stmt.js renderWithoutProbe) and both paths must say the same thing.
const HEARTBEAT_TIMEOUT = /maximum number of heartbeats/;
const HEARTBEAT_NOTE =
  `\n\nNOTE (harness): every check fixes maxHeartbeats at ${MAX_HEARTBEATS} per declaration; a ` +
  `\`set_option maxHeartbeats\` in your file can only lower that, never raise it. Raising it will not ` +
  `help — make the step cheaper instead (smaller \`decide\`/\`interval_cases\` ranges, fewer \`simp\` ` +
  `lemmas, split the work into separate lemmas so each gets its own allowance).`;

function render(resp, shifted) {
  const messages = (resp.messages ?? []).map((m) => ({
    severity: m.severity,
    line: (m.pos?.line ?? 0) - shifted,
    column: m.pos?.column ?? 0,
    text: HEARTBEAT_TIMEOUT.test(m.data ?? "") ? `${m.data}${HEARTBEAT_NOTE}` : m.data,
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

// `pretty` is capped at 8 KB by render(), but `messages` and `sorries` are not, and a
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
// Retries are capped because a check that really IS the balloon would otherwise re-kill a
// worker on every attempt, the exact starvation the fuses exist to stop; two also keeps
// the worst case (fuse + restart + fuse) inside the client's CLIENT_WAIT_MS socket
// budget. `mem` is not counted — the MIN_AVAIL fuse picks its victim by worker SIZE, so
// its casualty is whatever check happened to be in flight and the kill implicates nobody;
// the deadline is what bounds a box stuck under its memory floor.
//
// Past either limit the answer is `unavailable`: not a verdict, never memoized, nothing
// recorded about the file. Until 2026-08-01 a second cpu/wall/rss kill was instead
// "accepted as the file's own cost" and became a charged, memoized failure — a verdict
// decided by a measurement, which is exactly the coin-flip this change removes. What a
// file costs is now unjudged; what it elaborates to is judged by the heartbeat cap.
const MAX_KILLS = 2;
const RETRY_DEADLINE_MS = parseInt(process.env.CMP_RETRY_DEADLINE_MS ?? "1200000"); // < CLIENT_WAIT_MS
const unavailable = (r, kills) => ({
  ok: false, kind: "unavailable", bound: r.bound, error: r.error,
  pretty:
    r.bound === "cpu"
      ? `lean check unavailable: this file burned the ${Math.round(CPU_FUSE_MS / 1000)} CPU-second machine fuse ` +
        `${kills}x, each time on a different REPL instance. Nothing was recorded about your proof — but this ` +
        `machine cannot compile the file as written, so it has to get dramatically cheaper.`
      : `lean check unavailable: the machine could not run this check (${r.bound} fuse)`,
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
      // The verdict this server enforces, so a client can check it is the one it thinks
      // it is: the watchdog keeps a server alive across runs, so the code on disk and the
      // code deciding today's checks are not necessarily the same (run.js refuses to
      // launch on a mismatch).
      max_heartbeats: MAX_HEARTBEATS,
      // Which library (if any) is baked into the env — the other half of the verdict's
      // identity. run.js refuses to launch when this does not match what the run
      // expects, exactly like max_heartbeats.
      library_sha256: LIB_SHA,
      cpu_fuse_s: CPU_FUSE_MS / 1000,
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

server.listen(PORT, "127.0.0.1", () => log(`lean server on 127.0.0.1:${PORT} (${WORKERS} worker${WORKERS > 1 ? "s" : ""}, verdict: maxHeartbeats ${MAX_HEARTBEATS}/decl${LIB_SHA ? `, library ${LIB_SHA.slice(0, 12)}…` : ""}; fuses: ${CPU_FUSE_MS / 1000}s CPU, ${WALL_FUSE_MS / 1000}s wall, rss cap ${MAX_RSS_MB > 0 ? `${MAX_RSS_MB}MB` : "off"}, avail floor ${MIN_AVAIL_MB > 0 ? `${MIN_AVAIL_MB}MB` : "off"})`));
// Sequential imports: worker 0 pays the cold import; later workers reuse its warm
// page cache. The pool starts serving as soon as the FIRST worker is ready.
(async () => {
  for (const w of workers) await startRepl(w);
})().catch((e) => { log("fatal:", e.message); process.exit(1); });
