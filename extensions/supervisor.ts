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
import { serverCheck } from "../runner/stmt.js";
import { cmpConfig, costStd } from "../runner/common.js";

export default function (pi: ExtensionAPI) {
  const cfg = cmpConfig();
  const budget: number = cfg.budget_std ?? 0;
  const maxNudges: number = cfg.max_nudges ?? 3; // consecutive no-progress nudges; resets on non-read tool activity
  const problem: string = cfg.problem ?? "supervisor";
  const work = process.cwd(); // run.js spawns pi with cwd = the attempt's work dir

  const tokens = { in: 0, out: 0, cache_read: 0 };
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

  pi.on("agent_end", async (_event: any) => {
    dbg("agent_end", { lastStopReason, actions, noProgress });
    if (lastStopReason === "aborted") return;
    if (existsSync(join(work, "..", "STOP"))) return;
    if (budget > 0 && costStd(tokens) >= budget) return;

    let content: string;
    try {
      content = readFileSync(join(work, "problem.lean"), "utf8");
    } catch (e: any) {
      dbg("no problem.lean:", e?.message);
      return;
    }
    let check: any = null;
    try {
      check = await serverCheck(content, undefined, problem);
    } catch (e: any) {
      dbg("serverCheck failed:", e?.message);
    }
    dbg("check:", { ok: check?.ok, sorries: (check?.sorries ?? []).length });
    if (check?.ok && (check.sorries ?? []).length === 0) return; // verified done — let the attempt end

    noProgress = actions > actionsAtNudge ? 0 : noProgress + 1;
    actionsAtNudge = actions;
    if (noProgress > maxNudges) return; // wall-clock/budget still bound everything

    const nudge =
      (lastStopReason === "length"
        ? `Your last message hit the output-token limit and was CUT OFF — everything after the cutoff is lost. Do not restart the derivation in chat. Write your current best attempt into problem.lean NOW (state intermediate facts as \`have\` steps closed by ring/linarith/norm_num etc.; leave hard parts as sorry'd steps) and run lean_check.\n\n`
        : `You are not done. `) +
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
  });
}
