// @tools grep_mathlib
// Experimental arm (PLAN.md block A): symbolic search — grep over the pinned local
// Mathlib checkout, vs lean-search's semantic API. Tests confirmation-retrieval
// (verify a name the model can nearly guess) against discovery-retrieval. Like
// lean-search, the arm's whole prompt delta lives in the tool description below.
// Core logic in runner/grep.js.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { grepMathlib } from "../runner/grep.js";

// Fixed result count, deliberately not a tool parameter — same reasoning as
// lean-search's NUM_RESULTS: retrieval depth is a property of the arm, not a
// decision for the agent. Higher than semantic's 6 on purpose: grep results are
// file-order, not relevance-ranked, so a low cap can drop the right hit
// arbitrarily; each tool runs at its mechanism's natural depth (decided 0729).
const MAX_RESULTS = 10;

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "grep_mathlib",
    label: "Grep Mathlib",
    // What the tool is and what comes back — no when/why steering, mirroring
    // search_mathlib so the semantic-vs-grep arms differ only in retrieval mode.
    description:
      "Text search (grep) over the Mathlib source code, at the exact version being compiled against. " +
      "The pattern is matched literally against declaration names and statement text " +
      "(e.g. 'mul_pow' or '(a * b) ^ n'); set regex=true for an extended regex. " +
      "Falls back to case-insensitive matching when an exact-case search finds nothing. " +
      "Returns matching declarations with their names, type signatures, and file locations.",
    promptSnippet: "grep_mathlib - literal text or regex search over Mathlib source",
    parameters: Type.Object({
      pattern: Type.String({ description: "Text to search for (literal unless regex=true)" }),
      regex: Type.Optional(Type.Boolean({ description: "Treat pattern as an extended regex (default false)" })),
    }),
    async execute(_toolCallId, params, signal) {
      const maxResults = MAX_RESULTS;
      try {
        const r = await grepMathlib(params.pattern, { regex: params.regex ?? false, maxResults }, signal);
        if (r.hits.length === 0) {
          return {
            content: [{ type: "text", text: "No matches (case-insensitive included). Try a shorter fragment, different name segments, or statement text." }],
            details: { count: 0 },
          };
        }
        const blocks = r.hits.map((h) => `• ${h.path}:${h.line}\n${h.text}`);
        const notes = [
          r.ci ? "note: exact-case search found nothing; these are case-insensitive matches." : "",
          r.truncated ? "note: more matches exist — narrow the pattern." : "",
        ].filter(Boolean);
        return {
          content: [{ type: "text", text: [...blocks, ...notes].join("\n\n") }],
          details: { count: r.hits.length, truncated: r.truncated, ci: r.ci },
        };
      } catch (e: any) {
        // Bad regexes land here with grep's own message — actionable for the model.
        return { content: [{ type: "text", text: `grep_mathlib failed: ${String(e?.message ?? e)}` }], isError: true };
      }
    },
  });
}
