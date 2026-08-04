// @tools spawn_subagents
// Experimental arm (PLAN.md block C): model-owned subagents. One tool, blocking
// batch: the agent hands over 1–N task briefs, workers run in parallel, and the call
// returns every report — parallelism with zero bookkeeping in the agent's view (no
// ids, no polling, no collect step to forget). Worker mechanics in runner/spawn.js.
//
// Like the search/snippet arms, the whole prompt delta lives in the tool description;
// the spawn+plan arm's steering line rides separately in delegate.prompt.md.
//
// Cost roll-up: the runner tails worker session files alongside the parent's, so
// child usage lands in the same budget SIGKILL and in the attempt record (PLAN:
// "child usage rolls into the shared per-problem cap"). This extension additionally
// keeps workers/ledger.json current so the IN-PROCESS soft stop — the supervisor's
// "budget spent, stop nudging" check, which only sees parent messages — agrees with
// the runner's hard cap.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runWorker } from "../runner/spawn.js";
import { cmpConfig, costStd, ToolFailure } from "../runner/common.js";

export default function (pi: ExtensionAPI) {
  const cfg = cmpConfig();
  // Depth 1 is structural — run.js never loads this extension into a worker — but a
  // misconfigured adhoc launch should degrade to "tool absent", not to worker trees.
  if (cfg.worker != null) return;
  const workersDir: string = cfg.workers_dir ?? join(process.cwd(), "..", "workers");
  const stopPath = join(process.cwd(), "..", "STOP");
  const hasFacts = (cfg.tools ?? []).includes("add_fact");

  // Cumulative worker usage across every spawn call of the attempt, mirrored to disk
  // for the supervisor (separate extension instance — module state doesn't cross).
  const ledger = { tokens: { in: 0, out: 0, cache_read: 0 } };
  const onTokens = (u: any) => {
    ledger.tokens.in += u?.input ?? 0;
    ledger.tokens.out += u?.output ?? 0;
    ledger.tokens.cache_read += u?.cacheRead ?? 0;
    try { writeFileSync(join(workersDir, "ledger.json"), JSON.stringify(ledger)); } catch {}
  };
  let nextIdx = 1;

  pi.registerTool({
    name: "spawn_subagents",
    label: "Spawn subagents",
    // The batch is the parallelism, so the tool itself never needs to run alongside
    // another copy of itself; sequential keeps two batches from interleaving their
    // worker numbering and budget picture.
    executionMode: "sequential",
    // No budget/spend language anywhere the model can see (2026-08-04): the harness
    // never tells the agent how much budget exists or is left, and dollar telemetry
    // in worker reports invited exactly the strategic early wrap-ups the arm is not
    // supposed to induce. Cost stays in the tool-result `details` (session log only)
    // and in worker.json for analysis.
    description:
      "Delegate subtasks to fresh worker agents that run in PARALLEL and report back. " +
      "Each task launches one worker that sees ONLY the problem statement and your task text — " +
      "none of your conversation, files, or progress — so put everything the worker needs into " +
      "the task: the precise Lean statement to prove or question to settle, relevant definitions " +
      "and notation, and anything you already learned. Workers have check_snippet and the same " +
      "search tools as you" +
      (hasFacts ? ", plus add_fact into the shared bank" : "") +
      ", but no files: they cannot see or touch problem.lean, and everything they verify comes " +
      "back only in their report" +
      (hasFacts ? " or through the bank" : "") +
      ". The call blocks until every worker in it finishes, so batch independent subtasks into one call.",
    parameters: Type.Object({
      tasks: Type.Array(
        Type.Object({
          task: Type.String({
            description:
              "Complete, self-contained brief for one worker (it sees only this and the problem statement)",
          }),
        }),
        { minItems: 1 },
      ),
    }),
    async execute(_toolCallId, params, signal) {
      let handles: { promise: Promise<any>; kill: (reason: string) => void }[];
      try {
        mkdirSync(workersDir, { recursive: true });
        handles = params.tasks.map((t) =>
          runWorker({
            idx: nextIdx++,
            task: t.task,
            cfg: { ...cfg, workers_dir: workersDir },
            onTokens,
          }),
        );
      } catch (e: any) {
        throw new ToolFailure(`spawn_subagents could not launch workers: ${String(e?.message ?? e)}`);
      }
      // Abort paths while blocked: the attempt's STOP file (the documented per-attempt
      // abort — the supervisor only sees it at agent_end, which never comes while this
      // call holds the loop) and pi's own abort signal.
      const killAll = (reason: string) => handles.forEach((h) => h.kill(reason));
      const watcher = setInterval(() => { if (existsSync(stopPath)) killAll("aborted"); }, 2000);
      const onAbort = () => killAll("aborted");
      signal?.addEventListener("abort", onAbort);
      let results: any[];
      try {
        results = await Promise.all(handles.map((h) => h.promise));
      } finally {
        clearInterval(watcher);
        signal?.removeEventListener("abort", onAbort);
      }

      // Report headers carry the outcome word only — no turn counts, no dollars: the
      // model gets the workers' content, never their cost.
      const endNote: Record<string, string> = {
        completed: "finished",
        task_cap: "stopped early",
        aborted: "aborted",
        died: "died before finishing",
      };
      const text = results
        .map((r) => {
          const rep = r.report ?? "(no report — the worker produced no final message)";
          const capped = rep.length > 30000 ? rep.slice(0, 30000) + "\n... (report truncated)" : rep;
          return `## Worker ${r.idx} — ${endNote[r.end] ?? r.end}\n\n${capped}`;
        })
        .join("\n\n");
      return {
        content: [{ type: "text", text }],
        details: { workers: results.map((r) => ({ idx: r.idx, end: r.end, cost_std: +costStd(r.stats.tokens).toFixed(5) })) },
        isError: false,
      };
    },
  });
}
