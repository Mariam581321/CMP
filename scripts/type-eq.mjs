import { readFileSync } from "node:fs";
import { benchmarkDecls, stmtProbe, parseStmtProbe, serverCheck } from "../runner/stmt.js";
import { fileURLToPath } from "node:url";
const ROOT = fileURLToPath(new URL("..", import.meta.url));

const CASES = [
  ["fatex_13", "benchmarks/FATE/FATE-X/FATEX/13.lean", "problems-fatex/fatex_13.lean"],
  ["fatex_23", "benchmarks/FATE/FATE-X/FATEX/23.lean", "problems-fatex/fatex_23.lean"],
  ["fatex_60", "benchmarks/FATE/FATE-X/FATEX/60.lean", "problems-fatex/fatex_60.lean"],
  ["fatex_75", "benchmarks/FATE/FATE-X/FATEX/75.lean", "problems-fatex/fatex_75.lean"],
  ["fatex_81", "benchmarks/FATE/FATE-X/FATEX/81.lean", "problems-fatex/fatex_81.lean"],
  ["fateh_78", "benchmarks/FATE/FATE-H/FATEH/78.lean", "problems-fateh/fateh_78.lean"],
];

async function probe(src) {
  const decls = benchmarkDecls(src);
  const r = await serverCheck(`${src}\n${stmtProbe(decls)}\n`);
  if (r.error) throw new Error(r.error);
  return { decls, probe: parseStmtProbe(r.messages), ok: r.ok };
}

for (const [name, origPath, oursPath] of CASES) {
  const orig = readFileSync(ROOT + origPath, "utf8");
  const ours = readFileSync(ROOT + oursPath, "utf8");
  try {
    const [a, b] = await Promise.all([probe(orig), probe(ours)]);
    const declsSame = JSON.stringify(a.decls) === JSON.stringify(b.decls);
    let allSame = declsSame;
    const notes = [];
    for (const d of a.decls) {
      const ta = a.probe[d]?.type, tb = b.probe[d]?.type;
      if (ta !== tb) { allSame = false; notes.push(`TYPE DIFFERS: ${d}`); }
      const va = a.probe[d]?.value, vb = b.probe[d]?.value;
      if (va !== vb) { allSame = false; notes.push(`VALUE DIFFERS: ${d}`); }
    }
    // does the theorem's canonical type mention a non-Mathlib Irreducible?
    const mainTy = Object.values(a.probe).map(p => p.type ?? "").join(" ");
    const irr = [...mainTy.matchAll(/[\w.]*Irreducible[\w.]*/g)].map(m => m[0]);
    console.log(`${name}: decls=${a.decls.join(",")} | orig compiles=${a.ok} ours compiles=${b.ok} | IDENTICAL TYPES+VALUES: ${allSame ? "YES" : "NO -> " + notes.join("; ")}${irr.length ? " | Irreducible consts: " + [...new Set(irr)].join(",") : ""}`);
  } catch (e) {
    console.log(`${name}: ERROR ${e.message.slice(0, 200)}`);
  }
}
