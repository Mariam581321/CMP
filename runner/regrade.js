#!/usr/bin/env node
// Re-grade finished runs with the current grader and report verdict flips.
// Read-only: results.jsonl / attempt.json are never touched — the recorded verdicts
// document what the run measured at the time; this shows how the current grader
// would judge the same files (e.g. after the line-level statement check was replaced
// by the type-level one). Needs the lean server up.
//
//   node runner/regrade.js results/<run-id> [more run dirs...]

import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { grade } from "./grade.js";
import { green, red, yellow, dim, bold } from "./common.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dirs = process.argv.slice(2).map((d) => resolve(d));
if (!dirs.length) {
  console.error("usage: node runner/regrade.js results/<run-id> [more run dirs...]");
  process.exit(1);
}

for (const runDir of dirs) {
  const runMeta = JSON.parse(readFileSync(join(runDir, "run.json"), "utf8"));
  const problemsDir = runMeta.problems_dir ?? join(ROOT, "problems");
  // Grade at the run's own budget, so a regrade reproduces that run's metric instead of
  // whatever the default happens to be today. Runs before 2026-07-31 recorded
  // check_timeout_s, a WALL-clock bound — reusing the number as CPU-seconds is the
  // intended reading (the same file gets at least as much room under the new metric),
  // not an equivalence between the two quantities.
  const checkCpuMs = (runMeta.check_cpu_s ?? runMeta.check_timeout_s ?? 120) * 1000;
  const probs = readdirSync(runDir).filter((f) => statSync(join(runDir, f)).isDirectory());
  console.log(bold(`\n${runMeta.run_id} (${probs.length} attempts)`));

  let flips = 0, same = 0, skipped = 0;
  for (const name of probs.sort()) {
    const attemptPath = join(runDir, name, "attempt.json");
    const solPath = join(runDir, name, "work", "problem.lean");
    if (!existsSync(attemptPath) || !existsSync(solPath)) { skipped++; continue; }
    const old = JSON.parse(readFileSync(attemptPath, "utf8"));
    const now = await grade(name, solPath, join(problemsDir, `${name}.lean`), checkCpuMs);
    // v2 records carry the grader's verdict separately (grade.*) — compare it to the
    // fresh grade directly. Legacy records merged run outcome into fail_reason, so
    // timeout/budget/provider must be carried over to stay comparable.
    const legacy = !old.grade;
    const oldReason = legacy ? (old.solved ? "solved" : old.fail_reason) : old.grade.solved ? "solved" : old.grade.reason;
    const newReason = now.solved ? "solved" : legacy && ["timeout", "budget_exceeded", "provider_error"].includes(oldReason) ? oldReason : now.reason;
    const kw = now.suspicious_keywords ? yellow(`  ⚠ ${now.suspicious_keywords.join(",")}`) : "";
    if (oldReason === newReason) {
      same++;
      console.log(dim(`  ${name.padEnd(22)} ${oldReason}`) + kw);
    } else {
      flips++;
      const arrow = `${oldReason} -> ${newReason}`;
      console.log(`  ${name.padEnd(22)} ${newReason === "solved" ? green(arrow) : red(arrow)}${kw}` +
        (now.solved ? "" : dim(`  ${(now.detail ?? "").split("\n")[0].slice(0, 80)}`)));
    }
  }
  console.log(bold(`  => ${flips} flipped, ${same} unchanged${skipped ? `, ${skipped} skipped (no files)` : ""}`));
}
