#!/usr/bin/env node
// Re-grades finished runs with the current grader and reports verdict flips (read-only).
//   node runner/regrade.js results/<run-id> [more run dirs...]

import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { grade } from "./grade.js";
import { CHECK_SHA, checkEnvDiff } from "./check-env.js";
import { LEAN_URL, green, red, yellow, dim, bold } from "./common.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dirs = process.argv.slice(2).map((d) => resolve(d));
if (!dirs.length) {
  console.error("usage: node runner/regrade.js results/<run-id> [more run dirs...]");
  process.exit(1);
}

const health = await fetch(`${LEAN_URL}/health`, { signal: AbortSignal.timeout(3000) })
  .then((r) => r.json()).catch(() => null);
const serverLib = health?.library_sha256 ?? null;
if (health && health.check_sha !== CHECK_SHA)
  console.error(
    yellow(`note: the lean server's check environment is ${health.check_sha ?? "(pre-fingerprint)"}, this checkout is ${CHECK_SHA}`) +
      dim(" — flips below may come from the check environment, not the grader\n") + checkEnvDiff(health.check_env).join("\n") + "\n",
  );

for (const runDir of dirs) {
  const runMeta = JSON.parse(readFileSync(join(runDir, "run.json"), "utf8"));
  if ((runMeta.library_sha ?? null) !== serverLib) {
    console.error(
      `${runMeta.run_id}: skipped — the run recorded library ` +
        `${runMeta.library_sha ? runMeta.library_sha.slice(0, 12) + "…" : "(none)"} but the server has ` +
        `${serverLib ? serverLib.slice(0, 12) + "…" : "(none)"} baked in; restart the server to match before regrading.`,
    );
    continue;
  }
  const problemsDir = runMeta.problems_dir ?? join(ROOT, "problems");
  const probs = readdirSync(runDir).filter((f) => statSync(join(runDir, f)).isDirectory());
  console.log(bold(`\n${runMeta.run_id} (${probs.length} attempts)`));

  let flips = 0, same = 0, skipped = 0;
  for (const name of probs.sort()) {
    const attemptPath = join(runDir, name, "attempt.json");
    const solPath = join(runDir, name, "work", "problem.lean");
    if (!existsSync(attemptPath) || !existsSync(solPath)) { skipped++; continue; }
    const old = JSON.parse(readFileSync(attemptPath, "utf8"));
    const now = await grade(name, solPath, join(problemsDir, `${name}.lean`), { end: old.end ?? "completed" });
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
