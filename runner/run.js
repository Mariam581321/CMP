#!/usr/bin/env node
// Run one extension combo over a problem list. One pi subprocess per problem in an
// isolated scratch dir, pi's own session file as the log, independent grading, pretty
// output.
//
//   node runner/run.js --combo lean-search --problems problems/dev.txt
//
// Flags: --combo a,b ("" = baseline) --problems <file> --budget-std <usd> (1.00)
//        --timeout <s> (172800, wall-clock backstop)
//        --concurrency <n> (25) --model <id> --thinking <level> (high) --run-id <s>
//        --problems-dir <dir> (problems/; e.g. problems-nl/ for statements with
//        the informal NL docstring kept)
//
// What "compiles" means is not a flag: it is the lean server's per-declaration
// maxHeartbeats cap (MAX_HEARTBEATS in common.js), recorded in run.json as
// `max_heartbeats` from the LIVE server, which this runner refuses to launch against if
// it disagrees with the checkout.

import { spawn, execSync } from "node:child_process";
import { parseArgs } from "node:util";
import { mkdirSync, readFileSync, readdirSync, writeFileSync, appendFileSync, copyFileSync, createWriteStream, existsSync, openSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { grade } from "./grade.js";
import { tailSessions, newStats, applyEntry } from "./session-tail.js";
import { costStd, LEAN_PORT, LEAN_URL, MAX_HEARTBEATS, green, red, yellow, dim, bold, cyan, money, secs } from "./common.js";

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
      // 25: sized for the 64 GB server (2026-08-02). With checks served warm by the
      // 8-worker REPL pool the LLM is the bottleneck — the fatex-rest90 run held
      // "0 checks queued" at concurrency 12 — and under the deterministic heartbeat
      // verdict load can stretch wall clock but can no longer flip a verdict, so
      // concurrency is purely a throughput knob. The laptop-era caution (25-30 put a
      // run plus a Claude session over the 12 GB memory floor, the 0727 VM death)
      // does not apply on this box.
      concurrency: { type: "string", default: "25" },
      model: { type: "string", default: "deepseek/deepseek-v4-flash" },
      // Thinking is fixed config for the whole grid, not an arm (PLAN: a model knob,
      // not a harness answer; the on/off pilot found thinking-on same-or-better and
      // cheaper). It defaults to the grid value so a forgotten flag can no longer
      // produce an off-protocol run that looks perfectly normal in the output.
      thinking: { type: "string", default: "high" },
      "max-tokens": { type: "string", default: "384000" },
      // Block D: a finished library phase's results dir (runner/library.js). The
      // library must ALREADY be baked into the running lean server (CMP_LIB_FILE);
      // this flag makes the run verify that, advertise the library in the prompt,
      // and stamp library_sha into every record.
      library: { type: "string" },
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
]) {
  if (!Number.isFinite(v) || v < min) {
    console.error(`--${flag} ${A[flag]}: not a number ≥ ${min}`);
    process.exit(1);
  }
}
// Always send an explicit output cap — DeepSeek's server default is 8192/response when
// none is sent, and PLAN's protocol says a tight cap may only ever be a manipulated
// factor. Capped experiment cells pass e.g. --max-tokens 8192; 0 falls back to the
// provider default (don't use in real runs).
// The flag is the CEILING on a single response, not a flat reservation: the model max
// (384000) stays the default, and extensions/max-tokens.ts injects
// clamp(window - context - slack, 131072, ceiling) per request, which offers the model
// whatever room physically exists. (Sending the ceiling FLAT was wrong — the cap is
// charged against the context window at admission, so it capped conversation at 664576
// and 400'd everything past it; fatex-rest90's 19867 assistant messages never exceeded
// 122423 output.) Near the window the 131072 floor forces an admission 400 — free,
// pre-inference — which triggers pi's compact-and-retry, and the attempt continues
// with a fresh window for as long as it runs.
const MAX_TOKENS = parseInt(A["max-tokens"]);
// Library cell (block D): resolve the phase artifacts up front — a missing or
// half-written phase dir must fail the launch, not the 40th attempt.
let LIBRARY = null;
if (A.library) {
  const dir = resolve(A.library);
  try {
    const meta = JSON.parse(readFileSync(join(dir, "library.json"), "utf8"));
    LIBRARY = { dir, sha: meta.library_sha256, run_id: meta.run_id, index: readFileSync(join(dir, "index.md"), "utf8") };
  } catch (e) {
    console.error(`--library ${A.library}: not a finished library phase (${e.message})`);
    process.exit(1);
  }
}
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
// A server this run has to spawn itself must come up with the right env baked in; a
// reused server is checked against the same expectation in verifyCheckVerdict.
if (LIBRARY) process.env.CMP_LIB_FILE = join(LIBRARY.dir, "library.lean");
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

// What "compiles" means for this run is whatever the SERVER enforces, and the watchdog
// keeps one server alive across runs — and across checkouts. So the cap on disk is not
// evidence about today's checks: ask the process that will decide them, and refuse to
// launch on a mismatch rather than record a run.json whose `max_heartbeats` is fiction.
async function verifyCheckVerdict() {
  const h = await fetch(`${LEAN_URL}/health`, { signal: AbortSignal.timeout(5000) })
    .then((r) => r.json()).catch(() => null);
  if (!h) throw new Error("lean server health unreadable — cannot confirm the check verdict this run would use");
  if (h.max_heartbeats !== MAX_HEARTBEATS)
    throw new Error(
      `check verdict mismatch: the running lean server enforces maxHeartbeats ` +
        `${h.max_heartbeats ?? "(none — it predates the heartbeat verdict)"}, this checkout defines ${MAX_HEARTBEATS}. ` +
        `Restart the server (scripts/lean-server-watchdog.sh) before launching.`,
    );
  // The env identity is the verdict's other half (block D): a library cell against a
  // bare server would grade every library-using proof compile_error, and a plain cell
  // against a library server would let attempts lean on declarations the arm does not
  // include — both silently, hence the refusal either way.
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
// session dir — both corrupted, both graded on the other's file.
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
writeFileSync(join(runDir, "run.json"), JSON.stringify({ run_id: RUN_ID, combo: COMBO, model: MODEL, thinking: THINKING, max_tokens: MAX_TOKENS || null, budget_std: BUDGET_STD || null, timeout_s: TIMEOUT_S, max_heartbeats: MAX_HEARTBEATS, library_sha: LIBRARY?.sha ?? null, library_run: LIBRARY?.run_id ?? null, concurrency: CONCURRENCY, problems, problems_dir: PROBLEMS_DIR, git_sha: gitSha, pi_version: piVersion, balance_before: balanceBefore, started_at: new Date(RUN_STARTED).toISOString() }, null, 2));

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
// The library cell's whole prompt delta: the index of what exists beyond Mathlib.
// Everything else about the library is ambient (baked into the compile env), so the
// agent's rules do not change — the declarations are simply there, like Mathlib's.
if (LIBRARY)
  addenda.push(
    `## Additional verified library\n\nBeyond Mathlib, this environment also contains the declarations listed below — usable by name in problem.lean and in snippets, exactly like Mathlib lemmas. Every one of them is fully proved and kernel-checked (no sorry, no axioms beyond Mathlib's standard three), so you may build on them without re-proving or re-checking anything, and proofs that use them grade exactly like proofs that use Mathlib:\n\n${LIBRARY.index.trim()}`,
  );
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
const serverHealth = await verifyCheckVerdict();
console.log(dim(`  check:       maxHeartbeats ${MAX_HEARTBEATS}/decl (the verdict)   cpu fuse: ${serverHealth.cpu_fuse_s}s (machine protection, never a verdict)`));
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
  // Worker dirs (block C) live BESIDE work/, not inside it: the file sandbox roots at
  // work/, so the parent agent cannot browse worker transcripts — workers report back
  // as summaries, which is the manipulation the spawn arm is supposed to test.
  const workersRoot = join(probDir, "workers");
  mkdirSync(work, { recursive: true });
  mkdirSync(sessionDir, { recursive: true });
  copyFileSync(join(PROBLEMS_DIR, `${name}.lean`), join(work, "problem.lean"));
  // Worker session dirs appear mid-attempt (first spawn call creates them); re-listed
  // every tail tick.
  const workerSessionDirs = () => {
    try {
      return readdirSync(workersRoot).filter((d) => /^w\d+$/.test(d)).map((d) => join(workersRoot, d, "session"));
    } catch { return []; }
  };

  const args = [
    // NOT --mode json. That mode serialises every session event to stdout, and
    // `message_update` fires once per stream delta carrying the WHOLE accumulated
    // message, so one assistant message of T deltas costs O(T^2) bytes — 2.55 GB
    // measured for a single 35k-token message. pi queues those writes in memory with no
    // backpressure, so whenever the runner fell behind (one thread, 12 children) the
    // child hit V8's heap cap and aborted mid-attempt: 11 attempts across 0727-0802,
    // each recorded `agent_died`, the last four in fatex-rest90. --mode text runs the
    // identical print-mode path with a subscriber that emits nothing per delta
    // (modes/print-mode.js), and the runner reads the session file instead — which
    // carries every number it used to scrape, byte-exactly. See runner/session-tail.js.
    "--mode", "text",
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

  const stderrLog = createWriteStream(join(probDir, "stderr.log"));
  // A log stream error (disk full, quota) must degrade that attempt's logging, not
  // crash the whole runner: an unhandled stream 'error' is an uncaught exception that
  // would take down every in-flight attempt and skip the summary/closing balance.
  stderrLog.on("error", (e) => console.error(`  ${red("stderr.log write error")} ${name}: ${e.message}`));
  const started = Date.now();
  const stats = newStats(); // the parent agent's session
  const wStats = newStats(); // all workers, aggregated — kept apart so turns/tool_calls/nudges stay parent-only
  let timedOut = false;
  let budgetExceeded = false;

  // One pi process per attempt. The supervisor extension keeps the agent going
  // in-process (nudges are follow-up messages inside the same session); the runner
  // owns hard enforcement only: budget SIGKILL (overshoot ≤ 1 message) and the
  // wall-clock backstop for hangs that book no spend.
  // The child says nothing on stdout (--mode text); everything the runner needs is
  // read off pi's own session jsonl as it is appended.
  const exit = await new Promise((resolveExit) => {
    const child = spawn("pi", args, {
      cwd: work,
      env: {
        ...process.env,
        // A fuse, not a fix: the GC aborts that killed 11 attempts came from pi's json
        // event stream (see --mode text above), and that flood is now gone. This just
        // keeps a child from dying on V8's 4 GB default should anything else ever grow.
        // Backlog was ~quadratic in message length, so 4 GB → 8 GB would have bought
        // only ~1.4x more message; nothing here is load-bearing.
        NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --max-old-space-size=8192`.trim(),
        CMP_CONFIG: JSON.stringify({
          original_file: join(PROBLEMS_DIR, `${name}.lean`),
          problem: name,
          budget_std: BUDGET_STD,
          max_nudges: MAX_NUDGES,
          max_tokens: MAX_TOKENS > 0 ? MAX_TOKENS : null,
          tools: toolList,
          // Block C: everything lean-spawn needs to launch workers that mirror this
          // attempt's config, and where the shared bank lives when the facts arm is on.
          combo: COMBO,
          model: MODEL,
          thinking: THINKING,
          workers_dir: workersRoot,
          facts_file: COMBO.includes("lean-facts") ? join(work, "facts.lean") : null,
        }),
      },
      detached: true,
      stdio: ["ignore", "ignore", "pipe"],
    });
    liveAttempts.add(child.pid);
    const kill = () => { try { process.kill(-child.pid, "SIGKILL"); } catch {} };
    const killer = setTimeout(() => { timedOut = true; kill(); }, TIMEOUT_S * 1000);

    // Accounting follows the session files, one completed message at a time — the same
    // granularity the budget always enforced at ("overshoot ≤ 1 message"), now with up
    // to one poll interval of extra latency. Worker sessions (block C) are tailed
    // alongside the parent's into a separate bucket, and the budget binds their SUM:
    // child usage rolls into the shared per-problem cap (PLAN), and the group SIGKILL
    // reaps workers with the parent (they are spawned undetached, in its group).
    const untail = tailSessions(() => [sessionDir, ...workerSessionDirs()], (entry, _raw, dir) => {
      applyEntry(dir === sessionDir ? stats : wStats, entry);
      if (BUDGET_STD > 0 && !budgetExceeded && costStd(stats.tokens) + costStd(wStats.tokens) >= BUDGET_STD) {
        budgetExceeded = true;
        kill();
      }
    });
    // No silence fuse. A "no message completed in N minutes" kill was tried (2026-08-02)
    // and dropped: every way an attempt can sit inside ONE operation is already bounded
    // well under the wall backstop — lean_check by the server's 900 s wall / 600 s CPU
    // fuses under a 30 min client wait, loogle by a 30 s abort, a stalled provider stream
    // by pi's 5 min HTTP idle timeout, and a provider retry storm not at all, since pi
    // persists each failed assistant message (stopReason "error") like any other. A
    // single message is capped by --max-tokens, and the 60 min fuse was sized against the
    // then-default 384k (~58 min of generation at the rate this model streams), so it sat
    // barely above a legitimate long message and was likelier to kill a working attempt
    // than a stuck one. The supervisor's server-outage wait — the one genuinely unbounded
    // silence — is bounded in the extension itself, where it belongs.
    // An attempt that hangs anyway rides the 48 h backstop and is there to inspect.
    child.stderr.on("data", (d) => stderrLog.write(d));
    child.on("close", (code, signal) => {
      liveAttempts.delete(child.pid);
      clearTimeout(killer);
      // Drains once more before stopping: the messages written between the last poll
      // and exit are exactly the ones a killed attempt is judged on.
      untail();
      resolveExit({ code, signal });
    });
  });
  stderrLog.end();

  // Sweep leftover workers. The group kill covers every runner-ordered death, but a
  // parent that died on its own (agent_died: SIGABRT, OOM) leaves its workers running
  // and spending with all enforcement gone. A worker that wrote worker.json exited
  // normally — only pid files without a record are live suspects.
  try {
    for (const d of readdirSync(workersRoot)) {
      if (!/^w\d+$/.test(d) || existsSync(join(workersRoot, d, "worker.json"))) continue;
      try { process.kill(parseInt(readFileSync(join(workersRoot, d, "pid"), "utf8")), "SIGKILL"); } catch {}
    }
  } catch {}

  const wallMs = Date.now() - started;
  // A death the runner did not order — OOM kill, pi crash, provider-retry exhaustion —
  // is not "completed": it used to be recorded as one and silently counted as an
  // ordinary arm failure (one such record already exists in the 0727 data). The file
  // still grades on its merits; `end` says the attempt is a rerun candidate, not a
  // clean sample of the arm.
  const end = timedOut ? "timeout" : budgetExceeded ? "budget_exceeded" : exit.code === 0 ? "completed" : "agent_died";
  // Verdict (grade) and outcome (end) are orthogonal and both recorded truthfully:
  // the grader's judgment of the final file is never overwritten by how the attempt
  // ended, so "how close were the timeouts?" is a query, not a re-grading session.
  // Nothing about the metric is passed in: the grader compiles against the same server
  // and the same heartbeat cap as the agent's own lean_check, so the agent-observed
  // verdict and the recorded one cannot differ (2026-08-01). The one place `end`
  // enters the grade is the statement checks: on an abnormal end, a missing or
  // altered benchmark declaration is the file state the kill happened to catch, not
  // evidence of tampering, and grade.js records the end cause instead of
  // `statement_changed` (2026-08-03; the 0802 fatex run had three such mislabels —
  // fatex_25/33/34).
  const g = await grade(name, join(work, "problem.lean"), join(PROBLEMS_DIR, `${name}.lean`), { end });

  // Per-worker records, written by runner/spawn.js at each worker's exit. A dir with
  // no record is a worker the kill caught mid-flight — its usage is still in wStats
  // (tailed from the session file), only the per-worker breakdown line is partial.
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

  // Top-level tokens/cost are the attempt TOTAL (parent + workers): child usage rolls
  // into the parent's ledger (PLAN), and cost_std here is what the budget enforced on.
  // turns/tool_calls/nudges stay parent-only; the per-worker breakdown carries its own.
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
    // nudges = ALL supervisor messages (userMsgs minus the CLI prompt).
    budget_std: BUDGET_STD || null, nudges: Math.max(0, stats.userMsgs - 1),
    ...(workers.length ? { workers, workers_cost_std: +costStd(wStats.tokens).toFixed(5) } : {}),
    ...(LIBRARY ? { library_sha: LIBRARY.sha } : {}),
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
  const workersNote = workers.length ? `, ${workers.length}w` : "";
  console.log(
    `  ${dim(`[${String(idx + 1).padStart(2)}/${problems.length}]`)} ${name.padEnd(18)} ${tag}  ${dim(
      `${stats.turns} turns, ${checks} checks${workersNote}, ${money(stats.cost + wStats.cost)}, ${secs(wallMs)}`,
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
