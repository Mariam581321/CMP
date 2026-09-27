// check_snippet core: compiles a standalone snippet against Mathlib on the lean server.

import { postCheck, MAX_HEARTBEATS } from "./common.js";
import { CLIENT_WAIT_MS } from "./check-env.js";
import { bannedTactic } from "./stmt.js";
import { renderCheck } from "./render.js";

// Renders with `snippet:` labels.
const renderSnippet = (messages, sorries) =>
  renderCheck({ messages, sorries, label: "snippet", maxHeartbeats: MAX_HEARTBEATS });

// `prefix`: the fact bank, compiled ahead of the snippet; its region is stripped and positions shifted back.
export async function checkSnippet(code, { client, prefix }) {
  if (bannedTactic(code)) {
    return {
      ok: false,
      rejected: "native_decide",
      pretty:
        "CHECK REJECTED (snippet was NOT compiled): it uses `native_decide`, which is " +
        "banned — it trusts the native compiler instead of the Lean kernel, and grading " +
        "rejects it via #print axioms no matter what. Close the goal with kernel-checked " +
        "reasoning (`decide`, `norm_num`, `omega`, ... are all fine).",
      messages: [],
      sorries: [],
    };
  }
  const pre = prefix?.trim() ? prefix.trimEnd() + "\n\n" : "";
  const preLines = pre ? pre.split("\n").length - 1 : 0;
  const r = await postCheck({ code: pre + code, client }, CLIENT_WAIT_MS);
  if (r.error) return r;
  const shift = (xs) => (xs ?? []).filter((x) => x.line > preLines).map((x) => ({ ...x, line: x.line - preLines }));
  const messages = preLines ? shift(r.messages) : r.messages;
  const sorries = preLines ? shift(r.sorries) : r.sorries;
  return { ...r, messages, sorries, ...renderSnippet(messages, sorries) };
}
