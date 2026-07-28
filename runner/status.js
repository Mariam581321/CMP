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
// Sums usage out of each running attempt's events.jsonl the same way run.js does
// (assistant message_end usage; costStd over in/out/cacheRead), so the live number
// converges to the recorded one. Incremental: a per-run cache in tmpdir keeps a byte
// offset per problem and each tick reads only the new bytes — event files reach tens
// of MB and a full re-parse every 10 s would compete with the run itself. The number
// trails reality by the turn currently being generated; that is inherent to reading
// logs. Cache corruption/absence just means one full re-read, never a wrong verdict.
const CACHE = join(tmpdir(), `cmp-status-${runId}.json`);
let cache = {};
try { cache = JSON.parse(readFileSync(CACHE, "utf8")); } catch {}
function liveStats(p) {
  const f = join(runDir, p, "events.jsonl");
  if (!existsSync(f)) return null;
  const ent = (cache[p] ??= { off: 0, in: 0, out: 0, cache_read: 0, cost: 0, turns: 0, checks: 0 });
  const size = statSync(f).size;
  if (size < ent.off) Object.assign(ent, { off: 0, in: 0, out: 0, cache_read: 0, cost: 0, turns: 0, checks: 0 });
  if (size > ent.off) {
    const fd = openSync(f, "r");
    const buf = Buffer.alloc(size - ent.off);
    const n = readSync(fd, buf, 0, buf.length, ent.off);
    closeSync(fd);
    const lastNl = buf.lastIndexOf(10, n - 1);
    if (lastNl >= 0) {
      for (const line of buf.toString("utf8", 0, lastNl + 1).split("\n")) {
        if (line.includes('"type":"turn_end"')) { ent.turns++; continue; }
        if (line.includes('"type":"tool_execution_end"') && line.includes('"toolName":"lean_check"')) { ent.checks++; continue; }
        if (!line.includes('"type":"message_end"') || !line.includes('"role":"assistant"')) continue;
        try {
          const u = JSON.parse(line).message?.usage;
          if (!u) continue;
          ent.in += u.input ?? 0;
          ent.out += u.output ?? 0;
          ent.cache_read += u.cacheRead ?? 0;
          ent.cost += u.cost?.total ?? 0;
        } catch {}
      }
      ent.off += lastNl + 1;
    }
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
    const ev = join(runDir, p, "events.jsonl");
    const lastMs = existsSync(ev) ? statSync(ev).mtimeMs : startMs;
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
