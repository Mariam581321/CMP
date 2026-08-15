// @tools
// Dev instrument, never part of an arm and never loaded by a run: dumps the EXACT
// provider payload of the FIRST request — system prompt, messages, tool schemas, as the
// model receives them — to $CMP_DUMP_VIEW, then exits. The exit happens inside
// before_provider_request, i.e. before the request leaves the process, so inspecting a
// view costs zero tokens and zero dollars.
//
// Reading the payload rather than reconstructing it is the whole point: the prompt this
// harness writes is not the prompt the model sees (pi appends its own trailer to a
// custom system prompt, and tool descriptions live in the extensions, not here). Used by
// `runner/triage.js --print-view`.

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
