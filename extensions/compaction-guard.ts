// Retries a failed compaction: first drops errored/aborted assistant messages, then caps long blocks.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const CAP = 16000;

const clip = (s: string, cap: number) => `${s.slice(0, cap)}\n\n[... ${s.length - cap} characters truncated]`;

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
  // session_before_compact firings since the last successful compaction.
  let tries = 0;
  const log = (...a: any[]) => console.error("[compaction-guard]", ...a);

  pi.on("session_compact", () => {
    tries = 0;
  });

  pi.on("session_before_compact", (event: any) => {
    tries++;
    if (tries < 2) return undefined;
    const prep = event?.preparation;
    if (!prep) return undefined;
    const lists = [prep.messagesToSummarize, prep.turnPrefixMessages].filter(Array.isArray);

    const protect = lists.every((l) => l.every(isDead)) ? lastMessage(lists) : null;

    const dead = lists.reduce(
      (acc, l) => {
        const r = dropDead(l, protect);
        return { n: acc.n + r.n, bytes: acc.bytes + r.bytes };
      },
      { n: 0, bytes: 0 },
    );
    if (dead.n > 0) log(`try ${tries}: dropped ${dead.n} errored/aborted messages (${dead.bytes} chars)`);

    if (protect) {
      const cap = tries >= 3 ? tighten(tries) : CAP;
      const n = lists.reduce((acc, l) => acc + capLong(l, cap), 0);
      log(`try ${tries}: every message was dead — kept the newest, capped ${n} at ${cap} chars`);
      return undefined;
    }

    if (tries >= 3) {
      const cap = tighten(tries);
      const n = lists.reduce((acc, l) => acc + capLong(l, cap), 0);
      log(`try ${tries}: capped thinking/tool-call args at ${cap} chars in ${n} messages`);
    }
    return undefined;
  });
}
