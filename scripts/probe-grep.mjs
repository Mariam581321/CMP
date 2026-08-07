#!/usr/bin/env node
// Probes for grep_mathlib's ordering (runner/grep.js). Needs the Mathlib checkout, not
// the lean server — this is text search, not compilation.
//
// The property under test: results are no longer emitted in `grep -rnI` order. That
// order is alphabetical by path and says nothing about relevance, so with a cap on the
// list it answered a query with whatever happened to live earliest in the tree —
// measured over grep-fatex87-0805, 43% of calls truncated and the median truncated query
// matched 38 declarations, so nearly half of all retrievals were an alphabetical prefix.
// The ranking is deliberately minimal (runner/grep.js nameTier): name-is-the-query, then
// name-ends-with-the-query, then query-in-the-name, then signature-only, ties keeping
// traversal order. These probes pin exactly that and nothing more.
//
//   node scripts/probe-grep.mjs
import { existsSync } from "node:fs";
import { grepMathlib, MATHLIB_SRC } from "../runner/grep.js";

let failed = 0;
const check = (name, cond, detail = "") => {
  console.log(`${cond ? "  ok  " : "  FAIL"}  ${name}${cond || !detail ? "" : `\n        ${detail}`}`);
  if (!cond) failed++;
};

if (!existsSync(MATHLIB_SRC)) {
  console.log(`  skip  no Mathlib checkout at ${MATHLIB_SRC}`);
  process.exit(0);
}

const MAX = 25; // extensions/lean-grep.ts MAX_RESULTS — the arm's depth
const names = (r) => r.hits.map((h) => h.name);

// A query that names a declaration exactly puts that declaration first, even when
// hundreds of other declarations mention the token and thousands of lines match. Every
// one of these used to come back buried or absent: `Ideal` matches 11,916 lines in
// Mathlib and its own definition lives in RingTheory/, past the old 400-line grep cut.
for (const [pattern, want] of [["Ideal", "Ideal"], ["Submodule", "Submodule"], ["mul_pow", "mul_pow"], ["IsNoetherianRing", "IsNoetherianRing"]]) {
  const r = await grepMathlib(pattern, { maxResults: MAX });
  check(`exact name first: ${pattern}`, names(r)[0] === want, names(r).slice(0, 4).join(" | "));
}

// A query naming the last segment of a qualified declaration ranks those declarations
// above ones that merely contain the token inside a longer name.
{
  const r = await grepMathlib("inv_mem", { maxResults: MAX });
  const tier1 = names(r).findIndex((n) => n?.split(".").pop() === "inv_mem");
  const tier2 = names(r).findIndex((n) => n && n.includes("inv_mem") && n.split(".").pop() !== "inv_mem");
  check("last-segment matches outrank substring matches", tier1 === 0 && (tier2 === -1 || tier1 < tier2), names(r).slice(0, 6).join(" | "));
}

// Declarations always outrank usage sites (a usage site answers a different question and
// is annotated as such) — this predates the ranking and must survive it.
{
  const r = await grepMathlib("IsNoetherianRing", { maxResults: MAX });
  const lastDecl = r.hits.map((h) => !h.text.includes("↳ matches inside its proof")).lastIndexOf(true);
  const firstUsage = r.hits.findIndex((h) => h.text.includes("↳ matches inside its proof"));
  check("declarations before usage sites", firstUsage === -1 || firstUsage > lastDecl, `${lastDecl} / ${firstUsage}`);
}

// The depth of the list and the honesty of the truncation note.
{
  const r = await grepMathlib("Ideal", { maxResults: MAX });
  check("returns up to the arm's depth", r.hits.length === MAX, `${r.hits.length}`);
  check("a query with more matches says so", r.truncated === true);
  const narrow = await grepMathlib("IsDiscreteValuationRing.iff_pid_with_one_nonzero_prime", { maxResults: MAX });
  check("a query with few matches does not", narrow.truncated === false && narrow.hits.length > 0, `${narrow.hits.length} / ${narrow.truncated}`);
}

// Ranking must not reorder equals: within one tier the order is still grep's, so two
// runs of the same query are byte-identical and a cell is reproducible.
{
  const a = await grepMathlib("map_add", { maxResults: MAX });
  const b = await grepMathlib("map_add", { maxResults: MAX });
  check("deterministic", JSON.stringify(names(a)) === JSON.stringify(names(b)));
}

// A whole-declaration expansion must not cut a signature in half — that is the one thing
// the expansion exists for. (24 lines / 1600 chars, raised from 10 / 600.)
{
  const r = await grepMathlib("theorem isNoetherianRing_iff", { maxResults: MAX });
  const cut = r.hits.filter((h) => h.text.endsWith(" …")).length;
  check("signatures are not routinely cut", cut === 0, `${cut} of ${r.hits.length} cut`);
}

// A pattern that is a valid JS regex but an invalid POSIX ERE reaches the regex rung and
// makes grep exit 2. That message is the actionable answer, so it must survive to the
// agent instead of being swallowed as "no matches" — but only when nothing else hit.
{
  let msg = null;
  try { await grepMathlib("a{1,2,3}", { maxResults: MAX }); } catch (e) { msg = e.message; }
  check("a pattern grep rejects surfaces grep's own message", msg != null && /grep|invalid/i.test(msg), String(msg).slice(0, 80));
}

// ...and a pattern this harness cannot even read as a regex is a plain no-match, not a
// failure: the literal rungs still ran and honestly found nothing.
{
  const r = await grepMathlib("\\d+definitelyNotInMathlib[", { maxResults: MAX });
  check("an unreadable pattern is a result, not a throw", r.hits.length === 0 && r.mode === null);
}

console.log(failed ? `\n${failed} probe(s) FAILED` : "\nall grep probes green");
process.exit(failed ? 1 : 0);
