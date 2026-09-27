#!/usr/bin/env node
// Run one extension combo over a problem list, one pi subprocess per problem, then grade.
// Usage: node runner/run.js --combo a,b [--problems F] [--budget-std X] [--run-id ID] [--resume]

import { spawn, execSync } from "node:child_process";
import { parseArgs } from "node:util";
import { mkdirSync, readFileSync, readdirSync, writeFileSync, appendFileSync, copyFileSync, createWriteStream, existsSync, openSync, symlinkSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { grade } from "./grade.js";
import { benchmarkDecls } from "./stmt.js";
import { MATHLIB_SRC } from "./grep.js";
import { tailSessions, newStats, applyEntry } from "./session-tail.js";
import { gradeHighWater } from "./highwater.js";
import { CHECK_SHA, checkEnvDiff, CPU_FUSE_MS, WALL_FUSE_MS } from "./check-env.js";
import { costStd, LEAN_PORT, LEAN_URL, MAX_HEARTBEATS, green, red, yellow, dim, bold, cyan, money, secs } from "./common.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

let A;
try {
  A = parseArgs({
    options: {
      combo: { type: "string", default: "" },
      problems: { type: "string", default: join(ROOT, "problems-fatex/safe90.txt") },
      "problems-dir": { type: "string", default: join(ROOT, "problems-fatex") },
      "budget-std": { type: "string", default: "1.00" },
      timeout: { type: "string", default: "172800" },
      concurrency: { type: "string", default: "25" },
      model: { type: "string", default: "deepseek/deepseek-v4-flash" },
      thinking: { type: "string", default: "high" },
      "max-tokens": { type: "string", default: "384000" },
      library: { type: "string" },
      "run-id": { type: "string" },
      resume: { type: "boolean", default: false },
    },
    strict: true,
  }).values;
} catch (e) {
  console.error(e.message);
  process.exit(1);
}
const COMBO = A.combo.split(",").map((s) => s.trim()).filter(Boolean);
const RESUME = A.resume;
const PROBLEMS_FILE = A.problems;
const PROBLEMS_DIR = resolve(A["problems-dir"]);
const BUDGET_STD = parseFloat(A["budget-std"]);
const TIMEOUT_S = parseInt(A.timeout);
const CONCURRENCY = parseInt(A.concurrency);
const MODEL = A.model;
const THINKING = A.thinking;
for (const [flag, v, min] of [
  ["budget-std", BUDGET_STD, 0],
  ["timeout", TIMEOUT_S, 1],
  ["concurrency", CONCURRENCY, 1],
  ["max-tokens", parseInt(A["max-tokens"]), 0],
]) {
  if (!Number.isFinite(v) || v < min) {
    console.error(`--${flag} ${A[flag]}: not a number ≥ ${min}`);
    process.exit(1);
  }
}
const MAX_TOKENS = parseInt(A["max-tokens"]);
let LIBRARY = null;
if (A.library) {
  const dir = resolve(A.library);
  try {
    const meta = JSON.parse(readFileSync(join(dir, "library.json"), "utf8"));
    LIBRARY = { dir, sha: meta.library_sha256, run_id: meta.run_id };
  } catch (e) {
    console.error(`--library ${A.library}: not a finished library phase (${e.message})`);
    process.exit(1);
  }
}
const RUN_ID = A["run-id"] ?? `${COMBO.join("+") || "baseline"}-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, "")}`;

const IS_DEEPSEEK = MODEL.includes("deepseek");

const dotenv = join(ROOT, ".env");
if (existsSync(dotenv)) process.loadEnvFile(dotenv);
process.env.PATH = `${process.env.HOME}/.local/node/bin:${process.env.HOME}/.elan/bin:${process.env.PATH}`;
process.env.CMP_LEAN_ENV = join(ROOT, "lean-env");
process.env.CMP_LEAN_PORT = LEAN_PORT;
if (LIBRARY) process.env.CMP_LIB_FILE = join(LIBRARY.dir, "library.lean");
process.env.PI_CODING_AGENT_DIR = join(ROOT, "pi-agent");
process.env.OPENAI_LOG = "info";

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
  const deadline = Date.now() + parseInt(process.env.CMP_IMPORT_TIMEOUT_MS ?? "900000") + 120_000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 3000));
    const h = await fetch(`${LEAN_URL}/health`, { signal: AbortSignal.timeout(2000) })
      .then((r) => r.json()).catch(() => null);
    if (h && !h.recycling && h.ready) return console.log(dim("ready"));
  }
  console.log(yellow("timed out — starting anyway"));
}

// Reuse a running lean server (recycling its workers) or spawn one and wait for ready.
async function ensureLeanServer(logPath) {
  const health = () =>
    fetch(`${LEAN_URL}/health`, { signal: AbortSignal.timeout(2000) })
      .then((r) => r.json()).then((j) => j.ready).catch(() => null);
  if (await health()) {
    if (process.env.CMP_NO_RECYCLE) console.log(dim("  reusing lean server — recycle skipped (CMP_NO_RECYCLE; another cell is live)"));
    else await recycleWorkers();
    return null;
  }
  const fd = openSync(logPath, "a");
  const child = spawn("node", [join(ROOT, "runner/lean-server.js")], { env: process.env, stdio: ["ignore", fd, fd] });
  process.on("exit", () => { try { child.kill("SIGTERM"); } catch {} });
  process.stdout.write(dim("  starting lean server (importing Mathlib)... "));
  const waitMs = parseInt(process.env.CMP_IMPORT_TIMEOUT_MS ?? "900000") + 120_000;
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 3000));
    if (await health()) { console.log(dim("ready")); return child; }
    if (child.exitCode != null) throw new Error(`lean server died; see ${logPath}`);
  }
  throw new Error(`lean server did not become ready in ${Math.round(waitMs / 60000)} min; see ${logPath}`);
}

// Refuse to run unless the server's check env and library match this checkout.
async function verifyCheckVerdict() {
  const h = await fetch(`${LEAN_URL}/health`, { signal: AbortSignal.timeout(5000) })
    .then((r) => r.json()).catch(() => null);
  if (!h) throw new Error("lean server health unreadable — cannot confirm the check verdict this run would use");
  if (h.check_sha !== CHECK_SHA)
    throw new Error(
      `check environment mismatch: the running lean server is ${h.check_sha ?? "(pre-fingerprint)"}, ` +
        `this checkout is ${CHECK_SHA}. Restart the server (scripts/lean-server-watchdog.sh) before launching.\n` +
        checkEnvDiff(h.check_env).join("\n"),
    );
  const want = LIBRARY?.sha ?? null;
  if ((h.library_sha256 ?? null) !== want)
    throw new Error(
      want
        ? `library mismatch: this run needs library ${want.slice(0, 12)}… baked into the server ` +
          `(server has ${h.library_sha256 ? h.library_sha256.slice(0, 12) + "…" : "none"}). ` +
          `Restart it with CMP_LIB_FILE=${join(LIBRARY.dir, "library.lean")}.`
        : `the running lean server has library ${h.library_sha256.slice(0, 12)}… baked in, but this run ` +
          `expects a bare environment. Restart the server without CMP_LIB_FILE.`,
    );
  return h;
}

for (const ext of COMBO)
  if (!existsSync(join(ROOT, "extensions", `${ext}.ts`))) {
    console.error(`unknown extension: ${ext} (no extensions/${ext}.ts)`);
    process.exit(1);
  }

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

const extTools = (name) => {
  const m = /^\/\/ @tools\s+(.+)$/m.exec(readFileSync(join(ROOT, "extensions", `${name}.ts`), "utf8"));
  return m ? m[1].split(",").map((s) => s.trim()).filter(Boolean) : [];
};
const toolList = ["read", "edit", "write", ...extTools("lean-check"), ...COMBO.flatMap(extTools)];

const problems = readFileSync(PROBLEMS_FILE, "utf8").split("\n").map((s) => s.trim()).filter(Boolean);
if (new Set(problems).size !== problems.length) {
  const seen = new Set();
  const dupes = problems.filter((p) => (seen.has(p) ? true : (seen.add(p), false)));
  console.error(`duplicate problems in ${PROBLEMS_FILE}: ${[...new Set(dupes)].join(", ")}`);
  process.exit(1);
}
const runDir = join(ROOT, "results", RUN_ID);
if (RESUME) {
  let prev;
  try { prev = JSON.parse(readFileSync(join(runDir, "run.json"), "utf8")); }
  catch { console.error(`--resume: results/${RUN_ID}/run.json not found — nothing to resume`); process.exit(1); }
  const mismatch = [];
  if (JSON.stringify(prev.combo ?? []) !== JSON.stringify(COMBO)) mismatch.push(`combo ${JSON.stringify(prev.combo)} != ${JSON.stringify(COMBO)}`);
  if (prev.model !== MODEL) mismatch.push(`model ${prev.model} != ${MODEL}`);
  if (prev.thinking !== THINKING) mismatch.push(`thinking ${prev.thinking} != ${THINKING}`);
  if ((prev.budget_std ?? null) !== (BUDGET_STD || null)) mismatch.push(`budget_std ${prev.budget_std} != ${BUDGET_STD}`);
  if (mismatch.length) { console.error(`--resume config mismatch vs run.json:\n  ${mismatch.join("\n  ")}`); process.exit(1); }
  for (const p of problems) {
    if (!existsSync(join(runDir, p, "session"))) { console.error(`--resume: no session to continue for ${p}`); process.exit(1); }
  }
} else if (existsSync(join(runDir, "results.jsonl")) || existsSync(join(runDir, "run.json"))) {
  console.error(`results/${RUN_ID}/ already exists — pick a new --run-id or move the old run aside`);
  process.exit(1);
}
mkdirSync(runDir, { recursive: true });
let gitSha = "unknown";
try { gitSha = execSync("git rev-parse --short HEAD", { cwd: ROOT }).toString().trim(); } catch {}
let piVersion = "unknown";
try { piVersion = execSync("pi --version", { env: process.env }).toString().trim(); } catch {}
const BALANCE_SETTLE_MS = 20_000;
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
    } catch {}
    if (tries > 1) await new Promise((r) => setTimeout(r, 10_000));
  }
  return null;
}
const balanceBefore = await deepseekBalance();
const RUN_STARTED = Date.now();
if (!RESUME) writeFileSync(join(runDir, "run.json"), JSON.stringify({ run_id: RUN_ID, combo: COMBO, model: MODEL, thinking: THINKING, max_tokens: MAX_TOKENS || null, budget_std: BUDGET_STD || null, timeout_s: TIMEOUT_S, max_heartbeats: MAX_HEARTBEATS, check_sha: CHECK_SHA, library_sha: LIBRARY?.sha ?? null, library_run: LIBRARY?.run_id ?? null, concurrency: CONCURRENCY, problems, problems_dir: PROBLEMS_DIR, git_sha: gitSha, pi_version: piVersion, balance_before: balanceBefore, started_at: new Date(RUN_STARTED).toISOString() }, null, 2));

const SYSTEM_PROMPT = `Your goal is to solve a mathematics problem, formalized in Lean 4 with Mathlib.

The file problem.lean in your working directory contains the theorem statement, with the proof left as \`sorry\`.

Rules:
- Replace \`sorry\` with a complete proof. If there is an \`abbrev ..._solution := sorry\`, you must determine the answer yourself and fill it in too.
- NEVER modify the theorem statement, imports, or \`open\` lines. Only replace what comes after \`:=\` / fill in sorries. You may add helper lemmas ABOVE the theorem.
- No new \`axiom\` declarations. No \`native_decide\`.
- There is no shell in this environment: bash, grep, and similar commands do not exist. Your only file operations are read, write, and edit.
- Use the lean_check tool to compile and verify your work. It returns the Lean compiler output: a first line stating the verdict — COMPLETE, INCOMPLETE or FAILED — followed by the error count, the line number of every remaining \`sorry\`, and whether the theorem statement is intact and the axioms are clean; then the errors, then the goal state at each \`sorry\`, then any warnings. If that output was too long to return in full it says so, and the complete untruncated output of your last check is always in .check/last.txt, which you can read. lean_check compiles exactly one file — problem.lean; no other file you create is ever compiled, checked, or graded, so scratch .lean files are inert text. You are NOT done until lean_check reports COMPLETE.
- NEVER end your response without a tool call unless lean_check has passed. Analysis alone is not an answer — put your reasoning into the proof and verify it.`;

const addenda = COMBO.map((x) => join(ROOT, "extensions", `${x}.prompt.md`)).filter(existsSync).map((p) => readFileSync(p, "utf8").trim());
if (LIBRARY)
  addenda.push(
    `## Additional verified library\n\nBeyond Mathlib, this environment also contains an additional library of verified declarations — every one fully proved and kernel-checked (no sorry, no axioms beyond Mathlib's standard three). They are available by name in problem.lean and in snippets, exactly like Mathlib lemmas, and proofs that use them grade exactly like proofs that use Mathlib. The full source is in library.lean in your working directory — read it to see what exists${COMBO.includes("lean-grep") ? "; grep_mathlib searches it alongside Mathlib" : ""}.`,
  );
const FULL_SYSTEM_PROMPT = [SYSTEM_PROMPT, ...addenda].join("\n\n");

const PROMPT = "Prove the theorem in problem.lean. Read it first, then work until lean_check reports COMPLETE.";
const MAX_NUDGES = 3;

console.log(bold(`\nrun ${RUN_ID}`));
console.log(dim(`  combo:       ${COMBO.length ? COMBO.join(" + ") : "(baseline)"}`));
console.log(dim(`  model:       ${MODEL} (thinking: ${THINKING})`));
console.log(dim(`  problems:    ${problems.length} from ${PROBLEMS_FILE}`));
console.log(dim(`  budget:      ${BUDGET_STD > 0 ? `$${BUDGET_STD.toFixed(2)} @std/problem` : "(none)"}   timeout: ${TIMEOUT_S}s backstop   concurrency: ${CONCURRENCY}`));
console.log(dim(`  results:     results/${RUN_ID}/\n`));

const leanServer = await ensureLeanServer(join(runDir, "lean-server.log"));
await verifyCheckVerdict();
console.log(dim(`  check:       ${CHECK_SHA} — maxHeartbeats ${MAX_HEARTBEATS}/decl (the verdict)`));
console.log(dim(`  fuses:       ${CPU_FUSE_MS / 1000}s CPU, ${WALL_FUSE_MS / 1000}s wall (machine protection, never a verdict)`));
leanServer?.unref();
const stopServer = () => { try { leanServer?.kill("SIGTERM"); } catch {} };
process.on("exit", stopServer);
const liveAttempts = new Set();
for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    for (const pid of liveAttempts) { try { process.kill(-pid, "SIGKILL"); } catch {} }
    stopServer();
    process.exit(sig === "SIGINT" ? 130 : 143);
  });
}

// One problem: launch pi, enforce budget and timeout, grade, write attempt.json.
async function attempt(name, idx) {
  const probDir = join(runDir, name);
  const work = join(probDir, "work");
  const sessionDir = join(probDir, "session");
  const workersRoot = join(probDir, "workers");
  mkdirSync(work, { recursive: true });
  mkdirSync(sessionDir, { recursive: true });
  if (!(RESUME && existsSync(join(work, "problem.lean"))))
    copyFileSync(join(PROBLEMS_DIR, `${name}.lean`), join(work, "problem.lean"));
  if (LIBRARY) try { symlinkSync(join(LIBRARY.dir, "library.lean"), join(work, "library.lean")); } catch {}
  if (COMBO.includes("lean-grep")) try { symlinkSync(MATHLIB_SRC, join(work, "Mathlib")); } catch {}
  const workerSessionDirs = () => {
    try {
      return readdirSync(workersRoot).filter((d) => /^w\d+$/.test(d)).map((d) => join(workersRoot, d, "session"));
    } catch { return []; }
  };

  const args = [
    "--mode", "text",
    "--no-extensions", "--no-skills", "-nc", "--no-prompt-templates", "--no-themes",
    "--model", MODEL, "--thinking", THINKING,
    "--tools", toolList.join(","),
    "-e", join(ROOT, "extensions", "lean-check.ts"),
    "-e", join(ROOT, "extensions", "file-sandbox.ts"),
    "-e", join(ROOT, "extensions", "cmp-edit.ts"),
    "-e", join(ROOT, "extensions", "supervisor.ts"),
    "-e", join(ROOT, "extensions", "compaction-guard.ts"),
    ...(MAX_TOKENS > 0 ? ["-e", join(ROOT, "extensions", "max-tokens.ts")] : []),
    ...COMBO.flatMap((x) => ["-e", join(ROOT, "extensions", `${x}.ts`)]),
    "--system-prompt", FULL_SYSTEM_PROMPT,
    "--session-dir", sessionDir,
    ...(RESUME ? ["-c", "<<cmp-pi-continue-sentinel>>"] : [PROMPT]),
  ];

  const stderrLog = createWriteStream(join(probDir, "stderr.log"));
  stderrLog.on("error", (e) => console.error(`  ${red("stderr.log write error")} ${name}: ${e.message}`));
  const started = Date.now();
  const stats = newStats();
  const wStats = newStats();
  let timedOut = false;
  let budgetExceeded = false;

  const exit = await new Promise((resolveExit) => {
    const child = spawn(RESUME ? process.execPath : "pi", RESUME ? [join(ROOT, "runner/pi-continue.mjs"), ...args] : args, {
      cwd: work,
      env: {
        ...process.env,
        NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --max-old-space-size=8192`.trim(),
        CMP_CONFIG: JSON.stringify({
          original_file: join(PROBLEMS_DIR, `${name}.lean`),
          problem: name,
          budget_std: BUDGET_STD,
          max_nudges: MAX_NUDGES,
          max_tokens: MAX_TOKENS > 0 ? MAX_TOKENS : null,
          tools: toolList,
          combo: COMBO,
          model: MODEL,
          thinking: THINKING,
          workers_dir: workersRoot,
          facts_file: COMBO.includes("lean-facts") ? join(work, "facts.lean") : null,
          blocked_names: COMBO.includes("lean-facts") ? benchmarkDecls(readFileSync(join(PROBLEMS_DIR, `${name}.lean`), "utf8")) : null,
          library_file: LIBRARY ? join(work, "library.lean") : null,
          mathlib_read: COMBO.includes("lean-grep"),
        }),
      },
      detached: true,
      stdio: ["ignore", "ignore", "pipe"],
    });
    liveAttempts.add(child.pid);
    const kill = () => { try { process.kill(-child.pid, "SIGKILL"); } catch {} };
    const killer = setTimeout(() => { timedOut = true; kill(); }, TIMEOUT_S * 1000);

    // Tally tokens from parent and worker session files; kill on budget.
    const untail = tailSessions(() => [sessionDir, ...workerSessionDirs()], (entry, _raw, dir) => {
      applyEntry(dir === sessionDir ? stats : wStats, entry);
      if (BUDGET_STD > 0 && !budgetExceeded && costStd(stats.tokens) + costStd(wStats.tokens) >= BUDGET_STD) {
        budgetExceeded = true;
        kill();
      }
    });
    child.stderr.on("data", (d) => stderrLog.write(d));
    child.on("close", (code, signal) => {
      liveAttempts.delete(child.pid);
      clearTimeout(killer);
      untail();
      resolveExit({ code, signal });
    });
  });
  stderrLog.end();

  try {
    for (const d of readdirSync(workersRoot)) {
      if (!/^w\d+$/.test(d) || existsSync(join(workersRoot, d, "worker.json"))) continue;
      try { process.kill(parseInt(readFileSync(join(workersRoot, d, "pid"), "utf8")), "SIGKILL"); } catch {}
    }
  } catch {}

  let priorWallS = 0, priorEnd = null;
  if (RESUME) {
    try {
      const prevAttempt = JSON.parse(readFileSync(join(probDir, "attempt.json"), "utf8"));
      priorWallS = prevAttempt.wall_s ?? 0;
      priorEnd = prevAttempt.end ?? null;
    } catch {}
  }
  const wallMs = Date.now() - started + priorWallS * 1000;
  const end = timedOut ? "timeout" : budgetExceeded ? "budget_exceeded" : exit.code === 0 ? "completed" : "agent_died";
  // Grade the final file, then whether any earlier state held a proof.
  const g = await grade(name, join(work, "problem.lean"), join(PROBLEMS_DIR, `${name}.lean`), { end });

  let highWater = null;
  try {
    highWater = await gradeHighWater(probDir, (file) =>
      grade(name, file, join(PROBLEMS_DIR, `${name}.lean`), { end: "completed" }));
  } catch (e) {
    console.error(`  ${red("high-water grade error")} ${name}: ${e.message}`);
  }

  let workers = [];
  try {
    workers = readdirSync(workersRoot)
      .filter((d) => /^w\d+$/.test(d))
      .sort((a, b) => +a.slice(1) - +b.slice(1))
      .map((d) => {
        try { return JSON.parse(readFileSync(join(workersRoot, d, "worker.json"), "utf8")); }
        catch { return { idx: +d.slice(1), end: "killed_with_attempt" }; }
      });
  } catch {}

  const tokensAll = {
    in: stats.tokens.in + wStats.tokens.in,
    out: stats.tokens.out + wStats.tokens.out,
    cache_read: stats.tokens.cache_read + wStats.tokens.cache_read,
  };
  const record = {
    run_id: RUN_ID, problem: name, combo: COMBO, model: MODEL, thinking: THINKING,
    started_at: new Date(started).toISOString(), wall_s: Math.round(wallMs / 1000),
    turns: stats.turns, tokens: tokensAll, cost_usd: +(stats.cost + wStats.cost).toFixed(5),
    cost_std: +costStd(tokensAll).toFixed(5),
    tool_calls: stats.toolCalls, exit_code: exit.code, exit_signal: exit.signal ?? null,
    budget_std: BUDGET_STD || null, nudges: Math.max(0, stats.userMsgs - 1),
    ...(workers.length ? { workers, workers_cost_std: +costStd(wStats.tokens).toFixed(5) } : {}),
    ...(LIBRARY ? { library_sha: LIBRARY.sha } : {}),
    end,
    grade: {
      solved: g.solved, reason: g.solved ? null : g.reason,
      detail: g.solved ? null : (g.detail ?? "").slice(0, 500),
      axioms: g.axioms ?? null, suspicious_keywords: g.suspicious_keywords ?? null,
    },
    solved: g.solved,
    high_water: highWater,
    harness_git_sha: gitSha, pi_version: piVersion,
    ...(RESUME ? { resumed: true, prior_end: priorEnd } : {}),
  };
  writeFileSync(join(probDir, "attempt.json"), JSON.stringify(record, null, 2));
  appendFileSync(join(runDir, "results.jsonl"), JSON.stringify(record) + "\n");

  const tag =
    (g.solved ? green("✓ solved ") : end === "timeout" ? yellow("⏱ timeout") : end === "budget_exceeded" ? yellow("$ budget ") : red(`✗ ${g.reason}`)) +
    (g.suspicious_keywords ? yellow(` ⚠ ${g.suspicious_keywords.join(",")}`) : "") +
    (!g.solved && highWater?.ever_solved ? yellow(" ⚑ had a proof") : "");
  const checks = stats.toolCalls.lean_check ?? 0;
  const workersNote = workers.length ? `, ${workers.length}w` : "";
  console.log(
    `  ${dim(`[${String(idx + 1).padStart(2)}/${problems.length}]`)} ${name.padEnd(18)} ${tag}  ${dim(
      `${stats.turns} turns, ${checks} checks${workersNote}, ${money(stats.cost + wStats.cost)}, ${secs(wallMs)}`,
    )}`,
  );
  return record;
}

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
        try { appendFileSync(join(runDir, "results.jsonl"), JSON.stringify(records.at(-1)) + "\n"); } catch (e2) { console.error(`  ${red("results.jsonl write error")}: ${e2.message}`); }
      }
    }
  }),
);

const solved = records.filter((r) => r.solved);
const cost = records.reduce((s, r) => s + (r.cost_usd ?? 0), 0);
const costStdTotal = records.reduce((s, r) => s + (r.cost_std ?? 0), 0);
const reasonOf = (r) => (r.end !== "completed" ? r.end : r.grade?.reason ?? "unknown");
const reasons = {};
for (const r of records) if (!r.solved) reasons[reasonOf(r)] = (reasons[reasonOf(r)] ?? 0) + 1;
const lostProofs = records.filter((r) => !r.solved && r.high_water?.ever_solved);
let balanceAfter = null, billedUsd = null, billedNote = null;
if (balanceBefore != null) {
  await new Promise((r) => setTimeout(r, BALANCE_SETTLE_MS));
  balanceAfter = await deepseekBalance();
  if (balanceAfter == null) billedNote = "closing balance unavailable";
  else {
    billedUsd = +(balanceBefore - balanceAfter).toFixed(4);
    if (billedUsd < 0) billedNote = "balance rose mid-run (top-up?) — billed_usd not meaningful";
  }
} else billedNote = IS_DEEPSEEK ? "opening balance unavailable" : "not a deepseek run";

const billedStr = billedUsd != null && billedUsd >= 0 ? `, ${money(billedUsd)} billed` : "";
console.log(bold(`\n${COMBO.join("+") || "baseline"}: ${solved.length}/${records.length} solved  (${money(costStdTotal)} @std, ${money(cost)} est${billedStr})`));
if (solved.length) console.log(`  ${green("solved:")} ${solved.map((r) => r.problem).join(", ")}`);
for (const [reason, n] of Object.entries(reasons)) console.log(`  ${dim(`${reason}: ${n}`)}`);
if (lostProofs.length)
  console.log(`  ${yellow("⚑ held a proof but did not submit one:")} ${lostProofs.map((r) => r.problem).join(", ")}`);
if (billedNote) console.log(dim(`  billed_usd: ${billedNote}`));
console.log(dim(`  full records: results/${RUN_ID}/results.jsonl\n`));

const summary = {
  run_id: RUN_ID, combo: COMBO, model: MODEL, thinking: THINKING, git_sha: gitSha,
  problems: records.length, solved: solved.length, cost_usd: +cost.toFixed(4), cost_std: +costStdTotal.toFixed(4),
  ever_solved: records.filter((r) => r.solved || r.high_water?.ever_solved).length,
  lost_proofs: lostProofs.map((r) => r.problem),
  balance_before: balanceBefore, balance_after: balanceAfter, billed_usd: billedUsd, billed_note: billedNote,
  fail_reasons: reasons, finished_at: new Date().toISOString(),
};
writeFileSync(join(runDir, RESUME ? "summary-resume.json" : "summary.json"), JSON.stringify(summary, null, 2));
console.log(cyan(`  ${JSON.stringify(summary)}\n`));
