// check_snippet core: compile a standalone snippet against Mathlib on the lean
// server. Stateless by design — no files involved, and no statement probe: a
// snippet is not the graded file, so there is nothing to preserve. Shared by
// extensions/lean-snippet.ts (and block-C workers, which get this instead of
// lean_check).

import { postCheck, MAX_HEARTBEATS } from "./common.js";
import { CLIENT_WAIT_MS } from "./check-env.js";
import { bannedTactic } from "./stmt.js";
import { renderCheck } from "./render.js";

// The server renders message positions as `problem.lean:line:col` (historically its
// only compiled file); for a snippet that label is actively misleading — the agent
// would go looking for the error in problem.lean. Rebuild pretty here from the
// structured messages/sorries with `snippet:` labels instead of changing the server:
// a server-side label param would poison the memo (keyed by code hash alone, so the
// first caller's label would be served to everyone compiling identical code).
// Format is otherwise renderCheck's, so the agent sees one error shape across both check
// tools. No `outputName` here: a snippet is stateless and block-C workers have no file
// tools at all, so there is nothing for a pointer to point at — the digest is the whole
// channel, which is why it gets the same 16 KB cap rather than a smaller one.
const renderSnippet = (messages, sorries) =>
  renderCheck({ messages, sorries, label: "snippet", maxHeartbeats: MAX_HEARTBEATS });

// `prefix` (the facts arm): compile [prefix + snippet] so the shared fact bank is in
// scope for scratch work — the bank's whole point as a channel. The prefix is trusted
// (everything in it passed the add_fact gate, so it compiles clean); its region is
// stripped from what the caller sees and snippet positions are shifted back to the
// snippet's own coordinates. The server memo keys on the full compiled text, so a
// snippet re-checked after the bank grew is a fresh compile, as it must be.
export async function checkSnippet(code, { client, prefix }) {
  // Same pre-reject as lean_check, same two reasons: a doomed native_decide attempt
  // burns minutes of the shared serialized REPL, and a snippet "verified" with it
  // would teach the agent a step that can never count in problem.lean.
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
  if (r.error) return r; // typed server failure ({error, kind, ...}) — caller words it for the agent
  const shift = (xs) => (xs ?? []).filter((x) => x.line > preLines).map((x) => ({ ...x, line: x.line - preLines }));
  const messages = preLines ? shift(r.messages) : r.messages;
  const sorries = preLines ? shift(r.sorries) : r.sorries;
  return { ...r, messages, sorries, ...renderSnippet(messages, sorries) };
}
