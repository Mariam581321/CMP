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
const shortReason = { statement_changed: "stmt", compile_error: "compile", uses_sorry: "sorry", bad_axioms: "axioms", unsafe_decl: "unsafe", timeout: "time", budget_exceeded: "budget", no_file: "nofile", runner_error: "runner", grader_error: "grader", provider_error: "provider" };
// One label per unsolved attempt: the abnormal end (timeout/budget/provider) if there
// was one, else the grader's verdict. Records store the two separately (schema v2);
// the final ?? is the single legacy fallback for pre-v2 records' merged fail_reason.
const reasonOf = (r) => (r.solved ? null : (r.end ? (r.end !== "completed" ? r.end : r.grade?.reason) : r.fail_reason) ?? "unknown");

const colW = Math.max(...runs.map((r) => r.name.length), 16) + 2;
const cell = (rec) => {
  if (!rec) return dim("—".padEnd(colW));
  const cost = rec.cost_usd != null ? ` $${rec.cost_usd.toFixed(3)}` : "";
  const reason = reasonOf(rec);
  // timeout and budget_exceeded are resource exhaustion, not wrong answers — yellow
  const plain = rec.solved ? `✓${cost}` : reason === "timeout" ? `⏱${cost}` : reason === "budget_exceeded" ? `$${cost}` : `✗ ${shortReason[reason] ?? reason}${cost}`;
  const padded = plain.padEnd(colW);
  return rec.solved ? green(padded) : ["timeout", "budget_exceeded"].includes(reason) ? yellow(padded) : red(padded);
};

console.log(bold(`\n${"problem".padEnd(20)}${runs.map((r) => r.name.slice(0, colW - 1).padEnd(colW)).join("")}`));
for (const p of problems) {
  console.log(`${p.padEnd(20)}${runs.map((r) => cell(r.byProblem[p])).join("")}`);
}

console.log("");
for (const r of runs) {
  const all = problems.map((p) => r.byProblem[p]).filter(Boolean);
  // Attempts the provider aborted say nothing about the arm — rating them as failures
  // would let a throttle burst during one run masquerade as an arm difference.
  const aborted = all.filter((x) => reasonOf(x) === "provider_error");
  const recs = all.filter((x) => reasonOf(x) !== "provider_error");
  const solved = recs.filter((x) => x.solved);
  const cost = all.reduce((s, x) => s + (x.cost_usd ?? 0), 0);
  // cost_std (tokens at the fixed off-peak table, common.js) is THE comparison number —
  // peak-invariant by construction; billed cost_usd is informational only. Pre-cost_std
  // records were all billed off-peak, where cost_usd equals it — fall back.
  const costStd = all.reduce((s, x) => s + (x.cost_std ?? x.cost_usd ?? 0), 0);
  const wall = recs.reduce((s, x) => s + (x.wall_s ?? 0), 0);
  const checks = recs.reduce((s, x) => s + (x.tool_calls?.lean_check ?? 0), 0);
  const searches = recs.reduce((s, x) => s + (x.tool_calls?.search_mathlib ?? 0), 0);
  const tokIn = recs.reduce((s, x) => s + (x.tokens?.in ?? 0), 0);
  const tokOut = recs.reduce((s, x) => s + (x.tokens?.out ?? 0), 0);
  const tok = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : `${Math.round(n / 1e3)}k`);
  console.log(
    bold(`${r.name}: `) +
      `${solved.length}/${recs.length} solved   $${costStd.toFixed(3)} @std   ` +
      dim(`$${cost.toFixed(3)} billed, ${tok(tokIn)}/${tok(tokOut)} tok in/out, ${Math.round(wall / Math.max(recs.length, 1))}s avg, ${checks} lean_checks${searches ? `, ${searches} searches` : ""}`) +
      (aborted.length ? red(`   ⚠ ${aborted.length} provider-aborted, excluded`) : ""),
  );
}

if (runs.length === 2) {
  const [a, b] = runs;
  const onlyA = problems.filter((p) => a.byProblem[p]?.solved && !b.byProblem[p]?.solved);
  const onlyB = problems.filter((p) => b.byProblem[p]?.solved && !a.byProblem[p]?.solved);
  console.log(dim(`\nonly ${a.name}: ${onlyA.join(", ") || "(none)"}`));
  console.log(dim(`only ${b.name}: ${onlyB.join(", ") || "(none)"}\n`));
}
