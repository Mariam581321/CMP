#!/usr/bin/env node
// One-shot status render of a run directory, designed to sit under `watch`:
//
//   watch -n 10 node runner/status.js            # latest run
//   watch -n 10 node runner/status.js <run-id>   # specific run
//
// Shows per-problem state (finished from results.jsonl; running = problem dir exists
// but no attempt.json yet; pending otherwise) plus totals.

import { readFileSync, readdirSync, existsSync, statSync, writeFileSync, openSync, readSync, closeSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { green, red, yellow, dim, bold, money, secs, LEAN_URL, costStd } from "./common.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const RESULTS = join(ROOT, "results");

let runId = process.argv[2];
if (!runId) {
  const dirs = readdirSync(RESULTS).filter((d) => existsSync(join(RESULTS, d, "run.json")));
  if (!dirs.length) { console.log("no runs in results/"); process.exit(0); }
  runId = dirs.sort((a, b) => statSync(join(RESULTS, b, "run.json")).mtimeMs - statSync(join(RESULTS, a, "run.json")).mtimeMs)[0];
}
const runDir = join(RESULTS, runId);
const run = JSON.parse(readFileSync(join(runDir, "run.json"), "utf8"));

const finished = new Map();
if (existsSync(join(runDir, "results.jsonl")))
  for (const l of readFileSync(join(runDir, "results.jsonl"), "utf8").split("\n").filter(Boolean))
    try { const r = JSON.parse(l); finished.set(r.problem, r); } catch {}

console.log(`${bold(`run ${runId}`)}   ${dim(`combo: ${run.combo?.join("+") || "baseline"}   model: ${run.model}   rendered ${new Date().toLocaleTimeString()}`)}`);

// Lean server health — a dead server doesn't stop a run, it silently burns budget
// (agents loop on ECONNREFUSED "transient" errors), so surface it where eyes already
// are. Only checked while the run is live; after summary.json the server is expected
// to be gone.
const runComplete = existsSync(join(runDir, "summary.json"));
if (!runComplete) {
  try {
    const h = await fetch(`${LEAN_URL}/health`, { signal: AbortSignal.timeout(2000) }).then((r) => r.json());
    const queued = Object.values(h.queued ?? {}).reduce((a, b) => a + b, 0);
    console.log(h.ready
      ? dim(`  lean server: up, ${queued} check(s) queued`)
      : yellow(`  lean server: importing Mathlib, ${queued} check(s) waiting`));
  } catch {
    console.log(red(bold(`  ⚠ LEAN SERVER DOWN — checks are failing while agents burn budget; start scripts/lean-server-watchdog.sh`)));
  }
}
console.log();

// abnormal end if there was one, else the grader's reason; ?? = legacy fail_reason fallback
const reasonOf = (r) => (r.end ? (r.end !== "completed" ? r.end : r.grade?.reason) : r.fail_reason) ?? "failed";

// --- live spend for running attempts ----------------------------------------
// Sums usage out of each running attempt's pi session file the same way run.js does
// (assistant `usage`; costStd over in/out/cacheRead), so the live number converges to
// the recorded one. Incremental: a per-run cache in tmpdir keeps a byte offset per
// session file and each tick reads only the new bytes. The number trails reality by the
// message currently being generated; that is inherent to reading logs. Cache
// corruption/absence just means one full re-read, never a wrong verdict.
// (Pre-0802 runs logged pi's json event stream to events.jsonl instead; the session
// file has always been written alongside it, so one code path covers both.)
// Versioned filename: a cache written by an older status.js holds totals accumulated
// under a different scheme, and silently adding to them double-counts (observed once —
// it read a $1.00-capped attempt as $1.93 and made the budget look broken).
const CACHE = join(tmpdir(), `cmp-status-v2-${runId}.json`);
let cache = {};
try { cache = JSON.parse(readFileSync(CACHE, "utf8")); } catch {}
// Parent session plus any worker sessions (block C): live spend must converge to the
// recorded cost_std, which since workers rolls up parent + children. (Live turns/checks
// merge parent and workers here — a display simplification; the record keeps them apart.)
const sessionFiles = (p) => {
  const dirs = [join(runDir, p, "session")];
  try {
    for (const d of readdirSync(join(runDir, p, "workers")))
      if (/^w\d+$/.test(d)) dirs.push(join(runDir, p, "workers", d, "session"));
  } catch {}
  const out = [];
  for (const dir of dirs) {
    try { out.push(...readdirSync(dir).filter((f) => f.endsWith(".jsonl")).sort().map((f) => join(dir, f))); }
    catch {}
  }
  return out;
};
function liveStats(p) {
  const files = sessionFiles(p);
  if (!files.length) return null;
  const ent = (cache[p] ??= { offs: {}, in: 0, out: 0, cache_read: 0, cost: 0, turns: 0, checks: 0 });
  ent.offs ??= {};
  for (const f of files) {
    const size = statSync(f).size;
    const off = ent.offs[f] ?? 0;
    if (size < off) { ent.offs[f] = 0; continue; } // truncated: re-read next tick
    if (size === off) continue;
    const fd = openSync(f, "r");
    const buf = Buffer.alloc(size - off);
    const n = readSync(fd, buf, 0, buf.length, off);
    closeSync(fd);
    const lastNl = buf.lastIndexOf(10, n - 1);
    if (lastNl < 0) continue;
    for (const line of buf.toString("utf8", 0, lastNl + 1).split("\n")) {
      if (!line.trim()) continue;
      let m;
      try { m = JSON.parse(line).message; } catch { continue; }
      if (m?.role === "toolResult") { if (m.toolName === "lean_check") ent.checks++; continue; }
      if (m?.role !== "assistant") continue;
      ent.turns++;
      const u = m.usage;
      if (!u) continue;
      ent.in += u.input ?? 0;
      ent.out += u.output ?? 0;
      ent.cache_read += u.cacheRead ?? 0;
      ent.cost += u.cost?.total ?? 0;
    }
    ent.offs[f] = off + lastNl + 1;
  }
  return ent;
}

let solved = 0, cost = 0, liveCost = 0;
for (const p of run.problems) {
  const r = finished.get(p);
  if (r) {
    cost += r.cost_usd ?? 0;
    const chk = r.tool_calls?.lean_check ?? 0;
    const plan = r.tool_calls?.plan_check;
    const extras = `${r.turns ?? "?"}t ${chk}chk${plan != null ? ` ${plan}plan` : ""} ${money(r.cost_usd ?? 0)} ${r.wall_s ?? "?"}s`;
    if (r.solved) { solved++; console.log(`  ${green("✓ solved ")}  ${p.padEnd(20)} ${dim(extras)}`); }
    else console.log(`  ${red(`✗ ${reasonOf(r).padEnd(7)}`)}  ${p.padEnd(20)} ${dim(extras)}`);
  } else if (existsSync(join(runDir, p))) {
    const startMs = statSync(join(runDir, p)).ctimeMs;
    // "active" = time since the last COMPLETED message, not since the last byte moved.
    // Nothing kills on it (run.js has no silence fuse — see the comment there): it is
    // here so a stuck attempt is visible long before the 48 h backstop reaps it.
    const sess = sessionFiles(p).at(-1);
    const lastMs = sess ? statSync(sess).mtimeMs : startMs;
    const s = liveStats(p);
    const spend = s ? ` · ~${money(costStd(s))}${run.budget_std ? `/${money(run.budget_std)}` : ""} std, ${s.turns}t ${s.checks}chk` : "";
    liveCost += s?.cost ?? 0;
    console.log(`  ${yellow("… running")}  ${p.padEnd(20)} ${dim(`${secs(Date.now() - startMs)} elapsed, active ${secs(Date.now() - lastMs)} ago${spend}`)}`);
  } else {
    console.log(`  ${dim("· pending")}  ${p}`);
  }
}

const done = finished.size;
try { writeFileSync(CACHE, JSON.stringify(cache)); } catch {}
console.log(`\n  ${bold(`${solved}/${done} solved`)} ${dim(`of ${run.problems.length} problems   ${money(cost)} finished${liveCost ? ` + ~${money(liveCost)} running` : ""}`)}`);
if (runComplete) console.log(dim(`  run complete (summary.json written)`));
