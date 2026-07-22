// Independent grading of a finished attempt. Never trusts the agent's own lean_check.
// Checks: (1) theorem statement preserved vs the sanitized original,
//         (2) file compiles (via the persistent lean server),
//         (3) #print axioms for every benchmark declaration is clean
//             (catches sorry via sorryAx, custom axioms, native_decide via ofReduceBool).

import { readFileSync, existsSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { postCheck, classifyLines } from "./common.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ALLOWED_AXIOMS = new Set(["propext", "Classical.choice", "Quot.sound"]);
const GRADE_TIMEOUT_MS = 480_000;

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
// Lines ending in bare `:=` (proof on the next line) get the same prefix rule: the
// statement ends at `:=`, so continuing the line (e.g. `:= by`) only adds proof content.
// Docstrings/comments/blanks are not required — deleting them is harmless.
export function checkStatementPreserved(original, solution) {
  const solLines = solution.split("\n");
  const solSet = new Set(solLines.map((l) => l.trimEnd()));
  for (const { line, kind } of classifyLines(original)) {
    if (kind !== "code") continue;
    const stripped = line.trim();
    if (stripped === "sorry") continue;
    if (stripped.includes(":= sorry")) {
      const prefix = line.replace(/:=\s*sorry.*$/, ":=").trimEnd();
      if (!solLines.some((sl) => sl.trimEnd().startsWith(prefix.trim()) || sl.trimEnd() === prefix))
        return { ok: false, detail: `modified: ${stripped}` };
      continue;
    }
    if (stripped.endsWith(":=")) {
      if (!solLines.some((sl) => sl.trimEnd().startsWith(line.trimEnd())))
        return { ok: false, detail: `missing/modified line: ${stripped}` };
      continue;
    }
    if (!solSet.has(line.trimEnd()))
      return { ok: false, detail: `missing/modified line: ${stripped}` };
  }
  return { ok: true };
}

// timeoutMs bounds REPL execution; the client waits longer since queueing is unbounded.
export function serverCheck(code, timeoutMs = GRADE_TIMEOUT_MS) {
  return postCheck({ code, timeoutMs }, 30 * 60_000);
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

  const probes = decls.map((d) => `#print axioms ${d}`).join("\n");
  let r;
  try {
    r = await serverCheck(`${solution}\n\n${probes}\n`);
  } catch (e) {
    return { solved: false, reason: "grader_error", detail: `lean server unreachable: ${e.message}` };
  }
  if (r.error) return { solved: false, reason: "grader_error", detail: r.error };
  if (!r.ok) return { solved: false, reason: "compile_error", detail: (r.pretty ?? "").slice(0, 4000) };

  const allText = (r.messages ?? []).map((m) => m.text).join("\n");
  const axioms = {};
  for (const d of decls) {
    const esc = d.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const m =
      allText.match(new RegExp(`'${esc}' depends on axioms: \\[([^\\]]*)\\]`)) ??
      (allText.match(new RegExp(`'${esc}' does not depend on any axioms`)) ? [null, ""] : null);
    if (!m) return { solved: false, reason: "grader_error", detail: `no axiom report for ${d}\n${allText.slice(0, 2000)}` };
    axioms[d] = m[1] === "" ? [] : m[1].split(",").map((s) => s.trim());
    const bad = axioms[d].filter((a) => !ALLOWED_AXIOMS.has(a));
    if (bad.length > 0) {
      const reason = bad.includes("sorryAx") ? "uses_sorry" : "bad_axioms";
      return { solved: false, reason, detail: `${d}: [${bad.join(", ")}]`, axioms };
    }
  }
  return { solved: true, axioms };
}

// CLI: node runner/grade.js <problem_name> <solution.lean>   (needs the lean server up)
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [name, sol] = process.argv.slice(2);
  const orig = join(ROOT, "problems", `${name}.lean`);
  grade(name, resolve(sol), orig).then((r) => {
    console.log(JSON.stringify(r, null, 2));
    process.exit(r.solved ? 0 : 1);
  });
}
