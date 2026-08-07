#!/usr/bin/env node
// THE invariant of this harness, checked against real Lean: what the agent watches and
// what the grader records are the same verdict.
//
// "A solve must be observable inside the agent's own feedback loop" (2026-07-27) has been
// violated three times, each time on a new axis and each time only visible after a run:
//   * the agent's check and the grader disagreed about what "compiles" means;
//   * a smuggled `axiom` passed compile, statement and sorry checks, so lean_check said
//     green and the grader failed the finished attempt as bad_axioms (0804, fatex_99);
//   * the header said CLEAN on a file whose statement had been rewritten (0807).
// So this probe builds one file per fault class, asks checkedCompile (the agent's path)
// and grade() (the recorded path) about each, and fails if they ever disagree — including
// on the WORD the agent reads first.
//
//   node scripts/probe-grade-agreement.mjs      (needs the lean server up; ~15 s)
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkedCompile } from "../runner/stmt.js";
import { checkStatus } from "../runner/verdict.js";
import { grade } from "../runner/grade.js";
import { LEAN_URL } from "../runner/common.js";

let failed = 0;
const check = (name, cond, detail = "") => {
  console.log(`${cond ? "  ok  " : "  FAIL"}  ${name}${cond || !detail ? "" : `\n        ${detail}`}`);
  if (!cond) failed++;
};

const up = await fetch(`${LEAN_URL}/health`, { signal: AbortSignal.timeout(2000) }).then((r) => r.json()).catch(() => null);
if (!up?.ready) {
  console.log(`  skip  no lean server on ${LEAN_URL}`);
  process.exit(0);
}

// A fixture with everything the grader looks at: a setup def whose BODY is part of the
// statement, a namespace (so the probe has to work with qualified names), and a sorry.
const ORIGINAL = `import Mathlib

namespace CmpProbe

def helper (n : ℕ) : ℕ := n + 1

theorem probe_thm (n : ℕ) : helper n = n + 1 := by
  sorry

end CmpProbe
`;
const dir = mkdtempSync(join(tmpdir(), "cmp-agree-"));
const origPath = join(dir, "cmp_probe.lean");
writeFileSync(origPath, ORIGINAL);

// [name, file, expected header word, expected grade reason (null = solved)]
const CASES = [
  ["a real proof", ORIGINAL.replace("  sorry", "  rfl"), "COMPLETE", null],
  ["a sorry left", ORIGINAL, "INCOMPLETE", "uses_sorry"],
  ["does not compile", ORIGINAL.replace("  sorry", "  exact absurd rfl (by simp)"), "FAILED", "compile_error"],
  ["statement rewritten", ORIGINAL.replace("helper n = n + 1", "helper n = helper n").replace("  sorry", "  rfl"), "FAILED", "statement_changed"],
  // The setup-def hole: the theorem's TYPE is untouched (it names `helper`), only the
  // body moved. Verified exploitable 2026-07-28 before the value probe existed.
  ["setup def gutted", ORIGINAL.replace("def helper (n : ℕ) : ℕ := n + 1", "def helper (n : ℕ) : ℕ := n + 1 + 0"), "FAILED", "statement_changed"],
  ["smuggled axiom", ORIGINAL.replace("theorem probe_thm", "axiom cheat : ∀ n : ℕ, helper n = n + 1\n\ntheorem probe_thm").replace("  sorry", "  exact cheat n"), "FAILED", "bad_axioms"],
  // Renaming the theorem makes `#print axioms` in the probe region fail to resolve; the
  // statement verdict has to speak first, and the probe's own error must not read as the
  // agent's file failing to compile.
  ["theorem renamed away", ORIGINAL.replace("theorem probe_thm", "theorem probe_other").replace("  sorry", "  rfl"), "FAILED", "statement_changed"],
];

const solPath = join(dir, "solution.lean");
for (const [name, code, word, reason] of CASES) {
  const r = await checkedCompile(code, { original: ORIGINAL, problemName: "cmp_probe", client: "probe" });
  const s = checkStatus(r);
  writeFileSync(solPath, code);
  const g = await grade("cmp_probe", solPath, origPath);
  const header = r.pretty.split("\n")[0];
  check(`${name}: agent and grader agree`, s.done === g.solved,
    `done=${s.done} grade.solved=${g.solved} (${g.reason ?? "solved"})`);
  check(`${name}: header word is ${word}`, header.startsWith(word), header.slice(0, 100));
  check(`${name}: grades ${reason ?? "solved"}`, (g.reason ?? null) === reason, `${g.reason}: ${(g.detail ?? "").split("\n")[0]}`);
}

rmSync(dir, { recursive: true, force: true });
console.log(failed ? `\n${failed} probe(s) FAILED` : "\nagent-visible verdict and recorded verdict agree on every fault class");
process.exit(failed ? 1 : 0);
