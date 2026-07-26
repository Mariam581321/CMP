// Always-on tool: compile the agent's problem.lean against Mathlib and report errors.
// Checks go to the persistent lean server (runner/lean-server.js), which keeps Mathlib
// resident so a check takes seconds instead of a full olean reload.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { createHash } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import { join, basename } from "node:path";
import { benchmarkDecls, stmtProbe, verifyStatement, stripProbeOutput } from "../runner/grade.js";
import { postCheck } from "../runner/common.js";

const CLIENT_TIMEOUT_MS = 30 * 60_000; // server queue is serialized; be patient

export default function (pi: ExtensionAPI) {
  // Hash of problem.lean at the last check that returned a result. Lets the tool
  // flag "you re-checked without changing the file" — the observation the
  // putnam_1965_b6 agent needed to escape its wrong-path loop.
  let lastCheckedHash: string | null = null;

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
        // The statement probe rides on the same check request; its CMPSTMT output is
        // stripped from what the agent sees.
        const origPath = process.env.CMP_ORIGINAL_FILE;
        const origSource = origPath && existsSync(origPath) ? readFileSync(origPath, "utf8") : null;
        const probe = origSource ? `\n${stmtProbe(benchmarkDecls(origSource))}\n` : "";
        const code = readFileSync(src, "utf8");
        const hash = createHash("md5").update(code).digest("hex").slice(0, 12);
        const r = (await postCheck({ code: code + probe }, CLIENT_TIMEOUT_MS)) as any;
        // A tampered statement is reported as a FAILED check, not a footnote after
        // "compiled successfully" — weak models skim past appended warnings.
        let text = stripProbeOutput(r.pretty) || "no output";
        let ok = r.ok;
        if (origSource) {
          const stmt = await verifyStatement(basename(origPath!, ".lean"), origSource, r.messages);
          if (!stmt.ok) {
            ok = false;
            text =
              `CHECK FAILED: you modified the theorem statement (${stmt.detail}). ` +
              `Proofs of a modified statement do not count. Restore the original statement — ` +
              `you may only add helper lemmas above it and fill in sorries.\n\nCompiler output:\n${text}`;
          }
        }
        // Identify exactly what was graded, so a path mixup (agent editing a file
        // this tool never sees) can't survive: the header pins the file, and the
        // unchanged note fires when the agent re-checks without touching it.
        let header = `checked ${src} (${Buffer.byteLength(code)} bytes, md5 ${hash})`;
        if (hash === lastCheckedHash) {
          header +=
            `\nNOTE: this file is byte-identical to your previous lean_check — ` +
            `if you meant to change it, your edit did not reach ${src}.`;
        }
        lastCheckedHash = hash;
        text = `${header}\n\n${text}`;
        return { content: [{ type: "text", text }], details: { ok, cached: r.cached }, isError: r.error != null };
      } catch (e: any) {
        // "try again" only for genuinely transient faults — a permanent error phrased
        // as transient sends weak models into a check-spam loop (seen: 406 calls).
        const msg = String(e?.message ?? e);
        const transient = /timed out|unreachable|ECONN|socket|fetch failed|REPL|respond/i.test(msg);
        const advice = transient
          ? "— transient, try again"
          : "— this is an internal error and retrying will NOT fix it; continue improving the file without this check and mention the error in your final message";
        return { content: [{ type: "text", text: `lean_check unavailable (${msg}) ${advice}` }], isError: true };
      }
    },
  });
}
