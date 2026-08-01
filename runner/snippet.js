// check_snippet core: compile a standalone snippet against Mathlib on the lean
// server. Stateless by design — no files involved, and no statement probe: a
// snippet is not the graded file, so there is nothing to preserve. Shared by
// extensions/lean-snippet.ts (and block-C workers, which get this instead of
// lean_check).

import { postCheck } from "./common.js";
import { CLIENT_WAIT_MS, bannedTactic } from "./stmt.js";

// The server renders message positions as `problem.lean:line:col` (historically its
// only compiled file); for a snippet that label is actively misleading — the agent
// would go looking for the error in problem.lean. Rebuild pretty here from the
// structured messages/sorries with `snippet:` labels instead of changing the server:
// a server-side label param would poison the memo (keyed by code hash alone, so the
// first caller's label would be served to everyone compiling identical code).
// Format otherwise mirrors lean-server.js render(), so the agent sees one error
// shape across both check tools.
function renderSnippet(messages, sorries) {
  const parts = [];
  for (const m of messages ?? []) parts.push(`${m.severity}: snippet:${m.line}:${m.column}: ${m.text}`);
  for (const s of sorries ?? []) parts.push(`sorry at line ${s.line}, goal:\n  ${s.goal}`);
  const ok = (messages ?? []).every((m) => m.severity !== "error");
  let pretty = parts.join("\n\n") || "snippet compiled successfully: no errors, no warnings";
  if (ok && parts.length) pretty = `snippet compiled with output:\n${pretty}`;
  if (!ok) pretty = `snippet compilation FAILED:\n${pretty}`;
  if (pretty.length > 8000) pretty = pretty.slice(0, 8000) + "\n... (truncated)";
  return { ok, pretty };
}

export async function checkSnippet(code, { client }) {
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
  const r = await postCheck({ code, client }, CLIENT_WAIT_MS);
  if (r.error) return r; // typed server failure ({error, kind, ...}) — caller words it for the agent
  return { ...r, ...renderSnippet(r.messages, r.sorries) };
}
