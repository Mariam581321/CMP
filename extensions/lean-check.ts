// Always-on tool: compile the agent's problem.lean against Mathlib and report errors.
// Checks go to the persistent lean server (runner/lean-server.js), which keeps Mathlib
// resident so a check takes seconds instead of a full olean reload.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { checkStatementPreserved } from "../runner/grade.js";

const PORT = process.env.CMP_LEAN_PORT ?? "8787";
const CLIENT_TIMEOUT_MS = 600_000; // server queues requests; be patient

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "lean_check",
    label: "Lean check",
    description:
      "Compile problem.lean with Lean 4 + Mathlib and return the compiler output. " +
      "This is the ground truth for whether your proof is accepted. " +
      "Checks are queued; make each check count.",
    promptSnippet: "lean_check - compile problem.lean and get Lean compiler errors/warnings",
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, signal, _onUpdate, ctx) {
      const src = join(ctx.cwd, "problem.lean");
      if (!existsSync(src)) {
        return { content: [{ type: "text", text: "error: problem.lean not found in working directory" }], isError: true };
      }
      const ac = new AbortController();
      const t = setTimeout(() => ac.abort(), CLIENT_TIMEOUT_MS);
      signal?.addEventListener("abort", () => ac.abort());
      try {
        const resp = await fetch(`http://127.0.0.1:${PORT}/check`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ code: readFileSync(src, "utf8") }),
          signal: ac.signal,
        });
        const r = (await resp.json()) as any;
        // early tamper feedback: grading enforces this either way, but telling the
        // agent now makes it recoverable instead of a silent disqualification
        let text = r.pretty ?? "no output";
        const origPath = process.env.CMP_ORIGINAL_FILE;
        if (origPath && existsSync(origPath)) {
          const stmt = checkStatementPreserved(readFileSync(origPath, "utf8"), readFileSync(src, "utf8"));
          if (!stmt.ok)
            text += `\n\nWARNING: you have modified the theorem statement (${stmt.detail}). This attempt will NOT count as solved unless you restore the original statement exactly (you may still add helper lemmas above it and fill in sorries).`;
        }
        return { content: [{ type: "text", text }], details: { ok: r.ok, cached: r.cached }, isError: r.error != null };
      } catch (e: any) {
        return { content: [{ type: "text", text: `lean_check unavailable: ${e?.message ?? e} (is the lean server running?)` }], isError: true };
      } finally {
        clearTimeout(t);
      }
    },
  });
}
