#!/usr/bin/env node
// Run one extension combo over a problem list. One pi subprocess per problem in an
// isolated scratch dir, full event logging, independent grading, pretty output.
//
//   node runner/run.js --combo lean-search --problems problems/dev.txt
//
// Flags: --combo a,b ("" = baseline) --problems <file> --budget-std <usd> (1.00)
//        --timeout <s> (172800, wall-clock backstop)
//        --concurrency <n> (12) --model <id> --thinking <level> (high) --run-id <s>
//        --problems-dir <dir> (problems/; e.g. problems-nl/ for statements with
//        the informal NL docstring kept)
//        --check-cpu <s> (120, CPU-second budget per check — the ONE compile budget)

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
      // 12: with checks served warm by the REPL pool the LLM is the bottleneck, so
      // the useful band is 8-16 (SKELETON, "Concurrency"). The old default of 6
      // under-used the box; the 25-30 of the pre-freeze runs put a run and a Claude
      // session together over the memory floor (see the 0727 VM death).
      concurrency: { type: "string", default: "12" },
      model: { type: "string", default: "deepseek/deepseek-v4-flash" },
      // Thinking is fixed config for the whole grid, not an arm (PLAN: a model knob,
      // not a harness answer; the on/off pilot found thinking-on same-or-better and
      // cheaper). It defaults to the grid value so a forgotten flag can no longer
      // produce an off-protocol run that looks perfectly normal in the output.
      thinking: { type: "string", default: "high" },
      "max-tokens": { type: "string", default: "384000" },
      "check-cpu": { type: "string", default: "120" },
      "run-id": { type: "string" },
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
// Flag NAMES are strict above; VALUES were not: `--budget-std 1..0` parsed to NaN and
// silently disabled the cap (recorded as if intentional), and a NaN --timeout became a
// ~1 ms setTimeout that SIGKILLed every attempt at birth. A typo'd number must be as
// hard an error as a typo'd flag.
for (const [flag, v, min] of [
  ["budget-std", BUDGET_STD, 0],
  ["timeout", TIMEOUT_S, 1],
  ["concurrency", CONCURRENCY, 1],
  ["max-tokens", parseInt(A["max-tokens"]), 0],
  ["check-cpu", parseInt(A["check-cpu"]), 1],
]) {
  if (!Number.isFinite(v) || v < min) {
    console.error(`--${flag} ${A[flag]}: not a number ≥ ${min}`);
    process.exit(1);
  }
}
// Always send an explicit output cap — DeepSeek's server default is 8192/response when
// none is sent, and PLAN's protocol says a tight cap may only ever be a manipulated
// factor. Default = deepseek-v4-flash's max output. Capped experiment cells pass e.g.
// --max-tokens 8192; 0 falls back to the provider default (don't use in real runs).
const MAX_TOKENS = parseInt(A["max-tokens"]);
const CHECK_CPU_S = parseInt(A["check-cpu"]);
const RUN_ID = A["run-id"] ?? `${COMBO.join("+") || "baseline"}-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, "")}`;

// No peak-hour guard. DeepSeek "will soon adopt" peak-valley pricing (2x during
// 01:00–04:00 and 06:00–10:00 UTC), but billing checked 2026-07-31 was flat, so the
// windows currently cost nothing and blocking launches inside them only got in the way
// of testing. The comparison never depended on it: cost_std is peak-invariant by
// construction, so peak pricing can waste real money but cannot move an arm result.
// If it does activate, billed_usd (below) shows it and run.json's started_at plus each
// attempt's wall_s are enough to work out the overlap after the fact.
const IS_DEEPSEEK = MODEL.includes("deepseek");

// ---------- setup ----------
const dotenv = join(ROOT, ".env");
if (existsSync(dotenv)) process.loadEnvFile(dotenv);
process.env.PATH = `${process.env.HOME}/.local/node/bin:${process.env.HOME}/.elan/bin:${process.env.PATH}`;
process.env.CMP_LEAN_ENV = join(ROOT, "lean-env");
process.env.CMP_LEAN_PORT = LEAN_PORT;
// pi reads settings from here instead of ~/.pi/agent/, so the retry policy is versioned
// with the experiment: pi-agent/settings.json turns on the SDK-level retry that makes a
// wifi drop invisible to the model. Set before the --list-models preflight so the
// catalog it validates against is the one the run will actually use.
process.env.PI_CODING_AGENT_DIR = join(ROOT, "pi-agent");
// Log every request and every retry the SDK absorbs. Absorbed retries emit no pi event,
// so without this a bad-wifi night leaves no trace at all. pi rebinds stray stdout to
// stderr in non-interactive modes, so these lines land in each attempt's stderr.log and
// cannot corrupt the JSON event stream.
process.env.OPENAI_LOG = "info";

// A reused server is the normal case, not the exception — the watchdog keeps one alive
// across runs — so without this every run inherited whatever state hours of serving had
// left the workers in: ~2.5 GB of accumulated heap each, part swapped, and drifted onto
// different slices of the .olean cache so they barely shared any (measured 2026-07-31).
// The recycle costs ~1 min and nothing is queued behind it yet. Best effort by design:
// a stale-but-working server beats losing the launch, which is the same reason the
// import bound below is generous.
async function recycleWorkers() {
  process.stdout.write(dim("  reusing lean server — recycling workers... "));
  try {
    const r = await fetch(`${LEAN_URL}/recycle`, { method: "POST", signal: AbortSignal.timeout(10_000) });
    if (!r.ok) {
      const why = await r.json().then((j) => j.error).catch(() => `HTTP ${r.status}`);
      return console.log(yellow(`skipped (${why})`));
    }
  } catch (e) {
    return console.log(yellow(`skipped (${e.message})`));
  }
  // Poll rather than hold the POST open: undici kills a response whose headers take
  // >5 min, and a recycle under memory pressure can outlast that (see postCheck).
  const deadline = Date.now() + parseInt(process.env.CMP_IMPORT_TIMEOUT_MS ?? "900000") + 120_000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 3000));
    const h = await fetch(`${LEAN_URL}/health`, { signal: AbortSignal.timeout(2000) })
      .then((r) => r.json()).catch(() => null);
    if (h && !h.recycling && h.ready) return console.log(dim("ready"));
  }
  console.log(yellow("timed out — starting anyway"));
}

// Persistent lean server: reuse one that's already up, else spawn and wait for
// Mathlib to load (~1-2 min). Spawned server is killed when this run exits.
async function ensureLeanServer(logPath) {
  const health = () =>
    fetch(`${LEAN_URL}/health`, { signal: AbortSignal.timeout(2000) })
      .then((r) => r.json()).then((j) => j.ready).catch(() => null);
  if (await health()) { await recycleWorkers(); return null; }
  const fd = openSync(logPath, "a");
  const child = spawn("node", [join(ROOT, "runner/lean-server.js")], { env: process.env, stdio: ["ignore", fd, fd] });
  // Register the kill BEFORE anything below can throw. Both throws here abort the whole
  // run, and until this existed the server we just spawned — plus its detached 6 GB
  // repl — survived as orphans nobody knew to look for (2026-07-30). lean-server.js
  // turns SIGTERM into exit, which kills its repl process groups.
  process.on("exit", () => { try { child.kill("SIGTERM"); } catch {} });
  process.stdout.write(dim("  starting lean server (importing Mathlib)... "));
  // Wait out the server's OWN import bound plus a margin, read from the same env var, so
  // the two can't drift: a runner deadline shorter than the import bound shoots a
  // healthy-but-slow import and costs the whole launch (which is exactly what a 9 min
  // runner deadline did against a 15 min import bound).
  const waitMs = parseInt(process.env.CMP_IMPORT_TIMEOUT_MS ?? "900000") + 120_000;
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 3000));
    if (await health()) { console.log(dim("ready")); return child; }
    if (child.exitCode != null) throw new Error(`lean server died; see ${logPath}`);
  }
  throw new Error(`lean server did not become ready in ${Math.round(waitMs / 60000)} min; see ${logPath}`);
}

for (const ext of COMBO)
  if (!existsSync(join(ROOT, "extensions", `${ext}.ts`))) {
    console.error(`unknown extension: ${ext} (no extensions/${ext}.ts)`);
    process.exit(1);
  }

// lean-loogle's environment filter reads a derived, gitignored file; without it every
// loogle call of a multi-day run would fail while the budget burned. Refuse to launch.
if (COMBO.includes("lean-loogle") && !existsSync(join(ROOT, "problems", "env-names.txt"))) {
  console.error("lean-loogle needs problems/env-names.txt — regenerate with `node scripts/dump-env-names.mjs` (lean server must be up)");
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
// A duplicated line would give two concurrent attempts the same work dir and
// events.jsonl — both corrupted, both graded on the other's file.
if (new Set(problems).size !== problems.length) {
  const seen = new Set();
  const dupes = problems.filter((p) => (seen.has(p) ? true : (seen.add(p), false)));
  console.error(`duplicate problems in ${PROBLEMS_FILE}: ${[...new Set(dupes)].join(", ")}`);
  process.exit(1);
}
const runDir = join(ROOT, "results", RUN_ID);
// Guard on run.json too, not only results.jsonl: a launch that died before its first
// record (a wide window — first records can take hours) left a dir the old guard
// happily reused, interleaving two generations of attempts in one run dir.
if (existsSync(join(runDir, "results.jsonl")) || existsSync(join(runDir, "run.json"))) {
  console.error(`results/${RUN_ID}/ already exists — pick a new --run-id or move the old run aside`);
  process.exit(1);
}
mkdirSync(runDir, { recursive: true });
let gitSha = "unknown";
try { gitSha = execSync("git rev-parse --short HEAD", { cwd: ROOT }).toString().trim(); } catch {}
// The agent loop is whatever pi is globally installed — record its version, or the
// harness_git_sha alone under-identifies the harness (one `npm update` wide hole).
let piVersion = "unknown";
try { piVersion = execSync("pi --version", { env: process.env }).toString().trim(); } catch {}
// cost_usd is pi's own arithmetic over a baked-in price table, and it only sees requests
// that returned a completed message — reconciled against DeepSeek's billing it runs a few
// percent low. DeepSeek exposes no per-request cost, and its dashboard aggregates by UTC
// day, which cannot separate two runs that share a day or one run that straddles midnight.
// The account balance is the only per-run source of truth: sample it either side and the
// delta is what was actually billed. Sampling has to happen live — a run whose boundaries
// went unrecorded can never be priced afterwards.
// Caveats, all recorded rather than corrected for: the balance is account-wide, so
// concurrent runs on the same key make every delta meaningless; a mid-run top-up shows up
// as a negative delta (flagged, not trusted); and the balance carries 2 decimals, so the
// floor on resolution is $0.01 — exact enough for a grid cell, coarse for a smoke test.
const BALANCE_SETTLE_MS = 20_000;
// A few retries at each boundary: the two samples are the run's only ground-truth
// billing numbers, an unrecorded boundary is unrecoverable, and a single wifi blip at
// launch used to null BOTH (the closing sample is skipped when the opening one is null).
async function deepseekBalance() {
  if (!IS_DEEPSEEK || !process.env.DEEPSEEK_API_KEY) return null;
  for (let tries = 3; tries > 0; tries--) {
    try {
      const res = await fetch("https://api.deepseek.com/user/balance", {
        headers: { Authorization: `Bearer ${process.env.DEEPSEEK_API_KEY}` },
        signal: AbortSignal.timeout(15_000),
      });
      if (res.ok) {
        const usd = (await res.json())?.balance_infos?.find((b) => b.currency === "USD");
        const v = Number(usd?.total_balance);
        if (Number.isFinite(v)) return v;
      }
    } catch {} // never let billing telemetry take down a run
    if (tries > 1) await new Promise((r) => setTimeout(r, 10_000));
  }
  return null;
}
const balanceBefore = await deepseekBalance();
const RUN_STARTED = Date.now();
writeFileSync(join(runDir, "run.json"), JSON.stringify({ run_id: RUN_ID, combo: COMBO, model: MODEL, thinking: THINKING, max_tokens: MAX_TOKENS || null, budget_std: BUDGET_STD || null, timeout_s: TIMEOUT_S, check_cpu_s: CHECK_CPU_S, concurrency: CONCURRENCY, problems, problems_dir: PROBLEMS_DIR, git_sha: gitSha, pi_version: piVersion, balance_before: balanceBefore, started_at: new Date(RUN_STARTED).toISOString() }, null, 2));

// Benchmark-neutral by design: no "competition" framing, since the problem source
// changes between blocks (Putnam -> FATE -> whatever is next) and the prompt must not
// have to change with it. The lean_check rule states the tool's RETURN SHAPE (errors +
// per-sorry goal states) rather than teaching what to do with it: disclosure is
// baseline, technique ("leave a step sorry'd to read off the goal") would be an arm.
const SYSTEM_PROMPT = `Your goal is to solve a mathematics problem, formalized in Lean 4 with Mathlib.

The file problem.lean in your working directory contains the theorem statement, with the proof left as \`sorry\`.

Rules:
- Replace \`sorry\` with a complete proof. If there is an \`abbrev ..._solution := sorry\`, you must determine the answer yourself and fill it in too.
- NEVER modify the theorem statement, imports, or \`open\` lines. Only replace what comes after \`:=\` / fill in sorries. You may add helper lemmas ABOVE the theorem.
- No new \`axiom\` declarations. No \`native_decide\`.
- There is no shell in this environment: bash, grep, and similar commands do not exist. Your only file operations are read, write, and edit.
- Use the lean_check tool to compile and verify your work. It returns the full Lean compiler output: every error and warning with its line number, and the goal state at each remaining \`sorry\`. lean_check compiles exactly one file — problem.lean; no other file you create is ever compiled, checked, or graded, so scratch .lean files are inert text. You are NOT done until lean_check reports no errors and no 'declaration uses sorry' warnings.
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
// Killing the runner must kill the attempts. The pi children are detached (their own
// process groups, so the budget SIGKILL can target a group), which also means they do
// NOT die with us: an interrupted run used to leave every in-flight agent alive and
// spending against DeepSeek with all enforcement gone, and their attempts unrecorded.
// SIGTERM matters as much as SIGINT — `pkill -f run.js` is the documented ops move,
// and Node's default SIGTERM death runs no 'exit' handlers (the 2026-07-30 orphan).
const liveAttempts = new Set(); // pids of in-flight pi children
for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    for (const pid of liveAttempts) { try { process.kill(-pid, "SIGKILL"); } catch {} }
    stopServer();
    process.exit(sig === "SIGINT" ? 130 : 143);
  });
}

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
    "-e", join(ROOT, "extensions", "cmp-edit.ts"),
    "-e", join(ROOT, "extensions", "supervisor.ts"),
    ...(MAX_TOKENS > 0 ? ["-e", join(ROOT, "extensions", "max-tokens.ts")] : []),
    ...COMBO.flatMap((x) => ["-e", join(ROOT, "extensions", `${x}.ts`)]),
    "--system-prompt", FULL_SYSTEM_PROMPT,
    "--session-dir", sessionDir,
    PROMPT,
  ];

  const events = createWriteStream(join(probDir, "events.jsonl"));
  const stderrLog = createWriteStream(join(probDir, "stderr.log"));
  // A log stream error (disk full, quota) must degrade that attempt's logging, not
  // crash the whole runner: an unhandled stream 'error' is an uncaught exception that
  // would take down every in-flight attempt and skip the summary/closing balance.
  events.on("error", (e) => console.error(`  ${red("events.jsonl write error")} ${name}: ${e.message}`));
  stderrLog.on("error", (e) => console.error(`  ${red("stderr.log write error")} ${name}: ${e.message}`));
  const started = Date.now();
  const stats = { turns: 0, userMsgs: 0, toolCalls: {}, tokens: { in: 0, out: 0, cache_read: 0 }, cost: 0 };
  let timedOut = false;
  let budgetExceeded = false;

  // One pi process per attempt. The supervisor extension keeps the agent going
  // in-process (nudges are follow-up messages inside the same session); the runner
  // owns hard enforcement only: budget SIGKILL (overshoot ≤ 1 message) and the
  // wall-clock backstop for hangs that emit no usage events.
  const exit = await new Promise((resolveExit) => {
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
          check_cpu_ms: CHECK_CPU_S * 1000,
          tools: toolList,
        }),
      },
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    liveAttempts.add(child.pid);
    // Decode as UTF-8 across chunk boundaries: per-chunk Buffer→string coercion turned
    // a ℕ/→/∀ that straddled a 64 KB pipe chunk into U+FFFD in events.jsonl.
    child.stdout.setEncoding("utf8");
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
    child.on("close", (code, signal) => {
      liveAttempts.delete(child.pid);
      clearTimeout(killer);
      resolveExit({ code, signal });
    });
  });
  events.end();
  stderrLog.end();

  const wallMs = Date.now() - started;
  // Verdict (grade) and outcome (end) are orthogonal and both recorded truthfully:
  // the grader's judgment of the final file is never overwritten by how the attempt
  // ended, so "how close were the timeouts?" is a query, not a re-grading session.
  // Budget passed, not inherited: grade() runs here in the runner, which has no
  // CMP_CONFIG, so an ambient read would hold the grader at 120 s while the agent ran
  // on --check-cpu. One budget for agent, supervisor and grader is the metric.
  const g = await grade(name, join(work, "problem.lean"), join(PROBLEMS_DIR, `${name}.lean`), CHECK_CPU_S * 1000);
  // A death the runner did not order — OOM kill, pi crash, provider-retry exhaustion —
  // is not "completed": it used to be recorded as one and silently counted as an
  // ordinary arm failure (one such record already exists in the 0727 data). The file
  // still grades on its merits; `end` says the attempt is a rerun candidate, not a
  // clean sample of the arm.
  const end = timedOut ? "timeout" : budgetExceeded ? "budget_exceeded" : exit.code === 0 ? "completed" : "agent_died";

  const record = {
    run_id: RUN_ID, problem: name, combo: COMBO, model: MODEL, thinking: THINKING,
    started_at: new Date(started).toISOString(), wall_s: Math.round(wallMs / 1000),
    turns: stats.turns, tokens: stats.tokens, cost_usd: +stats.cost.toFixed(5),
    cost_std: +costStd(stats.tokens).toFixed(5),
    tool_calls: stats.toolCalls, exit_code: exit.code, exit_signal: exit.signal ?? null,
    // nudges = ALL supervisor messages (userMsgs minus the CLI prompt).
    budget_std: BUDGET_STD || null, nudges: Math.max(0, stats.userMsgs - 1),
    end,
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
    (g.solved ? green("✓ solved ") : end === "timeout" ? yellow("⏱ timeout") : end === "budget_exceeded" ? yellow("$ budget ") : red(`✗ ${g.reason}`)) +
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
        // If even the error record cannot be written (the disk-full double fault),
        // keep the worker alive: the in-memory record still reaches the summary.
        try { appendFileSync(join(runDir, "results.jsonl"), JSON.stringify(records.at(-1)) + "\n"); } catch (e2) { console.error(`  ${red("results.jsonl write error")}: ${e2.message}`); }
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
// Let the last requests settle on DeepSeek's side before reading the closing balance,
// or the tail of the run bills after the sample and vanishes from billed_usd.
let balanceAfter = null, billedUsd = null, billedNote = null;
if (balanceBefore != null) {
  await new Promise((r) => setTimeout(r, BALANCE_SETTLE_MS));
  balanceAfter = await deepseekBalance();
  if (balanceAfter == null) billedNote = "closing balance unavailable";
  else {
    billedUsd = +(balanceBefore - balanceAfter).toFixed(4);
    // A negative delta means the balance went UP mid-run: a top-up, not a refund. The
    // number is meaningless then, so surface it instead of reporting a nonsense cost.
    if (billedUsd < 0) billedNote = "balance rose mid-run (top-up?) — billed_usd not meaningful";
  }
} else billedNote = IS_DEEPSEEK ? "opening balance unavailable" : "not a deepseek run";

const billedStr = billedUsd != null && billedUsd >= 0 ? `, ${money(billedUsd)} billed` : "";
console.log(bold(`\n${COMBO.join("+") || "baseline"}: ${solved.length}/${records.length} solved  (${money(costStdTotal)} @std, ${money(cost)} est${billedStr})`));
if (solved.length) console.log(`  ${green("solved:")} ${solved.map((r) => r.problem).join(", ")}`);
for (const [reason, n] of Object.entries(reasons)) console.log(`  ${dim(`${reason}: ${n}`)}`);
if (billedNote) console.log(dim(`  billed_usd: ${billedNote}`));
console.log(dim(`  full records: results/${RUN_ID}/results.jsonl\n`));

const summary = {
  run_id: RUN_ID, combo: COMBO, model: MODEL, thinking: THINKING, git_sha: gitSha,
  problems: records.length, solved: solved.length, cost_usd: +cost.toFixed(4), cost_std: +costStdTotal.toFixed(4),
  // billed_usd is DeepSeek's own number (balance delta); cost_usd/cost_std are ours.
  balance_before: balanceBefore, balance_after: balanceAfter, billed_usd: billedUsd, billed_note: billedNote,
  fail_reasons: reasons, finished_at: new Date().toISOString(),
};
writeFileSync(join(runDir, "summary.json"), JSON.stringify(summary, null, 2));
console.log(cyan(`  ${JSON.stringify(summary)}\n`));
