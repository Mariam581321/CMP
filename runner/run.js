#!/usr/bin/env node
// Run one extension combo over a problem list. One pi subprocess per problem in an
// isolated scratch dir, full event logging, independent grading, pretty output.
//
//   node runner/run.js --combo lean-search --problems problems/dev.txt
//
// Flags: --combo a,b ("" = baseline) --problems <file> --timeout <s> (600)
//        --concurrency <n> (4) --model <id> --thinking <level> --run-id <s>

import { spawn, execSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync, appendFileSync, copyFileSync, createWriteStream, existsSync, rmSync, readdirSync, statSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { grade } from "./grade.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// ---------- args ----------
function arg(name, dflt) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : dflt;
}
const COMBO = (arg("combo", "") || "").split(",").map((s) => s.trim()).filter(Boolean);
const PROBLEMS_FILE = arg("problems", join(ROOT, "problems/dev.txt"));
const TIMEOUT_S = parseInt(arg("timeout", "1500"));
const CONCURRENCY = parseInt(arg("concurrency", "6"));
const MODEL = arg("model", "deepseek/deepseek-v4-flash");
const THINKING = arg("thinking", "off");
const RUN_ID = arg("run-id", `${COMBO.join("+") || "baseline"}-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, "")}`);

// ---------- setup ----------
const dotenv = join(ROOT, ".env");
if (existsSync(dotenv))
  for (const line of readFileSync(dotenv, "utf8").split("\n")) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
process.env.PATH = `${process.env.HOME}/.local/node/bin:${process.env.HOME}/.elan/bin:${process.env.PATH}`;
process.env.CMP_LEAN_ENV = join(ROOT, "lean-env");
process.env.CMP_LEAN_PORT = process.env.CMP_LEAN_PORT ?? "8787";

// Persistent lean server: reuse one that's already up, else spawn and wait for
// Mathlib to load (~1-2 min). Spawned server is killed when this run exits.
async function ensureLeanServer(logPath) {
  const health = () =>
    fetch(`http://127.0.0.1:${process.env.CMP_LEAN_PORT}/health`, { signal: AbortSignal.timeout(2000) })
      .then((r) => r.json()).then((j) => j.ready).catch(() => null);
  if (await health()) return null;
  const { openSync } = await import("node:fs");
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

// pi's --tools is an allowlist that also filters extension tools, so custom tool names
// must be listed explicitly. Map: extension file -> tool names it registers.
const EXT_TOOLS = { "lean-check": ["lean_check"], "lean-search": ["search_mathlib"] };
const toolList = ["read", "edit", "write", ...EXT_TOOLS["lean-check"], ...COMBO.flatMap((x) => EXT_TOOLS[x] ?? [x.replace(/-/g, "_")])];

const problems = readFileSync(PROBLEMS_FILE, "utf8").split("\n").map((s) => s.trim()).filter(Boolean);
const runDir = join(ROOT, "results", RUN_ID);
mkdirSync(runDir, { recursive: true });
let gitSha = "unknown";
try { gitSha = execSync("git rev-parse --short HEAD", { cwd: ROOT }).toString().trim(); } catch {}
writeFileSync(join(runDir, "run.json"), JSON.stringify({ run_id: RUN_ID, combo: COMBO, model: MODEL, thinking: THINKING, timeout_s: TIMEOUT_S, concurrency: CONCURRENCY, problems, git_sha: gitSha, started_at: new Date().toISOString() }, null, 2));

const SYSTEM_PROMPT = `You are proving a theorem from a mathematics competition, formalized in Lean 4 with Mathlib.

The file problem.lean in your working directory contains the theorem statement with \`sorry\` placeholders.

Rules:
- Replace every \`sorry\` with real content. If there is an \`abbrev ..._solution := sorry\`, you must determine the answer yourself and fill it in too.
- NEVER modify the theorem statement, imports, or \`open\` lines. Only replace what comes after \`:=\` / fill in sorries. You may add helper lemmas ABOVE the theorem.
- No new \`axiom\` declarations. No \`native_decide\`.
- Use the lean_check tool to compile and verify your work. You are NOT done until lean_check reports no errors and no 'declaration uses sorry' warnings.
- Work efficiently: think before checking, since each check takes about a minute.
- NEVER end your response without a tool call unless lean_check has passed. Analysis alone is not an answer — put your reasoning into the proof and verify it.`;

const PROMPT = "Prove the theorem in problem.lean. Read it first, then work until lean_check passes with no errors and no sorry warnings.";
const NUDGE_PROMPT = "You are not done: problem.lean still contains `sorry` or has not been verified. Continue working on the proof. Edit the file and run lean_check; do not stop until it passes.";
const MAX_NUDGES = 3;

// ---------- pretty printing ----------
const tty = process.stdout.isTTY;
const c = (code, s) => (tty ? `\x1b[${code}m${s}\x1b[0m` : s);
const green = (s) => c(32, s), red = (s) => c(31, s), yellow = (s) => c(33, s), dim = (s) => c(2, s), bold = (s) => c(1, s), cyan = (s) => c(36, s);
const money = (x) => `$${x.toFixed(3)}`;
const secs = (ms) => `${Math.round(ms / 1000)}s`;

console.log(bold(`\nrun ${RUN_ID}`));
console.log(dim(`  combo:       ${COMBO.length ? COMBO.join(" + ") : "(baseline)"}`));
console.log(dim(`  model:       ${MODEL} (thinking: ${THINKING})`));
console.log(dim(`  problems:    ${problems.length} from ${PROBLEMS_FILE}`));
console.log(dim(`  timeout:     ${TIMEOUT_S}s/problem   concurrency: ${CONCURRENCY}`));
console.log(dim(`  results:     results/${RUN_ID}/\n`));

const leanServer = await ensureLeanServer(join(runDir, "lean-server.log"));
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
  copyFileSync(join(ROOT, "problems", `${name}.lean`), join(work, "problem.lean"));

  const baseArgs = [
    "--mode", "json",
    "--no-extensions", "--no-skills", "-nc", "--no-prompt-templates", "--no-themes",
    "--model", MODEL, "--thinking", THINKING,
    "--tools", toolList.join(","),
    "-e", join(ROOT, "extensions", "lean-check.ts"),
    ...COMBO.flatMap((x) => ["-e", join(ROOT, "extensions", `${x}.ts`)]),
    "--system-prompt", SYSTEM_PROMPT,
  ];

  const events = createWriteStream(join(probDir, "events.jsonl"));
  const started = Date.now();
  const deadline = started + TIMEOUT_S * 1000;
  const stats = { turns: 0, toolCalls: {}, tokens: { in: 0, out: 0 }, cost: 0 };
  let timedOut = false;

  const spawnPi = (args) =>
    new Promise((resolveExit) => {
      const child = spawn("pi", args, {
        cwd: work,
        env: { ...process.env, CMP_ORIGINAL_FILE: join(ROOT, "problems", `${name}.lean`) },
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
      const killer = setTimeout(() => {
        timedOut = true;
        try { process.kill(-child.pid, "SIGKILL"); } catch {}
      }, Math.max(deadline - Date.now(), 1000));

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
            if (e.type === "message_end" && e.message?.role === "assistant" && e.message?.usage) {
              const u = e.message.usage;
              stats.tokens.in += u.input ?? 0;
              stats.tokens.out += u.output ?? 0;
              stats.cost += u.cost?.total ?? 0;
            }
          } catch {}
        }
      });
      child.stderr.on("data", (d) => appendFileSync(join(probDir, "stderr.log"), d));
      child.on("close", (code) => {
        clearTimeout(killer);
        resolveExit(code);
      });
    });

  const newestSession = () => {
    const files = readdirSync(sessionDir).filter((f) => f.endsWith(".jsonl"));
    if (!files.length) return null;
    return join(sessionDir, files.map((f) => [f, statSync(join(sessionDir, f)).mtimeMs]).sort((a, b) => b[1] - a[1])[0][0]);
  };

  // The model sometimes ends its turn with analysis instead of working. If the file
  // still contains `sorry` and budget remains, resume the session and tell it to
  // continue (same policy for every combo, so comparisons stay fair).
  let exitCode = await spawnPi([...baseArgs, "--session-dir", sessionDir, PROMPT]);
  let nudges = 0;
  while (nudges < MAX_NUDGES && !timedOut && Date.now() < deadline - 30_000) {
    let content;
    try { content = readFileSync(join(work, "problem.lean"), "utf8"); } catch { break; }
    if (!content.includes("sorry")) break;
    const sess = newestSession();
    if (!sess) break;
    nudges++;
    exitCode = await spawnPi([...baseArgs, "--session", sess, NUDGE_PROMPT]);
  }
  events.end();

  const wallMs = Date.now() - started;
  const verdict = await grade(name, join(work, "problem.lean"), join(ROOT, "problems", `${name}.lean`));
  if (timedOut && !verdict.solved) verdict.reason = "timeout";

  const record = {
    run_id: RUN_ID, problem: name, combo: COMBO, model: MODEL, thinking: THINKING,
    started_at: new Date(started).toISOString(), wall_s: Math.round(wallMs / 1000),
    turns: stats.turns, tokens: stats.tokens, cost_usd: +stats.cost.toFixed(5),
    tool_calls: stats.toolCalls, exit_code: exitCode, timed_out: timedOut, nudges,
    solved: verdict.solved, fail_reason: verdict.solved ? null : verdict.reason,
    fail_detail: verdict.solved ? null : (verdict.detail ?? "").slice(0, 500),
    axioms: verdict.axioms ?? null, harness_git_sha: gitSha,
  };
  writeFileSync(join(probDir, "attempt.json"), JSON.stringify(record, null, 2));
  appendFileSync(join(runDir, "results.jsonl"), JSON.stringify(record) + "\n");

  const tag = verdict.solved ? green("✓ solved ") : verdict.reason === "timeout" ? yellow("⏱ timeout") : red(`✗ ${verdict.reason}`);
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
        records.push({ run_id: RUN_ID, problem: name, combo: COMBO, solved: false, fail_reason: "runner_error", fail_detail: String(err).slice(0, 500) });
        appendFileSync(join(runDir, "results.jsonl"), JSON.stringify(records.at(-1)) + "\n");
      }
    }
  }),
);

// ---------- summary ----------
const solved = records.filter((r) => r.solved);
const cost = records.reduce((s, r) => s + (r.cost_usd ?? 0), 0);
const reasons = {};
for (const r of records) if (!r.solved) reasons[r.fail_reason] = (reasons[r.fail_reason] ?? 0) + 1;

console.log(bold(`\n${COMBO.join("+") || "baseline"}: ${solved.length}/${records.length} solved  (${money(cost)} total)`));
if (solved.length) console.log(`  ${green("solved:")} ${solved.map((r) => r.problem).join(", ")}`);
for (const [reason, n] of Object.entries(reasons)) console.log(`  ${dim(`${reason}: ${n}`)}`);
console.log(dim(`  full records: results/${RUN_ID}/results.jsonl\n`));

const summary = {
  run_id: RUN_ID, combo: COMBO, model: MODEL, thinking: THINKING, git_sha: gitSha,
  problems: records.length, solved: solved.length, cost_usd: +cost.toFixed(4),
  fail_reasons: reasons, finished_at: new Date().toISOString(),
};
writeFileSync(join(runDir, "summary.json"), JSON.stringify(summary, null, 2));
console.log(cyan(`  ${JSON.stringify(summary)}\n`));
