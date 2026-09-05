// Shared bits: config, lean-server client, CLI/TTY helpers, PutnamBench line classifier.

import { request } from "node:http";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// --- config -----------------------------------------------------------------
export const LEAN_PORT = process.env.CMP_LEAN_PORT ?? "8787";
export const LEAN_URL = `http://127.0.0.1:${LEAN_PORT}`;

// THE check verdict: a per-declaration elaboration cap, enforced by Lean itself
// (runner/lean-server.js injects `set_option maxHeartbeats` and clamps any the file
// sets for itself). Heartbeats count elaboration steps — a pure function of the file,
// identical on any machine, under any load, at any REPL age — so over-cap is an
// ordinary, byte-reproducible compile error ("(deterministic) timeout"), the same for
// agent, supervisor, grader and any future regrade. A measured budget (CPU seconds)
// would have a noise band around its threshold; CPU is a machine fuse instead (see
// CPU_FUSE_MS). 400 000 is 2x Lean's default. Any change to this number changes what
// "compiles" means: runs recorded either side of it are not comparable.
export const MAX_HEARTBEATS = 400_000;

// The axiom whitelist — one definition for the grader (bad_axioms verdict), the
// agent-facing checks (stmt.js checkedCompile reports would-grade-bad_axioms in-loop)
// and the fact-bank gate (facts.js). Lives here because stmt.js cannot import it from
// grade.js without a cycle.
export const ALLOWED_AXIOMS = new Set(["propext", "Classical.choice", "Quot.sound"]);

// deepseek-v4-flash standard (off-peak) rates in $/1M tokens — the only place prices
// live; update ONLY when DeepSeek reprices or the default model changes.
// cost_std = tokens re-priced at this fixed table. Unlike billed cost_usd it is
// invariant to peak-hour 2x pricing, so it is the headline metric for arm comparisons.
export const STD_PRICES = { in: 0.14, cacheRead: 0.0028, out: 0.28 };
export const costStd = (t) =>
  ((t?.in ?? 0) * STD_PRICES.in + (t?.cache_read ?? 0) * STD_PRICES.cacheRead + (t?.out ?? 0) * STD_PRICES.out) / 1e6;

// What this attempt's spawned workers have spent so far, read from the ledger
// runner/spawn.js keeps on disk. An extension's own message_end handler sees only the
// PARENT's usage, but the budget the runner enforces binds parent + workers together —
// so anything reasoning about "what has this attempt spent" (the high-water mark's
// cost-at-first-proof stamp) has to add this in or it is quoting a number the runner
// does not enforce on. 0 without workers, and 0 if the ledger is mid-write: a missed
// poll is worth less than a crash in an agent_end handler.
export function workerSpendStd(cfg, cwd) {
  const dir = cfg?.workers_dir ?? join(cwd ?? process.cwd(), "..", "workers");
  try { return costStd(JSON.parse(readFileSync(join(dir, "ledger.json"), "utf8")).tokens); } catch { return 0; }
}

// POST JSON to the lean server via node:http. Deliberately NOT fetch(): undici's
// built-in 300s headers-timeout kills any request that queues >5 min at the server,
// which happens routinely when many agents share one serialized REPL.
export function postCheck(body, timeoutMs) {
  return new Promise((resolve, reject) => {
    const req = request(
      { host: "127.0.0.1", port: LEAN_PORT, path: "/check", method: "POST", headers: { "content-type": "application/json" }, timeout: timeoutMs },
      (res) => {
        let data = "";
        // Decode as UTF-8 ACROSS chunk boundaries. Without this, `data += d` coerces each
        // Buffer independently and a multi-byte char straddling a chunk becomes U+FFFD
        // while JSON.parse still succeeds, so the corruption is silent. This response
        // carries every compiler message, every sorry goal, and the canonical types that
        // decide statement preservation, so a mangled byte here can read as a changed
        // statement on a valid proof.
        res.setEncoding("utf8");
        res.on("data", (d) => (data += d));
        res.on("end", () => {
          try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
        });
      },
    );
    req.on("timeout", () => req.destroy(new Error(`lean server did not respond within ${Math.round(timeoutMs / 1000)}s`)));
    req.on("error", reject);
    req.end(JSON.stringify(body));
  });
}

// Retry fn() across connection-level failures (server dead / mid-restart) for up to
// deadlineMs. Typed server responses are results, not throws, and are never retried;
// this only covers "no response arrived at all". The grader uses it because its
// verdict is recorded permanently — a REPL restart at grading time must not turn a
// valid proof on disk into a forever grader_error. (lean_check and the supervisor
// carry their own production-validated variants of this loop.)
export async function withConnRetry(fn, deadlineMs = 5 * 60_000) {
  const deadline = Date.now() + deadlineMs;
  for (;;) {
    try {
      return await fn();
    } catch (e) {
      const connErr = /ECONNREFUSED|ECONNRESET|EPIPE|socket hang up/i.test(`${e?.code ?? ""} ${e?.message ?? ""}`);
      if (!connErr || Date.now() + 10_000 > deadline) throw e;
      await new Promise((r) => setTimeout(r, 10_000));
    }
  }
}

// --- tool failures ------------------------------------------------------------
// pi decides a tool call's isError from a THROWN error only: executePreparedToolCall
// (pi/packages/agent/src/agent-loop.ts) hardcodes isError:false on the success path
// and never reads the isError field of a returned result, so a returned {isError:true}
// lands in the session unflagged. Tools THROW to signal failure; pi turns the message
// into the result text. This marker means "already classified": an outer catch that
// exists to label transient/unknown failures rethrows it instead of relabelling it.
// No effect on what the model sees — the openai-completions path DeepSeek runs on
// serializes tool results as {role:"tool", content} and never sends isError.
export class ToolFailure extends Error {}

// --- CLI --------------------------------------------------------------------
export function arg(name, dflt) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : dflt;
}

// --- extension config --------------------------------------------------------
// run.js passes per-attempt config to the pi subprocess's extensions as ONE JSON
// env var (CMP_CONFIG): original_file, problem, budget_std, max_nudges, max_tokens,
// tools, and for spawn arms: combo, model, thinking, workers_dir, facts_file. Workers get
// their own variant from runner/spawn.js (problem, worker: <idx>, max_tokens, tools,
// facts_file — `worker` set is what marks a worker process). Empty object outside a
// run (e.g. grader in the runner process). Nothing about the check metric travels
// here any more — it is the server's, identically for everyone.
export function cmpConfig() {
  try { return JSON.parse(process.env.CMP_CONFIG ?? "{}"); } catch { return {}; }
}

// --- TTY colors -------------------------------------------------------------
// FORCE_COLOR: keep ANSI when piped through watch(1).
const tty = process.stdout.isTTY || !!process.env.FORCE_COLOR;
const c = (code, s) => (tty ? `\x1b[${code}m${s}\x1b[0m` : s);
export const green = (s) => c(32, s);
export const red = (s) => c(31, s);
export const yellow = (s) => c(33, s);
export const dim = (s) => c(2, s);
export const bold = (s) => c(1, s);
export const cyan = (s) => c(36, s);
export const money = (x) => `$${x.toFixed(3)}`;
export const secs = (ms) => `${Math.round(ms / 1000)}s`;

// --- Lean source line classification ----------------------------------------
// One definition of "what is a docstring vs a comment vs code" shared by the
// sanitizer (which strips comments = answers) and the grader (which checks the
// statement survived). If these two disagree, the pipeline breaks silently.
// Whole-line `/- -/` block comments are tracked with nesting depth (Lean block
// comments nest, and PutnamBench does ship indented block comments explaining a
// hypothesis in prose). Inline forms (`foo /- c -/ bar`, trailing `-- c`) still
// classify as code: none exist in either corpus, and mangling strings containing
// `--` would be worse.
export function classifyLines(source) {
  const out = [];
  let inDocstring = false;
  let blockDepth = 0;
  const opens = (s) => (s.match(/\/-/g) ?? []).length;
  const closes = (s) => (s.match(/-\//g) ?? []).length;
  for (const line of source.split("\n")) {
    const stripped = line.trim();
    let kind;
    if (blockDepth > 0) {
      kind = "comment";
      blockDepth += opens(stripped) - closes(stripped);
      if (blockDepth < 0) blockDepth = 0;
    } else if (inDocstring) {
      kind = "docstring";
      if (stripped.endsWith("-/")) inDocstring = false;
    } else if (stripped.startsWith("/--")) {
      kind = "docstring";
      if (!stripped.endsWith("-/") || stripped === "/--") inDocstring = true;
    } else if (stripped.startsWith("/-")) {
      kind = "comment";
      blockDepth += opens(stripped) - closes(stripped);
      if (blockDepth < 0) blockDepth = 0;
    } else if (stripped.startsWith("--")) {
      kind = "comment";
    } else if (stripped === "") {
      kind = "blank";
    } else {
      kind = "code";
    }
    out.push({ line, kind });
  }
  return out;
}
