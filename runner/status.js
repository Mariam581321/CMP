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
import { green, red, yellow, dim, bold, money, secs } from "./common.js";

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

console.log(`${bold(`run ${runId}`)}   ${dim(`combo: ${run.combo?.join("+") || "baseline"}   model: ${run.model}   rendered ${new Date().toLocaleTimeString()}`)}\n`);

let solved = 0, cost = 0;
for (const p of run.problems) {
  const r = finished.get(p);
  if (r) {
    cost += r.cost_usd ?? 0;
    const chk = r.tool_calls?.lean_check ?? 0;
    const plan = r.tool_calls?.plan_check;
    const extras = `${r.turns ?? "?"}t ${chk}chk${plan != null ? ` ${plan}plan` : ""} ${money(r.cost_usd ?? 0)} ${r.wall_s ?? "?"}s`;
    if (r.solved) { solved++; console.log(`  ${green("✓ solved ")}  ${p.padEnd(20)} ${dim(extras)}`); }
    else console.log(`  ${red(`✗ ${(r.fail_reason ?? "failed").padEnd(7)}`)}  ${p.padEnd(20)} ${dim(extras)}`);
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
if (existsSync(join(runDir, "summary.json"))) console.log(dim(`  run complete (summary.json written)`));
