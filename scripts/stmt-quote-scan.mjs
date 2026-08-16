// How much did the statement-modified blocker's wording cost each arm?
//
// Before 5d3e2b7 the blocker said "restore the original statement exactly" without
// showing it; an agent that tripped it had usually overwritten its only copy and had to
// re-guess the line from memory, check by check. basequote-fatex90-0813 runs the fixed
// wording (the blocker quotes the original file, CMP_STMT_QUOTE=1); every other cell ran
// the old one. This scan measures the recovery grind per attempt so the arms can be
// compared:
//
//   tripped   — attempt had >=1 lean_check/plan_check result flagged STATEMENT MODIFIED
//   rounds    — flagged check results in the attempt (each is one failed recovery try)
//   streak    — longest run of consecutive flagged results among stmt-bearing checks
//   died bad  — the attempt's LAST stmt-bearing check was still flagged at the end
//   h flagged — wall-clock spent in the flagged state (first flagged result -> next
//               intact result, summed over episodes; gaps between entries > 30 min are
//               clipped to 0 so a stranded REPL doesn't book its stall here)
//
// Counted ONLY in toolResult messages — the same wording rides on supervisor nudges and
// gets quoted back by the model, so counting other roles double-books each round.
// Scans every .jsonl in each problem's session/ (spawn cells keep subagent sessions
// there too; subagent facts/snippet checks carry no statement facts, so they cannot
// false-positive).
//
//   node scripts/stmt-quote-scan.mjs <run-dir>...
//   node scripts/stmt-quote-scan.mjs --json <...>
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join, basename } from "node:path";

const args = process.argv.slice(2).filter((a) => a !== "--json");
const asJson = process.argv.includes("--json");
if (args.length === 0) {
  console.error("usage: node scripts/stmt-quote-scan.mjs [--json] <run-dir>...");
  process.exit(2);
}

const GAP_CLIP_MS = 30 * 60 * 1000;

const runs = [];
for (const dir of args) {
  if (!statSync(dir).isDirectory()) { console.error(`skip ${dir}: not a run directory`); continue; }
  const run = basename(dir.replace(/\/+$/, ""));
  const attempts = [];
  for (const problem of readdirSync(dir)) {
    const sdir = join(dir, problem, "session");
    if (!existsSync(sdir)) continue;

    // One chronological stream of stmt-bearing check results across all session files.
    const events = [];
    for (const sfile of readdirSync(sdir).filter((f) => f.endsWith(".jsonl"))) {
      for (const line of readFileSync(join(sdir, sfile), "utf8").split("\n")) {
        if (!line) continue;
        let r; try { r = JSON.parse(line); } catch { continue; }
        if (r.type !== "message" || r.message?.role !== "toolResult") continue;
        const txt = JSON.stringify(r.message.content ?? "");
        const bad = txt.includes("STATEMENT MODIFIED");
        const ok = txt.includes("statement intact");
        if (!bad && !ok) continue;
        events.push({ t: Date.parse(r.timestamp), bad });
      }
    }
    events.sort((a, b) => a.t - b.t);

    let rounds = 0, streak = 0, best = 0, flaggedMs = 0, flaggedSince = null;
    for (const e of events) {
      if (e.bad) {
        rounds++;
        streak++;
        if (streak > best) best = streak;
        if (flaggedSince === null) flaggedSince = e.t;
        else flaggedMs += Math.min(e.t - flaggedSince, GAP_CLIP_MS), (flaggedSince = e.t);
      } else {
        streak = 0;
        if (flaggedSince !== null) {
          flaggedMs += Math.min(e.t - flaggedSince, GAP_CLIP_MS);
          flaggedSince = null;
        }
      }
    }
    const diedBad = events.length > 0 && events[events.length - 1].bad;

    let a = {};
    const apath = join(dir, problem, "attempt.json");
    if (existsSync(apath)) { try { a = JSON.parse(readFileSync(apath, "utf8")); } catch {} }

    attempts.push({
      problem, checks: events.length, rounds, max_streak: best, died_bad: diedBad,
      flagged_h: +(flaggedMs / 3600000).toFixed(2),
      solved: a.grade?.solved ?? a.solved ?? null, cost_usd: a.cost_usd ?? null,
    });
  }
  runs.push({ run, attempts });
}

const median = (xs) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};

const rows = runs.map(({ run, attempts }) => {
  const tripped = attempts.filter((a) => a.rounds > 0);
  return {
    run,
    n: attempts.length,
    tripped: tripped.length,
    rounds: tripped.reduce((s, a) => s + a.rounds, 0),
    med_rounds: median(tripped.map((a) => a.rounds)),
    max_rounds: Math.max(0, ...tripped.map((a) => a.rounds)),
    thrash10: tripped.filter((a) => a.rounds >= 10).length,
    died_bad: tripped.filter((a) => a.died_bad).length,
    flagged_h: +tripped.reduce((s, a) => s + a.flagged_h, 0).toFixed(1),
    solved_tripped: tripped.filter((a) => a.solved).length,
    solved_clean: attempts.filter((a) => a.rounds === 0 && a.solved).length,
    clean: attempts.filter((a) => a.rounds === 0).length,
  };
});

if (asJson) {
  console.log(JSON.stringify({ rows, runs }, null, 1));
} else {
  const pad = (s, w) => String(s).padStart(w);
  console.log(
    "run".padEnd(28) + pad("n", 4) + pad("tripped", 9) + pad("rounds", 8) + pad("med", 5) +
    pad("max", 5) + pad(">=10", 6) + pad("died", 6) + pad("hrs", 7) + pad("slv-t", 7) + pad("slv-c", 7));
  for (const r of rows) {
    console.log(
      r.run.padEnd(28) + pad(r.n, 4) + pad(`${r.tripped} (${Math.round((100 * r.tripped) / r.n)}%)`, 9) +
      pad(r.rounds, 8) + pad(r.med_rounds, 5) + pad(r.max_rounds, 5) + pad(r.thrash10, 6) +
      pad(r.died_bad, 6) + pad(r.flagged_h, 7) +
      pad(`${r.solved_tripped}/${r.tripped}`, 7) + pad(`${r.solved_clean}/${r.clean}`, 7));
  }
  console.log("\nslv-t = solved among tripped, slv-c = solved among never-tripped.");
  console.log("rounds/med/max/hrs are over tripped attempts only.");
}
