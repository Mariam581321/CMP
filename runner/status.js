#!/usr/bin/env node
// One-shot status render of a run directory, designed to sit under `watch`:
//
//   watch -n 10 node runner/status.js            # latest run
//   watch -n 10 node runner/status.js <run-id>   # specific run
//
// Shows per-problem state (finished from results.jsonl; running = problem dir exists
// but no attempt.json yet; pending otherwise) plus totals.

import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { green, red, yellow, dim, bold, money, secs, LEAN_URL } from "./common.js";

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

let solved = 0, cost = 0;
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
    console.log(`  ${yellow("… running")}  ${p.padEnd(20)} ${dim(`${secs(Date.now() - startMs)} elapsed, active ${secs(Date.now() - lastMs)} ago`)}`);
  } else {
    console.log(`  ${dim("· pending")}  ${p}`);
  }
}

const done = finished.size;
console.log(`\n  ${bold(`${solved}/${done} solved`)} ${dim(`of ${run.problems.length} problems   ${money(cost)} so far`)}`);
if (runComplete) console.log(dim(`  run complete (summary.json written)`));
