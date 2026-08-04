// @tools submit_verdict
// Triage arm (PLAN.md, off the hill-climb): the judge's one extra tool. Calling it
// records the verdict and ends the session (`terminate`); the harness side
// (runner/triage.js) also watches for the verdict file and stops the process, so the
// session ends even if an older pi ignores the terminate flag.
//
// The agent-facing contract is deliberately tiny: submit when settled, yes or no,
// with a reason. No scrutiny mandates, no method steering, no budget language —
// whether quick verdicts are calibrated IS the measurement. The only harness presence
// is a fixed, content-free reminder if the judge ends its turn without a verdict
// (max 3, same shape as the supervisor's nudge cap), protecting the attempt from
// evaporating into an unsubmitted essay without pushing the decision either way.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

export default function (pi: ExtensionAPI) {
  const verdictPath = join(process.cwd(), "verdict.json");
  let submitted = false;
  let reminders = 0;

  pi.registerTool({
    name: "submit_verdict",
    label: "Submit verdict",
    description:
      "Submit your final verdict and end the task. verdict is \"yes\" if you judge the theorem " +
      "provable in this environment, \"no\" if not; reason is a short justification, recorded " +
      "with the verdict. This is the only way to finish the task.",
    parameters: Type.Object({
      verdict: Type.Union([Type.Literal("yes"), Type.Literal("no")], {
        description: "Your verdict: yes (provable in this environment) or no",
      }),
      reason: Type.String({ description: "Short justification — what settled it" }),
    }),
    async execute(_toolCallId, params) {
      writeFileSync(verdictPath, JSON.stringify({ verdict: params.verdict, reason: params.reason, reminders }));
      submitted = true;
      return {
        content: [{ type: "text", text: "Verdict recorded. The task is complete." }],
        details: { verdict: params.verdict },
        terminate: true,
      };
    },
  });

  pi.on("agent_end", () => {
    if (submitted || reminders >= 3) return;
    if (existsSync(join(process.cwd(), "..", "STOP"))) return;
    reminders++;
    try {
      pi.sendUserMessage("When your verdict is settled, submit it with submit_verdict.", { deliverAs: "followUp" });
    } catch {}
  });
}
