// Config knob, not an arm. pi's agent loop never sends max_tokens, so the provider's
// server-side default output cap applies (DeepSeek: 8192/response). This extension
// injects max_tokens into the raw provider payload via the before_provider_request
// hook, from the runner's --max-tokens flag (CMP_MAX_TOKENS env). The runner now always
// passes a cap — model max by default, so the 8k server default never silently applies;
// a tight cap (e.g. 8192) exists only as a manipulated factor in capped experiment cells.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  const cap = parseInt(process.env.CMP_MAX_TOKENS ?? "0", 10);
  if (!(cap > 0)) return;
  pi.on("before_provider_request", (event: any) => {
    return { ...event.payload, max_tokens: cap };
  });
}
