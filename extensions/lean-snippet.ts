// @tools check_snippet
// Experimental arm (PLAN.md block B): scratch verification — compile any snippet,
// no files involved. Motivated by the autopsies: agents already write scratch .lean
// files and try to compile them (silently inert today), and clobber the graded file
// with probes, destroying best states (fateh_28: statement_changed after 371 turns
// of scratch work in problem.lean). Like the search arms, the whole prompt delta
// lives in the tool description. Core logic in runner/snippet.js.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { existsSync, readFileSync } from "node:fs";
import { checkSnippet } from "../runner/snippet.js";
import { cmpConfig, ToolFailure } from "../runner/common.js";

export default function (pi: ExtensionAPI) {
  // Facts arm (cfg.facts_file set): the shared bank is in scope for snippets — read
  // fresh per call, since the bank grows during the attempt (parent and workers add
  // to it concurrently). Without facts the prefix is undefined and nothing changes.
  const factsFile: string | null = cmpConfig().facts_file ?? null;
  pi.registerTool({
    name: "check_snippet",
    label: "Check snippet",
    // What the tool is, what comes back, and the factual grading boundary — no
    // when/why steering (scratch strategy is the agent's; steering would make the
    // arm a strategy hint rather than a capability).
    description:
      "Compile a standalone Lean 4 snippet against Mathlib and return the compiler output: " +
      "every error and warning with its line number, and the goal state at each `sorry`. " +
      "The snippet is checked on its own in a fresh environment with Mathlib available — " +
      "it does not see problem.lean or any file, so it must be self-contained " +
      "(include any `open` lines and helper definitions it needs). " +
      (factsFile
        ? "Exception: every declaration in the shared fact bank IS in scope for snippets, " +
          "so snippets may use bank facts by name without restating them. "
        : "") +
      "Nothing checked here is graded: only problem.lean, compiled with lean_check, counts.",
    promptSnippet: "check_snippet - compile a standalone Lean snippet (scratch work, never graded) and get compiler errors + sorry goals",
    parameters: Type.Object({
      code: Type.String({ description: "Lean 4 source to compile (self-contained; Mathlib is available)" }),
    }),
    async execute(_toolCallId, params, signal) {
      try {
        // Same round-robin client id as lean_check (the problem name), so snippet
        // checks queue behind the attempt's own work, never in front of the run's.
        const client = cmpConfig().problem ?? "anon";
        const prefix = factsFile && existsSync(factsFile) ? readFileSync(factsFile, "utf8") : undefined;
        // Connection-level failures retried here where waiting costs zero tokens —
        // same production-validated loop as lean_check (see the rationale there).
        // Typed server responses (unavailable, crash) are NOT retried.
        const deadline = Date.now() + 5 * 60_000;
        let r: any;
        for (;;) {
          try {
            r = (await checkSnippet(params.code, { client, prefix })) as any;
            break;
          } catch (e: any) {
            const connErr = /ECONNREFUSED|ECONNRESET|EPIPE|socket hang up/i.test(`${e?.code ?? ""} ${e?.message ?? ""}`);
            if (!connErr || signal?.aborted || Date.now() + 10_000 > deadline) throw e;
            await new Promise((res) => setTimeout(res, 10_000));
          }
        }

        if (r.error) {
          // Mirror lean_check: nothing here is a verdict. Compile verdicts — the
          // deterministic heartbeat timeout included — come back as Lean messages on the
          // normal path; the server requeues resource kills instead of reporting them,
          // so this is a crash or "this machine could not run the check".
          const text =
            r.kind === "unavailable"
              ? `check_snippet could not compile this snippet: ${r.pretty}`
              : `check_snippet unavailable (${r.error}) — transient, try again`;
          throw new ToolFailure(text);
        }

        // Policy rejection (banned construct); the snippet was not compiled.
        if (r.rejected) {
          return { content: [{ type: "text", text: r.pretty }], details: { ok: false, rejected: r.rejected }, isError: false };
        }

        return { content: [{ type: "text", text: r.pretty || "no output" }], details: { ok: r.ok, cached: r.cached }, isError: false };
      } catch (e: any) {
        // Thrown = no server response at all (connection refused mid-restart) —
        // genuinely transient, unlike the typed error responses handled above.
        // A ToolFailure is already classified: rethrow rather than relabel.
        if (e instanceof ToolFailure) throw e;
        throw new ToolFailure(`check_snippet unavailable (${String(e?.message ?? e)}) — transient, try again`);
      }
    },
  });
}
