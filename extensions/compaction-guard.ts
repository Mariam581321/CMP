// Rescue for compaction's one self-defeating case: the request pi sends to SHRINK the
// context can be larger than the context it is shrinking, and then it is refused too.
//
// pi builds the summarization payload from the raw session branch (compaction.ts,
// prepareCompaction -> getMessageFromEntryForCompaction -> sessionEntryToContextMessages,
// which filters nothing), and serializeConversation truncates ONLY tool results
// (TOOL_RESULT_MAX_CHARS = 2000) — assistant thinking and tool-call arguments go in
// verbatim. But every LIVE provider request drops assistant messages with stopReason
// error/aborted (pi-ai transform-messages.ts, "Skip errored/aborted assistant messages").
// So a stream that dies inside a write leaves a 500-700 KB partial file that the model
// never saw on any turn and cannot act on, yet the summarizer still pays full price for
// it. Measured over the 500 attempts that reached the wall: this dead weight is a median
// of 0 bytes on the ones that recovered, and 1.47 MB (up to 9.79 MB, 4.7x their live
// context) on the ones that did not.
//
// When it tips the summarization request over the window the failure is silent in every
// channel this harness records: auto-compaction failures are emitted as an in-process
// compaction_end event only (agent-session.ts), --mode text renders none of it, and
// nothing is appended to the session .jsonl. The only trace is an extra 400 in
// stderr.log. Compaction then never happens, the supervisor reads stopReason "error" as
// transport death and nudges, every nudge makes an already-inadmissible context larger,
// and the attempt dies at max_error_streak recorded as end=completed with budget
// unspent. 14 attempts across the corpus, 10 of them base.
//
// Two properties are deliberate:
//
// (1) It does NOTHING until pi has already tried and failed. session_before_compact
//     fires per attempt, session_compact only on success, so a second firing with no
//     success in between IS pi's own path failing. Everything that compacts today
//     compacts identically tomorrow — the handler returns undefined on the first
//     firing, every firing, forever, unless recovery is already broken. The cost of
//     waiting is one wasted cycle instead of twenty.
//
// (2) It never writes the summary itself. It sanitises `preparation` in place and lets
//     pi summarise — same prompts, same model, same auth, same cut point — so a rescued
//     compaction stays comparable with the ones that never needed rescuing, and this
//     file cannot drift from pi's summarization contract.
//
// Escalates only as far as it must: drop the dead messages first (rescues 12 of the 14),
// and only if pi fails AGAIN cap the two channels serializeConversation leaves
// uncapped. Capping is arm-neutral by construction — thinking is ~2/3 of the payload in
// every arm (67% with grep_mathlib, 66% without).

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// Same budget as every other digest the harness caps (runner/render.js RENDER_CAP).
const CAP = 16000;

const clip = (s: string, cap: number) => `${s.slice(0, cap)}\n\n[... ${s.length - cap} characters truncated]`;

// Each further failure halves the cap, never below 1000.
const tighten = (tries: number) => Math.max(1000, Math.floor(CAP / 2 ** (tries - 3)));

const isDead = (m: any) => m?.role === "assistant" && (m.stopReason === "error" || m.stopReason === "aborted");

const bytes = (m: any): number => {
  let n = 0;
  for (const b of m?.content ?? []) {
    if (b?.type === "text") n += b.text?.length ?? 0;
    else if (b?.type === "thinking") n += b.thinking?.length ?? 0;
    else if (b?.type === "toolCall") n += JSON.stringify(b.arguments ?? {}).length;
  }
  return n;
};

// Safe to splice: prepareCompaction builds these arrays fresh for this one call. NOT
// safe to mutate the messages inside them — those are the session's own objects, shared
// with the live context and the session file — so capping replaces the slot with a copy.
function dropDead(list: any[], protect: any): { n: number; bytes: number } {
  let n = 0;
  let b = 0;
  for (let i = list.length - 1; i >= 0; i--) {
    if (!isDead(list[i]) || list[i] === protect) continue;
    b += bytes(list[i]);
    list.splice(i, 1);
    n++;
  }
  return { n, bytes: b };
}

// The one state the drop must never create. prepareCompaction refuses to return a
// preparation with both lists empty, so compact() does not defend against it: off the
// split-turn path it hands the empty array straight to generateSummary, which summarises
// an empty <conversation> and then appendCompaction replaces real history with that
// nothing. Reachable exactly where this guard lives — a turn that begins at the previous
// compaction boundary (messagesToSummarize legitimately empty) and blows the window on
// one giant partial write (turnPrefixMessages = that one dead message). So when every
// message in both lists is dead, keep the most recent one and let capping shrink it
// instead; a summary of one clipped message is honest, a summary of nothing is not.
const lastMessage = (lists: any[][]) => {
  for (let i = lists.length - 1; i >= 0; i--) {
    const l = lists[i];
    if (l.length) return l[l.length - 1];
  }
  return null;
};

function capLong(list: any[], cap: number): number {
  let n = 0;
  for (let i = 0; i < list.length; i++) {
    const m = list[i];
    if (m?.role !== "assistant" || !Array.isArray(m.content)) continue;
    let touched = false;
    const content = m.content.map((b: any) => {
      if (b?.type === "thinking" && (b.thinking?.length ?? 0) > cap) {
        touched = true;
        return { ...b, thinking: clip(b.thinking, cap) };
      }
      if (b?.type === "text" && (b.text?.length ?? 0) > cap) {
        touched = true;
        return { ...b, text: clip(b.text, cap) };
      }
      if (b?.type === "toolCall" && b.arguments && typeof b.arguments === "object") {
        let argsTouched = false;
        const args: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(b.arguments)) {
          if (typeof v === "string" && v.length > cap) {
            args[k] = clip(v, cap);
            argsTouched = true;
          } else args[k] = v;
        }
        if (argsTouched) {
          touched = true;
          return { ...b, arguments: args };
        }
      }
      return b;
    });
    if (touched) {
      list[i] = { ...m, content };
      n++;
    }
  }
  return n;
}

export default function (pi: ExtensionAPI) {
  // Firings of session_before_compact since the last successful compaction. 1 = pi's
  // first try, still untouched. >=2 = pi's path has demonstrably failed at least once.
  let tries = 0;
  const log = (...a: any[]) => console.error("[compaction-guard]", ...a);

  pi.on("session_compact", () => {
    tries = 0;
  });

  pi.on("session_before_compact", (event: any) => {
    tries++;
    if (tries < 2) return undefined; // pi's own path, byte for byte
    const prep = event?.preparation;
    if (!prep) return undefined;
    const lists = [prep.messagesToSummarize, prep.turnPrefixMessages].filter(Array.isArray);

    // Nothing live anywhere: hold back the newest message so the payload cannot go empty.
    const protect = lists.every((l) => l.every(isDead)) ? lastMessage(lists) : null;

    const dead = lists.reduce(
      (acc, l) => {
        const r = dropDead(l, protect);
        return { n: acc.n + r.n, bytes: acc.bytes + r.bytes };
      },
      { n: 0, bytes: 0 },
    );
    if (dead.n > 0) log(`try ${tries}: dropped ${dead.n} errored/aborted messages (${dead.bytes} chars)`);

    // The held-back message is the giant one by construction, and dropping is off the
    // table for it, so cap on this firing rather than burning another cycle to get there.
    if (protect) {
      const cap = tries >= 3 ? tighten(tries) : CAP;
      const n = lists.reduce((acc, l) => acc + capLong(l, cap), 0);
      log(`try ${tries}: every message was dead — kept the newest, capped ${n} at ${cap} chars`);
      return undefined;
    }

    // Still failing with the dead weight gone (or there was none): cap what pi's
    // serializer leaves uncapped, tightening on each further failure.
    if (tries >= 3) {
      const cap = tighten(tries);
      const n = lists.reduce((acc, l) => acc + capLong(l, cap), 0);
      log(`try ${tries}: capped thinking/tool-call args at ${cap} chars in ${n} messages`);
    }
    return undefined; // pi summarises the sanitised payload
  });
}
