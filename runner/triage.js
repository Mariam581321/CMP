#!/usr/bin/env node
// Triage judge (PLAN.md, off the hill-climb): one feasibility judge per problem —
// an agentic loop with the attempt arm's information tools (search + check_snippet,
// from --combo) plus submit_verdict, which ends the session. The arm is never "run"
// as an attempt arm: runner/triage-join.js reweights an existing cell with these
// verdicts. Judges ride the worker machinery (runner/spawn.js) with a judge view.
//
//   node runner/triage.js --combo lean-search,lean-snippet \
//     --problems problems-fatex/pilot10-0802.txt --problems-dir problems-fatex \
//     --run-id triage-pilot10-0804
//
// The cap (--cap-std, default 0.50) is generous by intent: a judge that runs out
// mid-deliberation records no verdict, and no-verdict problems are EXCLUDED from the
// counterfactual — an infra artifact must not become a filter decision. The judge
// never learns any of this: no budget language anywhere, the session simply ends.
// Belt and braces on session end: submit_verdict sets pi's terminate flag AND this
// runner watches for verdict.json and stops the process itself.

import { parseArgs } from "node:util";
import { mkdirSync, readFileSync, writeFileSync, appendFileSync, existsSync } from "node:fs";
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
      "run-id": { type: "string" },
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
const CONCURRENCY = parseInt(A.concurrency);
const MAX_TOKENS = parseInt(A["max-tokens"]);
for (const [flag, v, min] of [["cap-std", CAP_STD, 0.01], ["concurrency", CONCURRENCY, 1], ["max-tokens", MAX_TOKENS, 0]]) {
  if (!Number.isFinite(v) || v < min) { console.error(`--${flag}: not a number ≥ ${min}`); process.exit(1); }
}
if (!A.problems) { console.error("--problems <file> is required"); process.exit(1); }
const RUN_ID = A["run-id"] ?? `triage-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, "")}`;

const dotenv = join(ROOT, ".env");
if (existsSync(dotenv)) process.loadEnvFile(dotenv);
process.env.PATH = `${process.env.HOME}/.local/node/bin:${process.env.HOME}/.elan/bin:${process.env.PATH}`;
process.env.CMP_LEAN_ENV = join(ROOT, "lean-env");
process.env.PI_CODING_AGENT_DIR = join(ROOT, "pi-agent");

const problems = readFileSync(A.problems, "utf8").split("\n").map((s) => s.trim()).filter(Boolean);
const runDir = join(ROOT, "results", RUN_ID);
if (existsSync(join(runDir, "triage.jsonl"))) {
  console.error(`results/${RUN_ID}/ already has a triage.jsonl — pick a new --run-id`);
  process.exit(1);
}
mkdirSync(runDir, { recursive: true });

const health = await fetch(`${LEAN_URL}/health`, { signal: AbortSignal.timeout(3000) }).then((r) => r.json()).catch(() => null);
if (!health?.ready) { console.error("lean server not ready — judges need snippet checks"); process.exit(1); }

// The whole judge view: question, tools, submit. No method steering, no budget talk.
const judgePrompt = (statement) => `You are judging feasibility, not producing a solution. The question: can the theorem below be proved in Lean 4 with Mathlib, in this environment, by an agent with the same tools you have? Investigate however you see fit — search Mathlib, compile snippets, try proof steps. When your verdict is settled, submit it with submit_verdict: "yes" if you judge it provable here, "no" if not (for example: the required theory is absent from Mathlib and far too large to build here, or the statement is false as formalized). The reason you submit is recorded.

Rules:
- There are no files and no shell in this environment; check_snippet compiles self-contained snippets against Mathlib.
- No new \`axiom\` declarations. No \`native_decide\`.
- submit_verdict is the only way to finish the task.

The theorem:

\`\`\`lean
${statement}
\`\`\``;

// Judge toolset = the arm's information tools + the verdict tool. lean_check, files,
// spawn and facts never appear here, whatever the combo says.
const extTools = (name) => {
  const m = /^\/\/ @tools\s+(.+)$/m.exec(readFileSync(join(ROOT, "extensions", `${name}.ts`), "utf8"));
  return m ? m[1].split(",").map((s) => s.trim()).filter(Boolean) : [];
};
const exts = ["lean-snippet", ...COMBO.filter((x) => ["lean-search", "lean-grep", "lean-loogle"].includes(x)), "lean-verdict"];
const view = { exts, tools: exts.flatMap(extTools) };

console.log(bold(`\ntriage ${RUN_ID}`));
console.log(dim(`  judge tools: ${view.tools.join(", ")}   cap: ${money(CAP_STD)} @std   problems: ${problems.length}\n`));

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
    task: "Judge whether the theorem in your instructions is provable in this environment, then submit your verdict.",
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
  run_id: RUN_ID, combo: COMBO, model: A.model, cap_std: CAP_STD, problems: records.length,
  yes: count("yes"), no: count("no"), no_verdict: records.filter((r) => r.verdict == null).length,
  cost_std: +cost.toFixed(4), finished_at: new Date().toISOString(),
};
writeFileSync(join(runDir, "triage.json"), JSON.stringify(summary, null, 2));
console.log(bold(`\n${summary.yes} yes / ${summary.no} no / ${summary.no_verdict} no-verdict  (${money(cost)} @std)`));
console.log(dim(`  results/${RUN_ID}/triage.jsonl\n`));
