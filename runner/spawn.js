// spawn_subagents core: runs one worker pi subprocess per task and returns its final message as the report.

import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync, existsSync, createWriteStream } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tailSession, newStats, applyEntry } from "./session-tail.js";
import { costStd } from "./common.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const extTools = (name) => {
  const m = /^\/\/ @tools\s+(.+)$/m.exec(readFileSync(join(ROOT, "extensions", `${name}.ts`), "utf8"));
  return m ? m[1].split(",").map((s) => s.trim()).filter(Boolean) : [];
};

export function workerExtensions(combo) {
  const exts = [
    "lean-snippet",
    ...(combo ?? []).filter((x) => ["lean-search", "lean-grep"].includes(x)),
    ...((combo ?? []).includes("lean-facts") ? ["lean-facts"] : []),
  ];
  return { exts, tools: exts.flatMap(extTools) };
}

const capText = (s, n) => (s.length > n ? s.slice(0, n) + "\n... (truncated)" : s);

function workerSystemPrompt(cfg) {
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

// Launches one worker. Returns { promise, kill }; the promise resolves to { idx, end, report, stats }.
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
    "-e", join(ROOT, "extensions", "compaction-guard.ts"),
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
      CMP_CONFIG: JSON.stringify({
        problem: cfg.problem,
        worker: idx,
        max_tokens: cfg.max_tokens ?? null,
        tools,
        facts_file: cfg.facts_file ?? null,
        blocked_names: cfg.blocked_names ?? null,
      }),
    },
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
    const txt = (m.content ?? [])
      .filter((c) => c?.type === "text")
      .map((c) => c.text ?? "")
      .join("\n")
      .trim();
    if (txt) lastReport = txt;
    try { onTokens?.(m.usage); } catch {}
    if (maxCostStd > 0 && costStd(stats.tokens) >= maxCostStd) kill("task_cap");
  });

  const promise = new Promise((resolveDone) => {
    let settled = false;
    const finish = (code) => {
      if (settled) return;
      settled = true;
      untail();
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
    child.on("error", () => { killedAs = killedAs ?? "died"; finish(null); });
    child.on("close", (code) => finish(code));
  });

  return { promise, kill };
}
