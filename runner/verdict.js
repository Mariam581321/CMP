// THE reading of a compile result: what is wrong with this file, and would it grade
// solved. Every part of the harness that answers that question reads it from here —
// the header line the agent sees first (runner/render.js), lean_check's failure
// wording, the supervisor's stop-nudging test, and the solved high-water snapshot gate
// (runner/highwater.js).
//
// Why one place: whenever two parts of the harness kept their own idea of "green" they
// drifted — on what "compiles" means, on the axiom axis (a green check on a file the
// grader fails as bad_axioms), on the sorry axis (apply?/exact? admit the goal via
// sorryAx with no listable `sorry`), and in the header itself (a CLEAN first line above
// a "you modified the theorem statement" paragraph). So `done` here is the ONLY
// definition of a green file, and the header word is derived from it rather than
// computed alongside it.

import { ALLOWED_AXIOMS } from "./common.js";

const plural = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;

/**
 * @param {object} check  a lean-server result or a `checkedCompile` result:
 *   `{ok?, messages, sorries, stmt?, axiomsBad?, axSorries?}`. `stmt`, `axiomsBad` and
 *   `axSorries` are present only where the question exists — problem.lean has a
 *   statement to preserve and benchmark declarations to axiom-check, a scratch snippet
 *   has neither — and their absence is carried through to the header rather than
 *   guessed at.
 */
export function checkStatus(check = {}) {
  const messages = check.messages ?? [];
  const errors = messages.filter((m) => m.severity === "error");
  const warnings = messages.length - errors.length;
  const sorries = check.sorries ?? [];
  const stmt = check.stmt ?? null;
  const axiomsBad = check.axiomsBad ?? null;
  const axSorries = check.axSorries ?? [];
  const stmtOriginal = check.stmtOriginal ?? null;
  const stmtBad = stmt?.ok === false;
  const axBad = axiomsBad != null && Object.keys(axiomsBad).length > 0;
  // `check.ok` is the SERVER's verdict over the WHOLE submitted body — the agent's file
  // plus the appended probe — while `errors` counts only what the agent is shown. They
  // differ exactly when the probe itself failed to elaborate (e.g. `#print axioms` on a
  // declaration the file deleted), which is never a green file, so both are required.
  const compiles = errors.length === 0 && check.ok !== false;
  // sorryAx reached without a `sorry` the server could list: apply?/exact? admit the
  // goal silently, `exact sorryAx ...` does it in a term. The grader fails these as
  // uses_sorry, so `done` must too. Surfaced
  // only when it is the ONLY sorry signal — with errors present, recovery turns every
  // failed proof into sorryAx and the report is noise; with a listed sorry the header
  // already says sorry. `done` is already false in both of those cases, so gating the
  // flag on them changes no verdict, only keeps the header honest.
  const hiddenSorry = compiles && sorries.length === 0 && axSorries.length > 0;
  const done = compiles && sorries.length === 0 && !stmtBad && !axBad && !hiddenSorry;
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
    axSorries,
    hiddenSorry,
    stmtOriginal,
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
      : status.hiddenSorry
        ? "PROOF USES sorry (admitted goal — no `sorry` token in the file)"
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
// compiler output. One wording, used by lean_check and the supervisor's nudge, so they
// cannot drift in what they claim grading does.
export function blockerNotes(status) {
  const notes = [];
  if (status.stmtBad) {
    // Quote the file to restore, not just the instruction to restore it: agents that
    // trip this have usually overwritten their only copy of the original and otherwise
    // re-guess the line from memory, sometimes for dozens of rounds.
    const quote = status.stmtOriginal
      ? `\n\nThe ORIGINAL file was, byte-exact (restore every declaration to this, keeping your ` +
        `helper lemmas above the statement and your proof in place of the sorry):\n` +
        "```\n" + (status.stmtOriginal.length > 3000
          ? status.stmtOriginal.slice(0, 3000) + "\n[... truncated]"
          : status.stmtOriginal) + "\n```"
      : "";
    notes.push(
      `you modified the theorem statement (${status.stmtDetail}). Proofs of a modified statement ` +
        `do not count. Restore the original statement exactly — you may only fill in sorries and add ` +
        `helper lemmas above it.${quote}`,
    );
  }
  if (status.axBad)
    notes.push(
      `the proof depends on disallowed axioms (${axiomList(status)}). Grading accepts only ` +
        `${[...ALLOWED_AXIOMS].join(", ")} — a proof that declares or uses any other axiom can NEVER count, ` +
        `however it is constructed. Remove the axiom declarations and prove those steps honestly.`,
    );
  if (status.hiddenSorry)
    notes.push(
      `the proof of ${status.axSorries.join(", ")} depends on \`sorryAx\` even though no \`sorry\` appears ` +
        `in the file. Search tactics like \`apply?\`/\`exact?\` do this: they print a suggestion but close ` +
        `the goal by ADMITTING it, and a term like \`sorryAx ..\` is a sorry spelled differently. Grading ` +
        `rejects the file as unsolved either way. Replace the search tactic with the proof it suggested, ` +
        `or prove the goal directly.`,
    );
  return notes;
}
