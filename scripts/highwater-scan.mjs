#!/usr/bin/env node
// Retroactive solved high-water mark: find every attempt that ever HELD a verified
// proof, and say what it did next.
//
// extensions/lean-check.ts stamps this live from 2026-08-07 on (runner/highwater.js).
// Every run recorded before that has no stamp, so this reconstructs one from the pi
// session files, which are the durable linear record of an attempt (see
// runner/session-tail.js). It is read-only with respect to results/ — the same contract
// as runner/regrade.js: recorded verdicts document what a run measured at the time, and
// this reports on them rather than rewriting them.
//
//   node scripts/highwater-scan.mjs [results/<run-id> ...]   (default: every run)
//     --verify-all   re-grade the first-green file of EVERY green attempt, not just
//                    the ones that graded unsolved (hours of Lean time)
//     --no-verify    skip the lean server entirely; leave ambiguous checks unresolved
//     --out <path>   markdown report (default results/highwater-audit-<date>.md)
//     --csv <path>   per-attempt csv
//
// How a check is coloured. `details.ok` on a lean_check result already folds in the
// compile, statement and axiom verdicts (extensions/lean-check.ts sets ok=false for the
// last two), so the ONE thing it does not cover is sorries — a file full of them has
// ok:true. Sorries are read from the rendered text, which is where the trap is: the
// render is capped at 8000 chars and prints sorries LAST, so a truncated ok-check may
// be hiding a sorry list. Those are marked `ambiguous` and resolved by recompiling the
// reconstructed bytes, never by guessing. Measured on the corpus: every uses_sorry
// attempt that looked green did so through a truncated check.
//
// How the file is reconstructed. Replay every successful write/edit tool call over the
// original problem file, in session order, through the same applyEdits the agent's edit
// tool uses. Each lean_check prints `md5 <hex>` of the bytes it compiled, so the replay
// is CHECKED at every step rather than trusted: a check whose md5 disagrees is reported
// as unverified and never fed to the compiler as if it were the agent's file.

import { readFileSync, readdirSync, existsSync, statSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { join, resolve, dirname, basename } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { applyEdits, normalizeEditArgs } from "../runner/edit.js";
import { checkedCompile } from "../runner/stmt.js";
import { verifiedDone } from "../runner/highwater.js";
import { grade } from "../runner/grade.js";
import { costStd, green, red, dim, bold } from "../runner/common.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
const flag = (n) => argv.includes(`--${n}`);
const opt = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : d; };
const VERIFY_ALL = flag("verify-all");
const NO_VERIFY = flag("no-verify");
// Local date, not toISOString(): a run analysed at 23:30 UTC+1 belongs to that day in
// the notebook, and a filename that disagrees with its own header is a filing error
// waiting to happen.
const now = new Date();
const DATE = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
const OUT = opt("out", join(ROOT, "results", `highwater-audit-${DATE.slice(5).replace("-", "")}.md`));
const CSV = opt("csv", join(ROOT, "results", `highwater-audit-${DATE.slice(5).replace("-", "")}.csv`));

const md5 = (s) => createHash("md5").update(s).digest("hex");
// Positional args are run dirs; --out/--csv swallow the token after them.
const TAKES_VALUE = new Set(["--out", "--csv"]);
let runDirs = [];
for (let i = 0; i < argv.length; i++) {
  if (TAKES_VALUE.has(argv[i])) { i++; continue; }
  if (argv[i].startsWith("--")) continue;
  runDirs.push(resolve(argv[i]));
}
if (!runDirs.length) {
  // results/ is gitignored, so it exists in the main checkout and not in a worktree —
  // where this script is likely being developed. Say so instead of throwing ENOENT.
  const results = join(ROOT, "results");
  if (!existsSync(results)) {
    console.error(`no results/ under ${ROOT} — pass run dirs explicitly, e.g. node scripts/highwater-scan.mjs ~/CMP/results/<run-id>`);
    process.exit(1);
  }
  runDirs = readdirSync(results)
    .map((d) => join(results, d))
    .filter((d) => existsSync(join(d, "run.json")))
    .sort();
}

// --- one attempt --------------------------------------------------------------

// Success wording of the file tools, which is how a replay knows an edit LANDED.
// A rejected edit (oldText not found, sandbox block, non-unique match) leaves the file
// untouched, and replaying it anyway would desynchronise every later md5.
const WROTE = /^Successfully wrote \d+ bytes to /;
const REPLACED = /^Successfully replaced \d+ block\(s\) in /;
const HEADER = /^checked (.*?) \((\d+) bytes, md5 ([0-9a-f]+)\)/;

// Models address problem.lean both relatively and absolutely. The absolute form names
// the attempt's ORIGINAL location, so a dir that has since been moved (results/_archive)
// would resolve to nothing and the replay would silently drop every edit — which the md5
// check would then report as a corpus-wide mismatch rather than as a moved directory.
// The sandbox (extensions/file-sandbox.ts) guarantees every successful write landed
// inside that attempt's own work/, so the path tail identifies the file unambiguously.
function targetsProblemFile(p, attemptDir, workFile) {
  return resolve(join(attemptDir, "work"), p) === workFile || /(^|\/)work\/problem\.lean$/.test(p);
}

function textOf(m) {
  return (m.content ?? []).filter((c) => c.type === "text").map((c) => c.text ?? "").join("");
}

function sessionEntries(attemptDir) {
  const dir = join(attemptDir, "session");
  let files;
  try { files = readdirSync(dir).filter((f) => f.endsWith(".jsonl")).sort(); } catch { return []; }
  // Several files = the pre-2026-07-29 respawn era, one session per nudge cycle. The
  // file on disk survived across respawns, so filename order IS attempt order.
  const out = [];
  for (const f of files) {
    for (const line of readFileSync(join(dir, f), "utf8").split("\n")) {
      if (!line.trim()) continue;
      try { out.push(JSON.parse(line)); } catch {}
    }
  }
  return out;
}

function scanAttempt(runDir, name, problemsDir) {
  const attemptDir = join(runDir, name);
  const origPath = join(problemsDir, `${name}.lean`);
  const entries = sessionEntries(attemptDir);
  if (!entries.length || !existsSync(origPath)) return null;

  const original = readFileSync(origPath, "utf8");
  const workFile = resolve(join(attemptDir, "work", "problem.lean"));
  let state = original; // run.js copies the problem file in as the starting problem.lean
  let turns = 0, checkIndex = 0;
  const tokens = { in: 0, out: 0, cache_read: 0 };
  const pending = new Map(); // toolCallId -> {name, args}
  const checks = [];
  let edits = 0, writes = 0, failedEdits = 0, desynced = false;

  for (const e of entries) {
    const m = e.message;
    if (!m) continue;
    if (m.role === "assistant") {
      turns++;
      const u = m.usage;
      if (u) { tokens.in += u.input ?? 0; tokens.out += u.output ?? 0; tokens.cache_read += u.cacheRead ?? 0; }
      // Raw recorded arguments, normalized exactly as the tool's prepareArguments does.
      for (const b of m.content ?? []) if (b.type === "toolCall") pending.set(b.id, { name: b.name, args: normalizeEditArgs(b.arguments ?? {}) });
      continue;
    }
    if (m.role !== "toolResult") continue;
    const call = pending.get(m.toolCallId);
    const text = textOf(m);

    if (call && (call.name === "write" || call.name === "edit")) {
      const p = call.args?.path;
      if (typeof p === "string" && targetsProblemFile(p, attemptDir, workFile)) {
        if (call.name === "write" && WROTE.test(text)) { state = String(call.args.content ?? ""); writes++; }
        else if (call.name === "edit" && REPLACED.test(text)) {
          try { state = applyEdits(state, call.args.edits ?? [], "problem.lean").newContent; edits++; }
          catch { desynced = true; } // replay diverged; the md5 check below will say so
        } else failedEdits++;
      }
      continue;
    }

    if (m.toolName !== "lean_check") continue;
    checkIndex++;
    const h = HEADER.exec(text);
    const d = m.details ?? null;
    // Both renderers, because this scanner reads transcripts from before and after the
    // 2026-08-07 check-output re-cut: the old one ended a cut result with "(truncated)"
    // and printed sorries last (hence "ambiguous" — an ok-looking check that may have
    // hidden a sorry list); the new one cuts only the ERROR section, marks it inline, and
    // states every sorry line in its header, so `ambiguous` cannot arise in new runs.
    const truncated = text.trimEnd().endsWith("(truncated)") || text.includes("[... errors truncated");
    const sorried = /sorr(?:y|ies) at line/.test(text) || text.includes("declaration uses 'sorry'");
    const replayMd5 = md5(state);
    const rec = {
      index: checkIndex,
      turn: turns,
      cost_std: costStd(tokens),
      header_md5: h ? h[3] : null,
      header_bytes: h ? +h[2] : null,
      replay_md5: replayMd5,
      // The header md5 is 12 hex chars (a prefix), so compare prefixes.
      verified: h ? replayMd5.startsWith(h[3]) : null,
      code: state,
      truncated,
      colour:
        d?.ok === true ? (sorried ? "sorry" : truncated ? "ambiguous" : "green")
        : d?.ok === false ? "fail"
        : "error", // thrown ToolFailure: unavailable/crash, no verdict about the file
    };
    checks.push(rec);
  }

  const finalReplay = md5(state);
  let finalOnDisk = null;
  try { finalOnDisk = md5(readFileSync(workFile, "utf8")); } catch {}
  return {
    run: basename(runDir), problem: name, attemptDir, origPath, original,
    turns, checks, edits, writes, failedEdits, desynced,
    cost_std_end: costStd(tokens),
    final_replay_md5: finalReplay, final_ondisk_md5: finalOnDisk,
    final_replay_ok: finalOnDisk == null ? null : finalOnDisk === finalReplay,
  };
}

// What happened after the first proof — the question this whole audit exists to answer.
function after(a, firstIdx) {
  const first = a.checks.find((c) => c.index === firstIdx);
  const later = a.checks.filter((c) => c.index > firstIdx);
  const byColour = {};
  for (const c of later) byColour[c.colour] = (byColour[c.colour] ?? 0) + 1;
  return {
    first,
    checks_after: later.length,
    checks_after_by_colour: byColour,
    // Bytes, not intentions: did the file the attempt submitted differ from the proof?
    changed_after: a.final_replay_md5 !== first.replay_md5,
    turns_after: a.turns - first.turn,
    cost_std_after: +(a.cost_std_end - first.cost_std).toFixed(5),
    cost_std_at_proof: +first.cost_std.toFixed(5),
    // A later green means it wrecked the proof and got it back (or improved it).
    last_green_index: later.filter((c) => c.colour === "green").at(-1)?.index ?? firstIdx,
  };
}

// --- scan ---------------------------------------------------------------------

const attempts = [];
for (const runDir of runDirs) {
  let meta;
  try { meta = JSON.parse(readFileSync(join(runDir, "run.json"), "utf8")); } catch { continue; }
  const problemsDir = meta.problems_dir ?? join(ROOT, "problems");
  const names = readdirSync(runDir).filter((f) => { try { return statSync(join(runDir, f)).isDirectory(); } catch { return false; } });
  let n = 0;
  for (const name of names.sort()) {
    const a = scanAttempt(runDir, name, problemsDir);
    if (!a) continue;
    try {
      const rec = JSON.parse(readFileSync(join(runDir, name, "attempt.json"), "utf8"));
      a.solved = !!rec.solved;
      a.end = rec.end ?? null;
      a.reason = rec.solved ? null : rec.grade?.reason ?? rec.fail_reason ?? null;
      a.cost_std_recorded = rec.cost_std ?? null;
    } catch { a.solved = null; a.end = null; a.reason = "no_record"; }
    a.run_meta = { combo: meta.combo ?? [], git_sha: meta.git_sha ?? null, started_at: meta.started_at ?? null };
    attempts.push(a);
    n++;
  }
  process.stderr.write(dim(`  scanned ${basename(runDir)}: ${n} attempts\n`));
}

const totals = { attempts: attempts.length, checks: 0, green: 0, ambiguous: 0, sorry: 0, fail: 0, error: 0, unverified: 0 };
for (const a of attempts) {
  for (const c of a.checks) { totals.checks++; totals[c.colour]++; if (c.verified === false) totals.unverified++; }
}

// --- resolve the ambiguous checks --------------------------------------------
// A truncated ok-check might be a proof or might be a wall of sorries. Recompile the
// reconstructed bytes and ask the same gate the harness asks (runner/highwater.js).

const ambiguous = attempts.flatMap((a) => a.checks.filter((c) => c.colour === "ambiguous").map((c) => ({ a, c })));
let resolved = { green: 0, sorry: 0, unresolved: 0 };
if (!NO_VERIFY && ambiguous.length) {
  console.log(bold(`\nresolving ${ambiguous.length} truncated ok-checks by recompile`));
  for (const { a, c } of ambiguous) {
    if (c.verified === false) { c.colour = "ambiguous-unverified"; resolved.unresolved++; continue; }
    try {
      const r = await checkedCompile(c.code, { original: a.original, problemName: a.problem, client: "highwater-scan" });
      if (r.error) { c.colour = "ambiguous-unresolved"; resolved.unresolved++; continue; }
      c.colour = verifiedDone(r) ? "green" : "sorry";
      c.resolved_by_recompile = true;
      resolved[c.colour]++;
    } catch (e) {
      c.colour = "ambiguous-unresolved";
      c.error = e.message;
      resolved.unresolved++;
    }
    process.stderr.write(dim(`    ${a.run}/${a.problem} check ${c.index} -> ${c.colour}\n`));
  }
}

// --- the high-water verdict ---------------------------------------------------

for (const a of attempts) {
  const firstGreen = a.checks.find((c) => c.colour === "green");
  a.high_water = firstGreen ? after(a, firstGreen.index) : null;
}

// Re-grade the first-green file where it matters. "The harness of the day said green"
// is not the same claim as "this file grades solved today": the axiom gate only entered
// the agent-facing check on 2026-08-04, and before 2026-08-01 a measured CPU budget
// could convict a file the agent had watched compile. Only a fresh grade() settles it.
const toVerify = attempts.filter((a) => a.high_water && (VERIFY_ALL || a.solved === false));
if (!NO_VERIFY && toVerify.length) {
  console.log(bold(`\nre-grading ${toVerify.length} first-proof files with the current grader`));
  const tmp = mkdtempSync(join(tmpdir(), "highwater-"));
  try {
    for (const a of toVerify) {
      const c = a.high_water.first;
      if (c.verified === false) { a.high_water.verdict = { solved: false, reason: "replay_unverified" }; continue; }
      const p = join(tmp, `${a.problem}.lean`);
      writeFileSync(p, c.code);
      try {
        // end:"completed" — a snapshot is a file the agent deliberately produced and
        // watched pass, so the statement checks apply straight (grade.js opts.end).
        const g = await grade(a.problem, p, a.origPath, { end: "completed" });
        a.high_water.verdict = { solved: g.solved, reason: g.solved ? null : g.reason, detail: g.solved ? null : (g.detail ?? "").split("\n")[0].slice(0, 200) };
      } catch (e) {
        a.high_water.verdict = { solved: false, reason: "grader_error", detail: e.message.slice(0, 200) };
      }
      const v = a.high_water.verdict;
      process.stderr.write(`    ${a.run}/${a.problem} ${v.solved ? green("proof confirmed") : red(`not a proof: ${v.reason}`)}\n`);
    }
  } finally { rmSync(tmp, { recursive: true, force: true }); }
}

// --- report -------------------------------------------------------------------

const withProof = attempts.filter((a) => a.high_water);
const lost = withProof.filter((a) => a.solved === false);
const confirmedLost = lost.filter((a) => a.high_water.verdict?.solved === true);
const changedAfter = withProof.filter((a) => a.high_water.changed_after);

const pct = (x, n) => (n ? `${((100 * x) / n).toFixed(1)}%` : "-");
console.log(bold("\n=== solved high-water scan ==="));
console.log(`  attempts scanned:        ${totals.attempts}`);
console.log(`  lean_check results:      ${totals.checks}  (green ${totals.green}, sorry ${totals.sorry}, fail ${totals.fail}, error ${totals.error})`);
console.log(`  replay md5 mismatches:   ${totals.unverified} ${dim(`(${pct(totals.unverified, totals.checks)} of checks)`)}`);
console.log(`  attempts reaching green: ${withProof.length} ${dim(`(${pct(withProof.length, totals.attempts)})`)}`);
console.log(`  ... that kept editing:   ${changedAfter.length} ${dim(`(${pct(changedAfter.length, withProof.length)} of them)`)}`);
console.log(
  `  ... graded UNSOLVED:     ${lost.length}` +
    (lost.length ? (NO_VERIFY ? dim("  (not re-graded: --no-verify)") : `, ${confirmedLost.length} with the proof confirmed by a fresh grade`) : ""),
);

const rows = [["run", "problem", "combo", "solved", "end", "reason", "checks", "first_green_check", "turn_at_proof",
  "cost_std_at_proof", "cost_std_end", "checks_after", "turns_after", "changed_after", "last_green_check",
  "highwater_verdict", "highwater_reason", "replay_verified"]];
for (const a of attempts.filter((x) => x.high_water)) {
  const h = a.high_water;
  rows.push([a.run, a.problem, (a.run_meta.combo ?? []).join("+") || "baseline", a.solved, a.end ?? "", a.reason ?? "",
    a.checks.length, h.first.index, h.first.turn, h.cost_std_at_proof, +a.cost_std_end.toFixed(5),
    h.checks_after, h.turns_after, h.changed_after, h.last_green_index,
    h.verdict ? h.verdict.solved : "", h.verdict?.reason ?? "", h.first.verified]);
}
writeFileSync(CSV, rows.map((r) => r.map((x) => (typeof x === "string" && /[",]/.test(x) ? `"${x.replace(/"/g, '""')}"` : x)).join(",")).join("\n") + "\n");
console.log(dim(`\n  per-attempt csv: ${CSV}`));

// Markdown: the narrative the audit reports are written in, generated from the same
// numbers so the report and the csv cannot disagree.
const lines = [];
lines.push(`# Solved high-water audit — ${DATE}`, "");
lines.push(`Reconstructed from pi session files across ${runDirs.length} runs. Read-only: no recorded verdict was changed.`, "");
lines.push("## Corpus", "");
lines.push(`- ${totals.attempts} attempts, ${totals.checks} \`lean_check\` results.`);
lines.push(`- Check colours: ${totals.green} green, ${totals.sorry} sorry-carrying, ${totals.fail} failing, ${totals.error} server errors.`);
lines.push(`- ${ambiguous.length} ok-checks were truncated before their sorry list and had to be recompiled to be coloured` +
  (NO_VERIFY ? " (skipped: --no-verify)." : `: ${resolved.green} were real proofs, ${resolved.sorry} were hiding sorries, ${resolved.unresolved} unresolved.`));
lines.push(`- Replay fidelity: ${totals.checks - totals.unverified}/${totals.checks} checks reproduced the exact bytes the agent compiled (md5 from the check header).`);
lines.push("");
lines.push("## Did anyone hold a proof and not submit it?", "");
lines.push(`${withProof.length} of ${totals.attempts} attempts reached a green check. ${changedAfter.length} of those kept editing afterwards, and ${lost.length} graded unsolved.`, "");
if (lost.length) {
  lines.push("| run | problem | end | graded | first green | checks after | turns after | cost@proof | cost end | proof re-graded |", "|---|---|---|---|---|---|---|---|---|---|");
  for (const a of lost) {
    const h = a.high_water;
    lines.push(`| ${a.run} | ${a.problem} | ${a.end ?? "-"} | ${a.reason ?? "-"} | ${h.first.index}/${a.checks.length} | ${h.checks_after} | ${h.turns_after} | $${h.cost_std_at_proof} | $${a.cost_std_end.toFixed(4)} | ${h.verdict ? (h.verdict.solved ? "**solved**" : h.verdict.reason) : "not run"} |`);
  }
  lines.push("");
}
lines.push("## What agents do after their first proof", "");
const kept = withProof.filter((a) => a.high_water.checks_after > 0);
lines.push(`- ${kept.length}/${withProof.length} ran at least one more \`lean_check\` after the proof.`);
lines.push(`- ${changedAfter.length}/${withProof.length} submitted different bytes than the proof they held.`);
const solvedChanged = changedAfter.filter((a) => a.solved === true).length;
lines.push(`- Of those, ${solvedChanged} still graded solved (a refactor that held) and ${changedAfter.length - solvedChanged} did not.`);
const costs = withProof.map((a) => [a.high_water.cost_std_at_proof, a.cost_std_end]).filter(([p, e]) => e > 0);
const share = costs.length ? costs.reduce((s, [p, e]) => s + p / e, 0) / costs.length : 0;
lines.push(`- Cost at first proof averages ${(100 * share).toFixed(1)}% of cost at attempt end — the rest is spent after the problem is already solved.`);
lines.push("");
lines.push("## Per-attempt data", "", `\`${basename(CSV)}\` (same directory).`, "");
writeFileSync(OUT, lines.join("\n"));
console.log(dim(`  report:          ${OUT}\n`));
