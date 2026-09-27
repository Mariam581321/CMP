#!/usr/bin/env node
// Probes for runner/highwater.js bookkeeping and its failure branches. Filesystem only, no Lean.
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, chmodSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recordHighWater, readHighWater, gradeHighWater, FIRST_FILE, LAST_FILE, STAMP_FILE } from "../runner/highwater.js";

let failed = 0;
const check = (name, cond, detail = "") => {
  console.log(`${cond ? "  ok  " : "  FAIL"}  ${name}${cond || !detail ? "" : `\n        ${detail}`}`);
  if (!cond) failed++;
};
const fresh = () => mkdtempSync(join(tmpdir(), "cmp-hw-"));
const at = (i) => ({ check_index: i, turn: i * 2, cost_std: i / 100 });
const solved = () => ({ solved: true });
const unsolved = (reason = "uses_sorry") => ({ solved: false, reason, detail: "d".repeat(900) });

// ------------------------------------------------------------- first vs last
{
  const d = fresh();
  recordHighWater(d, "PROOF ONE", at(1));
  recordHighWater(d, "PROOF TWO", at(2));
  recordHighWater(d, "PROOF THREE", at(3));
  const hw = readHighWater(d);
  check("greens counts every green check", hw.greens === 3, JSON.stringify(hw.greens));
  check("first is the FIRST proof and never moves", readFileSync(join(d, FIRST_FILE), "utf8") === "PROOF ONE");
  check("last is refreshed every time", readFileSync(join(d, LAST_FILE), "utf8") === "PROOF THREE");
  check("first stamp keeps cost-at-first-proof", hw.first.check_index === 1 && hw.first.cost_std === 0.01, JSON.stringify(hw.first));
  check("last stamp is the latest", hw.last.check_index === 3);
  check("stamps carry md5 and byte length", hw.first.md5.length === 32 && hw.first.bytes === 9, JSON.stringify(hw.first));
  rmSync(d, { recursive: true, force: true });
}

{
  const d = fresh();
  recordHighWater(d, "ONLY", at(1));
  const hw = readHighWater(d);
  check("one green: first and last agree by md5", hw.first.md5 === hw.last.md5);
  rmSync(d, { recursive: true, force: true });
}

// ------------------------------------------------------------- damage cases
{
  const d = fresh();
  recordHighWater(d, "REAL FIRST", at(1));
  rmSync(join(d, STAMP_FILE));
  recordHighWater(d, "LATER", at(9));
  check("a lost stamp does not overwrite the first snapshot", readFileSync(join(d, FIRST_FILE), "utf8") === "REAL FIRST");
  rmSync(d, { recursive: true, force: true });
}

{
  const d = fresh();
  writeFileSync(join(d, STAMP_FILE), "{not json");
  check("a corrupt stamp reads as null", readHighWater(d) === null);
  check("...and the next green check still records", recordHighWater(d, "X", at(1))?.greens === 1);
  rmSync(d, { recursive: true, force: true });
}

{
  const d = fresh();
  const ro = join(d, "readonly");
  mkdirSync(ro);
  chmodSync(ro, 0o500);
  let threw = false;
  let r;
  try { r = recordHighWater(ro, "X", at(1)); } catch { threw = true; }
  check("an unwritable dir returns null rather than throwing", !threw && r === null, `threw=${threw} r=${JSON.stringify(r)}`);
  chmodSync(ro, 0o700);
  rmSync(d, { recursive: true, force: true });
}

check("no watermark at all reads as null", readHighWater(fresh()) === null);

// ------------------------------------------------------------- the grading pass
{
  const d = fresh();
  let calls = 0;
  const r = await gradeHighWater(d, () => { calls++; return solved(); });
  check("never green: null record, grader never called", r === null && calls === 0);
  rmSync(d, { recursive: true, force: true });
}

{
  const d = fresh();
  recordHighWater(d, "P", at(1));
  let calls = 0;
  const r = await gradeHighWater(d, () => { calls++; return solved(); });
  check("unchanged proof is compiled once", calls === 1, `${calls} calls`);
  check("...and both slots report it", r.ever_solved === true && r.first.solved && r.last.solved);
  rmSync(d, { recursive: true, force: true });
}

{
  const d = fresh();
  recordHighWater(d, "FIRST PROOF", at(1));
  recordHighWater(d, "BETTER PROOF", at(5));
  const seen = [];
  const r = await gradeHighWater(d, (f) => { seen.push(readFileSync(f, "utf8")); return solved(); });
  check("changed proof is compiled twice, first then last", seen.length === 2 && seen[0] === "FIRST PROOF" && seen[1] === "BETTER PROOF", JSON.stringify(seen));
  check("both stamps survive into the record", r.first.check_index === 1 && r.last.check_index === 5);
  rmSync(d, { recursive: true, force: true });
}

{
  const d = fresh();
  recordHighWater(d, "GOOD", at(1));
  const r = await gradeHighWater(d, () => solved());
  check("a held proof is ever_solved even when the attempt is not", r.ever_solved === true);
  rmSync(d, { recursive: true, force: true });
}

{
  const d = fresh();
  recordHighWater(d, "LOOKED GREEN", at(1));
  const r = await gradeHighWater(d, () => unsolved("statement_changed"));
  check("a snapshot the grader rejects is not ever_solved", r.ever_solved === false && r.first.reason === "statement_changed");
  check("the record keeps a bounded reason detail", r.first.detail.length === 500, `${r.first.detail.length}`);
  rmSync(d, { recursive: true, force: true });
}

{
  const d = fresh();
  recordHighWater(d, "P", at(1));
  rmSync(join(d, FIRST_FILE));
  const r = await gradeHighWater(d, () => solved());
  check("a missing first snapshot does not suppress the last", r.ever_solved === true && r.first === null && r.last?.solved === true, JSON.stringify(r));
  rmSync(d, { recursive: true, force: true });
}

{
  const d = fresh();
  recordHighWater(d, "P", at(1));
  rmSync(join(d, FIRST_FILE));
  rmSync(join(d, LAST_FILE));
  const r = await gradeHighWater(d, () => solved());
  check("both snapshots gone: greens kept, nothing claimed", r.greens === 1 && r.ever_solved === false && r.first === null && r.last === null, JSON.stringify(r));
  rmSync(d, { recursive: true, force: true });
}

console.log(failed ? `\n${failed} probe(s) FAILED` : "\nall high-water probes green");
process.exit(failed ? 1 : 0);
