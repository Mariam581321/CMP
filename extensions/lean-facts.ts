// @tools add_fact
// Append-only fact bank: add_fact admits code only if it compiles cleanly; direct write/edit is blocked.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { resolve, join, basename } from "node:path";
import { addFact } from "../runner/facts.js";
import { cmpConfig, ToolFailure } from "../runner/common.js";

export default function (pi: ExtensionAPI) {
  const cfg = cmpConfig();
  const factsFile: string = cfg.facts_file ?? join(process.cwd(), "facts.lean");
  const bankName = basename(factsFile);
  const client: string = cfg.problem ?? "anon";
  const isWorker = cfg.worker != null;
  const hasSpawn = (cfg.tools ?? []).includes("spawn_subagents");

  pi.on("tool_call", (event) => {
    if (event.toolName !== "write" && event.toolName !== "edit") return;
    const p = (event.input as { path?: unknown }).path;
    if (typeof p !== "string") return;
    if (resolve(process.cwd(), p) === resolve(factsFile))
      return {
        block: true,
        reason:
          `blocked: ${bankName} is the append-only fact bank, written only through add_fact ` +
          "(the compiler gate is what makes its contents trustworthy). Read it freely; to add to it, call add_fact.",
      };
  });

  pi.registerTool({
    name: "add_fact",
    label: "Add fact",
    description:
      `Add verified Lean declarations to the shared fact bank (${bankName}). The code is ` +
      "compiled with Mathlib and the current bank in scope, and admitted only if it has no " +
      "errors, no `sorry`, and no axioms beyond propext/Classical.choice/Quot.sound — so " +
      "everything in the bank is machine-verified and can be used without re-checking. " +
      "The bank is append-only and shared: facts you add are immediately in scope for " +
      (isWorker
        ? "your own and everyone else's check_snippet calls (the main agent and the other workers see them too). "
        : hasSpawn
          ? "check_snippet for you and for any workers you spawn. "
          : "your check_snippet calls. ") +
      "Facts may freely use earlier bank facts by name. Rejected code returns the compiler " +
      "output and changes nothing. Submit named lemma/theorem/def/abbrev/instance declarations " +
      "only — no `axiom`, no metaprogramming, nothing `private`. " +
      (isWorker
        ? "The bank contents at your start are in your instructions; additions since then are in scope even though you cannot see their text."
        : "problem.lean is still graded standalone: before finishing, copy every bank fact your final proof uses (proofs included, plus the bank facts they depend on) above the theorem."),
    parameters: Type.Object({
      code: Type.String({
        description:
          "Lean 4 source: one or more named declarations (Mathlib and the current bank are in scope; close every namespace/section you open)",
      }),
    }),
    async execute(_toolCallId, params, signal) {
      try {
        const deadline = Date.now() + 5 * 60_000;
        let r: any;
        for (;;) {
          try {
            r = (await addFact(params.code, { factsFile, client, blockedNames: cfg.blocked_names ?? null })) as any;
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
              ? `add_fact could not compile this fact: ${r.pretty ?? r.error}`
              : `add_fact unavailable (${r.error}) — transient, try again`;
          throw new ToolFailure(text);
        }
        return { content: [{ type: "text", text: r.pretty }], details: { ok: r.ok, names: r.names ?? null }, isError: false };
      } catch (e: any) {
        if (e instanceof ToolFailure) throw e;
        throw new ToolFailure(`add_fact unavailable (${String(e?.message ?? e)}) — transient, try again`);
      }
    },
  });
}
