// Plan-artifact check (arm 1). A *plan* is problem.lean in a state where:
//   (1) the file compiles,
//   (2) the statement is preserved,
//   (3) no benchmark declaration's own proof term reaches `sorry` directly — i.e.
//       only helper lemmas may be sorry'd; the main theorem's proof (and any
//       _solution abbrev) is complete *in terms of* the helpers, so the compiler has
//       verified the reduction "helpers ⟹ theorem".
// (3) is decided by the statement probe (runner/stmt.js), which walks each benchmark
// declaration's proof term in the environment — a sorry inside a referenced helper
// lemma lives in the helper's value and does not count against the plan. No source
// line heuristics.
// The one fake this definition admits — a helper that merely restates the theorem —
// is scored (never gated) via token similarity between each helper's sorry goal and
// the original theorem's sorry goal, and logged in the tool-result details for
// post-hoc analysis.

import { postCheck } from "./common.js";
import { checkedCompile, benchmarkDecls, AGENT_CHECK_TIMEOUT_MS } from "./stmt.js";

const CLIENT_WAIT_MS = 30 * 60_000; // server queue is serialized; be patient

// Crude goal similarity: Jaccard over the token sets of the pretty-printed goals.
// A helper that restates the theorem reproduces its sorry goal almost verbatim.
export function goalSimilarity(a, b) {
  const toks = (s) => new Set(String(s).split(/[\s(),{}⟨⟩[\]]+/).filter(Boolean));
  const A = toks(a), B = toks(b);
  if (A.size === 0 || B.size === 0) return 0;
  let inter = 0;
  for (const t of A) if (B.has(t)) inter++;
  return inter / (A.size + B.size - inter);
}

/**
 * Check whether `solution` is currently a valid plan for `original`.
 * `problemName` keys the original-side type cache (basename of the problem file);
 * the sha guard keeps a wrong/default name correct, just uncached.
 * Returns { ok, text, details } — text is agent-facing, details are for the log.
 */
export async function planCheck(original, solution, problemName = "adhoc") {
  const check = await checkedCompile(solution, { original, problemName, client: problemName });
  if (check.rejected)
    return { ok: false, text: check.pretty, details: { ok: false, reason: check.rejected } };
  if (check.error)
    return { ok: false, text: check.pretty || `lean server error: ${check.error}`, details: { ok: false, reason: "server_error" }, isError: true };

  if (!check.stmt.ok)
    return {
      ok: false,
      text:
        `PLAN CHECK FAILED: you modified the theorem statement (${check.stmt.detail}). ` +
        `Restore the original statement exactly; helper lemmas go above it.`,
      details: { ok: false, reason: "statement_changed" },
    };

  if (!check.ok)
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

  // Restatement score: max similarity of each helper's sorry goal to the original
  // theorem's sorry goal(s). Logged only — never shown to the agent, never gated.
  let helpers = [];
  try {
    const orig = await postCheck({ code: original, timeoutMs: AGENT_CHECK_TIMEOUT_MS, client: problemName }, CLIENT_WAIT_MS);
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
