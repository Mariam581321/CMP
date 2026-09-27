// @tools spawn_subagents
// Runs a batch of worker agents in parallel and returns their reports.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runWorker } from "../runner/spawn.js";
import { cmpConfig, costStd, ToolFailure } from "../runner/common.js";

export default function (pi: ExtensionAPI) {
  const cfg = cmpConfig();
  if (cfg.worker != null) return;
  const workersDir: string = cfg.workers_dir ?? join(process.cwd(), "..", "workers");
  const stopPath = join(process.cwd(), "..", "STOP");
  const hasFacts = (cfg.tools ?? []).includes("add_fact");

  // Cumulative worker usage, mirrored to workers/ledger.json for the supervisor.
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
    executionMode: "sequential",
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
            maxCostStd: cfg.worker_cap_std ?? 0,
            cfg: { ...cfg, workers_dir: workersDir },
            onTokens,
          }),
        );
      } catch (e: any) {
        throw new ToolFailure(`spawn_subagents could not launch workers: ${String(e?.message ?? e)}`);
      }
      // Kill workers on the attempt's STOP file or pi's abort signal.
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
