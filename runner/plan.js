// Plan-artifact check (arm 1). A *plan* is problem.lean in a state where:
//   (1) the file compiles,
//   (2) the statement is preserved,
//   (3) every `sorry` lies outside the benchmark declarations — i.e. only helper
//       lemmas may be sorry'd; the main theorem's proof (and any _solution abbrev)
//       is complete *in terms of* the helpers, so the compiler has verified the
//       reduction "helpers ⟹ theorem".
// The one fake this definition admits — a helper that merely restates the theorem —
// is scored (never gated) via token similarity between each helper's sorry goal and
// the original theorem's sorry goal, and logged in the tool-result details for
// post-hoc analysis.

import { postCheck } from "./common.js";
import { benchmarkDecls, stmtProbe, verifyStatement, stripProbeOutput } from "./grade.js";

const CLIENT_TIMEOUT_MS = 30 * 60_000; // server queue is serialized; be patient

// Start of a top-level declaration (helpers are unindented in practice; the
// type-level statement check guarantees each benchmark decl still *exists* under
// its name — the region scan below is a best-effort line heuristic on top).
const DECL_RE =
  /^(?:@\[[^\]]*\]\s*)?(?:private\s+|protected\s+|noncomputable\s+|partial\s+)*(?:theorem|lemma|abbrev|def|example|instance|opaque|axiom|structure|inductive|corollary)\b/;

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// 1-indexed inclusive line regions of the named declarations; a region runs to the
// next top-level declaration or EOF.
export function declRegions(source, names) {
  const lines = source.split("\n");
  const declStarts = [];
  for (let i = 0; i < lines.length; i++) if (DECL_RE.test(lines[i])) declStarts.push(i + 1);
  const regions = [];
  for (const name of names) {
    const re = new RegExp(
      `^(?:@\\[[^\\]]*\\]\\s*)?(?:private\\s+|protected\\s+|noncomputable\\s+|partial\\s+)*(?:theorem|lemma|abbrev|def)\\s+${esc(name)}\\b`,
    );
    const start = declStarts.find((ln) => re.test(lines[ln - 1]));
    if (!start) continue;
    const next = declStarts.find((ln) => ln > start);
    regions.push({ name, start, end: next ? next - 1 : lines.length });
  }
  return regions;
}

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
  // statement probe rides on the same request; sorries keep their line numbers
  // since the probe is appended below the solution
  const check = await postCheck({ code: `${solution}\n${stmtProbe(benchmarkDecls(original))}\n` }, CLIENT_TIMEOUT_MS);
  if (check.error) return { ok: false, text: stripProbeOutput(check.pretty) || `lean server error: ${check.error}`, details: { ok: false, reason: "server_error" }, isError: true };
  const pretty = stripProbeOutput(check.pretty);

  const stmt = await verifyStatement(problemName, original, check.messages);
  if (!stmt.ok)
    return {
      ok: false,
      text:
        `PLAN CHECK FAILED: you modified the theorem statement (${stmt.detail}). ` +
        `Restore the original statement exactly; helper lemmas go above it.`,
      details: { ok: false, reason: "statement_changed" },
    };

  if (!check.ok)
    return {
      ok: false,
      text: `PLAN CHECK FAILED: the file does not compile. A plan must compile (helper bodies may be \`sorry\`).\n\n${pretty}`,
      details: { ok: false, reason: "compile_error" },
    };

  const names = benchmarkDecls(original);
  const regions = declRegions(solution, names);
  const sorries = check.sorries ?? [];
  const inMain = sorries.filter((s) => regions.some((r) => s.line >= r.start && s.line <= r.end));
  const helperSorries = sorries.filter((s) => !inMain.includes(s));

  if (inMain.length > 0) {
    const where = inMain
      .map((s) => `line ${s.line} (inside ${regions.find((r) => s.line >= r.start && s.line <= r.end).name})`)
      .join(", ");
    return {
      ok: false,
      text:
        `PLAN CHECK FAILED: \`sorry\` at ${where}. In a valid plan, the main theorem's proof ` +
        `(and any _solution abbrev) must be complete, written in terms of sorry'd helper lemmas stated above it. ` +
        `Move the unknown parts into helper lemmas and make the main proof use them.`,
      details: { ok: false, reason: "sorry_in_main", sorry_lines: inMain.map((s) => s.line) },
    };
  }

  // Restatement score: max similarity of each helper's sorry goal to the original
  // theorem's sorry goal(s). Logged only — never shown to the agent, never gated.
  let helpers = [];
  try {
    const orig = await postCheck({ code: original }, CLIENT_TIMEOUT_MS);
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
  if (sorries.length === 0)
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
