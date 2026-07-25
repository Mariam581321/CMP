// Arm 1 (plan): explicit plan artifact. Registers `plan_check`, which validates that
// problem.lean is currently a *plan*: compiles, statement preserved, and every `sorry`
// lies outside the benchmark declarations (only helper lemmas may be sorry'd).
// Soft gate: lean_check never refuses anything; planning stays observable in tool_calls.
// Every checked plan is snapshotted to ../plans/ (outside the agent's cwd) so plans can
// be judged post-hoc (real decomposition vs restated theorem).

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from "node:fs";
import { join, basename } from "node:path";
import { planCheck } from "../runner/plan.js";

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "plan_check",
    label: "Plan check",
    description:
      "Verify that problem.lean is currently a valid PLAN: it compiles, the theorem statement " +
      "is unmodified, and every `sorry` is in a helper lemma — the main theorem's proof (and any " +
      "_solution abbrev) is complete in terms of those helpers. A green plan_check means the " +
      "compiler has verified that your helper lemmas suffice to prove the theorem. " +
      "This is a planning-phase tool, not a general compile checker — while filling in helper " +
      "proofs, use lean_check.",
    promptSnippet: "plan_check - verify problem.lean is a valid plan (compiling skeleton, sorries only in helper lemmas)",
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      const src = join(ctx.cwd, "problem.lean");
      if (!existsSync(src)) {
        return { content: [{ type: "text", text: "error: problem.lean not found in working directory" }], isError: true };
      }
      const origPath = process.env.CMP_ORIGINAL_FILE;
      if (!origPath || !existsSync(origPath)) {
        return { content: [{ type: "text", text: "plan_check unavailable: original problem file not configured" }], isError: true };
      }
      try {
        const solution = readFileSync(src, "utf8");
        const r = await planCheck(readFileSync(origPath, "utf8"), solution, basename(origPath, ".lean"));
        // Snapshot every checked plan; index derived from disk so it survives the
        // runner's nudge-respawns. Green-snapshot existence doubles as cross-process
        // "planning phase already succeeded" state.
        let hadGreen = false;
        try {
          const plansDir = join(ctx.cwd, "..", "plans");
          mkdirSync(plansDir, { recursive: true });
          const prior = readdirSync(plansDir).filter((f) => /^plan-\d+-(green|red)\.lean$/.test(f));
          hadGreen = prior.some((f) => f.endsWith("-green.lean"));
          writeFileSync(join(plansDir, `plan-${String(prior.length + 1).padStart(2, "0")}-${r.ok ? "green" : "red"}.lean`), solution);
        } catch {}
        let text = r.text;
        if (!r.ok && hadGreen && (r as any).isError !== true) {
          text +=
            "\n\nNote: your plan already passed plan_check earlier — the planning phase is done. " +
            "If you are now filling in helper proofs, use lean_check to compile; call plan_check " +
            "again only after deliberately revising the skeleton.";
        }
        return { content: [{ type: "text", text }], details: { ...r.details, had_green: hadGreen }, isError: (r as any).isError === true };
      } catch (e: any) {
        return { content: [{ type: "text", text: `plan_check temporarily unavailable (${e?.message ?? e}) — try again` }], isError: true };
      }
    },
  });
}
