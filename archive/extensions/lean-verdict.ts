// @tools submit_verdict
// submit_verdict: records a yes/no verdict and ends the session; reminds up to 3 times if none was submitted.

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
    description: "Submit your answer and end the task. This is the only way to finish.",
    parameters: Type.Object({
      verdict: Type.Union([Type.Literal("yes"), Type.Literal("no")], {
        description: "Your answer: yes or no",
      }),
      reason: Type.String({ description: "Your reason, briefly" }),
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
      pi.sendUserMessage("Answer with submit_verdict.", { deliverAs: "followUp" });
    } catch {}
  });
}
