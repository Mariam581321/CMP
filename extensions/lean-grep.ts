// @tools grep_mathlib
// Experimental arm (PLAN.md block A): symbolic search — grep over the pinned local
// Mathlib checkout, vs lean-search's semantic API. Tests confirmation-retrieval
// (verify a name the model can nearly guess) against discovery-retrieval. Like
// lean-search, the arm's whole prompt delta lives in the tool description below.
// Core logic in runner/grep.js.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { grepMathlib } from "../runner/grep.js";
import { ToolFailure } from "../runner/common.js";

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
      "Text search over the Mathlib source code, at the exact version being compiled against. " +
      "A pattern is matched as literal text (e.g. 'mul_pow' or '(a * b) ^ n'), as an extended " +
      "regex (e.g. 'GL.*Sylow'), or as a fully-qualified declaration name (e.g. " +
      "'IntermediateField.inv_mem'); regex patterns match across the line breaks that wrap long " +
      "signatures, and case-insensitive matching is tried when exact case finds nothing. " +
      "Returns matching declarations with their names, type signatures, and file locations; each " +
      "result states which of these readings produced it.",
    promptSnippet: "grep_mathlib - text or regex search over Mathlib source",
    parameters: Type.Object({
      pattern: Type.String({ description: "Text or extended-regex pattern to search for" }),
    }),
    async execute(_toolCallId, params, signal) {
      const maxResults = MAX_RESULTS;
      try {
        const r = await grepMathlib(params.pattern, { maxResults }, signal);
        if (r.hits.length === 0) {
          return {
            content: [{ type: "text", text: "No matches (case-insensitive included). Try a shorter fragment, different name segments, or statement text." }],
            details: { count: 0 },
          };
        }
        const blocks = r.hits.map((h) => `• ${h.path}:${h.line}\n${h.text}`);
        // Say which reading of the pattern produced these, so a hit that came from a
        // looser rung is not mistaken for an exact-text match.
        // A qualified-name hit answers a different question from the text rungs — "yes,
        // this declaration exists" — and the note also states why the source looks
        // nothing like the query, which is the thing the agent cannot see.
        const qualifiedNote = () => {
          const i = params.pattern.lastIndexOf(".");
          return `note: \`${params.pattern}\` exists. Mathlib's source writes it as \`${params.pattern.slice(i + 1)}\` inside \`namespace ${params.pattern.slice(0, i)}\`, which is why a text search for the full name finds nothing.`;
        };
        const MODE_NOTE: Record<string, string> = {
          "literal-ci": "note: exact-case search found nothing; these are case-insensitive matches.",
          regex: "note: no literal matches; your pattern was read as a regular expression.",
          "regex-ci": "note: no literal matches; your pattern was read as a case-insensitive regular expression.",
          "cross-line": "note: no single line matches; your pattern was matched against whole declarations, across the line breaks that wrap long signatures.",
        };
        const notes = [
          r.mode === "qualified-name" ? qualifiedNote() : r.mode ? (MODE_NOTE[r.mode] ?? "") : "",
          r.truncated ? "note: more matches exist — narrow the pattern." : "",
        ].filter(Boolean);
        return {
          content: [{ type: "text", text: [...blocks, ...notes].join("\n\n") }],
          details: { count: r.hits.length, truncated: r.truncated, mode: r.mode },
        };
      } catch (e: any) {
        // Bad regexes land here with grep's own message — actionable for the model.
        // Throws (not a returned isError) so the failure is recorded as one; see
        // ToolFailure in runner/common.js. A zero-hit search is a result, not a
        // failure, and still returns normally above.
        throw new ToolFailure(`grep_mathlib failed: ${String(e?.message ?? e)}`);
      }
    },
  });
}
