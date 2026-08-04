// spawn_subagents core (PLAN.md block C): launch one worker pi subprocess per task,
// follow its session file, and hand back its final message as the report. Shared by
// extensions/lean-spawn.ts.
//
// A worker is a CHILD PI PROCESS, not an in-process SDK session, deliberately: it is
// the exact launch shape run.js already trusts (same --mode text/no-stdout discipline,
// same max-tokens extension, same session-file accounting — see SKELETON.md "Why the
// runner does not read stdout"), it cannot take the parent down with it (the 0802
// SIGABRT class), and the installed pi (0.80.6) is behind the checked-out source, so
// the SDK surface is unverified where the CLI surface runs every day.
//
// Process hygiene: workers are spawned WITHOUT detaching, so they stay in the parent
// pi's process group — the runner's budget/backstop SIGKILL of that group reaps them
// for free. Each worker's pid is dropped in its dir so the runner can sweep leftovers
// when the parent dies some way that skips the group kill (agent_died).
//
// The worker's view (kept deliberately small and free): a role prompt, the problem
// statement, the bank snapshot when the facts arm is on, and the parent's task text
// as the one user message. Tools are check_snippet + the run's search arms (+ add_fact
// with facts) — never lean_check, never file tools, never spawn (depth 1 is mechanical:
// lean-spawn.ts is simply not loaded into workers). No supervisor either: a worker
// that stops has stopped, and its report — the final assistant message — goes back to
// the parent, who decides what happens next.

import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync, existsSync, createWriteStream } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tailSession, newStats, applyEntry } from "./session-tail.js";
import { costStd } from "./common.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// Same convention as run.js: each extension declares its tools in a `// @tools` header.
const extTools = (name) => {
  const m = /^\/\/ @tools\s+(.+)$/m.exec(readFileSync(join(ROOT, "extensions", `${name}.ts`), "utf8"));
  return m ? m[1].split(",").map((s) => s.trim()).filter(Boolean) : [];
};

// Workers always get check_snippet (PLAN: "workers get check_snippet (+ search), not
// lean_check"), whatever search arms the parent combo carries, and add_fact iff the
// facts arm is on. Everything else — file tools, lean_check, plan_check, spawn — is
// deliberately absent.
export function workerExtensions(combo) {
  const exts = [
    "lean-snippet",
    ...(combo ?? []).filter((x) => ["lean-search", "lean-grep", "lean-loogle"].includes(x)),
    ...((combo ?? []).includes("lean-facts") ? ["lean-facts"] : []),
  ];
  return { exts, tools: exts.flatMap(extTools) };
}

const capText = (s, n) => (s.length > n ? s.slice(0, n) + "\n... (truncated)" : s);

function workerSystemPrompt(cfg) {
  // The context block is the problem statement by default (block C: "workers see one
  // subgoal + the parent statements"). A phase without a single problem — the block-D
  // librarian — swaps in its own preamble via cfg.worker_preamble_file instead; the
  // parent's task text stays the only other channel either way.
  const preamble =
    cfg.worker_preamble_file && existsSync(cfg.worker_preamble_file)
      ? readFileSync(cfg.worker_preamble_file, "utf8").trim()
      : null;
  const statement = preamble ? null : readFileSync(cfg.original_file, "utf8").trim();
  const bank = cfg.facts_file && existsSync(cfg.facts_file) ? readFileSync(cfg.facts_file, "utf8").trim() : "";
  const factsRules = cfg.facts_file
    ? `
- You share an append-only bank of machine-verified facts with the main agent and the other workers. Everything in it is compiler-checked (no sorry, clean axioms) and automatically in scope for check_snippet, so you can use bank facts by name. Use add_fact to contribute anything durable you prove — admitted facts immediately become available to everyone.`
    : "";
  const bankSection = cfg.facts_file
    ? `

The fact bank at the time you started (later additions are also in scope for check_snippet, even though you cannot see their text):

\`\`\`lean
${bank ? capText(bank, 30000) : "-- (empty)"}
\`\`\``
    : "";
  const context = preamble
    ? `\n\n${preamble}`
    : `\n\nThe problem your subtask belongs to:\n\n\`\`\`lean\n${statement}\n\`\`\``;
  return `You are a worker agent. A main agent working on a Lean 4 / Mathlib problem has delegated ONE subtask to you; the subtask is the first user message. Your job is only the subtask.

Rules:
- There are no files and no shell in this environment. Verify Lean code with the check_snippet tool; a snippet must be self-contained (include the \`open\` lines and helper definitions it needs).
- No new \`axiom\` declarations. No \`native_decide\`. \`sorry\` never counts as proved.${factsRules}
- Your FINAL message is your report to the main agent — it is the only thing the main agent will ever see of your work. Make it self-contained: state what you established, include verbatim every Lean snippet that check_snippet accepted (with its \`open\` lines and helpers), and say clearly what remains unproved. If you could not finish, report what you tried and what you learned — a precise negative finding is valuable too.
- NEVER end your response without a tool call until you are ready to deliver the report.${context}${bankSection}`;
}

// Launch one worker. Returns { promise, kill }: the promise resolves (never rejects
// after launch) to { idx, end, report, stats } once the worker exits and its session
// is drained; kill(reason) stops it early. onTokens(usage) fires per completed
// assistant message so the caller can keep a live ledger for the supervisor.
// maxCostStd is a HARNESS-side knob only (the triage cap, block-D per-worker caps): it
// is deliberately not exposed in the spawn tool schema — the model is never given
// budget or spend language to reason about (2026-08-04).
// `view` ({ exts, tools, systemPrompt }) overrides the block-C worker view for other
// worker-shaped agents (the triage judge, and anything after it) — same process
// hygiene, session accounting and report channel, different role. `dirName` names the
// worker dir (default wN; triage uses the problem name).
export function runWorker({ idx, task, maxCostStd = 0, cfg, onTokens, view, dirName }) {
  const wDir = join(cfg.workers_dir, dirName ?? `w${idx}`);
  const work = join(wDir, "work");
  const sessionDir = join(wDir, "session");
  mkdirSync(work, { recursive: true });
  mkdirSync(sessionDir, { recursive: true });
  writeFileSync(join(wDir, "task.md"), task);

  const { exts, tools } = view ?? workerExtensions(cfg.combo);
  const systemPrompt = view?.systemPrompt ?? workerSystemPrompt(cfg);
  const args = [
    "--mode", "text",
    "--no-extensions", "--no-skills", "-nc", "--no-prompt-templates", "--no-themes",
    "--model", cfg.model, "--thinking", cfg.thinking,
    "--tools", tools.join(","),
    ...(cfg.max_tokens ? ["-e", join(ROOT, "extensions", "max-tokens.ts")] : []),
    ...exts.flatMap((x) => ["-e", join(ROOT, "extensions", `${x}.ts`)]),
    "--system-prompt", systemPrompt,
    "--session-dir", sessionDir,
    task,
  ];

  const started = Date.now();
  const stats = newStats();
  let lastReport = null;
  let killedAs = null;

  const stderrLog = createWriteStream(join(wDir, "stderr.log"));
  stderrLog.on("error", () => {});

  const child = spawn("pi", args, {
    cwd: work,
    env: {
      ...process.env,
      // Same client id as the parent (cfg.problem stays in CMP_CONFIG): the REPL's
      // round-robin is per ATTEMPT, so an attempt's workers queue behind its own
      // checks rather than multiplying its share of the run's REPL.
      CMP_CONFIG: JSON.stringify({
        problem: cfg.problem,
        worker: idx,
        max_tokens: cfg.max_tokens ?? null,
        tools,
        facts_file: cfg.facts_file ?? null,
      }),
    },
    // NOT detached: staying in the parent pi's process group is what lets the
    // runner's group SIGKILL (budget, backstop, ^C) reap workers with the parent.
    stdio: ["ignore", "ignore", "pipe"],
  });
  child.stderr.on("data", (d) => stderrLog.write(d));
  try { writeFileSync(join(wDir, "pid"), String(child.pid)); } catch {}

  const kill = (reason) => {
    if (!killedAs) killedAs = reason;
    try { process.kill(child.pid, "SIGKILL"); } catch {}
  };

  const untail = tailSession(sessionDir, (entry) => {
    applyEntry(stats, entry);
    const m = entry?.message;
    if (m?.role !== "assistant") return;
    // The report is the final VISIBLE text — thinking blocks are the worker's own.
    const txt = (m.content ?? [])
      .filter((c) => c?.type === "text")
      .map((c) => c.text ?? "")
      .join("\n")
      .trim();
    if (txt) lastReport = txt;
    try { onTokens?.(m.usage); } catch {}
    // Voluntary per-task cap (the parent set it in the spawn call): enforcement at
    // message granularity, like the runner's attempt budget — overshoot ≤ 1 message.
    if (maxCostStd > 0 && costStd(stats.tokens) >= maxCostStd) kill("task_cap");
  });

  const promise = new Promise((resolveDone) => {
    let settled = false;
    const finish = (code) => {
      if (settled) return;
      settled = true;
      untail(); // final drain: the report often lands between the last poll and exit
      stderrLog.end();
      const end = killedAs ?? (code === 0 ? "completed" : "died");
      const record = {
        idx,
        end,
        turns: stats.turns,
        tokens: stats.tokens,
        cost_usd: +stats.cost.toFixed(5),
        cost_std: +costStd(stats.tokens).toFixed(5),
        tool_calls: stats.toolCalls,
        wall_s: Math.round((Date.now() - started) / 1000),
        max_cost_std: maxCostStd || null,
        task: task.slice(0, 4000),
      };
      try { writeFileSync(join(wDir, "worker.json"), JSON.stringify(record, null, 2)); } catch {}
      resolveDone({ idx, end, report: lastReport, stats });
    };
    // A failed spawn (pi missing) emits 'error' and, depending on the Node version,
    // possibly no 'close' — settle on either, first one wins.
    child.on("error", () => { killedAs = killedAs ?? "died"; finish(null); });
    child.on("close", (code) => finish(code));
  });

  return { promise, kill };
}
