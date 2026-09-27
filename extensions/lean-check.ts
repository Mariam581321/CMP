// @tools lean_check
// Always-on tool: compile the agent's problem.lean against Mathlib and report errors.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { createHash } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import { join, basename } from "node:path";
import { checkedCompile } from "../runner/stmt.js";
import { cmpConfig, costStd, workerSpendStd, ToolFailure } from "../runner/common.js";
import { checkStatus, blockerNotes } from "../runner/verdict.js";
import { recordHighWater } from "../runner/highwater.js";

export default function (pi: ExtensionAPI) {
  let lastCheckedHash: string | null = null;

  const cfg = cmpConfig();
  const isWorker = cfg.worker != null;
  let checkIndex = 0;
  let turns = 0;
  const tokens = { in: 0, out: 0, cache_read: 0 };
  pi.on("message_end", (event: any) => {
    const m = event.message;
    if (m?.role !== "assistant") return;
    turns++;
    const u = m.usage;
    if (!u) return;
    tokens.in += u.input ?? 0;
    tokens.out += u.output ?? 0;
    tokens.cache_read += u.cacheRead ?? 0;
  });

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
      checkIndex++;
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
        // Retry connection-level failures (no server response) for up to 5 minutes.
        const deadline = Date.now() + 5 * 60_000;
        let r: any;
        for (;;) {
          try {
            r = (await checkedCompile(code, {
              original: readFileSync(origPath, "utf8"),
              problemName,
              client: problemName,
              workDir: ctx.cwd,
            })) as any;
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
              ? `lean_check could not compile this file: ${r.pretty}`
              : `lean_check unavailable (${r.error}) — transient, try again`;
          throw new ToolFailure(text);
        }

        // Policy rejection: the file was not compiled.
        if (r.rejected) {
          return { content: [{ type: "text", text: r.pretty }], details: { ok: false, rejected: r.rejected }, isError: false };
        }

        const status = checkStatus(r);
        const notes = blockerNotes(status).map((n: string) => `CHECK FAILED: ${n}`);
        let text = r.pretty || "no output";
        if (notes.length) text = `${notes.join("\n\n")}\n\nCompiler output:\n${text}`;
        let header = `checked ${src} (${Buffer.byteLength(code)} bytes, md5 ${hash})`;
        if (hash === lastCheckedHash) {
          header +=
            `\nNOTE: this file is byte-identical to your previous lean_check — ` +
            `if you meant to change it, your edit did not reach ${src}.`;
        }
        lastCheckedHash = hash;
        text = `${header}\n\n${text}`;

        // Record the solved high-water mark.
        if (!isWorker && status.done) {
          recordHighWater(join(ctx.cwd, ".."), code, {
            check_index: checkIndex,
            turn: turns,
            cost_std: +(costStd(tokens) + workerSpendStd(cfg, ctx.cwd)).toFixed(5),
          });
        }
        return {
          content: [{ type: "text", text }],
          details: {
            ok: status.compiles && !status.stmtBad && !status.axBad,
            done: status.done,
            sorries: status.sorries.length,
            cached: r.cached,
            full_bytes: r.full?.length ?? null,
            cut: (r.pretty ?? "").includes("[... errors truncated"),
          },
          isError: false,
        };
      } catch (e: any) {
        if (e instanceof ToolFailure) throw e;
        throw new ToolFailure(`lean_check unavailable (${String(e?.message ?? e)}) — transient, try again`);
      }
    },
  });
}
