#!/usr/bin/env node
// Run one extension combo over a problem list. One pi subprocess per problem in an
// isolated scratch dir, full event logging, independent grading, pretty output.
//
//   node runner/run.js --combo lean-search --problems problems/dev.txt
//
// Flags: --combo a,b ("" = baseline) --problems <file> --budget-std <usd> (1.00)
//        --timeout <s> (172800, wall-clock backstop)
//        --concurrency <n> (6) --model <id> --thinking <level> --run-id <s>
//        --problems-dir <dir> (problems/; e.g. problems-nl/ for statements with
//        the informal NL docstring kept)
//        --check-timeout <s> (120, REPL budget per agent-facing lean_check)
//        --peak-ok (allow launching during DeepSeek peak-hour pricing)

import { spawn, execSync } from "node:child_process";
import { parseArgs } from "node:util";
import { mkdirSync, readFileSync, writeFileSync, appendFileSync, copyFileSync, createWriteStream, existsSync, openSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { grade } from "./grade.js";
import { costStd, LEAN_PORT, LEAN_URL, green, red, yellow, dim, bold, cyan, money, secs } from "./common.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// ---------- args ----------
// strict: a mistyped flag is a hard error, not a silently-applied default — every
// flag here changes what an experiment measures or spends.
let A;
try {
  A = parseArgs({
    options: {
      combo: { type: "string", default: "" },
      problems: { type: "string", default: join(ROOT, "problems/dev.txt") },
      "problems-dir": { type: "string", default: join(ROOT, "problems") },
      "budget-std": { type: "string", default: "1.00" },
      timeout: { type: "string", default: "172800" },
      concurrency: { type: "string", default: "6" },
      model: { type: "string", default: "deepseek/deepseek-v4-flash" },
      thinking: { type: "string", default: "off" },
      "max-tokens": { type: "string", default: "384000" },
      "check-timeout": { type: "string", default: "120" },
      "run-id": { type: "string" },
      "peak-ok": { type: "boolean", default: false },
    },
    strict: true,
  }).values;
} catch (e) {
  console.error(e.message);
  process.exit(1);
}
const COMBO = A.combo.split(",").map((s) => s.trim()).filter(Boolean);
const PROBLEMS_FILE = A.problems;
const PROBLEMS_DIR = resolve(A["problems-dir"]);
// Attempts are capped by SPEND, not time: a per-problem budget in cost_std dollars
// (tokens at the fixed off-peak table, so the cap is peak-invariant). Checked after each
// assistant message, so enforcement lags by up to one message — accepted overshoot.
// Wall clock stays only as a generous backstop: a hung REPL or silent provider emits no
// usage events, so a spend cap alone would never fire. 0 disables the budget.
// Backstop sizing: burn varies hugely — check-queue-bound attempts at high concurrency
// spend <$0.08/h (fateh81 0727: three attempts killed at 14 h with budget unspent), so
// the backstop must sit far above the slowest plausible path to $1. 48 h means a timeout
// verdict is "genuinely hung", never "slow but working".
const BUDGET_STD = parseFloat(A["budget-std"]);
const TIMEOUT_S = parseInt(A.timeout);
const CONCURRENCY = parseInt(A.concurrency);
const MODEL = A.model;
const THINKING = A.thinking;
// Always send an explicit output cap — DeepSeek's server default is 8192/response when
// none is sent, and PLAN's protocol says a tight cap may only ever be a manipulated
// factor. Default = deepseek-v4-flash's max output. Capped experiment cells pass e.g.
// --max-tokens 8192; 0 falls back to the provider default (don't use in real runs).
const MAX_TOKENS = parseInt(A["max-tokens"]);
const CHECK_TIMEOUT_S = parseInt(A["check-timeout"]);
const RUN_ID = A["run-id"] ?? `${COMBO.join("+") || "baseline"}-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, "")}`;

// DeepSeek bills all items at 2x during peak hours: 01:00–04:00 and 06:00–10:00 UTC
// (peak-valley pricing, since mid-July 2026). The comparison metric cost_std is
// peak-invariant by construction, so peak only wastes real money — refuse to launch
// inside a window unless --peak-ok is passed. (billed cost_usd is informational.)
const IS_DEEPSEEK = MODEL.includes("deepseek");
const inPeak = (date) => {
  const h = date.getUTCHours();
  return (h >= 1 && h < 4) || (h >= 6 && h < 10);
};
if (IS_DEEPSEEK && inPeak(new Date()) && !A["peak-ok"]) {
  const endsAt = new Date().getUTCHours() < 4 ? "04:00" : "10:00";
  console.error(`DeepSeek peak-hour pricing is in effect (2x on all billing items; peak = 01:00-04:00 and 06:00-10:00 UTC).`);
  console.error(`This window ends at ${endsAt} UTC. Re-run then, or pass --peak-ok to pay 2x anyway (cost_std is unaffected).`);
  process.exit(1);
}

// ---------- setup ----------
const dotenv = join(ROOT, ".env");
if (existsSync(dotenv)) process.loadEnvFile(dotenv);
process.env.PATH = `${process.env.HOME}/.local/node/bin:${process.env.HOME}/.elan/bin:${process.env.PATH}`;
process.env.CMP_LEAN_ENV = join(ROOT, "lean-env");
process.env.CMP_LEAN_PORT = LEAN_PORT;

// Persistent lean server: reuse one that's already up, else spawn and wait for
// Mathlib to load (~1-2 min). Spawned server is killed when this run exits.
async function ensureLeanServer(logPath) {
  const health = () =>
    fetch(`${LEAN_URL}/health`, { signal: AbortSignal.timeout(2000) })
      .then((r) => r.json()).then((j) => j.ready).catch(() => null);
  if (await health()) return null;
  const fd = openSync(logPath, "a");
  const child = spawn("node", [join(ROOT, "runner/lean-server.js")], { env: process.env, stdio: ["ignore", fd, fd] });
  process.stdout.write(dim("  starting lean server (importing Mathlib)... "));
  for (let i = 0; i < 180; i++) {
    await new Promise((r) => setTimeout(r, 3000));
    if (await health()) { console.log(dim("ready")); return child; }
    if (child.exitCode != null) throw new Error(`lean server died; see ${logPath}`);
  }
  throw new Error("lean server did not become ready in 9 min");
}

for (const ext of COMBO)
  if (!existsSync(join(ROOT, "extensions", `${ext}.ts`))) {
    console.error(`unknown extension: ${ext} (no extensions/${ext}.ts)`);
    process.exit(1);
  }

// A model id pi's catalog doesn't know does NOT fail: pi clones the provider's default
// model and swaps only the id, so an unknown/mistyped id runs fine but is priced with
// the default model's cost table — silently wrong cost_usd in every result.
// Since cost is a measured output here, refuse to start unless the id is in the catalog.
{
  const listed = execSync("pi --list-models", { env: process.env, encoding: "utf8" });
  const id = MODEL.includes("/") ? MODEL.split("/").pop() : MODEL;
  if (!new RegExp(`^\\S+\\s+${id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s`, "m").test(listed)) {
    console.error(`model "${MODEL}" is not in pi's catalog — it would run but be priced as`);
    console.error(`the provider's default model. Check credentials in .env, or add a model`);
    console.error(`entry with the right cost block. \`pi --list-models\` shows what resolves.`);
    process.exit(1);
  }
}

// pi's --tools is an allowlist that also filters extension tools, so custom tool
// names must be listed explicitly. Each extension declares its own via a
// `// @tools name1,name2` header line (absent = registers none, e.g. prompt-only
// arms) — read from the file, so there is no central registry to forget to update.
const extTools = (name) => {
  const m = /^\/\/ @tools\s+(.+)$/m.exec(readFileSync(join(ROOT, "extensions", `${name}.ts`), "utf8"));
  return m ? m[1].split(",").map((s) => s.trim()).filter(Boolean) : [];
};
const toolList = ["read", "edit", "write", ...extTools("lean-check"), ...COMBO.flatMap(extTools)];

const problems = readFileSync(PROBLEMS_FILE, "utf8").split("\n").map((s) => s.trim()).filter(Boolean);
const runDir = join(ROOT, "results", RUN_ID);
if (existsSync(join(runDir, "results.jsonl"))) {
  console.error(`results/${RUN_ID}/ already has results — pick a new --run-id or move the old run aside`);
  process.exit(1);
}
mkdirSync(runDir, { recursive: true });
let gitSha = "unknown";
try { gitSha = execSync("git rev-parse --short HEAD", { cwd: ROOT }).toString().trim(); } catch {}
// The agent loop is whatever pi is globally installed — record its version, or the
// harness_git_sha alone under-identifies the harness (one `npm update` wide hole).
let piVersion = "unknown";
try { piVersion = execSync("pi --version", { env: process.env }).toString().trim(); } catch {}
const RUN_STARTED = Date.now();
writeFileSync(join(runDir, "run.json"), JSON.stringify({ run_id: RUN_ID, combo: COMBO, model: MODEL, thinking: THINKING, max_tokens: MAX_TOKENS || null, budget_std: BUDGET_STD || null, timeout_s: TIMEOUT_S, check_timeout_s: CHECK_TIMEOUT_S, concurrency: CONCURRENCY, problems, problems_dir: PROBLEMS_DIR, git_sha: gitSha, pi_version: piVersion, peak_pricing_at_launch: IS_DEEPSEEK && inPeak(new Date(RUN_STARTED)), started_at: new Date(RUN_STARTED).toISOString() }, null, 2));

const SYSTEM_PROMPT = `You are proving a theorem from a mathematics competition, formalized in Lean 4 with Mathlib.

The file problem.lean in your working directory contains the theorem statement with \`sorry\` placeholders.

Rules:
- Replace every \`sorry\` with real content. If there is an \`abbrev ..._solution := sorry\`, you must determine the answer yourself and fill it in too.
- NEVER modify the theorem statement, imports, or \`open\` lines. Only replace what comes after \`:=\` / fill in sorries. You may add helper lemmas ABOVE the theorem.
- No new \`axiom\` declarations. No \`native_decide\`.
- Use the lean_check tool to compile and verify your work. You are NOT done until lean_check reports no errors and no 'declaration uses sorry' warnings.
- Work efficiently: think before checking, since each check takes about a minute.
- NEVER end your response without a tool call unless lean_check has passed. Analysis alone is not an answer — put your reasoning into the proof and verify it.`;

// Per-arm prompt addenda: extensions/<name>.prompt.md is appended to the system prompt
// when <name> is in the combo, so prompt deltas are versioned alongside the arm's code.
const addenda = COMBO.map((x) => join(ROOT, "extensions", `${x}.prompt.md`)).filter(existsSync).map((p) => readFileSync(p, "utf8").trim());
const FULL_SYSTEM_PROMPT = [SYSTEM_PROMPT, ...addenda].join("\n\n");

const PROMPT = "Prove the theorem in problem.lean. Read it first, then work until lean_check passes with no errors and no sorry warnings.";
// Continuation policy (nudges) lives in extensions/supervisor.ts, in-process; the
// runner only passes the knob through CMP_CONFIG and keeps hard enforcement (budget
// SIGKILL, wall-clock backstop).
const MAX_NUDGES = 3; // consecutive no-progress nudges; progress = non-read tool calls (reads alone are loopable noise)

console.log(bold(`\nrun ${RUN_ID}`));
console.log(dim(`  combo:       ${COMBO.length ? COMBO.join(" + ") : "(baseline)"}`));
console.log(dim(`  model:       ${MODEL} (thinking: ${THINKING})`));
console.log(dim(`  problems:    ${problems.length} from ${PROBLEMS_FILE}`));
console.log(dim(`  budget:      ${BUDGET_STD > 0 ? `$${BUDGET_STD.toFixed(2)} @std/problem` : "(none)"}   timeout: ${TIMEOUT_S}s backstop   concurrency: ${CONCURRENCY}`));
console.log(dim(`  results:     results/${RUN_ID}/\n`));

const leanServer = await ensureLeanServer(join(runDir, "lean-server.log"));
leanServer?.unref(); // don't let the child keep the event loop alive after the summary is written
const stopServer = () => { try { leanServer?.kill("SIGTERM"); } catch {} };
process.on("exit", stopServer);
process.on("SIGINT", () => { stopServer(); process.exit(130); });

// ---------- one attempt ----------
async function attempt(name, idx) {
  const probDir = join(runDir, name);
  const work = join(probDir, "work");
  const sessionDir = join(probDir, "session");
  mkdirSync(work, { recursive: true });
  mkdirSync(sessionDir, { recursive: true });
  copyFileSync(join(PROBLEMS_DIR, `${name}.lean`), join(work, "problem.lean"));

  const args = [
    "--mode", "json",
    "--no-extensions", "--no-skills", "-nc", "--no-prompt-templates", "--no-themes",
    "--model", MODEL, "--thinking", THINKING,
    "--tools", toolList.join(","),
    "-e", join(ROOT, "extensions", "lean-check.ts"),
    "-e", join(ROOT, "extensions", "file-sandbox.ts"),
    "-e", join(ROOT, "extensions", "supervisor.ts"),
    ...(MAX_TOKENS > 0 ? ["-e", join(ROOT, "extensions", "max-tokens.ts")] : []),
    ...COMBO.flatMap((x) => ["-e", join(ROOT, "extensions", `${x}.ts`)]),
    "--system-prompt", FULL_SYSTEM_PROMPT,
    "--session-dir", sessionDir,
    PROMPT,
  ];

  const events = createWriteStream(join(probDir, "events.jsonl"));
  const stderrLog = createWriteStream(join(probDir, "stderr.log"));
  const started = Date.now();
  const stats = { turns: 0, userMsgs: 0, toolCalls: {}, tokens: { in: 0, out: 0, cache_read: 0 }, cost: 0, providerErrors: 0, lastError: null };
  let timedOut = false;
  let budgetExceeded = false;

  // One pi process per attempt. The supervisor extension keeps the agent going
  // in-process (nudges are follow-up messages inside the same session); the runner
  // owns hard enforcement only: budget SIGKILL (overshoot ≤ 1 message) and the
  // wall-clock backstop for hangs that emit no usage events.
  const exitCode = await new Promise((resolveExit) => {
    const child = spawn("pi", args, {
      cwd: work,
      env: {
        ...process.env,
        CMP_CONFIG: JSON.stringify({
          original_file: join(PROBLEMS_DIR, `${name}.lean`),
          problem: name,
          budget_std: BUDGET_STD,
          max_nudges: MAX_NUDGES,
          max_tokens: MAX_TOKENS > 0 ? MAX_TOKENS : null,
          check_timeout_ms: CHECK_TIMEOUT_S * 1000,
          tools: toolList,
        }),
      },
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const killer = setTimeout(() => {
      timedOut = true;
      try { process.kill(-child.pid, "SIGKILL"); } catch {}
    }, TIMEOUT_S * 1000);

    let buf = "";
    child.stdout.on("data", (d) => {
      buf += d;
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (!line.trim()) continue;
        // message_update fires per token and embeds the full accumulated message —
        // hundreds of MB per problem. message_end carries everything we need.
        if (line.includes('"type":"message_update"')) continue;
        events.write(line + "\n");
        try {
          const e = JSON.parse(line);
          if (e.type === "turn_end") stats.turns++;
          if (e.type === "tool_execution_start")
            stats.toolCalls[e.toolName] = (stats.toolCalls[e.toolName] ?? 0) + 1;
          // Every user message beyond the CLI prompt is a supervisor nudge.
          if (e.type === "message_end" && e.message?.role === "user") stats.userMsgs++;
          if (e.type === "message_end" && e.message?.role === "assistant") {
            // A provider error (throttle, 4xx) is NOT a failed proof: pi emits
            // stopReason "error" with zero usage and still exits 0, so without this
            // the attempt would be graded on an untouched file and recorded as
            // uses_sorry — infrastructure noise landing in the solve rate.
            if (e.message.stopReason === "error") {
              stats.providerErrors++;
              stats.lastError = (e.message.errorMessage ?? "").slice(0, 300);
            }
            const u = e.message.usage;
            if (u) {
              stats.tokens.in += u.input ?? 0;
              stats.tokens.out += u.output ?? 0;
              stats.tokens.cache_read += u.cacheRead ?? 0;
              stats.cost += u.cost?.total ?? 0;
              if (BUDGET_STD > 0 && !budgetExceeded && costStd(stats.tokens) >= BUDGET_STD) {
                budgetExceeded = true;
                try { process.kill(-child.pid, "SIGKILL"); } catch {}
              }
            }
          }
        } catch {}
      }
    });
    child.stderr.on("data", (d) => stderrLog.write(d));
    child.on("close", (code) => {
      clearTimeout(killer);
      resolveExit(code);
    });
  });
  events.end();
  stderrLog.end();

  const wallMs = Date.now() - started;
  // Verdict (grade) and outcome (end) are orthogonal and both recorded truthfully:
  // the grader's judgment of the final file is never overwritten by how the attempt
  // ended, so "how close were the timeouts?" is a query, not a re-grading session.
  const g = await grade(name, join(work, "problem.lean"), join(PROBLEMS_DIR, `${name}.lean`));
  const end = timedOut ? "timeout"
    : budgetExceeded ? "budget_exceeded"
    // Errors only count as aborts when the agent never got to work (no tool calls):
    // a transient throttle mid-attempt that the agent recovered from is a real attempt.
    : stats.providerErrors > 0 && Object.keys(stats.toolCalls).length === 0 ? "provider_error"
    : "completed";

  const record = {
    run_id: RUN_ID, problem: name, combo: COMBO, model: MODEL, thinking: THINKING,
    started_at: new Date(started).toISOString(), wall_s: Math.round(wallMs / 1000),
    turns: stats.turns, tokens: stats.tokens, cost_usd: +stats.cost.toFixed(5),
    cost_std: +costStd(stats.tokens).toFixed(5),
    provider_errors: stats.providerErrors,
    tool_calls: stats.toolCalls, exit_code: exitCode,
    budget_std: BUDGET_STD || null, nudges: Math.max(0, stats.userMsgs - 1),
    end, end_detail: end === "provider_error" ? (stats.lastError ?? "provider returned an error before any tool call") : null,
    grade: {
      solved: g.solved, reason: g.solved ? null : g.reason,
      detail: g.solved ? null : (g.detail ?? "").slice(0, 500),
      axioms: g.axioms ?? null, suspicious_keywords: g.suspicious_keywords ?? null,
    },
    solved: g.solved, // = grade.solved; a verified proof counts regardless of how the attempt ended
    harness_git_sha: gitSha, pi_version: piVersion,
  };
  writeFileSync(join(probDir, "attempt.json"), JSON.stringify(record, null, 2));
  appendFileSync(join(runDir, "results.jsonl"), JSON.stringify(record) + "\n");

  const tag =
    (g.solved ? green("✓ solved ") : end === "timeout" ? yellow("⏱ timeout") : end === "budget_exceeded" ? yellow("$ budget ") : end === "provider_error" ? red("✗ provider") : red(`✗ ${g.reason}`)) +
    (g.suspicious_keywords ? yellow(` ⚠ ${g.suspicious_keywords.join(",")}`) : "");
  const checks = stats.toolCalls.lean_check ?? 0;
  console.log(
    `  ${dim(`[${String(idx + 1).padStart(2)}/${problems.length}]`)} ${name.padEnd(18)} ${tag}  ${dim(
      `${stats.turns} turns, ${checks} checks, ${money(stats.cost)}, ${secs(wallMs)}`,
    )}`,
  );
  return record;
}

// ---------- worker pool ----------
const queue = problems.map((p, i) => [p, i]);
const records = [];
await Promise.all(
  Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => {
    while (queue.length) {
      const [name, idx] = queue.shift();
      try {
        records.push(await attempt(name, idx));
      } catch (err) {
        console.log(`  ${red("✗ runner error")} ${name}: ${err.message}`);
        records.push({ run_id: RUN_ID, problem: name, combo: COMBO, end: "runner_error", grade: { solved: false, reason: "runner_error", detail: String(err).slice(0, 500) }, solved: false });
        appendFileSync(join(runDir, "results.jsonl"), JSON.stringify(records.at(-1)) + "\n");
      }
    }
  }),
);

// ---------- summary ----------
const solved = records.filter((r) => r.solved);
const cost = records.reduce((s, r) => s + (r.cost_usd ?? 0), 0);
const costStdTotal = records.reduce((s, r) => s + (r.cost_std ?? 0), 0);
// One headline label per unsolved attempt: the abnormal end if there was one, else
// the grader's reason (end and grade are recorded separately and both kept).
const reasonOf = (r) => (r.end !== "completed" ? r.end : r.grade?.reason ?? "unknown");
const reasons = {};
for (const r of records) if (!r.solved) reasons[reasonOf(r)] = (reasons[reasonOf(r)] ?? 0) + 1;
// Attempts the provider never let start are not evidence about the arm. Rate them out of
// the valid denominator, or a throttle burst during one arm reads as a real solve-rate
// difference between arms — the exact quantity the factorial design is measuring.
const aborted = records.filter((r) => r.end === "provider_error");
const valid = records.length - aborted.length;

console.log(bold(`\n${COMBO.join("+") || "baseline"}: ${solved.length}/${valid} solved  (${money(costStdTotal)} @std, ${money(cost)} billed)`));
if (aborted.length)
  console.log(`  ${red(`⚠ ${aborted.length} attempt(s) aborted by provider errors — excluded from the rate above.`)}`);
if (solved.length) console.log(`  ${green("solved:")} ${solved.map((r) => r.problem).join(", ")}`);
for (const [reason, n] of Object.entries(reasons)) console.log(`  ${dim(`${reason}: ${n}`)}`);
console.log(dim(`  full records: results/${RUN_ID}/results.jsonl\n`));

const summary = {
  run_id: RUN_ID, combo: COMBO, model: MODEL, thinking: THINKING, git_sha: gitSha,
  problems: records.length, valid_attempts: valid, provider_aborted: aborted.length,
  solved: solved.length, cost_usd: +cost.toFixed(4), cost_std: +costStdTotal.toFixed(4),
  fail_reasons: reasons, finished_at: new Date().toISOString(),
};
writeFileSync(join(runDir, "summary.json"), JSON.stringify(summary, null, 2));
console.log(cyan(`  ${JSON.stringify(summary)}\n`));
