// THE reading of a compile result: what is wrong with this file, and would it grade
// solved. Every part of the harness that answers that question reads it from here —
// the header line the agent sees first (runner/render.js), lean_check's and
// plan_check's failure wording, the supervisor's stop-nudging test, and the solved
// high-water snapshot gate (runner/highwater.js).
//
// Why one place. Every time two parts of this harness kept their own idea of "green"
// they drifted, and the drift was only ever visible after a run:
//   * agent-facing check vs grader on what "compiles" means (fixed 2026-07-27);
//   * the axiom axis — lean_check said green on a file the grader failed as
//     bad_axioms (2026-08-04, spawn-fatex10-0804 fatex_99 and three 0802 incidents);
//   * the header itself (fixed here, 2026-08-07): it was computed from the compiler's
//     messages alone, so a file with a rewritten statement or a smuggled axiom opened
//     with `CLEAN — no errors, no sorries` and then had a `CHECK FAILED: you modified
//     the theorem statement` paragraph glued on above it. The first 200 characters —
//     the part of a check that is designed to be unmissable — said the opposite of the
//     verdict. 683 checks across the two block-A cells carried that contradiction.
// So `done` here is the ONLY definition of a green file, and the header word is
// derived from it rather than computed alongside it.

import { ALLOWED_AXIOMS } from "./common.js";

const plural = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;

/**
 * @param {object} check  a lean-server result or a `checkedCompile` result:
 *   `{ok?, messages, sorries, stmt?, axiomsBad?}`. `stmt` and `axiomsBad` are present
 *   only where the question exists — problem.lean has a statement to preserve and
 *   benchmark declarations to axiom-check, a scratch snippet has neither — and their
 *   absence is carried through to the header rather than guessed at.
 */
export function checkStatus(check = {}) {
  const messages = check.messages ?? [];
  const errors = messages.filter((m) => m.severity === "error");
  const warnings = messages.length - errors.length;
  const sorries = check.sorries ?? [];
  const stmt = check.stmt ?? null;
  const axiomsBad = check.axiomsBad ?? null;
  const stmtBad = stmt?.ok === false;
  const axBad = axiomsBad != null && Object.keys(axiomsBad).length > 0;
  // `check.ok` is the SERVER's verdict over the WHOLE submitted body — the agent's file
  // plus the appended probe — while `errors` counts only what the agent is shown. They
  // differ exactly when the probe itself failed to elaborate (e.g. `#print axioms` on a
  // declaration the file deleted), which is never a green file, so both are required.
  const compiles = errors.length === 0 && check.ok !== false;
  const done = compiles && sorries.length === 0 && !stmtBad && !axBad;
  return {
    errors: errors.length,
    warnings,
    sorries,
    hasStmt: stmt != null,
    hasAxioms: axiomsBad != null,
    stmtBad,
    stmtDetail: stmt?.detail ?? null,
    axiomsBad: axiomsBad ?? {},
    axBad,
    compiles,
    done,
    label: done ? "COMPLETE" : compiles && !stmtBad && !axBad ? "INCOMPLETE" : "FAILED",
  };
}

// The one predicate that means "this file would grade solved". Read by the supervisor
// (stop nudging) and by the high-water watermark (snapshot these bytes) — they answer
// the same question about the same object and must never answer it differently.
export const verifiedDone = (check) => checkStatus(check).done;

// The header's facts, in blocking order: what is broken first, then what is merely
// unfinished, then what is only advisory. `errDistinct` comes from the renderer, which
// is where identical message texts get collapsed.
export function headerFacts(status, errDistinct = status.errors) {
  const facts = [];
  facts.push(
    status.errors
      ? errDistinct < status.errors
        ? `${status.errors} errors (${errDistinct} distinct)`
        : plural(status.errors, "error")
      : "no errors",
  );
  facts.push(
    status.sorries.length
      ? `${status.sorries.length} sorr${status.sorries.length === 1 ? "y" : "ies"} at line ${status.sorries.map((s) => s.line).join(", ")}`
      : "no sorries",
  );
  // Only claimed where it was actually checked: a snippet has no statement to preserve,
  // so saying "statement intact" about one would be an invented guarantee.
  if (status.hasStmt) facts.push(status.stmtBad ? "STATEMENT MODIFIED" : "statement intact");
  if (status.hasAxioms) facts.push(status.axBad ? `DISALLOWED AXIOMS (${axiomList(status)})` : "axioms clean");
  if (status.warnings) facts.push(plural(status.warnings, "warning"));
  return facts;
}

export const axiomList = (status) =>
  Object.entries(status.axiomsBad).map(([d, a]) => `${d}: [${a.join(", ")}]`).join("; ");

// The agent-facing explanation of everything blocking this file that is NOT ordinary
// compiler output. One wording, used by lean_check, plan_check and the supervisor's
// nudge — three places that used to carry three near-copies of these paragraphs and
// could drift in what they claimed grading does.
export function blockerNotes(status) {
  const notes = [];
  if (status.stmtBad)
    notes.push(
      `you modified the theorem statement (${status.stmtDetail}). Proofs of a modified statement ` +
        `do not count. Restore the original statement exactly — you may only fill in sorries and add ` +
        `helper lemmas above it.`,
    );
  if (status.axBad)
    notes.push(
      `the proof depends on disallowed axioms (${axiomList(status)}). Grading accepts only ` +
        `${[...ALLOWED_AXIOMS].join(", ")} — a proof that declares or uses any other axiom can NEVER count, ` +
        `however it is constructed. Remove the axiom declarations and prove those steps honestly.`,
    );
  return notes;
}
