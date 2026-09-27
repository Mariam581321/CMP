// Reading of a compile result: what is wrong with the file, and whether it would grade solved.

import { ALLOWED_AXIOMS } from "./common.js";

const plural = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;

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
  const compiles = errors.length === 0 && check.ok !== false;
  // sorryAx reached with no listed `sorry` (e.g. apply?/exact?).
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

// True iff the file would grade solved.
export const verifiedDone = (check) => checkStatus(check).done;

// Header facts in blocking order: broken, unfinished, advisory.
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
  if (status.hasStmt) facts.push(status.stmtBad ? "STATEMENT MODIFIED" : "statement intact");
  if (status.hasAxioms) facts.push(status.axBad ? `DISALLOWED AXIOMS (${axiomList(status)})` : "axioms clean");
  if (status.warnings) facts.push(plural(status.warnings, "warning"));
  return facts;
}

export const axiomList = (status) =>
  Object.entries(status.axiomsBad).map(([d, a]) => `${d}: [${a.join(", ")}]`).join("; ");

// Agent-facing explanation of blockers that are not compiler output.
export function blockerNotes(status) {
  const notes = [];
  if (status.stmtBad) {
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
