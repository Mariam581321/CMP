#!/usr/bin/env node
// Compare finished runs side by side:
//   node runner/compare.js results/baseline-XXXX results/lean-search-XXXX [...]

import { readFileSync, existsSync } from "node:fs";
import { join, basename, resolve } from "node:path";
import { green, red, yellow, dim, bold } from "./common.js";

const dirs = process.argv.slice(2).map((d) => resolve(d));
if (dirs.length < 1) {
  console.error("usage: node runner/compare.js <results/run-dir> [<results/run-dir> ...]");
  process.exit(1);
}

const runs = dirs.map((dir) => {
  const f = join(dir, "results.jsonl");
  if (!existsSync(f)) {
    console.error(`no results.jsonl in ${dir}`);
    process.exit(1);
  }
  const byProblem = {};
  for (const line of readFileSync(f, "utf8").split("\n")) {
    if (!line.trim()) continue;
    const r = JSON.parse(line);
    byProblem[r.problem] = r; // last record wins if rerun
  }
  return { name: basename(dir), byProblem };
});

const problems = [...new Set(runs.flatMap((r) => Object.keys(r.byProblem)))].sort();
const shortReason = { statement_changed: "stmt", compile_error: "compile", uses_sorry: "sorry", bad_axioms: "axioms", timeout: "time", no_file: "nofile", runner_error: "runner", grader_error: "grader" };

const colW = Math.max(...runs.map((r) => r.name.length), 16) + 2;
const cell = (rec) => {
  if (!rec) return dim("—".padEnd(colW));
  const cost = rec.cost_usd != null ? ` $${rec.cost_usd.toFixed(3)}` : "";
  const plain = rec.solved ? `✓${cost}` : rec.fail_reason === "timeout" ? `⏱${cost}` : `✗ ${shortReason[rec.fail_reason] ?? rec.fail_reason}${cost}`;
  const padded = plain.padEnd(colW);
  return rec.solved ? green(padded) : rec.fail_reason === "timeout" ? yellow(padded) : red(padded);
};

console.log(bold(`\n${"problem".padEnd(20)}${runs.map((r) => r.name.slice(0, colW - 1).padEnd(colW)).join("")}`));
for (const p of problems) {
  console.log(`${p.padEnd(20)}${runs.map((r) => cell(r.byProblem[p])).join("")}`);
}

console.log("");
for (const r of runs) {
  const recs = problems.map((p) => r.byProblem[p]).filter(Boolean);
  const solved = recs.filter((x) => x.solved);
  const cost = recs.reduce((s, x) => s + (x.cost_usd ?? 0), 0);
  const wall = recs.reduce((s, x) => s + (x.wall_s ?? 0), 0);
  const checks = recs.reduce((s, x) => s + (x.tool_calls?.lean_check ?? 0), 0);
  const searches = recs.reduce((s, x) => s + (x.tool_calls?.search_mathlib ?? 0), 0);
  console.log(
    bold(`${r.name}: `) +
      `${solved.length}/${recs.length} solved   $${cost.toFixed(3)} total   ` +
      dim(`${Math.round(wall / Math.max(recs.length, 1))}s avg, ${checks} lean_checks${searches ? `, ${searches} searches` : ""}`),
  );
}

if (runs.length === 2) {
  const [a, b] = runs;
  const onlyA = problems.filter((p) => a.byProblem[p]?.solved && !b.byProblem[p]?.solved);
  const onlyB = problems.filter((p) => b.byProblem[p]?.solved && !a.byProblem[p]?.solved);
  console.log(dim(`\nonly ${a.name}: ${onlyA.join(", ") || "(none)"}`));
  console.log(dim(`only ${b.name}: ${onlyB.join(", ") || "(none)"}\n`));
}
