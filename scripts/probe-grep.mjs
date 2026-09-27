#!/usr/bin/env node
// Probes grep_mathlib result ranking (runner/grep.js). Needs the Mathlib checkout, not the lean server.
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

const MAX = 25; // extensions/lean-grep.ts MAX_RESULTS
const names = (r) => r.hits.map((h) => h.name);

for (const [pattern, want] of [["Ideal", "Ideal"], ["Submodule", "Submodule"], ["mul_pow", "mul_pow"], ["IsNoetherianRing", "IsNoetherianRing"]]) {
  const r = await grepMathlib(pattern, { maxResults: MAX });
  check(`exact name first: ${pattern}`, names(r)[0] === want, names(r).slice(0, 4).join(" | "));
}

{
  const r = await grepMathlib("inv_mem", { maxResults: MAX });
  const tier1 = names(r).findIndex((n) => n?.split(".").pop() === "inv_mem");
  const tier2 = names(r).findIndex((n) => n && n.includes("inv_mem") && n.split(".").pop() !== "inv_mem");
  check("last-segment matches outrank substring matches", tier1 === 0 && (tier2 === -1 || tier1 < tier2), names(r).slice(0, 6).join(" | "));
}

{
  const r = await grepMathlib("IsNoetherianRing", { maxResults: MAX });
  const lastDecl = r.hits.map((h) => !h.text.includes("↳ matches inside its proof")).lastIndexOf(true);
  const firstUsage = r.hits.findIndex((h) => h.text.includes("↳ matches inside its proof"));
  check("declarations before usage sites", firstUsage === -1 || firstUsage > lastDecl, `${lastDecl} / ${firstUsage}`);
}

{
  const r = await grepMathlib("Ideal", { maxResults: MAX });
  check("returns up to the arm's depth", r.hits.length === MAX, `${r.hits.length}`);
  check("a query with more matches says so", r.truncated === true);
  const narrow = await grepMathlib("IsDiscreteValuationRing.iff_pid_with_one_nonzero_prime", { maxResults: MAX });
  check("a query with few matches does not", narrow.truncated === false && narrow.hits.length > 0, `${narrow.hits.length} / ${narrow.truncated}`);
}

{
  const a = await grepMathlib("map_add", { maxResults: MAX });
  const b = await grepMathlib("map_add", { maxResults: MAX });
  check("deterministic", JSON.stringify(names(a)) === JSON.stringify(names(b)));
}

{
  const r = await grepMathlib("theorem isNoetherianRing_iff", { maxResults: MAX });
  const cut = r.hits.filter((h) => h.text.endsWith(" …")).length;
  check("signatures are not routinely cut", cut === 0, `${cut} of ${r.hits.length} cut`);
}

{
  let msg = null;
  try { await grepMathlib("a{1,2,3}", { maxResults: MAX }); } catch (e) { msg = e.message; }
  check("a pattern grep rejects surfaces grep's own message", msg != null && /grep|invalid/i.test(msg), String(msg).slice(0, 80));
}

{
  const r = await grepMathlib("\\d+definitelyNotInMathlib[", { maxResults: MAX });
  check("an unreadable pattern is a result, not a throw", r.hits.length === 0 && r.mode === null);
}

console.log(failed ? `\n${failed} probe(s) FAILED` : "\nall grep probes green");
process.exit(failed ? 1 : 0);
