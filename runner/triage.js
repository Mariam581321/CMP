#!/usr/bin/env node
// Triage judge (PLAN.md, off the hill-climb): one feasibility judge per problem —
// an agentic loop with the attempt arm's RETRIEVAL tool (from --combo) plus
// submit_verdict, which ends the session. No compiler of any kind: check_snippet was
// removed 2026-08-15 (Mariam's decision) — snippetonly showed verified scratch
// compilation is the grid's active ingredient, so a judge that can compile is halfway
// to an attempt arm, and its "yes" drifts from prediction ("that agent would prove
// this") toward trial ("I part-proved it"), with the judge fee drifting toward attempt
// cost. A judge of a search-less arm therefore holds ONLY submit_verdict: pure prior
// prediction from the statement. The arm is never "run" as an attempt arm:
// runner/triage-join.js reweights an existing cell with these verdicts. Judges ride
// the worker machinery (runner/spawn.js) with a judge view.
//
//   node runner/triage.js --combo lean-grep \
//     --problems problems-fatex/pilot10-0802.txt --problems-dir problems-fatex \
//     --cap-std 0.15 --target-budget-std 1.00 --run-id triage-grep1-pilot10-0815
//
// Add --print-view to the same command to print the judge's ENTIRE view for the first
// problem — system prompt, user message, tool schemas, request params, exactly as the
// provider receives them — and exit without running or spending anything.
//
// The judge is told which arm it is judging — that arm's tools and that arm's
// per-problem budget (--combo, --target-budget-std), since the join's counterfactual
// is about one cell, not about provability in principle. It is told nothing about how
// to decide (prompt variant plain-0815, recorded per verdict; see the judgePrompt note).
//
// The cap (--cap-std, default 0.50) is generous by intent: a judge that runs out
// mid-deliberation records no verdict, and no-verdict problems are EXCLUDED from the
// counterfactual — an infra artifact must not become a filter decision. The judge
// never learns any of this: no language about ITS OWN budget anywhere, the session
// simply ends.
// Belt and braces on session end: submit_verdict sets pi's terminate flag AND this
// runner watches for verdict.json and stops the process itself.

import { parseArgs } from "node:util";
import { execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, appendFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runWorker } from "./spawn.js";
import { LEAN_URL, costStd, green, red, yellow, dim, bold, money, secs } from "./common.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

let A;
try {
  A = parseArgs({
    options: {
      combo: { type: "string", default: "lean-search,lean-snippet" },
      problems: { type: "string" },
      "problems-dir": { type: "string", default: join(ROOT, "problems") },
      "cap-std": { type: "string", default: "0.50" },
      concurrency: { type: "string", default: "10" },
      model: { type: "string", default: "deepseek/deepseek-v4-flash" },
      thinking: { type: "string", default: "high" },
      "max-tokens": { type: "string", default: "384000" },
      // The budget of the ARM BEING JUDGED (run.js --budget-std), quoted to the judge
      // as a property of that agent. Not the judge's own cap — see the prompt note.
      "target-budget-std": { type: "string", default: "1.00" },
      "run-id": { type: "string" },
      // Print the judge's whole view for the first problem and exit — no run, no spend.
      "print-view": { type: "boolean", default: false },
    },
    strict: true,
  }).values;
} catch (e) {
  console.error(e.message);
  process.exit(1);
}
const COMBO = A.combo.split(",").map((s) => s.trim()).filter(Boolean);
const PROBLEMS_DIR = resolve(A["problems-dir"]);
const CAP_STD = parseFloat(A["cap-std"]);
const TARGET_BUDGET = parseFloat(A["target-budget-std"]);
const CONCURRENCY = parseInt(A.concurrency);
const MAX_TOKENS = parseInt(A["max-tokens"]);
for (const [flag, v, min] of [["cap-std", CAP_STD, 0.01], ["target-budget-std", TARGET_BUDGET, 0.01], ["concurrency", CONCURRENCY, 1], ["max-tokens", MAX_TOKENS, 0]]) {
  if (!Number.isFinite(v) || v < min) { console.error(`--${flag}: not a number ≥ ${min}`); process.exit(1); }
}
if (!A.problems) { console.error("--problems <file> is required"); process.exit(1); }
const PRINT_VIEW = A["print-view"];
const RUN_ID = A["run-id"] ?? `triage-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, "")}`;

const dotenv = join(ROOT, ".env");
if (existsSync(dotenv)) process.loadEnvFile(dotenv);
process.env.PATH = `${process.env.HOME}/.local/node/bin:${process.env.HOME}/.elan/bin:${process.env.PATH}`;
process.env.CMP_LEAN_ENV = join(ROOT, "lean-env");
process.env.PI_CODING_AGENT_DIR = join(ROOT, "pi-agent");

const problems = readFileSync(A.problems, "utf8").split("\n").map((s) => s.trim()).filter(Boolean);
const runDir = join(ROOT, "results", RUN_ID);
if (!PRINT_VIEW) {
  if (existsSync(join(runDir, "triage.jsonl"))) {
    console.error(`results/${RUN_ID}/ already has a triage.jsonl — pick a new --run-id`);
    process.exit(1);
  }
  mkdirSync(runDir, { recursive: true });
}

// Only search_mathlib talks to the server now (grep_mathlib greps source on disk, the
// verdict tool writes a file) — a compile-free judge should not be blocked by a REPL
// that it will never call.
if (COMBO.includes("lean-search") && !PRINT_VIEW) {
  const health = await fetch(`${LEAN_URL}/health`, { signal: AbortSignal.timeout(3000) }).then((r) => r.json()).catch(() => null);
  if (!health?.ready) { console.error("lean server not ready — search_mathlib judges need it"); process.exit(1); }
}

// The whole judge view: the question, the agent it is about, the theorem, submit.
//
// PROMPT VARIANT plain-0815 (was no-compile-0815, itself was target-arm-0815). Same
// question, stripped: everything that told the judge HOW to answer is gone, and what
// is left is only what the question is unintelligible without. Cut, and why —
//   - "for example: the required theory is absent from Mathlib and far too large to
//     build within that limit, or the statement is false as formalized" — two failure
//     modes named in the question is a checklist. A judge that finds neither has been
//     handed a reason to say yes; whether it generates its own failure modes IS the
//     measurement.
//   - "Investigate however you see fit with the tools you have" — permission nobody
//     withheld, and naming investigation invites turns to be spent proving it happened.
//   - "You are judging feasibility, not producing a solution" — the prompt no longer
//     needs a disclaimer about a solution it never asks for.
//   - The editorial trim ("It works alone", "stopped where it stands, proved or not"):
//     the same facts, said once.
// Kept, because the counterfactual is not defined without them:
//   1. The subject arm described explicitly, not by analogy — "same tools you have" was
//      false in both directions, and is worse now that the judge holds at most a search
//      tool (nothing at all for a search-less arm).
//   2. The arm's per-problem budget. "Provable in principle" and "provable at $1" are
//      different predicates on this tier — the reference grep cell's failures burned
//      $0.75 mean against a $1 cap — and the gate is only a gate if the judge answers
//      the second. This does NOT breach the no-budget-language rule (2026-08-04): that
//      rule keeps the judge's OWN cap out of its view, because enforcement must never
//      become information. The subject's budget is the opposite thing — it is the
//      counterfactual being predicted. The judge's own cap stays unmentioned, and a
//      capped judge still just ends.
//   3. "you cannot compile, run or test anything ... a prediction, not your own
//      attempt". Without it the judge's own emptyhandedness reads as evidence about the
//      subject, which is a much larger thumb on the scale than the sentence is.
// Residual, deliberately not narrated to the judge: its grep results are rendered
// path-free (cfg.mathlib_read is unset for judges), so it cannot open Mathlib sources
// the way the grep arm can. The judge is told what the arm has; it is not told that it
// has less. That asymmetry biases verdicts pessimistic, so it is a caveat on "no", not
// a silent thumb on "yes".
const retrievalLine = COMBO.includes("lean-grep")
  ? "- Searches Mathlib with grep_mathlib: text and regex search over the Mathlib source at the version it compiles against. It can open the source files those results name."
  : COMBO.includes("lean-search")
    ? "- Searches Mathlib with search_mathlib: semantic search returning matching declarations with their signatures."
    : "- Has no search tool.";
const judgePrompt = (statement) => `Would the agent described below prove the theorem below, in Lean 4 with Mathlib?

The agent:
- Works in a directory holding problem.lean — the theorem below, with the proof left as \`sorry\`. It reads, writes and edits that file, and compiles it with lean_check, which returns the verdict (COMPLETE, INCOMPLETE or FAILED), every error with its line number, and the goal state at each remaining \`sorry\`.
${retrievalLine}
- Has no other tools: no shell, no internet, no other agents, no human. One session, on the model you are running on.
- Stops at about $${TARGET_BUDGET.toFixed(2)} of model usage at standard prices, proved or not.
- May not add \`axiom\` declarations, use \`native_decide\`, or alter the theorem statement.

You cannot compile, run or test anything: your answer is a prediction about that agent, not a report of your own attempt. Answer with submit_verdict — "yes" or "no", and your reason, which is recorded. It is the only way to finish.

The theorem:

\`\`\`lean
${statement}
\`\`\``;

// Judge toolset = the arm's retrieval tool + the verdict tool, nothing else.
// check_snippet, lean_check, files, spawn and facts never appear here, whatever the
// combo says; a judge of a search-less arm holds only submit_verdict.
const extTools = (name) => {
  const m = /^\/\/ @tools\s+(.+)$/m.exec(readFileSync(join(ROOT, "extensions", `${name}.ts`), "utf8"));
  return m ? m[1].split(",").map((s) => s.trim()).filter(Boolean) : [];
};
const exts = [...COMBO.filter((x) => ["lean-search", "lean-grep", "lean-loogle"].includes(x)), "lean-verdict"];
const view = { exts, tools: exts.flatMap(extTools) };

// The one user message. The system prompt already asks the question; this only starts
// the turn, so it says nothing the system prompt has not said.
const TASK = "Answer the question in your instructions with submit_verdict.";

// Verdicts are only interpretable against the question that produced them, so the
// variant id rides in every record and in the summary — and so do the same freeze
// identifiers run.js records (git sha + pi version; the sha alone under-identifies the
// harness, one `npm update` wide hole).
const PROMPT_VARIANT = "plain-0815";
let gitSha = "unknown";
try { gitSha = execSync("git rev-parse --short HEAD", { cwd: ROOT }).toString().trim(); } catch {}
let piVersion = "unknown";
try { piVersion = execSync("pi --version", { env: process.env }).toString().trim(); } catch {}

console.log(bold(`\ntriage ${RUN_ID}`));
console.log(dim(`  judge tools: ${view.tools.join(", ")}   cap: ${money(CAP_STD)} @std   problems: ${problems.length}`));
console.log(dim(`  prompt:      ${PROMPT_VARIANT} — subject arm: ${COMBO.join(" + ") || "(baseline)"} + lean_check + files @ ${money(TARGET_BUDGET)}/problem\n`));

// --print-view: the judge's ENTIRE view for the first problem, read off the provider
// payload (extensions/dump-view.ts dumps it and exits before the request is sent, so
// this costs nothing) rather than reconstructed here — the prompt this file writes is
// not the prompt the model gets: pi appends its own trailer to a custom system prompt,
// and the tool schemas come from the extensions. Reconstruction would drift; this
// cannot. Nothing is written to results/.
if (PRINT_VIEW) {
  const name = problems[0];
  const tmpDir = mkdtempSync(join(tmpdir(), "triage-view-"));
  const dumpPath = join(tmpDir, "payload.json");
  process.env.CMP_DUMP_VIEW = dumpPath;
  await runWorker({
    idx: 0,
    dirName: name,
    task: TASK,
    cfg: { problem: name, model: A.model, thinking: A.thinking, max_tokens: MAX_TOKENS > 0 ? MAX_TOKENS : null, workers_dir: tmpDir },
    view: { ...view, exts: [...exts, "dump-view"], systemPrompt: judgePrompt(readFileSync(join(PROBLEMS_DIR, `${name}.lean`), "utf8").trim()) },
  }).promise;
  let payload;
  try { payload = JSON.parse(readFileSync(dumpPath, "utf8")); } catch {
    console.error(`no payload dumped — see ${join(tmpDir, name, "stderr.log")}`);
    process.exit(1);
  }
  const rule = (s) => console.log(bold(`\n${"─".repeat(78)}\n${s}\n${"─".repeat(78)}`));
  const text = (c) => (typeof c === "string" ? c : (c ?? []).map((b) => b?.text ?? JSON.stringify(b)).join("\n"));
  rule(`SYSTEM PROMPT  (problem ${name}, variant ${PROMPT_VARIANT})`);
  console.log(payload.system ? text(payload.system) : (payload.messages ?? []).filter((m) => m.role === "system").map((m) => text(m.content)).join("\n"));
  for (const m of (payload.messages ?? []).filter((m) => m.role !== "system")) {
    rule(`${m.role.toUpperCase()} MESSAGE`);
    console.log(text(m.content));
  }
  const tools = payload.tools ?? [];
  rule(`TOOLS  (${tools.length})`);
  for (const t of tools) {
    const f = t.function ?? t;
    console.log(`\n${bold(f.name)}\n${f.description}\nparameters: ${JSON.stringify(f.parameters ?? f.input_schema)}`);
  }
  rule("EVERYTHING ELSE IN THE REQUEST");
  console.log(JSON.stringify(Object.fromEntries(Object.entries(payload).filter(([k]) => !["system", "messages", "tools"].includes(k))), null, 2));
  process.exit(0);
}

async function judge(name, idx) {
  const statement = readFileSync(join(PROBLEMS_DIR, `${name}.lean`), "utf8").trim();
  const cfg = {
    problem: name, // REPL round-robin client id
    model: A.model,
    thinking: A.thinking,
    max_tokens: MAX_TOKENS > 0 ? MAX_TOKENS : null,
    workers_dir: runDir,
  };
  const started = Date.now();
  const handle = runWorker({
    idx,
    dirName: name,
    task: TASK,
    maxCostStd: CAP_STD,
    cfg,
    view: { ...view, systemPrompt: judgePrompt(statement) },
  });
  // Stop the process once the verdict lands (grace period lets pi flush the session)
  // — terminate-on-tool plus this watcher covers both pi behaviors.
  const verdictPath = join(runDir, name, "work", "verdict.json");
  const watcher = setInterval(() => {
    if (existsSync(verdictPath)) {
      clearInterval(watcher);
      setTimeout(() => handle.kill("verdict"), 3000);
    }
  }, 1000);
  const r = await handle.promise;
  clearInterval(watcher);
  let v = null;
  try { v = JSON.parse(readFileSync(verdictPath, "utf8")); } catch {}
  const rec = {
    run_id: RUN_ID, problem: name, combo: COMBO, model: A.model,
    prompt_variant: PROMPT_VARIANT, target_budget_std: TARGET_BUDGET,
    harness_git_sha: gitSha, pi_version: piVersion,
    verdict: v?.verdict ?? null, reason: v?.reason ?? null, reminders: v?.reminders ?? null,
    end: v ? "verdict" : r.end, turns: r.stats.turns,
    tokens: r.stats.tokens, cost_usd: +r.stats.cost.toFixed(5), cost_std: +costStd(r.stats.tokens).toFixed(5),
    tool_calls: r.stats.toolCalls, wall_s: Math.round((Date.now() - started) / 1000), cap_std: CAP_STD,
  };
  appendFileSync(join(runDir, "triage.jsonl"), JSON.stringify(rec) + "\n");
  const tag = rec.verdict === "yes" ? green("yes") : rec.verdict === "no" ? red("no ") : yellow("∅  (no verdict)");
  console.log(`  ${dim(`[${String(idx + 1).padStart(2)}/${problems.length}]`)} ${name.padEnd(14)} ${tag}  ${dim(`${rec.turns} turns, ${money(rec.cost_std)}, ${secs(Date.now() - started)}`)}${rec.reason ? dim(`  — ${String(rec.reason).slice(0, 100)}`) : ""}`);
  return rec;
}

const queue = problems.map((p, i) => [p, i]);
const records = [];
await Promise.all(
  Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => {
    while (queue.length) {
      const [name, idx] = queue.shift();
      try {
        records.push(await judge(name, idx));
      } catch (err) {
        console.log(`  ${red("✗ runner error")} ${name}: ${err.message}`);
        records.push({ run_id: RUN_ID, problem: name, verdict: null, end: "runner_error", error: String(err).slice(0, 300) });
        try { appendFileSync(join(runDir, "triage.jsonl"), JSON.stringify(records.at(-1)) + "\n"); } catch {}
      }
    }
  }),
);

const count = (v) => records.filter((r) => r.verdict === v).length;
const cost = records.reduce((s, r) => s + (r.cost_std ?? 0), 0);
const summary = {
  run_id: RUN_ID, combo: COMBO, model: A.model, cap_std: CAP_STD,
  prompt_variant: PROMPT_VARIANT, target_budget_std: TARGET_BUDGET,
  harness_git_sha: gitSha, pi_version: piVersion, problems: records.length,
  yes: count("yes"), no: count("no"), no_verdict: records.filter((r) => r.verdict == null).length,
  cost_std: +cost.toFixed(4), finished_at: new Date().toISOString(),
};
writeFileSync(join(runDir, "triage.json"), JSON.stringify(summary, null, 2));
console.log(bold(`\n${summary.yes} yes / ${summary.no} no / ${summary.no_verdict} no-verdict  (${money(cost)} @std)`));
console.log(dim(`  results/${RUN_ID}/triage.jsonl\n`));
