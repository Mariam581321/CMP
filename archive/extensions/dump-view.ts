// @tools
// Dumps the first provider request payload to $CMP_DUMP_VIEW, then exits before sending it.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { writeFileSync } from "node:fs";

export default function (pi: ExtensionAPI) {
  const out = process.env.CMP_DUMP_VIEW;
  if (!out) return;
  pi.on("before_provider_request", (event: any) => {
    try {
      writeFileSync(out, JSON.stringify(event.payload, null, 2));
    } catch {}
    process.exit(0);
  });
}
