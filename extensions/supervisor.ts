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
import { cmpConfig, costStd, workerSpendStd } from "../runner/common.js";
import { checkStatus, blockerNotes } from "../runner/verdict.js";

// See the call site: a nudge is a user message, so it is re-sent on every subsequent
// turn for the rest of the attempt, unlike a tool result the agent asked for.
const NUDGE_CAP = 6000;

export default function (pi: ExtensionAPI) {
  const cfg = cmpConfig();
  const budget: number = cfg.budget_std ?? 0;
  const maxNudges: number = cfg.max_nudges ?? 3; // consecutive no-progress nudges; resets on non-read tool activity
  // Consecutive errored agent_ends tolerated. An errored turn is not the model stalling —
  // it is transport dying below the message layer — so it must not spend the nudge budget
  // (0805 cells: three attempts ended with money unspent on error,error,NUDGE,... spirals).
  // But an errored turn books ZERO usage, so the spend cap cannot see it either: this
  // counter is then the ONLY bound on an error loop short of the 48 h wall backstop. 20 is
  // ~2x the longest burst observed (9). run.js does not pass this knob — the constant IS
  // the policy; cfg only exists so scripts/probe-supervisor.mjs can drive the give-up branch.
  const maxErrorStreak: number = cfg.max_error_streak ?? 20;
  const problem: string = cfg.problem ?? "supervisor";
  const work = process.cwd(); // run.js spawns pi with cwd = the attempt's work dir

  const tokens = { in: 0, out: 0, cache_read: 0 };
  // Worker spend (block C): the soft stop must count it, or it would keep nudging into
  // a cap the attempt has already spent through its workers. Shared with the high-water
  // stamp in lean-check.ts — see workerSpendStd in runner/common.js.
  const workerSpend = (): number => workerSpendStd(cfg, work);
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
  let errorStreak = 0;
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
  pi.on("agent_end", async (event: any) => {
    if (deciding) { dbg("agent_end re-entered mid-decision, ignored"); return; }
    deciding = true;
    try { await decide(event); } finally { deciding = false; }
  });

  async function decide(event?: any) {
    // The stop reason of THIS run's own last assistant message: agent_end carries the
    // messages the run produced, and an errored message is always the last of its run.
    // The attempt-wide lastStopReason only refreshes on a truthy stopReason, so on its
    // own it would let a previous turn's verdict decide this one; it remains as the
    // fallback for a pi build that ships agent_end without messages. (Not event.willRetry:
    // pi sets that on session-listener events only, never on the extension event — and a
    // wrong "will retry" prediction here would queue nothing and silently end the attempt.)
    const last = [...(event?.messages ?? [])].reverse().find((m: any) => m?.role === "assistant");
    const stopReason: string | null = last?.stopReason ?? lastStopReason;
    const errored = stopReason === "error";
    dbg("agent_end", { stopReason, actions, noProgress, errorStreak });
    if (stopReason === "aborted") return;
    if (existsSync(join(work, "..", "STOP"))) return;
    if (budget > 0 && costStd(tokens) + workerSpend() >= budget) return;

    // An errored turn (retry-exhausted transport, or a non-retryable 400) is not the model
    // stalling: pi already spent its own retries below the message layer (pi-agent/
    // settings.json), the message books no tokens and calls no tools, and it would look
    // like "no progress" forever. Charging it to noProgress ended attempts at 4
    // consecutive errors with the budget untouched (0805). It gets its own, much longer
    // ledger instead — and the SAME nudge below, because once pi's retries ARE spent the
    // queued message is the only thing keeping the session alive. Accepted side effect:
    // those continuations still count in run.js's `nudges` stat (userMsgs - 1).
    if (errored) {
      if (++errorStreak > maxErrorStreak) { dbg("error streak past cap, ending"); return; }
    } else {
      errorStreak = 0;
    }

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
          // Rendered at the nudge's own budget, and deliberately smaller than
          // lean_check's: this is a RE-statement of something the agent can fetch itself
          // in one call, and unlike a tool result it is a user message that every later
          // turn resends. Nudge counts reach 134 in one attempt, so a full 16 KB digest
          // per nudge would put hundreds of KB of duplicated compiler output permanently
          // in the window. NUDGE_CAP covers p99 of the nudges actually sent (3,152 chars
          // over the two block-A cells) with room, and renderCheck protects the header —
          // every sorry line, the statement and axiom verdicts — at any cap, which is
          // what the old blunt 3000-char slice after the fact did not.
          // No workDir: the file this would write is lean_check's, and the supervisor
          // must not overwrite it behind the agent's back.
          ? await checkedCompile(content, { original: readFileSync(origPath, "utf8"), problemName: problem, client: problem, cap: NUDGE_CAP })
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
    // One reading of the result (runner/verdict.js), shared with the header the agent
    // sees and with the high-water watermark in lean-check.ts: these must never disagree
    // about what a solved file looks like. A tampered statement and a disallowed axiom
    // both block "done" exactly like a sorry — an axiom-closed file compiles sorry-free
    // with the statement intact, and without that the supervisor blessed as done a file
    // the grader fails as bad_axioms (spawn-fatex10-0804 fatex_99; three 0802 incidents).
    // ok:false, not {}: checkStatus({}) reads "no errors, ok not false" as compiles ⇒
    // done ⇒ the attempt would END silently exactly when nothing could be checked (server
    // 500, parse failure, the 5-min deadline above expiring) — the opposite of the
    // "nudging anyway" contract this block promises.
    const status = checkStatus(check ?? { ok: false });
    dbg("check:", { compiles: status.compiles, sorries: status.sorries.length, stmtBad: status.stmtBad, axBad: status.axBad });
    if (status.done) return; // verified done — let the attempt end

    // The progress ledger judges the model, so an errored turn is exempt: it neither
    // spends the nudge budget nor moves actionsAtNudge (work done before the transport
    // died still gets credited at the next real nudge).
    if (!errored) {
      noProgress = actions > actionsAtNudge ? 0 : noProgress + 1;
      actionsAtNudge = actions;
      if (noProgress > maxNudges) return; // wall-clock/budget still bound everything
    }

    // Same paragraphs lean_check and plan_check use for the same faults (blockerNotes),
    // so the agent is never told two different things about what grading accepts.
    const nudge =
      (stopReason === "length"
        ? `Your last message hit the output-token limit and was CUT OFF — everything after the cutoff is lost. Do not restart the derivation in chat. Write your current best attempt into problem.lean NOW (state intermediate facts as \`have\` steps closed by ring/linarith/norm_num etc.; leave hard parts as sorry'd steps) and run lean_check.\n\n`
        : `You are not done. `) +
      blockerNotes(status).map((n: string) => `IMPORTANT: ${n}\n\n`).join("") +
      `Checking your current problem.lean reports:\n\n${check?.pretty ?? "no check result available"}\n\nFix this and run lean_check; do not stop until it reports COMPLETE.`;
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
