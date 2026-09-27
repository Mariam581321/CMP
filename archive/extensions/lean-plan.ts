// @tools plan_check
// plan_check: checks problem.lean is a plan (compiles, statement intact, sorries only in helper lemmas).

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from "node:fs";
import { join, basename } from "node:path";
import { planCheck } from "../runner/plan.js";
import { cmpConfig, ToolFailure } from "../runner/common.js";

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
        throw new ToolFailure("error: problem.lean not found in working directory");
      }
      const origPath = cmpConfig().original_file;
      if (!origPath || !existsSync(origPath)) {
        throw new ToolFailure("plan_check unavailable: original problem file not configured");
      }
      try {
        const solution = readFileSync(src, "utf8");
        const r = await planCheck(readFileSync(origPath, "utf8"), solution, basename(origPath, ".lean"));
        let hadGreen = false;
        try {
          const plansDir = join(ctx.cwd, "..", "plans");
          mkdirSync(plansDir, { recursive: true });
          const prior = readdirSync(plansDir).filter((f) => /^plan-\d+-(green|red)\.lean$/.test(f));
          hadGreen = prior.some((f) => f.endsWith("-green.lean"));
          writeFileSync(join(plansDir, `plan-${String(prior.length + 1).padStart(2, "0")}-${r.ok ? "green" : "red"}.lean`), solution);
        } catch {}
        if ((r as any).isError === true) throw new ToolFailure(r.text);
        let text = r.text;
        if (!r.ok && hadGreen) {
          text +=
            "\n\nNote: your plan already passed plan_check earlier — the planning phase is done. " +
            "If you are now filling in helper proofs, use lean_check to compile; call plan_check " +
            "again only after deliberately revising the skeleton.";
        }
        return { content: [{ type: "text", text }], details: { ...r.details, had_green: hadGreen } };
      } catch (e: any) {
        if (e instanceof ToolFailure) throw e;
        throw new ToolFailure(`plan_check temporarily unavailable (${e?.message ?? e}) — try again`);
      }
    },
  });
}
