// Continuation policy: when a turn ends and problem.lean is not done, nudge the agent to continue.
// Stops on budget spent, too many no-progress nudges, or a STOP file in the attempt dir.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { checkedCompile, serverCheck } from "../runner/stmt.js";
import { cmpConfig, costStd, workerSpendStd } from "../runner/common.js";
import { checkStatus, blockerNotes } from "../runner/verdict.js";

const NUDGE_CAP = 6000;

export default function (pi: ExtensionAPI) {
  const cfg = cmpConfig();
  const budget: number = cfg.budget_std ?? 0;
  const maxNudges: number = cfg.max_nudges ?? 3;
  const maxErrorStreak: number = cfg.max_error_streak ?? 20;
  const problem: string = cfg.problem ?? "supervisor";
  const work = process.cwd();

  const tokens = { in: 0, out: 0, cache_read: 0 };
  const workerSpend = (): number => workerSpendStd(cfg, work);
  // Progress = calls to configured non-read tools.
  const countable = new Set<string>((cfg.tools ?? []).filter((t: string) => t !== "read"));
  let actions = 0;
  let actionsAtNudge = 0;
  let noProgress = 0;
  let errorStreak = 0;
  let lastStopReason: string | null = null;

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

  // Serialize agent_end handling; pi can re-enter it during an await.
  let deciding = false;
  pi.on("agent_end", async (event: any) => {
    if (deciding) { dbg("agent_end re-entered mid-decision, ignored"); return; }
    deciding = true;
    try { await decide(event); } finally { deciding = false; }
  });

  async function decide(event?: any) {
    const last = [...(event?.messages ?? [])].reverse().find((m: any) => m?.role === "assistant");
    const stopReason: string | null = last?.stopReason ?? lastStopReason;
    const errored = stopReason === "error";
    dbg("agent_end", { stopReason, actions, noProgress, errorStreak });
    if (stopReason === "aborted") return;
    if (existsSync(join(work, "..", "STOP"))) return;
    if (budget > 0 && costStd(tokens) + workerSpend() >= budget) return;

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
    const origPath: string | undefined = cfg.original_file;
    const connDeadline = Date.now() + 5 * 60_000;
    for (;;) {
      try {
        check = origPath && existsSync(origPath)
          ? await checkedCompile(content, { original: readFileSync(origPath, "utf8"), problemName: problem, client: problem, cap: NUDGE_CAP })
          : await serverCheck(content, problem);
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
    const status = checkStatus(check ?? { ok: false });
    dbg("check:", { compiles: status.compiles, sorries: status.sorries.length, stmtBad: status.stmtBad, axBad: status.axBad });
    if (status.done) return;

    if (!errored) {
      noProgress = actions > actionsAtNudge ? 0 : noProgress + 1;
      actionsAtNudge = actions;
      if (noProgress > maxNudges) return;
    }

    const nudge =
      (stopReason === "length"
        ? `Your last message hit the output-token limit and was CUT OFF — everything after the cutoff is lost. Do not restart the derivation in chat. Write your current best attempt into problem.lean NOW (state intermediate facts as \`have\` steps closed by ring/linarith/norm_num etc.; leave hard parts as sorry'd steps) and run lean_check.\n\n`
        : `You are not done. `) +
      blockerNotes(status).map((n: string) => `IMPORTANT: ${n}\n\n`).join("") +
      `Checking your current problem.lean reports:\n\n${check?.pretty ?? "no check result available"}\n\nFix this and run lean_check; do not stop until it reports COMPLETE.`;
    try {
      pi.sendUserMessage(nudge, { deliverAs: "followUp" });
      dbg("nudge sent");
    } catch (e: any) {
      dbg("sendUserMessage FAILED:", e?.message);
    }
  }
}
