// @tools check_snippet
// Compiles a standalone snippet against Mathlib, no files involved.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { existsSync, readFileSync } from "node:fs";
import { checkSnippet } from "../runner/snippet.js";
import { cmpConfig, ToolFailure } from "../runner/common.js";

export default function (pi: ExtensionAPI) {
  // The fact bank, if any, is prepended to every snippet.
  const factsFile: string | null = cmpConfig().facts_file ?? null;
  pi.registerTool({
    name: "check_snippet",
    label: "Check snippet",
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
        const client = cmpConfig().problem ?? "anon";
        const prefix = factsFile && existsSync(factsFile) ? readFileSync(factsFile, "utf8") : undefined;
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
          const text =
            r.kind === "unavailable"
              ? `check_snippet could not compile this snippet: ${r.pretty}`
              : `check_snippet unavailable (${r.error}) — transient, try again`;
          throw new ToolFailure(text);
        }

        // Policy rejection: the snippet was not compiled.
        if (r.rejected) {
          return { content: [{ type: "text", text: r.pretty }], details: { ok: false, rejected: r.rejected }, isError: false };
        }

        return { content: [{ type: "text", text: r.pretty || "no output" }], details: { ok: r.ok, cached: r.cached }, isError: false };
      } catch (e: any) {
        if (e instanceof ToolFailure) throw e;
        throw new ToolFailure(`check_snippet unavailable (${String(e?.message ?? e)}) — transient, try again`);
      }
    },
  });
}
