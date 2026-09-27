// @tools grep_mathlib
// Text search over the pinned local Mathlib checkout.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { grepMathlib } from "../runner/grep.js";
import { ToolFailure, cmpConfig } from "../runner/common.js";

const MAX_RESULTS = 25;

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "grep_mathlib",
    label: "Grep Mathlib",
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
      "signatures; each result states which of these readings produced it." +
      (cmpConfig().mathlib_read
        ? " Each result also names its source file, which you can open with the read tool " +
          "(the Mathlib source tree is readable at Mathlib/ in your working directory)."
        : ""),
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
            content: [{ type: "text", text: "No matches (case-insensitive included)." }],
            details: { count: 0 },
          };
        }
        const readable = cmpConfig().mathlib_read === true;
        const blocks = r.hits.map((h) => {
          const head = h.name
            ? `${h.name}${h.isPrivate ? "  [private — declared private, so it cannot be used outside its own file]" : ""}`
            : "(no enclosing declaration — the matching source line is shown as-is)";
          return `• ${head}\n${h.text}${readable ? `\n  — ${h.path}:${h.line}` : ""}`;
        });
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
            hits: r.hits.map((h) => ({ name: h.name, path: h.path, line: h.line, private: h.isPrivate })),
          },
        };
      } catch (e: any) {
        throw new ToolFailure(`grep_mathlib failed: ${String(e?.message ?? e)}`);
      }
    },
  });
}
