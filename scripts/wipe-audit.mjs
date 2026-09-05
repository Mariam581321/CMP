import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { classifyLines } from "../runner/common.js";
import { sanitize } from "../runner/sanitize.js";
const ROOT = fileURLToPath(new URL("..", import.meta.url));

// any token that would make a dropped line semantically load-bearing
const CODE_TOKEN = /(^|\W)(import|open|namespace|end|section|variable|universe|set_option|attribute|local|instance|theorem|lemma|def|abbrev|structure|class|inductive|axiom|example|noncomputable|macro|notation|deriving|where|sorry|:=)(\W|$)/;

const CORPORA = [
  ["FATE-X", join(ROOT, "benchmarks/FATE/FATE-X/FATEX"), join(ROOT, "problems-fatex"), "fatex_"],
  ["FATE-H", join(ROOT, "benchmarks/FATE/FATE-H/FATEH"), join(ROOT, "problems-fateh"), "fateh_"],
  ["FATE-M", join(ROOT, "benchmarks/FATE/FATE-M/FATEM"), join(ROOT, "problems-fatem"), "fatem_"],
];

for (const [name, src, out, prefix] of CORPORA) {
  let files, mismatch = [], suspicious = [], missing = [], dropped = 0;
  try { files = readdirSync(src).filter(f => f.endsWith(".lean")) } catch (e) { console.log(`${name}: no src (${e.code})`); continue }
  for (const f of files) {
    const orig = readFileSync(join(src, f), "utf8");
    const cls = classifyLines(orig);
    for (const { line, kind } of cls) {
      if (kind === "comment" || kind === "docstring") {
        dropped++;
        // strip the comment delimiters, then see if anything code-like remains
        const bare = line.trim().replace(/^\/--?/, "").replace(/^--/, "").replace(/-\/\s*$/, "").trim();
        if (bare && CODE_TOKEN.test(bare)) suspicious.push([f, kind, line.trim().slice(0, 110)]);
      }
    }
    const ours = join(out, prefix + f);
    let shipped;
    try { shipped = readFileSync(ours, "utf8") } catch { missing.push(f); continue }
    if (shipped !== sanitize(orig)) mismatch.push(f);
  }
  console.log(`\n### ${name}: ${files.length} originals | dropped lines: ${dropped} | shipped != sanitize(orig): ${mismatch.length} ${mismatch.slice(0,10).join(",")} | no shipped file: ${missing.length}`);
  console.log(`  dropped lines containing code-like tokens: ${suspicious.length}`);
  for (const s of suspicious.slice(0, 25)) console.log("   ", s.join(" | "));
}
