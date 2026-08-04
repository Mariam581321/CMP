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
    // In a library cell (CMP_LIB_FILE set) the search surface genuinely includes the
    // baked library, and the description must say so — from the NAME alone an agent
    // would never guess grep_mathlib covers it. The name itself stays: renaming per
    // cell would break tool identity across arms, a bigger uncontrolled delta than
    // the sentence.
    description:
      "Text search over the Mathlib source code, at the exact version being compiled against" +
      (process.env.CMP_LIB_FILE
        ? ", and over the additional verified library (library.lean) — one search covers both"
        : "") +
      ". " +
      "A pattern is matched as literal text (e.g. 'mul_pow' or '(a * b) ^ n'), as an extended " +
      "regex (e.g. 'GL.*Sylow'), or as a fully-qualified declaration name (e.g. " +
      "'IntermediateField.inv_mem'); regex patterns match across the line breaks that wrap long " +
      "signatures, and case-insensitive matching is tried when exact case finds nothing. " +
      "Returns matching declarations with their fully-qualified names — the name as you would " +
      "write it in a proof, which is often not the name written in the source — and their type " +
      "signatures; each result states which of these readings produced it.",
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
            // Bare statement of fact, mirroring search_mathlib's "No results." — the
            // earlier "Try a shorter fragment..." sentence was retry coaching that
            // semantic-arm agents never got, i.e. a strategy asymmetry, not a result.
            content: [{ type: "text", text: "No matches (case-insensitive included)." }],
            details: { count: 0 },
          };
        }
        // The heading is the assembled name, not the file location. Two reasons, both from
        // the 0730b/0731 logs: the source text under it carries the name as *written*
        // (`r_zero`), which is not what a proof can call (`DihedralGroup.r_zero`), so the
        // namespace had to be decoded from the path — and returning a path made agents try
        // to read it. Of the grep-arm reads with an identifiable Mathlib path, 546 used a
        // path this tool had just printed against 8 guessed, in an environment where no
        // such read has ever succeeded. Locations stay in `details` for the run logs, which
        // the model never sees.
        const blocks = r.hits.map((h) => {
          const head = h.name
            ? `${h.name}${h.isPrivate ? "  [private — declared private, so it cannot be used outside its own file]" : ""}`
            : "(no enclosing declaration — the matching source line is shown as-is)";
          return `• ${head}\n${h.text}`;
        });
        // Say which reading of the pattern produced these, so a hit that came from a
        // looser rung is not mistaken for an exact-text match.
        // A qualified-name hit answers a different question from the text rungs — "yes,
        // this declaration exists" — and the note also states why the source looks
        // nothing like the query, which is the thing the agent cannot see.
        // No claim about HOW the source splits the name across namespaces: rung 0 also
        // matches heads written with an explicit prefix (`theorem Foo.bar` inside
        // `namespace A`), where the last-dot split asserted a decomposition that is
        // simply false. The existence statement and the why-text-search-fails hint hold
        // in every case; the split does not.
        const qualifiedNote = () =>
          `note: \`${params.pattern}\` exists. The source may declare it under an enclosing namespace with a shorter written name, which is why a text search for the full name can find nothing.`;
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
          details: {
            count: r.hits.length,
            truncated: r.truncated,
            mode: r.mode,
            // Log-only (pi sends the model `content`, never `details`): keeps every hit's
            // location for later analysis now that the agent no longer receives it.
            hits: r.hits.map((h) => ({ name: h.name, path: h.path, line: h.line, private: h.isPrivate })),
          },
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
