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
  // Runs tagged peak_pricing paid DeepSeek's 2x peak rate for (part of) their cost —
  // their cost_usd is not comparable with off-peak runs; tokens are.
  let peak = false;
  try { peak = JSON.parse(readFileSync(join(dir, "summary.json"), "utf8")).peak_pricing === true; } catch {}
  return { name: basename(dir), byProblem, peak };
});

const problems = [...new Set(runs.flatMap((r) => Object.keys(r.byProblem)))].sort();
const shortReason = { statement_changed: "stmt", compile_error: "compile", uses_sorry: "sorry", bad_axioms: "axioms", unsafe_decl: "unsafe", timeout: "time", no_file: "nofile", runner_error: "runner", grader_error: "grader", provider_error: "provider" };

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
  const all = problems.map((p) => r.byProblem[p]).filter(Boolean);
  // Attempts the provider aborted say nothing about the arm — rating them as failures
  // would let a throttle burst during one run masquerade as an arm difference.
  const aborted = all.filter((x) => x.fail_reason === "provider_error");
  const recs = all.filter((x) => x.fail_reason !== "provider_error");
  const solved = recs.filter((x) => x.solved);
  const cost = all.reduce((s, x) => s + (x.cost_usd ?? 0), 0);
  // cost_std (tokens at the fixed off-peak table, common.js) is the comparable number.
  // Pre-cost_std records were all billed off-peak, where cost_usd equals it — fall back.
  const costStd = all.reduce((s, x) => s + (x.cost_std ?? x.cost_usd ?? 0), 0);
  const wall = recs.reduce((s, x) => s + (x.wall_s ?? 0), 0);
  const checks = recs.reduce((s, x) => s + (x.tool_calls?.lean_check ?? 0), 0);
  const searches = recs.reduce((s, x) => s + (x.tool_calls?.search_mathlib ?? 0), 0);
  const tokIn = recs.reduce((s, x) => s + (x.tokens?.in ?? 0), 0);
  const tokOut = recs.reduce((s, x) => s + (x.tokens?.out ?? 0), 0);
  const tok = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : `${Math.round(n / 1e3)}k`);
  console.log(
    bold(`${r.name}: `) +
      `${solved.length}/${recs.length} solved   $${costStd.toFixed(3)} @std` +
      (r.peak ? yellow(" (peak 2x billed)") : "") +
      `   ` +
      dim(`$${cost.toFixed(3)} billed, ${tok(tokIn)}/${tok(tokOut)} tok in/out, ${Math.round(wall / Math.max(recs.length, 1))}s avg, ${checks} lean_checks${searches ? `, ${searches} searches` : ""}`) +
      (aborted.length ? red(`   ⚠ ${aborted.length} provider-aborted, excluded`) : ""),
  );
}

const peaky = runs.filter((r) => r.peak);
if (peaky.length)
  console.log(yellow(`\n⚠ ${peaky.map((r) => r.name).join(", ")}: ran under DeepSeek peak-hour pricing — billed cost is up to 2x inflated; compare on @std.`));

if (runs.length === 2) {
  const [a, b] = runs;
  const onlyA = problems.filter((p) => a.byProblem[p]?.solved && !b.byProblem[p]?.solved);
  const onlyB = problems.filter((p) => b.byProblem[p]?.solved && !a.byProblem[p]?.solved);
  console.log(dim(`\nonly ${a.name}: ${onlyA.join(", ") || "(none)"}`));
  console.log(dim(`only ${b.name}: ${onlyB.join(", ") || "(none)"}\n`));
}
