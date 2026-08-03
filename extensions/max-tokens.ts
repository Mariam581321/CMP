// Config knob, not an arm. pi's agent loop never sends max_tokens, so the provider's
// server-side default output cap applies (DeepSeek: 8192/response). This extension
// injects max_tokens into the raw provider payload via the before_provider_request
// hook, from the runner's --max-tokens flag (CMP_CONFIG). The runner always passes a
// cap, so the 8k server default never silently applies; a tight cap (e.g. 8192) exists
// only as a manipulated factor in capped experiment cells.
//
// The cap is an ADMISSION cost, not just an output bound: DeepSeek accepts a request
// only if prompt_tokens + max_tokens <= the context limit, so every token reserved here
// is a token the conversation cannot use. A flat model-max cap (384000) capped usable
// conversation at 1048576 - 384000 = 664576 and 400'd every request past it
// (fatex_64/_91/_95/_97, 2026-08-02) while buying nothing that run ever used: across
// its 19867 assistant messages ZERO hit the limit, p99 output was 22016 and the largest
// ever produced was 122423.
//
// So the injected value is dynamic: each request offers the model ALL the room that
// physically exists — clamp(window - estimated context - SLACK, FLOOR, ceiling) — where
// the ceiling is the --max-tokens flag (default: the 384000 model max). The estimate
// (ctx.getContextUsage(): last real usage + chars/4 for trailing messages) does not
// need to be accurate, because both failure directions are benign. Overestimate, and
// the cap shrinks toward FLOOR earlier than necessary — still above the largest output
// ever observed. Underestimate, and the request is refused at admission: a 400 rejected
// before inference (usage 0/0/0, cost 0, ~2.5 s) that IS the intended compaction
// trigger — pi's overflow recovery strips the error from context, compacts, retries
// (agent-session.ts, _overflowRecoveryAttempted), and the cycle repeats for as long as
// the attempt runs. fatex-rest90 hit this wall 42 times across 100 problems: one 400,
// one compaction, straight back to work, every time.
//
// FLOOR exists because refusal is the wanted outcome and truncation the worse one: a
// truncated message WAS admitted, and pi voids every tool call in it and immediately
// re-requests (agent-loop.js, failToolCallsFromTruncatedMessage, terminate:false) with
// the cut-off prefix and the error results now added to context — so the retry has less
// room and truncates sooner. FLOOR = 131072 sits just above the 122423 maximum: once
// the window cannot fit it, the request 400s instead of squeezing the model.
//
// Edge cases that fall out correctly: right after compaction getContextUsage() reports
// tokens: null (no post-compaction usage yet) and the cap falls back to the full
// ceiling — safe, post-compaction context is ~keepRecentTokens + summary. Capped cells
// are untouched by the dynamics: floor = min(ceiling, FLOOR), so --max-tokens 8192
// clamps to exactly 8192 on every request, identical to the flat scheme.

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
