// Always-on tool: compile the agent's problem.lean against Mathlib and report errors.
// Checks go to the persistent lean server (runner/lean-server.js), which keeps Mathlib
// resident so a check takes seconds instead of a full olean reload.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { checkStatementPreserved } from "../runner/grade.js";
import { postCheck } from "../runner/common.js";

const CLIENT_TIMEOUT_MS = 30 * 60_000; // server queue is serialized; be patient

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
      try {
        const r = (await postCheck({ code: readFileSync(src, "utf8") }, CLIENT_TIMEOUT_MS)) as any;
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
        return { content: [{ type: "text", text: `lean_check temporarily unavailable (${e?.message ?? e}) — try again` }], isError: true };
      }
    },
  });
}
