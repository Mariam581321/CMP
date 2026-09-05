#!/usr/bin/env node
// Block D library phase (PLAN.md): one librarian agent builds the shared library for
// a problem set, through the same machinery attempts use — spawn_subagents for
// parallel workers, add_fact as the only write path (the bank IS the library), the
// run's search arms, check_snippet with the bank in scope. The phase cap is enforced
// here by SIGKILL, silently; the librarian, like every agent, is budget-blind.
//
//   node runner/library.js --combo lean-search,lean-snippet \
//     --problems problems-fatex/scoreable95.txt --problems-dir problems-fatex \
//     --run-id library-fatex-0805 [--cap-std 5.00] [--worker-cap-std 1.00]
//
// The librarian's view is deliberately small: the problem statements (all of them,
// inline — no fetch tools, no pagination), the add_fact contract, spawn, search. No
// budget language, no schedule, no cluster list — which theory to build and how to
// split it across workers is the librarian's own call; the compile gate is the only
// hard rule. Artifacts on exit (however the phase ends): library.lean (the frozen
// bank), library.json (sha256 + stats — the `library_sha` every consuming run must
// record), index.md (name/signature/docstring per fact, the graded run's prompt
// addendum).

import { spawn } from "node:child_process";
import { parseArgs } from "node:util";
import { mkdirSync, readFileSync, readdirSync, writeFileSync, copyFileSync, createWriteStream, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { tailSessions, newStats, applyEntry } from "./session-tail.js";
import { benchmarkDecls } from "./stmt.js";
import { LEAN_URL, costStd, classifyLines, green, yellow, dim, bold, money, secs } from "./common.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

let A;
try {
  A = parseArgs({
    options: {
      combo: { type: "string", default: "lean-search,lean-snippet" },
      problems: { type: "string" },
      "problems-dir": { type: "string", default: join(ROOT, "problems") },
      "cap-std": { type: "string", default: "10.00" },
      "worker-cap-std": { type: "string", default: "1.00" },
      timeout: { type: "string", default: "86400" },
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
const WORKER_CAP = parseFloat(A["worker-cap-std"]);
const TIMEOUT_S = parseInt(A.timeout);
const MAX_TOKENS = parseInt(A["max-tokens"]);
for (const [flag, v, min] of [["cap-std", CAP_STD, 0.05], ["worker-cap-std", WORKER_CAP, 0], ["timeout", TIMEOUT_S, 60], ["max-tokens", MAX_TOKENS, 0]]) {
  if (!Number.isFinite(v) || v < min) { console.error(`--${flag}: not a number ≥ ${min}`); process.exit(1); }
}
if (!A.problems) { console.error("--problems <file> is required"); process.exit(1); }
const RUN_ID = A["run-id"] ?? `library-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, "")}`;

const dotenv = join(ROOT, ".env");
if (existsSync(dotenv)) process.loadEnvFile(dotenv);
process.env.PATH = `${process.env.HOME}/.local/node/bin:${process.env.HOME}/.elan/bin:${process.env.PATH}`;
process.env.CMP_LEAN_ENV = join(ROOT, "lean-env");
process.env.PI_CODING_AGENT_DIR = join(ROOT, "pi-agent");

const problems = readFileSync(A.problems, "utf8").split("\n").map((s) => s.trim()).filter(Boolean);
const runDir = join(ROOT, "results", RUN_ID);
if (existsSync(join(runDir, "library.json"))) {
  console.error(`results/${RUN_ID}/ already holds a finished library — pick a new --run-id`);
  process.exit(1);
}
const work = join(runDir, "work");
const sessionDir = join(runDir, "session");
const workersRoot = join(runDir, "workers");
mkdirSync(work, { recursive: true });
mkdirSync(sessionDir, { recursive: true });

const health = await fetch(`${LEAN_URL}/health`, { signal: AbortSignal.timeout(3000) }).then((r) => r.json()).catch(() => null);
if (!health?.ready) { console.error("lean server not ready"); process.exit(1); }

// All statements inline — the files are short, input tokens are cheap and cached,
// and a fetch tool would only add round-trips to the librarian's view.
const digest = problems
  .map((p) => `### ${p}\n\n\`\`\`lean\n${readFileSync(join(PROBLEMS_DIR, `${p}.lean`), "utf8").trim()}\n\`\`\``)
  .join("\n\n");
// Benchmark declaration names are reserved: a bank fact under one of them would
// collide with the statement itself once the library is baked (add_fact rejects
// with a rename instruction — the 0804 smoke found the librarian doing exactly this).
const blockedNames = [
  ...new Set(problems.flatMap((p) => benchmarkDecls(readFileSync(join(PROBLEMS_DIR, `${p}.lean`), "utf8")))),
];
const preambleFile = join(runDir, "worker-preamble.md");
writeFileSync(
  preambleFile,
  "Context: a librarian agent is building a shared library of verified, Mathlib-based facts to support future proof attempts on a set of hard algebra problems. Your subtask is one piece of that library; the brief above is your whole assignment.",
);

const SYSTEM_PROMPT = `You are the librarian for a campaign of formal proofs. Later, independent agents will each attempt one of the problems below, in Lean 4 with Mathlib, with your library available to them. Nothing else you produce survives this phase — the library is the deliverable. Build the shared background theory that will help those attempts most.

How this works:
- Everything enters the library through add_fact, which admits only verified code: compiles against Mathlib plus the library so far, no \`sorry\`, no axioms beyond propext/Classical.choice/Quot.sound. The library is append-only — add definitions before the lemmas that use them.
- You can delegate to parallel worker agents with spawn_subagents; workers can add facts too. Give each worker a complete, self-contained brief — exact statements to prove, where you can.
- Search before building: whatever Mathlib already has, use, don't rebuild.
- Prefer theory that several problems need over any single problem's endgame, and match the problems' own definitional idiom — where several problems restate identical definitions, build the one canonical copy they can all be bridged to.
- When you judge the library as useful as you can make it, finish: your final message should say what the library contains and what you judged out of reach.

The problems:

${digest}`;

const PROMPT = "Survey the problems, then build the library. Delegate freely; everything durable goes through add_fact.";

// Librarian toolset: read (the bank is a file worth re-reading) + snippet + the
// combo's search arms + facts + spawn. No lean_check (nothing here is graded), no
// write/edit (the gate is the only writer).
const extTools = (name) => {
  const m = /^\/\/ @tools\s+(.+)$/m.exec(readFileSync(join(ROOT, "extensions", `${name}.ts`), "utf8"));
  return m ? m[1].split(",").map((s) => s.trim()).filter(Boolean) : [];
};
const searchExts = COMBO.filter((x) => ["lean-search", "lean-grep"].includes(x));
const exts = ["file-sandbox", "lean-snippet", ...searchExts, "lean-facts", "lean-spawn"];
const toolList = ["read", ...exts.flatMap(extTools)];

console.log(bold(`\nlibrary phase ${RUN_ID}`));
console.log(dim(`  problems: ${problems.length}   cap: ${money(CAP_STD)} @std (worker cap ${money(WORKER_CAP)})   tools: ${toolList.join(", ")}\n`));

const args = [
  "--mode", "text",
  "--no-extensions", "--no-skills", "-nc", "--no-prompt-templates", "--no-themes",
  "--model", A.model, "--thinking", A.thinking,
  "--tools", toolList.join(","),
  ...(MAX_TOKENS > 0 ? ["-e", join(ROOT, "extensions", "max-tokens.ts")] : []),
  ...exts.map((x) => join(ROOT, "extensions", `${x}.ts`)).flatMap((p) => ["-e", p]),
  "--system-prompt", SYSTEM_PROMPT,
  "--session-dir", sessionDir,
  PROMPT,
];

const started = Date.now();
const libStats = newStats();
const wStats = newStats();
let capped = false, timedOut = false;
const workerSessionDirs = () => {
  try { return readdirSync(workersRoot).filter((d) => /^w\d+$/.test(d)).map((d) => join(workersRoot, d, "session")); }
  catch { return []; }
};

const stderrLog = createWriteStream(join(runDir, "stderr.log"));
stderrLog.on("error", () => {});
const exit = await new Promise((resolveExit) => {
  const child = spawn("pi", args, {
    cwd: work,
    env: {
      ...process.env,
      NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --max-old-space-size=8192`.trim(),
      CMP_CONFIG: JSON.stringify({
        problem: "library", // one REPL round-robin slot for the whole phase
        original_file: null,
        max_tokens: MAX_TOKENS > 0 ? MAX_TOKENS : null,
        tools: toolList,
        combo: [...searchExts, "lean-facts"], // workers: snippet + searches + add_fact
        model: A.model,
        thinking: A.thinking,
        workers_dir: workersRoot,
        facts_file: join(work, "library.lean"),
        worker_cap_std: WORKER_CAP,
        worker_preamble_file: preambleFile,
        blocked_names: blockedNames,
      }),
    },
    detached: true, // own process group: the cap SIGKILL takes librarian + workers together
    stdio: ["ignore", "ignore", "pipe"],
  });
  child.stderr.on("data", (d) => stderrLog.write(d));
  const kill = () => { try { process.kill(-child.pid, "SIGKILL"); } catch {} };
  for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => { kill(); process.exit(130); });
  const backstop = setTimeout(() => { timedOut = true; kill(); }, TIMEOUT_S * 1000);
  const untail = tailSessions(() => [sessionDir, ...workerSessionDirs()], (entry, _raw, dir) => {
    applyEntry(dir === sessionDir ? libStats : wStats, entry);
    if (!capped && costStd(libStats.tokens) + costStd(wStats.tokens) >= CAP_STD) {
      capped = true;
      kill();
    }
  });
  child.on("close", (code, signal) => { clearTimeout(backstop); untail(); resolveExit({ code, signal }); });
});
stderrLog.end();

// Freeze whatever the gate admitted — the bank is valid at every prefix, so a capped
// phase still ships a working library.
const bankPath = join(work, "library.lean");
const bank = existsSync(bankPath) ? readFileSync(bankPath, "utf8") : "";
writeFileSync(join(runDir, "library.lean"), bank);
const sha = createHash("sha256").update(bank).digest("hex");

// Index: one entry per declaration — preceding docstring + the head lines up to the
// signature-ending `:=`. A human-facing artifact (the graded run points agents at the
// readable source instead). The cut looks for `:=` at bracket depth 0 only: named
// arguments (`QuotientGroup.mk (s := H) a`) and structure-instance fields put `:=`
// INSIDE brackets, and cutting at the first occurrence truncated a signature mid-term
// (found in the 0804 smoke).
function buildIndex(source) {
  const entries = [];
  const lines = source.split("\n");
  const kinds = classifyLines(source);
  const cutAtTopLevelAssign = (line, depth) => {
    for (let i = 0; i < line.length - 1; i++) {
      const c = line[i];
      if ("([{⟨".includes(c)) depth++;
      else if (")]}⟩".includes(c)) depth--;
      else if (depth === 0 && c === ":" && line[i + 1] === "=") return { cut: i, depth };
    }
    return { cut: -1, depth };
  };
  for (let i = 0; i < lines.length; i++) {
    if (kinds[i].kind !== "code") continue;
    if (!/^\s*(?:@\[[^\]]*\]\s*)?(?:noncomputable\s+)?(?:abbrev|def|theorem|lemma|instance)\s/.test(lines[i])) continue;
    let doc = "";
    for (let j = i - 1; j >= 0 && kinds[j].kind === "docstring"; j--) doc = lines[j] + "\n" + doc;
    let sig = [];
    let depth = 0;
    for (let j = i; j < Math.min(i + 12, lines.length); j++) {
      const r = cutAtTopLevelAssign(lines[j], depth);
      if (r.cut >= 0) { sig.push(lines[j].slice(0, r.cut).trimEnd()); break; }
      depth = r.depth;
      sig.push(lines[j]);
    }
    entries.push((doc ? doc : "") + sig.join("\n"));
  }
  return entries;
}
const index = buildIndex(bank);
writeFileSync(join(runDir, "index.md"), index.length ? "```lean\n" + index.join("\n\n") + "\n```\n" : "");

const wall = Date.now() - started;
const workers = workerSessionDirs().length;
const summary = {
  run_id: RUN_ID, problems: problems.length, combo: COMBO, model: A.model,
  cap_std: CAP_STD, worker_cap_std: WORKER_CAP,
  end: capped ? "capped" : timedOut ? "timeout" : exit.code === 0 ? "completed" : "died",
  library_sha256: sha, decls: index.length, bytes: Buffer.byteLength(bank),
  librarian: { turns: libStats.turns, tool_calls: libStats.toolCalls, cost_std: +costStd(libStats.tokens).toFixed(5) },
  workers, workers_cost_std: +costStd(wStats.tokens).toFixed(5),
  cost_std: +(costStd(libStats.tokens) + costStd(wStats.tokens)).toFixed(5),
  wall_s: Math.round(wall / 1000), finished_at: new Date().toISOString(),
};
writeFileSync(join(runDir, "library.json"), JSON.stringify(summary, null, 2));
console.log(bold(`\nlibrary: ${index.length} declaration(s), ${Buffer.byteLength(bank)} bytes  (${summary.end}, ${money(summary.cost_std)} @std, ${workers} workers, ${secs(wall)})`));
console.log(dim(`  sha256 ${sha.slice(0, 12)}…   artifacts: results/${RUN_ID}/{library.lean,index.md,library.json}\n`));
