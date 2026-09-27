// Sets max_tokens on each provider request to the room left in the context window, clamped to [FLOOR, --max-tokens].

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { cmpConfig } from "../runner/common.js";

const FLOOR = 131072;
const SLACK = 4096;

export default function (pi: ExtensionAPI) {
  const ceiling = cmpConfig().max_tokens ?? 0;
  if (!(ceiling > 0)) return;
  const floor = Math.min(ceiling, FLOOR);
  pi.on("before_provider_request", (event: any, ctx: any) => {
    let cap = ceiling;
    const usage = ctx.getContextUsage?.();
    if (usage && usage.tokens !== null && usage.contextWindow > 0) {
      cap = Math.max(floor, Math.min(ceiling, usage.contextWindow - usage.tokens - SLACK));
    }
    return { ...event.payload, max_tokens: cap };
  });
}
