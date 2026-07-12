// Independent grading of a finished attempt. Never trusts the agent's own lean_check.
// Checks: (1) theorem statement preserved vs the sanitized original,
//         (2) file compiles under Lean+Mathlib,
//         (3) #print axioms for every benchmark declaration is clean
//             (catches sorry via sorryAx, custom axioms, native_decide via ofReduceBool).

import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { withLeanSlot } from "./lean-slots.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const LEAN_ENV = process.env.CMP_LEAN_ENV ?? join(ROOT, "lean-env");
const ALLOWED_AXIOMS = new Set(["propext", "Classical.choice", "Quot.sound"]);
const GRADE_TIMEOUT_MS = 600_000;

// Names of the declarations the benchmark expects (theorem + optional _solution abbrev).
export function benchmarkDecls(originalSource) {
  const decls = [];
  for (const m of originalSource.matchAll(/^\s*(?:noncomputable\s+)?(?:abbrev|def|theorem)\s+([\w.]+)/gm)) {
    decls.push(m[1]);
  }
  return decls;
}

// Every code line of the original (except bare `sorry`) must survive verbatim in the
// solution; for `... := sorry` lines the `... :=` prefix must survive as a line prefix.
// Docstrings /-- ... -/ are comments: deleting them is harmless, so they're not required.
export function checkStatementPreserved(original, solution) {
  const solLines = solution.split("\n");
  const solSet = new Set(solLines.map((l) => l.trimEnd()));
  let inDocstring = false;
  for (const line of original.split("\n")) {
    const stripped = line.trim();
    if (inDocstring) {
      if (stripped.endsWith("-/")) inDocstring = false;
      continue;
    }
    if (stripped.startsWith("/--")) {
      if (!stripped.endsWith("-/") || stripped === "/--") inDocstring = true;
      continue;
    }
    if (stripped === "sorry" || stripped === "") continue;
    if (stripped.includes(":= sorry")) {
      const prefix = line.replace(/:=\s*sorry.*$/, ":=").trimEnd();
      if (!solLines.some((sl) => sl.trimEnd().startsWith(prefix.trim()) || sl.trimEnd() === prefix))
        return { ok: false, detail: `modified: ${stripped}` };
      continue;
    }
    if (!solSet.has(line.trimEnd()))
      return { ok: false, detail: `missing/modified line: ${stripped}` };
  }
  return { ok: true };
}

function runLean(file) {
  return new Promise((res) => {
    execFile(
      "lake",
      ["env", "lean", file],
      { cwd: LEAN_ENV, timeout: GRADE_TIMEOUT_MS, maxBuffer: 10 * 1024 * 1024 },
      (err, stdout, stderr) => {
        res({ out: `${stdout ?? ""}\n${stderr ?? ""}`.trim(), code: err ? ((err.code ?? 1)) : 0 });
      },
    );
  });
}

/**
 * @returns {Promise<{solved: boolean, reason?: string, detail?: string, axioms?: object}>}
 */
export async function grade(problemName, solutionPath, originalPath) {
  if (!existsSync(solutionPath)) return { solved: false, reason: "no_file", detail: "problem.lean missing" };
  const original = readFileSync(originalPath, "utf8");
  const solution = readFileSync(solutionPath, "utf8");

  const stmt = checkStatementPreserved(original, solution);
  if (!stmt.ok) return { solved: false, reason: "statement_changed", detail: stmt.detail };

  const decls = benchmarkDecls(original);
  if (decls.length === 0) return { solved: false, reason: "grader_error", detail: "no declarations found in original" };

  const dir = join(LEAN_ENV, "_grade");
  mkdirSync(dir, { recursive: true });
  const tmp = join(dir, `${problemName}_${Date.now()}_${Math.floor(Math.random() * 1e6)}.lean`);
  const probes = decls.map((d) => `#print axioms ${d}`).join("\n");
  writeFileSync(tmp, `${solution}\n\n${probes}\n`);
  try {
    const { out, code } = await withLeanSlot(LEAN_ENV, () => runLean(tmp));
    if (code !== 0) return { solved: false, reason: "compile_error", detail: out.slice(0, 4000) };

    const axioms = {};
    for (const d of decls) {
      const esc = d.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const m =
        out.match(new RegExp(`'${esc}' depends on axioms: \\[([^\\]]*)\\]`)) ??
        (out.match(new RegExp(`'${esc}' does not depend on any axioms`)) ? [null, ""] : null);
      if (!m) return { solved: false, reason: "grader_error", detail: `no axiom report for ${d}\n${out.slice(0, 2000)}` };
      axioms[d] = m[1] === "" ? [] : m[1].split(",").map((s) => s.trim());
      const bad = axioms[d].filter((a) => !ALLOWED_AXIOMS.has(a));
      if (bad.length > 0) {
        const reason = bad.includes("sorryAx") ? "uses_sorry" : "bad_axioms";
        return { solved: false, reason, detail: `${d}: [${bad.join(", ")}]`, axioms };
      }
    }
    return { solved: true, axioms };
  } finally {
    rmSync(tmp, { force: true });
  }
}

// CLI: node runner/grade.js <problem_name> <solution.lean>
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [name, sol] = process.argv.slice(2);
  const orig = join(ROOT, "problems", `${name}.lean`);
  grade(name, resolve(sol), orig).then((r) => {
    console.log(JSON.stringify(r, null, 2));
    process.exit(r.solved ? 0 : 1);
  });
}
