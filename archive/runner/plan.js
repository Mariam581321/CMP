// Plan check: problem.lean compiles, the statement is intact, and only helper lemmas reach `sorry`.

import { postCheck } from "./common.js";
import { CLIENT_WAIT_MS } from "./check-env.js";
import { checkedCompile, benchmarkDecls } from "./stmt.js";
import { checkStatus, blockerNotes } from "./verdict.js";

// Jaccard similarity over the token sets of two goals.
export function goalSimilarity(a, b) {
  const toks = (s) => new Set(String(s).split(/[\s(),{}⟨⟩[\]]+/).filter(Boolean));
  const A = toks(a), B = toks(b);
  if (A.size === 0 || B.size === 0) return 0;
  let inter = 0;
  for (const t of A) if (B.has(t)) inter++;
  return inter / (A.size + B.size - inter);
}

// Returns { ok, text, details }: text is agent-facing, details are for the log.
export async function planCheck(original, solution, problemName = "adhoc") {
  const check = await checkedCompile(solution, { original, problemName, client: problemName });
  if (check.rejected)
    return { ok: false, text: check.pretty, details: { ok: false, reason: check.rejected } };
  if (check.error)
    return { ok: false, text: check.pretty || `lean server error: ${check.error}`, details: { ok: false, reason: "server_error" }, isError: true };

  const status = checkStatus(check);
  if (status.stmtBad || status.axBad)
    return {
      ok: false,
      text:
        blockerNotes(status).map((n) => `PLAN CHECK FAILED: ${n}`).join("\n\n") +
        (status.axBad ? "\n\nIn a plan, unknown steps belong in sorry'd helper lemmas — that is what a plan is." : ""),
      details: { ok: false, reason: status.stmtBad ? "statement_changed" : "bad_axioms" },
    };

  if (!status.compiles)
    return {
      ok: false,
      text: `PLAN CHECK FAILED: the file does not compile. A plan must compile (helper bodies may be \`sorry\`).\n\n${check.pretty}`,
      details: { ok: false, reason: "compile_error" },
    };

  const names = benchmarkDecls(original);
  const inMain = names.filter((d) => check.probe[d]?.direct_sorry);
  if (inMain.length > 0) {
    return {
      ok: false,
      text:
        `PLAN CHECK FAILED: the proof of ${inMain.join(" and ")} still reaches \`sorry\` directly. ` +
        `In a valid plan, the main theorem's proof (and any _solution abbrev) must be complete, ` +
        `written in terms of sorry'd helper lemmas stated above it. ` +
        `Move the unknown parts into helper lemmas and make the main proof use them.`,
      details: { ok: false, reason: "sorry_in_main", decls: inMain },
    };
  }

  // Main decls are sorry-free, so every reported sorry belongs to a helper.
  const helperSorries = check.sorries ?? [];

  // Restatement score: similarity of each helper's sorry goal to the original theorem's goals (logged only).
  let helpers = [];
  try {
    const orig = await postCheck({ code: original, client: problemName }, CLIENT_WAIT_MS);
    const origGoals = (orig.sorries ?? []).map((s) => s.goal).filter(Boolean);
    helpers = helperSorries.map((s) => ({
      line: s.line,
      goal: s.goal,
      restatement_similarity: origGoals.length ? Math.max(...origGoals.map((g) => goalSimilarity(s.goal, g))) : null,
    }));
  } catch {
    helpers = helperSorries.map((s) => ({ line: s.line, goal: s.goal, restatement_similarity: null }));
  }

  const details = {
    ok: true,
    n_helper_sorries: helperSorries.length,
    helpers,
    max_restatement_similarity: helpers.length ? Math.max(...helpers.map((h) => h.restatement_similarity ?? 0)) : null,
  };
  if (helperSorries.length === 0)
    return { ok: true, text: "PLAN CHECK PASSED — and the file is fully proved (no sorries left). Run lean_check to confirm you are done.", details };
  return {
    ok: true,
    text:
      `PLAN CHECK PASSED: the file compiles, the statement is intact, and the main proof is complete ` +
      `modulo ${helperSorries.length} sorry'd helper lemma(s) (lines ${helperSorries.map((s) => s.line).join(", ")}). ` +
      `The compiler has verified that these helpers suffice. Now prove them one at a time with lean_check.`,
    details,
  };
}
