// Scan attempts for the compaction death-spiral: pi hit the deliberate admission-400
// context wall (extensions/max-tokens.ts), then its own summarization request was
// refused too, so compaction never happened and the attempt spun until the supervisor's
// max_error_streak. Written for the 2026-08-14 audit; fixed the same day by
// extensions/compaction-guard.ts. Keep it runnable so in-flight cells can be re-checked.
//
//   node scripts/context-wall-scan.mjs <run-dir>...
//   node scripts/context-wall-scan.mjs --json <...>      machine-readable, to stdout
//
// Detector: count overflow-400 assistant messages and {"type":"compaction"} entries in
// each session. A healthy wall hit is exactly one 400 followed by one compaction. The
// summarization request that fails leaves NO record anywhere (auto-compaction failures
// are an in-process event only, and the runner runs --mode text), so its only trace is
// an extra 400 in stderr.log — reported as `unlogged_400s` for confirmation.
//
// Two classes come out:
//   dead    — >=1 overflow 400 and ZERO compactions. The attempt never recovered; it
//             burned to the error-streak cap and was recorded end="completed" with
//             budget unspent. These are the rerun candidates.
//   partial — compaction eventually ran, but more requests were refused than a clean
//             1-refusal-per-compaction recovery accounts for, so at least one
//             summarization was refused first. No rerun (the verdict stands); listed
//             because the failed cycles still cost wall-clock.
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join, basename } from "node:path";

const args = process.argv.slice(2).filter((a) => a !== "--json");
const asJson = process.argv.includes("--json");
if (args.length === 0) {
  console.error("usage: node scripts/context-wall-scan.mjs [--json] <run-dir>...");
  process.exit(2);
}

// Same wording pi matches (pi-ai/src/utils/overflow.ts) restricted to what DeepSeek and
// the OpenAI-compatible proxies actually emit at admission.
const OVERFLOW = /maximum context length is \d+ tokens|reduce the length of the messages|exceeds the context window|context_length_exceeded/i;

const out = { scanned: [], dead: [], partial: [] };

for (const dir of args) {
  if (!statSync(dir).isDirectory()) { console.error(`skip ${dir}: not a run directory`); continue; }
  const run = basename(dir.replace(/\/+$/, ""));
  let problems = 0;
  for (const problem of readdirSync(dir)) {
    const sdir = join(dir, problem, "session");
    if (!existsSync(sdir)) continue;
    const sfile = readdirSync(sdir).find((f) => f.endsWith(".jsonl"));
    if (!sfile) continue;
    problems++;

    let overflow400 = 0, compactions = 0, ghost = 0;
    for (const line of readFileSync(join(sdir, sfile), "utf8").split("\n")) {
      if (!line) continue;
      let r; try { r = JSON.parse(line); } catch { continue; }
      if (r.type === "compaction") { compactions++; continue; }
      if (r.type !== "message") continue;
      const m = r.message;
      if (m?.errorMessage && OVERFLOW.test(m.errorMessage)) overflow400++;
      if (m?.role === "assistant" && (m.stopReason === "error" || m.stopReason === "aborted")) {
        for (const b of m.content ?? []) {
          if (b?.type === "toolCall") ghost += JSON.stringify(b.arguments ?? {}).length;
          else if (b?.type === "thinking") ghost += b.thinking?.length ?? 0;
          else if (b?.type === "text") ghost += b.text?.length ?? 0;
        }
      }
    }
    if (overflow400 === 0) continue;

    // The failed summarization calls: HTTP 400s the provider log saw that the session
    // never recorded. Only meaningful when stderr.log survived.
    const errPath = join(dir, problem, "stderr.log");
    let unlogged = null;
    if (existsSync(errPath)) {
      const http400 = (readFileSync(errPath, "utf8").match(/status 400/g) ?? []).length;
      unlogged = http400 - overflow400;
    }

    let a = {};
    const apath = join(dir, problem, "attempt.json");
    if (existsSync(apath)) { try { a = JSON.parse(readFileSync(apath, "utf8")); } catch {} }

    const rec = {
      run, problem, overflow_400s: overflow400, compactions,
      unlogged_400s: unlogged, ghost_chars: ghost,
      end: a.end ?? null, solved: a.grade?.solved ?? null,
      cost_usd: a.cost_usd ?? null,
      unspent_usd: a.budget_std != null && a.cost_usd != null ? +(a.budget_std - a.cost_usd).toFixed(5) : null,
      nudges: a.nudges ?? null, wall_h: a.wall_s != null ? +(a.wall_s / 3600).toFixed(1) : null,
    };
    // A clean recovery is one refusal per compaction. Anything beyond that means a
    // summarization request was refused before one finally went through.
    if (compactions === 0) out.dead.push(rec);
    else if (overflow400 - compactions >= 2) out.partial.push(rec);
  }
  out.scanned.push({ run, problems });
}

const money = (rs) => rs.reduce((n, r) => n + (r.unspent_usd ?? 0), 0);

if (asJson) {
  console.log(JSON.stringify(out, null, 1));
} else {
  for (const s of out.scanned) console.log(`scanned ${s.run}: ${s.problems} problems`);
  console.log(`\ndead (hit the wall, compaction NEVER ran) — rerun candidates: ${out.dead.length}`);
  for (const r of out.dead.sort((x, y) => y.overflow_400s - x.overflow_400s)) {
    console.log(`  ${r.run}  ${r.problem}  ${r.overflow_400s} refused requests, ${r.unlogged_400s ?? "?"} of them unlogged` +
      `  ghost ${(r.ghost_chars / 1e6).toFixed(1)}MB  end=${r.end} solved=${r.solved}  $${r.unspent_usd} unspent  ${r.wall_h}h`);
  }
  console.log(`  unspent budget across rerun candidates: $${money(out.dead).toFixed(2)}`);
  console.log(`\npartial (recovered after >=2 refusals) — no rerun: ${out.partial.length}`);
  for (const r of out.partial.sort((x, y) => y.overflow_400s - x.overflow_400s)) {
    console.log(`  ${r.run}  ${r.problem}  ${r.overflow_400s} refused, ${r.compactions} compaction(s), end=${r.end} solved=${r.solved}`);
  }
}
