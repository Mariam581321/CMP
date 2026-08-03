// Always-on: the continuation policy ("nudge loop"), in-process. The model sometimes
// ends its turn with analysis instead of working; when the proof doesn't actually
// check out (real server check, memoized ≈ free) and budget remains, queue a nudge
// and the agent loop continues — same policy for every combo.
//
// This replaces the old runner-side respawn loop (spawn pi → wait for exit → resume
// session with a nudge): one pi process per attempt, one session file, one continuous
// event stream, and per-extension state (lean_check's unchanged-file note, lean-plan's
// green-phase memory) survives the whole attempt. pi explicitly supports this: messages
// queued by agent_end extension handlers trigger a continuation inside the same
// headless prompt() await (agent-session.ts, _handlePostAgentRun).
//
// Division of labor: this extension owns WHEN TO CONTINUE. The runner still owns hard
// enforcement — it SIGKILLs on the cost_std budget (overshoot ≤ 1 message) and on the
// wall-clock backstop; this extension merely stops nudging once the budget is spent so
// the attempt also ends gracefully at the next natural boundary.
//
// Per-attempt abort (first-class): drop a file named STOP in the attempt dir (next to
// work/) and the supervisor stops nudging — no process murder, the attempt drains,
// grades, and records normally.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { checkedCompile, serverCheck } from "../runner/stmt.js";
import { cmpConfig, costStd } from "../runner/common.js";

export default function (pi: ExtensionAPI) {
  const cfg = cmpConfig();
  const budget: number = cfg.budget_std ?? 0;
  const maxNudges: number = cfg.max_nudges ?? 3; // consecutive no-progress nudges; resets on non-read tool activity
  const problem: string = cfg.problem ?? "supervisor";
  const work = process.cwd(); // run.js spawns pi with cwd = the attempt's work dir

  const tokens = { in: 0, out: 0, cache_read: 0 };
  // Worker spend (block C). This extension's own counter sees only the parent's
  // message_end events, but the budget the runner enforces binds parent + workers
  // together — so the soft stop must read the ledger lean-spawn keeps on disk, or it
  // would keep nudging into a cap the attempt has already spent through its workers.
  const workersLedger = join(cfg.workers_dir ?? join(work, "..", "workers"), "ledger.json");
  const workerSpend = (): number => {
    try { return costStd(JSON.parse(readFileSync(workersLedger, "utf8")).tokens); } catch { return 0; }
  };
  // Progress = calls to REAL non-read tools (the runner passes the session's toolset
  // in cfg.tools). Reads don't count — a nudged model can loop on re-reading the file
  // forever (observed) — and neither do calls to hallucinated tool names (also
  // observed: nudged models invent lean_check spellings), which fire the tool
  // lifecycle but are degenerate loops, not work. Everything real — edits, writes,
  // checks, searches, arm tools — counts, so the definition stays arm-neutral.
  const countable = new Set<string>((cfg.tools ?? []).filter((t: string) => t !== "read"));
  let actions = 0;
  let actionsAtNudge = 0;
  let noProgress = 0;
  let lastStopReason: string | null = null;

  // No configured toolset (adhoc run) => nothing counts and nudging self-limits at
  // maxNudges+1 — the safe default.
  pi.on("tool_execution_start", (event: any) => {
    if (countable.has(event.toolName)) actions++;
  });

  pi.on("message_end", (event: any) => {
    const m = event.message;
    if (m?.role !== "assistant") return;
    if (m.stopReason) lastStopReason = m.stopReason;
    const u = m.usage;
    if (u) {
      tokens.in += u.input ?? 0;
      tokens.out += u.output ?? 0;
      tokens.cache_read += u.cacheRead ?? 0;
    }
  });

  const dbg = (...a: any[]) => { if (process.env.CMP_SUPERVISOR_DEBUG) console.error("[supervisor]", ...a); };

  // pi re-enters agent_end for every errored message, including each internal
  // auto-retry. Everything below reads and writes noProgress across an await, so without
  // this guard those invocations interleave and the nudge cap silently stops holding
  // (0729: 20 nudges under maxNudges = 3). One settle, one decision.
  let deciding = false;
  pi.on("agent_end", async (_event: any) => {
    if (deciding) { dbg("agent_end re-entered mid-decision, ignored"); return; }
    deciding = true;
    try { await decide(); } finally { deciding = false; }
  });

  async function decide() {
    dbg("agent_end", { lastStopReason, actions, noProgress });
    if (lastStopReason === "aborted") return;
    // A turn that died in transport rather than in the model gets no special treatment:
    // it is nudged on the same ledger as a stalled one. Bursts of them no longer reach
    // here — pi-agent/settings.json retries inside the SDK, below the message layer — so
    // only a drop mid-stream (which the SDK cannot retry) lands in this path, and the
    // nudge is what keeps the session alive when pi's own retries are spent.
    if (existsSync(join(work, "..", "STOP"))) return;
    if (budget > 0 && costStd(tokens) + workerSpend() >= budget) return;

    let content: string;
    try {
      content = readFileSync(join(work, "problem.lean"), "utf8");
    } catch (e: any) {
      dbg("no problem.lean:", e?.message);
      return;
    }
    let check: any = null;
    // checkedCompile, not bare serverCheck: (a) same code+probe body as the agent's
    // own lean_check, so the memo key matches and this check is usually free instead
    // of a duplicate REPL compile per agent_end; (b) "done" carries the statement
    // verdict, so a statement-tampered file that compiles sorry-free is nudged about
    // instead of silently ending into a statement_changed grade.
    // Connection-level failures (server dead, mid-restart) are waited out HERE, like
    // lean_check does in-tool: a nudge composed from "no check result available"
    // keeps the loop hot while nothing can be checked (2026-07-26 outage: >$2 of
    // retry storm). Waiting costs zero tokens, and the STOP file still aborts cleanly.
    //
    // Bounded, unlike the original version. This runs inside agent_end, so while it
    // waits the agent loop is blocked: no message completes, no tool returns, and the
    // session file stops growing entirely. An unbounded wait was therefore the one way
    // an attempt could go silent for hours and still be "alive" — invisible to the spend
    // cap (an unfinished message books nothing) and reaped only by the 48 h wall
    // backstop. 5 min matches lean-check.ts's in-tool retry deadline; past it, fall
    // through and nudge from whatever we have.
    const origPath: string | undefined = cfg.original_file;
    const connDeadline = Date.now() + 5 * 60_000;
    for (;;) {
      try {
        check = origPath && existsSync(origPath)
          ? await checkedCompile(content, { original: readFileSync(origPath, "utf8"), problemName: problem, client: problem })
          : await serverCheck(content, problem); // adhoc run without CMP_CONFIG
        break;
      } catch (e: any) {
        const connErr = /ECONNREFUSED|ECONNRESET|EPIPE|socket hang up/i.test(`${e?.code ?? ""} ${e?.message ?? ""}`);
        if (!connErr) { dbg("serverCheck failed:", e?.message); break; }
        if (existsSync(join(work, "..", "STOP"))) return;
        if (Date.now() + 10_000 > connDeadline) { dbg("server down past deadline, nudging anyway"); break; }
        dbg("server down, waiting:", e?.message);
        await new Promise((r) => setTimeout(r, 10_000));
      }
    }
    const stmtBad = check?.stmt?.ok === false;
    dbg("check:", { ok: check?.ok, sorries: (check?.sorries ?? []).length, stmtBad });
    if (check?.ok && (check.sorries ?? []).length === 0 && !stmtBad) return; // verified done — let the attempt end

    noProgress = actions > actionsAtNudge ? 0 : noProgress + 1;
    actionsAtNudge = actions;
    if (noProgress > maxNudges) return; // wall-clock/budget still bound everything

    const nudge =
      (lastStopReason === "length"
        ? `Your last message hit the output-token limit and was CUT OFF — everything after the cutoff is lost. Do not restart the derivation in chat. Write your current best attempt into problem.lean NOW (state intermediate facts as \`have\` steps closed by ring/linarith/norm_num etc.; leave hard parts as sorry'd steps) and run lean_check.\n\n`
        : `You are not done. `) +
      (stmtBad
        ? `IMPORTANT: you modified the theorem statement (${check.stmt.detail}). Proofs of a modified statement do not count — restore the original statement exactly; you may only fill sorries and add helper lemmas above it.\n\n`
        : "") +
      `Checking your current problem.lean reports:\n\n${(check?.pretty ?? "no check result available").slice(0, 3000)}\n\nFix this and run lean_check; do not stop until it passes with no errors and no sorries.`;
    try {
      // pi.sendUserMessage (ExtensionAPI, not the event ctx): messages queued by
      // agent_end handlers get a continuation inside the same headless prompt()
      // await — pi's documented supervisor pattern (agent-session _handlePostAgentRun).
      pi.sendUserMessage(nudge, { deliverAs: "followUp" });
      dbg("nudge sent");
    } catch (e: any) {
      // If queueing fails the attempt simply ends; the runner grades what's on disk.
      dbg("sendUserMessage FAILED:", e?.message);
    }
  }
}
