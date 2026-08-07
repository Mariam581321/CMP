#!/usr/bin/env node
// Probes for runner/edit.js — the always-on `edit` tool that shadows pi's built-in.
// Pure string work, no Lean.
//
// This tool exists because pi's own edit corrupts Lean source: its fuzzy matcher
// NFKC-normalizes and writes touched lines back from normalized space, so ℕ becomes N
// and x⁻¹ becomes x-1 on any fuzzy-matched edit — a "successful" edit that silently
// breaks the file. Everything below pins the two behaviours that replaced it and the
// failure wording, which is a real channel: 4% of edit calls in the block-A cells failed
// to match, and what comes back is what decides whether that costs one turn or five.
//
//   node scripts/probe-edit.mjs
import { applyEdits, closestRegion, normalizeEditArgs } from "../runner/edit.js";

let failed = 0;
const check = (name, cond, detail = "") => {
  console.log(`${cond ? "  ok  " : "  FAIL"}  ${name}${cond || !detail ? "" : `\n        ${detail}`}`);
  if (!cond) failed++;
};
const fails = (fn) => { try { fn(); return null; } catch (e) { return e.message; } };

// ------------------------------------------------------- Lean unicode survives
{
  const src = "theorem foo (n : ℕ) (x : ℝ) : x⁻¹ * x = 1 := by\n  sorry\n";
  // A trailing-whitespace mismatch is the ONE thing fuzzy matching heals, so this edit
  // takes the fuzzy path — the path that used to mangle the rest of the file.
  const { newContent } = applyEdits(src.replace(":= by\n", ":= by  \n"), [{ oldText: "  sorry", newText: "  simp" }], "problem.lean");
  check("fuzzy edit preserves ℕ ℝ ⁻¹", newContent.includes("ℕ") && newContent.includes("ℝ") && newContent.includes("x⁻¹"), newContent);
  check("fuzzy edit applied", newContent.includes("simp") && !newContent.includes("sorry"));
}

// An oldText ending in a newline used to get that newline back twice on the fuzzy path,
// silently inserting a blank line per edit.
{
  const src = "a  \nb\nc\n";
  const { newContent } = applyEdits(src, [{ oldText: "b\n", newText: "B\n" }], "f.lean");
  check("no blank line inserted by a fuzzy edit", newContent === "a  \nB\nc\n", JSON.stringify(newContent));
}

// -------------------------------------------------------------- failure wording
{
  const src = Array.from({ length: 40 }, (_, i) => `line ${i} of the proof`).join("\n");
  const msg = fails(() => applyEdits(src, [{ oldText: "line 20 of the PROOF", newText: "x" }], "problem.lean"));
  check("a near miss returns the closest region", msg?.includes("Closest region in the file") && msg.includes("line 20 of the proof"), msg?.slice(0, 120));
  const far = fails(() => applyEdits(src, [{ oldText: "nothing like this exists at all here", newText: "x" }], "problem.lean"));
  check("a total miss says to re-read instead", far?.includes("Nothing similar found"), far?.slice(0, 120));
}

// The region snippet is what lets the model fix its oldText in one turn. 600 chars cut
// it on 44% of the 454 failed matches across both block-A cells; 2000 is sized from what
// those regions would have been (p50 749, p75 1465), so an ordinary multi-line Lean block
// survives whole and only the pathological oldText is cut — where the answer is to
// re-read the file, which the message says, not to be handed more of it.
{
  const src = Array.from({ length: 60 }, (_, i) => `  have h${i} : some ${"long ".repeat(12)}fact ${i} := by positivity`).join("\n");
  const ordinary = closestRegion(src, Array.from({ length: 12 }, (_, i) => `  have h${i} : nope`).join("\n"));
  check("an ordinary multi-line block survives whole", !ordinary.snippet.endsWith(" …"), `${ordinary.snippet.length} chars`);
  const huge = closestRegion(src, Array.from({ length: 50 }, (_, i) => `  have h${i} : nope`).join("\n"));
  check("a pathological oldText is still cut", huge.snippet.endsWith(" …") && huge.snippet.length <= 2010, `${huge.snippet.length} chars`);
}

// Ambiguity and overlap are errors, not guesses: a non-unique oldText edited in place
// would silently change the wrong occurrence.
{
  const src = "x := 1\ny := 2\nx := 1\n";
  check("ambiguous oldText is refused", fails(() => applyEdits(src, [{ oldText: "x := 1", newText: "x := 9" }], "f"))?.includes("2 occurrences"));
  const overlap = fails(() => applyEdits("abcdef\n", [{ oldText: "abcd", newText: "1" }, { oldText: "cdef", newText: "2" }], "f"));
  check("overlapping edits are refused", overlap?.includes("overlap"), overlap);
  check("an empty oldText is refused", fails(() => applyEdits("a\n", [{ oldText: "", newText: "x" }], "f"))?.includes("must not be empty"));
  check("a no-op edit is refused", fails(() => applyEdits("a\n", [{ oldText: "a", newText: "a" }], "f"))?.includes("No changes made"));
}

// Several disjoint edits in one call, applied against the ORIGINAL file — the semantics
// the tool description promises.
{
  const { newContent } = applyEdits("one\ntwo\nthree\n", [{ oldText: "one", newText: "1" }, { oldText: "three", newText: "3" }], "f");
  check("disjoint multi-edit", newContent === "1\ntwo\n3\n", JSON.stringify(newContent));
}

// The argument shims: models send `edits` as a JSON string, or a single legacy
// top-level pair. A transcript replay (scripts/highwater-scan.mjs) has to normalize the
// raw recorded arguments exactly as the tool did, or it reconstructs a different file —
// the legacy pair form accounted for every replay divergence in the 0805 grep cell.
{
  const a = normalizeEditArgs({ path: "f", edits: JSON.stringify([{ oldText: "x", newText: "y" }]) });
  check("edits-as-string is parsed", Array.isArray(a.edits) && a.edits[0].oldText === "x");
  const b = normalizeEditArgs({ path: "f", oldText: "x", newText: "y" });
  check("legacy top-level pair becomes an edit", Array.isArray(b.edits) && b.edits.length === 1 && b.oldText === undefined);
  const c = normalizeEditArgs({ path: "f", edits: [{ oldText: "a", newText: "b" }], oldText: "x", newText: "y" });
  check("legacy pair appends to an existing list", c.edits.length === 2 && c.edits[1].oldText === "x");
}

// CRLF and BOM round-trip: problem.lean is written by the harness, but an agent may
// rewrite it wholesale, and a changed line ending would show up as a changed statement.
{
  const { newContent } = applyEdits("﻿a\r\nb\r\n", [{ oldText: "b", newText: "B" }], "f");
  check("BOM and CRLF preserved", newContent === "﻿a\r\nB\r\n", JSON.stringify(newContent));
}

console.log(failed ? `\n${failed} probe(s) FAILED` : "\nall edit probes green");
process.exit(failed ? 1 : 0);
