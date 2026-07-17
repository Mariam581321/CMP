// Config knob, not an arm. pi's agent loop never sends max_tokens, so the provider's
// server-side default output cap applies (DeepSeek: 8192/response). This extension
// injects max_tokens into the raw provider payload via the before_provider_request
// hook. Enabled by the runner's --max-tokens <n> flag (CMP_MAX_TOKENS env).

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  const cap = parseInt(process.env.CMP_MAX_TOKENS ?? "0", 10);
  if (!(cap > 0)) return;
  pi.on("before_provider_request", (event: any) => {
    return { ...event.payload, max_tokens: cap };
  });
}
