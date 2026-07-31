// @tools lean_check
// Always-on tool: compile the agent's problem.lean against Mathlib and report errors.
// Checks go to the persistent lean server (runner/lean-server.js), which keeps Mathlib
// resident so a check takes seconds instead of a full olean reload. All compile +
// statement-verdict plumbing lives in runner/stmt.js (checkedCompile) — shared with
// plan_check, so agent-facing checks can never drift from the grader.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { createHash } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import { join, basename } from "node:path";
import { checkedCompile } from "../runner/stmt.js";
import { cmpConfig, ToolFailure } from "../runner/common.js";

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
      "This tool takes no arguments and only ever compiles problem.lean — it cannot see any other file. " +
      "This is the ground truth for whether your proof is accepted.",
    promptSnippet: "lean_check - compile problem.lean (the only file ever compiled) and get Lean compiler errors/warnings",
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, signal, _onUpdate, ctx) {
      // Failures THROW; pi ignores the isError field of a returned result (see
      // ToolFailure in runner/common.js). A compile that FAILS is not a tool
      // failure — it is this tool's normal output and still returns normally.
      const src = join(ctx.cwd, "problem.lean");
      if (!existsSync(src)) {
        throw new ToolFailure("error: problem.lean not found in working directory");
      }
      const origPath = cmpConfig().original_file;
      if (!origPath || !existsSync(origPath)) {
        throw new ToolFailure("lean_check unavailable: original problem file not configured");
      }
      try {
        const problemName = basename(origPath, ".lean");
        const code = readFileSync(src, "utf8");
        const hash = createHash("md5").update(code).digest("hex").slice(0, 12);
        // Connection-level failures (server dead, mid-restart) are retried HERE,
        // inside the tool, where waiting costs zero tokens. Bouncing the error to
        // the model instead costs a full turn per retry — with the whole growing
        // context re-billed as input — and a dead server turns that into an hours-
        // long paid spiral (2026-07-26: ~70 min x 10 agents of ECONNREFUSED loops).
        // Typed server responses (check_timeout, crash) are NOT retried; only
        // throws where no server response arrived at all.
        const deadline = Date.now() + 5 * 60_000;
        let r: any;
        for (;;) {
          try {
            r = (await checkedCompile(code, {
              original: readFileSync(origPath, "utf8"),
              problemName,
              client: problemName,
            })) as any;
            break;
          } catch (e: any) {
            const connErr = /ECONNREFUSED|ECONNRESET|EPIPE|socket hang up/i.test(`${e?.code ?? ""} ${e?.message ?? ""}`);
            if (!connErr || signal?.aborted || Date.now() + 10_000 > deadline) throw e;
            await new Promise((res) => setTimeout(res, 10_000));
          }
        }

        if (r.error) {
          // The server classifies its own failures. A check the REPL watchdog killed
          // is DETERMINISTIC for that file — "try again" wording on it sends weak
          // models into a check-spam loop (seen: 406 calls) while each retry burns
          // minutes of the shared serialized REPL.
          const text =
            r.kind === "check_timeout"
              ? `lean_check gave up: ${r.error}. This outcome is deterministic for this exact file — ` +
                `your proof relies on tactics too expensive to check (heavy \`decide\`, huge \`interval_cases\`/\`simp\` searches, ...). ` +
                `Retrying the unchanged file WILL fail the same way; simplify the expensive step instead.`
              : `lean_check unavailable (${r.error}) — transient, try again`;
          throw new ToolFailure(text);
        }

        // Policy rejection (banned construct); the file was not compiled.
        if (r.rejected) {
          return { content: [{ type: "text", text: r.pretty }], details: { ok: false, rejected: r.rejected }, isError: false };
        }

        // A tampered statement is reported as a FAILED check, not a footnote after
        // "compiled successfully" — weak models skim past appended warnings.
        let text = r.pretty || "no output";
        let ok = r.ok;
        if (!r.stmt.ok) {
          ok = false;
          text =
            `CHECK FAILED: you modified the theorem statement (${r.stmt.detail}). ` +
            `Proofs of a modified statement do not count. Restore the original statement — ` +
            `you may only add helper lemmas above it and fill in sorries.\n\nCompiler output:\n${text}`;
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
        return { content: [{ type: "text", text }], details: { ok, cached: r.cached }, isError: false };
      } catch (e: any) {
        // Thrown = the request never got a server response (connection refused mid-
        // restart, client-side socket error) — genuinely transient, unlike the typed
        // error responses handled above. A ToolFailure is already classified (the
        // typed-error branch above): rethrow it rather than relabel it "transient".
        if (e instanceof ToolFailure) throw e;
        throw new ToolFailure(`lean_check unavailable (${String(e?.message ?? e)}) — transient, try again`);
      }
    },
  });
}
