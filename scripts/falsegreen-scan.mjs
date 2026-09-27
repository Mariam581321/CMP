// List attempts where the done-gate stamped a green but no snapshot graded solved
// (false_green), or the first green failed grading but a later one passed (recovered).
//
//   node scripts/falsegreen-scan.mjs [--json] <results.jsonl | run-dir>...
import { readFileSync, existsSync, statSync } from "node:fs";
import { join, basename } from "node:path";

const args = process.argv.slice(2).filter((a) => a !== "--json");
const asJson = process.argv.includes("--json");
if (args.length === 0) {
  console.error("usage: node scripts/falsegreen-scan.mjs [--json] <results.jsonl | run-dir>...");
  process.exit(2);
}

const out = { scanned: [], false_green: [], recovered: [] };
for (const arg of args) {
  const path = statSync(arg).isDirectory() ? join(arg, "results.jsonl") : arg;
  if (!existsSync(path)) { console.error(`skip (no results.jsonl): ${arg}`); continue; }
  let n = 0;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.trim()) continue;
    const r = JSON.parse(line);
    n++;
    const hw = r.high_water;
    if (!hw || !(hw.greens > 0)) continue;
    const at = (s) => s && { turn: s.turn, check_index: s.check_index, cost_std: s.cost_std, wall_at: s.wall_at, reason: s.reason };
    const rec = {
      run: r.run_id ?? basename(path),
      problem: r.problem,
      end: r.end,
      solved: r.solved,
      grade_reason: r.grade?.reason ?? null,
      greens: hw.greens,
      first_green: at(hw.first),
      last_green: at(hw.last),
    };
    if (!hw.ever_solved) out.false_green.push(rec);
    else if (hw.first?.solved === false) out.recovered.push(rec);
  }
  out.scanned.push({ path, records: n });
}

if (asJson) {
  console.log(JSON.stringify(out, null, 1));
} else {
  for (const s of out.scanned) console.log(`scanned ${s.path}: ${s.records} records`);
  console.log(`\nfalse greens (gate said COMPLETE, grader rejects every snapshot) — rerun candidates: ${out.false_green.length}`);
  for (const f of out.false_green)
    console.log(
      `  ${f.run}  ${f.problem}  greens=${f.greens}  first at turn ${f.first_green?.turn} ` +
        `($${f.first_green?.cost_std}, ${f.first_green?.wall_at})  snapshot: ${f.first_green?.reason}  end=${f.end}  final grade: ${f.grade_reason}`,
    );
  console.log(`\nrecovered (false FIRST green, later snapshot graded solved) — no rerun: ${out.recovered.length}`);
  for (const f of out.recovered)
    console.log(`  ${f.run}  ${f.problem}  first at turn ${f.first_green?.turn} (${f.first_green?.reason}) — later green real`);
}
