#!/usr/bin/env node
// Reweights a reference cell's results with a triage run's verdicts.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { bold, dim, green, red, yellow, money } from "./common.js";

const [triageDir, cellDir] = process.argv.slice(2);
if (!triageDir || !cellDir) {
  console.error("usage: node runner/triage-join.js <triage run dir> <reference cell dir>");
  process.exit(1);
}
const lines = (p) => readFileSync(p, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
const triage = new Map(lines(join(triageDir, "triage.jsonl")).map((r) => [r.problem, r]));
const cell = new Map(lines(join(cellDir, "results.jsonl")).map((r) => [r.problem, r]));

const joined = [...cell.keys()].filter((p) => triage.has(p)).map((p) => ({ p, t: triage.get(p), c: cell.get(p) }));
if (!joined.length) { console.error("no overlapping problems between the two runs"); process.exit(1); }
const judged = joined.filter((x) => x.t.verdict != null);
const excluded = joined.filter((x) => x.t.verdict == null);

// Confusion matrix: verdict × reference outcome.
const cellOf = (v, solved) => judged.filter((x) => x.t.verdict === v && !!x.c.solved === solved);
const TP = cellOf("yes", true), FP = cellOf("yes", false), FN = cellOf("no", true), TN = cellOf("no", false);

const judgeCost = judged.reduce((s, x) => s + (x.t.cost_std ?? 0), 0);
const attemptCostYes = [...TP, ...FP].reduce((s, x) => s + (x.c.cost_std ?? 0), 0);
const fullCost = judged.reduce((s, x) => s + (x.c.cost_std ?? 0), 0);
const fullSolves = judged.filter((x) => x.c.solved).length;

console.log(bold(`\ntriage ${triage.values().next().value.run_id} × cell ${cell.values().next().value.run_id}`));
console.log(dim(`  ${joined.length} shared problems, ${judged.length} judged, ${excluded.length} no-verdict (excluded)\n`));
console.log(bold("  verdict × outcome (reference cell):"));
console.log(`    ${green("yes+solved")}   ${String(TP.length).padStart(3)}  ${dim(TP.map((x) => x.p).join(", "))}`);
console.log(`    ${yellow("yes+unsolved")} ${String(FP.length).padStart(3)}  ${dim("cost the gate failed to save: " + money(FP.reduce((s, x) => s + (x.c.cost_std ?? 0), 0)))}`);
console.log(`    ${red("no+solved")}    ${String(FN.length).padStart(3)}  ${FN.length ? red("solves the gate deleted: " + FN.map((x) => x.p).join(", ")) : dim("—")}`);
console.log(`    ${green("no+unsolved")}  ${String(TN.length).padStart(3)}  ${dim("attempt cost saved: " + money(TN.reduce((s, x) => s + (x.c.cost_std ?? 0), 0)))}`);
console.log(bold("\n  two-stage system vs the full cell (judged subset):"));
console.log(`    full cell:  ${fullSolves}/${judged.length} solved, ${money(fullCost)} @std`);
console.log(`    two-stage:  ${TP.length}/${judged.length} solved, ${money(judgeCost + attemptCostYes)} @std  ${dim(`(judge ${money(judgeCost)} + attempts-on-yes ${money(attemptCostYes)})`)}`);
if (excluded.length) console.log(yellow(`\n  ⚠ ${excluded.length} no-verdict problem(s) excluded: ${excluded.map((x) => x.p).join(", ")} — raise the cap or rerun before trusting the headline`));
console.log();
