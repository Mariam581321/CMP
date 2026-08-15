// Probe extensions/compaction-guard.ts — the REAL module under --experimental-strip-types,
// driven by a fake pi, plus a replay against a session that actually died this way.
//
// Two properties carry the whole design and both are pinned here:
//   - the guard is a strict no-op until pi's own compaction has already failed once, so
//     the ~490 compactions that work today are untouched (a/d below);
//   - it sanitises preparation IN PLACE but never mutates the session's own message
//     objects, which are shared with the live context and the session file (c below).
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync, readdirSync, existsSync } from "node:fs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");

let failed = 0;
function check(name, cond, detail = "") {
  if (cond) console.log(`ok   ${name}`);
  else { failed++; console.log(`FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
}

const { default: guard } = await import(join(ROOT, "extensions", "compaction-guard.ts"));

function boot() {
  const handlers = {};
  guard({ on: (e, h) => { (handlers[e] ??= []).push(h); } });
  const emit = async (e, ev) => { for (const h of handlers[e] ?? []) await h(ev); };
  return { emit };
}

const live = (text, stop = "toolUse") => ({ role: "assistant", stopReason: stop, content: [{ type: "text", text }] });
const dead = (n, stop = "error") => ({
  role: "assistant", stopReason: stop,
  content: [{ type: "toolCall", name: "write", arguments: { path: "problem.lean", content: "x".repeat(n) } }],
});
const prep = (msgs, prefix = []) => ({ messagesToSummarize: msgs, turnPrefixMessages: prefix, firstKeptEntryId: "k", tokensBefore: 1 });

// (a) first firing is a strict no-op
{
  const { emit } = boot();
  const p = prep([live("a"), dead(500_000), live("b")]);
  const before = JSON.stringify(p);
  await emit("session_before_compact", { preparation: p });
  check("a: first firing leaves preparation untouched", JSON.stringify(p) === before);
}

// (b) second firing drops errored/aborted, keeps live messages and their order
{
  const { emit } = boot();
  const p = prep([live("a"), dead(500_000), live("b"), dead(9_000, "aborted")], [live("c"), dead(700_000)]);
  await emit("session_before_compact", { preparation: p });
  await emit("session_before_compact", { preparation: p });
  check("b: dead messages dropped from both lists",
    p.messagesToSummarize.length === 2 && p.turnPrefixMessages.length === 1,
    `${p.messagesToSummarize.length}/${p.turnPrefixMessages.length}`);
  check("b: live messages survive in order",
    p.messagesToSummarize.map((m) => m.content[0].text).join("") === "ab" &&
    p.turnPrefixMessages[0].content[0].text === "c");
}

// (c) the session's own message objects are never mutated
{
  const { emit } = boot();
  const shared = { role: "assistant", stopReason: "toolUse", content: [{ type: "thinking", thinking: "z".repeat(80_000) }] };
  const snapshot = JSON.stringify(shared);
  const p = prep([shared]);
  for (let i = 0; i < 4; i++) await emit("session_before_compact", { preparation: p });
  check("c: shared message object untouched", JSON.stringify(shared) === snapshot);
  check("c: the slot holds a capped COPY", p.messagesToSummarize[0] !== shared &&
    p.messagesToSummarize[0].content[0].thinking.length < 80_000);
}

// (d) a successful compaction resets the gate
{
  const { emit } = boot();
  const p1 = prep([live("a"), dead(500_000)]);
  await emit("session_before_compact", { preparation: p1 });
  await emit("session_compact", { fromExtension: false });
  const p2 = prep([live("a"), dead(500_000)]);
  const before = JSON.stringify(p2);
  await emit("session_before_compact", { preparation: p2 });
  check("d: after a success the next first firing is a no-op again", JSON.stringify(p2) === before);
}

// (e) capping only starts on the third firing, and tightens
{
  const { emit } = boot();
  const mk = () => prep([{ role: "assistant", stopReason: "toolUse", content: [{ type: "thinking", thinking: "z".repeat(80_000) }] }]);
  const p = mk();
  await emit("session_before_compact", { preparation: p });
  await emit("session_before_compact", { preparation: p });
  check("e: second firing does not cap (dead-drop only)", p.messagesToSummarize[0].content[0].thinking.length === 80_000);
  await emit("session_before_compact", { preparation: p });
  const at3 = p.messagesToSummarize[0].content[0].thinking.length;
  await emit("session_before_compact", { preparation: p });
  const at4 = p.messagesToSummarize[0].content[0].thinking.length;
  check("e: third firing caps at RENDER_CAP", at3 > 16_000 && at3 < 17_000, `${at3}`);
  check("e: fourth firing tightens further", at4 < at3, `${at3} -> ${at4}`);
}

// (g) the drop must never hand compact() two empty lists — pi's prepareCompaction never
//     produces that state, so compact() summarises an empty <conversation> and overwrites
//     real history with a summary of nothing. Shape is the one this guard exists for: a
//     turn starting at the previous compaction boundary that died on one giant write.
{
  const { emit } = boot();
  const p = prep([], [dead(700_000)]);
  await emit("session_before_compact", { preparation: p });
  await emit("session_before_compact", { preparation: p });
  check("g: all-dead payload keeps the newest message",
    p.messagesToSummarize.length + p.turnPrefixMessages.length === 1,
    `${p.messagesToSummarize.length}/${p.turnPrefixMessages.length}`);
  const kept = p.turnPrefixMessages[0];
  check("g: the kept message is capped on the same firing",
    kept && JSON.stringify(kept.content[0].arguments).length < 20_000,
    kept ? `${JSON.stringify(kept.content[0].arguments).length}` : "nothing kept");
  // and it still tightens if pi keeps refusing
  await emit("session_before_compact", { preparation: p });
  await emit("session_before_compact", { preparation: p });
  check("g: still tightens on later firings",
    p.turnPrefixMessages[0].content[0].arguments.content.length < 9_000,
    `${p.turnPrefixMessages[0].content[0].arguments.content.length}`);
}

// (h) a list that has live messages is unaffected by (g)'s protection
{
  const { emit } = boot();
  const p = prep([live("a")], [dead(700_000)]);
  await emit("session_before_compact", { preparation: p });
  await emit("session_before_compact", { preparation: p });
  check("h: dead still dropped outright when something live remains",
    p.messagesToSummarize.length === 1 && p.turnPrefixMessages.length === 0);
}

// (f) replay: a session that really died this way must shrink a lot; one that recovered
//     must be a no-op on its first firing (which is the only firing it ever gets).
{
  const size = (l) => l.reduce((n, m) => n + (m.content ?? []).reduce((k, b) =>
    k + (b.type === "text" ? b.text.length : b.type === "thinking" ? b.thinking.length :
      b.type === "toolCall" ? JSON.stringify(b.arguments ?? {}).length : 0), 0), 0);
  const load = (run, prob) => {
    const d = join(ROOT, "results", run, prob, "session");
    if (!existsSync(d)) return null;
    const f = readdirSync(d).find((x) => x.endsWith(".jsonl"));
    return readFileSync(join(d, f), "utf8").split("\n").filter(Boolean)
      .map((l) => JSON.parse(l)).filter((r) => r.type === "message").map((r) => r.message);
  };
  const sick = load("base-fatex90-0807-r2", "fatex_26");
  if (!sick) console.log("skip f: results/base-fatex90-0807-r2/fatex_26 not present");
  else {
    const { emit } = boot();
    const p = prep(sick.slice());
    const before = size(p.messagesToSummarize);
    await emit("session_before_compact", { preparation: p });
    check("f: real sick session untouched on pi's first try", size(p.messagesToSummarize) === before);
    await emit("session_before_compact", { preparation: p });
    const after = size(p.messagesToSummarize);
    check("f: real sick session shrinks >50% once pi has failed",
      after < before * 0.5, `${(before / 1e6).toFixed(1)}MB -> ${(after / 1e6).toFixed(1)}MB`);
  }
}

console.log(failed ? `\n${failed} FAILED` : "\nall passed");
process.exit(failed ? 1 : 0);
