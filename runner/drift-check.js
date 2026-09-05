#!/usr/bin/env node
// Statement-drift recheck (library-cell guard): with a library baked into the lean
// server's env, new instances could change how a BENCHMARK STATEMENT elaborates —
// which would silently change what is being proved. This script recompiles every
// statement against the CURRENT server env and compares each declaration's
// canonical type/value/kind against the cached no-library answers
// (problems/stmt-types.json, computed on a bare env). Zero drift is a launch
// precondition for the library cell; any drift means pruning the offending library
// instances and re-freezing.
//
//   node runner/drift-check.js problems-fatex problems-fatex/safe90.txt
//
// Run it with the LIBRARY server up (it checks /health and tells you which env it
// measured). It never writes the stmt-types cache — the cache stays the bare-env
// truth. Exits 1 on any drift or missing cache entry.

import { readFileSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { benchmarkDecls, stmtProbe, parseStmtProbe, serverCheck } from "./stmt.js";
import { LEAN_URL, green, red, dim, bold } from "./common.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const [problemsDirArg, listArg] = process.argv.slice(2);
if (!problemsDirArg || !listArg) {
  console.error("usage: node runner/drift-check.js <problems-dir> <problems.txt>");
  process.exit(1);
}
const PROBLEMS_DIR = resolve(problemsDirArg);
const problems = readFileSync(resolve(listArg), "utf8").split("\n").map((s) => s.trim()).filter(Boolean);
const cache = JSON.parse(readFileSync(join(ROOT, "problems", "stmt-types.json"), "utf8"));

const health = await fetch(`${LEAN_URL}/health`, { signal: AbortSignal.timeout(3000) }).then((r) => r.json()).catch(() => null);
if (!health?.ready) { console.error("lean server not ready"); process.exit(1); }
console.log(bold(`drift check against env: library ${health.library_sha256 ? health.library_sha256.slice(0, 12) + "…" : "(none — this measures nothing new)"}\n`));

let drifted = 0, clean = 0, errored = 0;
for (const name of problems) {
  const original = readFileSync(join(PROBLEMS_DIR, `${name}.lean`), "utf8");
  const decls = benchmarkDecls(original);
  const cached = cache[name]?.decls;
  if (!cached) { console.log(`  ${red("✗")} ${name}: no bare-env cache entry — build the stmt cache on a bare server first`); errored++; continue; }
  let r;
  try {
    r = await serverCheck(`${original}\n${stmtProbe(decls)}\n`, "drift-check", true);
  } catch (e) { console.log(`  ${red("✗")} ${name}: server error ${e.message}`); errored++; continue; }
  if (r.error) { console.log(`  ${red("✗")} ${name}: ${r.error}`); errored++; continue; }
  const errs = (r.messages ?? []).filter((m) => m.severity === "error");
  if (errs.length) { console.log(`  ${red("✗")} ${name}: statement no longer compiles under the library env\n      ${errs[0].text.slice(0, 200)}`); drifted++; continue; }
  const got = parseStmtProbe(r.messages);
  const diffs = [];
  for (const d of decls) {
    const g = got[d];
    if (!g || g.missing) { diffs.push(`${d}: missing`); continue; }
    if (g.type !== cached[d].type) diffs.push(`${d}: TYPE drift`);
    if (g.kind !== cached[d].kind) diffs.push(`${d}: kind ${cached[d].kind} -> ${g.kind}`);
    if (cached[d].value != null && cached[d].value !== "-" && g.value !== cached[d].value) diffs.push(`${d}: VALUE drift`);
  }
  if (diffs.length) { console.log(`  ${red("✗")} ${name}: ${diffs.join("; ")}`); drifted++; }
  else { clean++; console.log(`  ${green("✓")} ${name}`); }
}
console.log(bold(`\n${clean} clean, ${drifted} drifted, ${errored} errored`) + dim(`  (of ${problems.length})`));
process.exit(drifted || errored ? 1 : 0);
