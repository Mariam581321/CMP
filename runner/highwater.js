// The solved high-water mark: proof that an attempt HELD a verified solution, kept
// separately from the verdict on the file it finally submitted.
//
// Grading reads exactly one artefact — the final problem.lean (run.js -> grade.js). An
// attempt that reaches a verified proof and then wrecks it (the agent decides to
// simplify; the budget SIGKILL catches the file mid-edit) is recorded as whatever the
// last write happened to leave behind, and nothing in the record says the proof ever
// existed. So every time a check passes the done-gate, the exact bytes are snapshotted
// beside the attempt and stamped with where in the attempt it happened.
//
// Recording only, deliberately: `solved` stays the verdict on the final file and the
// snapshot verdicts are separate fields, so this can land mid-grid without making the
// cells already run incomparable. Nothing here is visible to the agent — the snapshots
// are written to the ATTEMPT dir, one level above the work dir that file-sandbox.ts
// confines every file tool to.

import { createHash } from "node:crypto";
import { writeFileSync, renameSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

export const FIRST_FILE = "highwater-first.lean";
export const LAST_FILE = "highwater-last.lean";
export const STAMP_FILE = "highwater.json";

// THE done-gate, in one place. `checkedCompile` (runner/stmt.js) computes every
// component; this is the reading of them that means "this file would grade solved".
// The supervisor's stop-nudging test and this watermark MUST be the same predicate:
// they answer the same question about the same result object, and the last time two
// parts of the harness each kept their own idea of "compiles" the agent-facing check
// and the grader drifted apart (fixed 2026-07-27, and again on the axiom axis 0804).
//
// Note what `ok` alone does NOT cover: `ok` is "no error-severity messages", so a file
// full of sorries has ok:true. Sorries, the statement verdict and the axiom verdict are
// each separate fields, and all four have to hold.
export function verifiedDone(check) {
  return (
    check?.ok === true &&
    (check.sorries ?? []).length === 0 &&
    check.stmt?.ok !== false &&
    Object.keys(check.axiomsBad ?? {}).length === 0
  );
}

// Atomic within the filesystem: a run reading these files (or a scan, or the next
// attempt's grader) sees either the whole previous snapshot or the whole new one.
// Never a torn file, which for a .lean snapshot would be a fake compile_error.
function writeAtomic(path, content) {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, content);
  renameSync(tmp, path);
}

/**
 * Record one green check. Call this for every check that passes `verifiedDone`.
 *
 * The FIRST green is written once and never overwritten — it is the answer to "when
 * did this attempt first hold a proof", and its `cost_std` is cost-at-first-proof,
 * which is not the same number as cost at attempt end. The LAST green is refreshed
 * every time, because an agent that improves a proof and then breaks it should be
 * judged on the best file it ever had, not only the first one that worked.
 *
 * @param {string} dir attempt dir (the parent of work/) — outside the agent's sandbox
 * @param {string} code the exact bytes that were checked
 * @param {{check_index:number, turn:number, cost_std:number}} at where in the attempt
 * @returns {object|null} the updated stamp, or null if nothing could be written
 */
export function recordHighWater(dir, code, at) {
  try {
    const stamp = {
      ...at,
      md5: createHash("md5").update(code).digest("hex"),
      bytes: Buffer.byteLength(code),
      wall_at: new Date().toISOString(),
    };
    let prev = {};
    try { prev = JSON.parse(readFileSync(join(dir, STAMP_FILE), "utf8")); } catch {}
    // existsSync as well as prev.first: if the stamp file was lost but the snapshot
    // survived, the first proof is still the one on disk, not this one.
    const isFirst = !prev.first && !existsSync(join(dir, FIRST_FILE));
    if (isFirst) writeAtomic(join(dir, FIRST_FILE), code);
    writeAtomic(join(dir, LAST_FILE), code);
    const next = { first: isFirst ? stamp : prev.first, last: stamp, greens: (prev.greens ?? 0) + 1 };
    writeAtomic(join(dir, STAMP_FILE), JSON.stringify(next, null, 1));
    return next;
  } catch {
    // A snapshot is a bonus record, never a reason to fail a check the agent is
    // waiting on: a full disk must cost the watermark, not the attempt.
    return null;
  }
}

// Read side, for run.js. Returns null when the attempt never reached a green check —
// which is the ordinary case, not an error.
export function readHighWater(dir) {
  try { return JSON.parse(readFileSync(join(dir, STAMP_FILE), "utf8")); } catch { return null; }
}
