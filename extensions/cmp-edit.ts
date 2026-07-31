// @tools edit
// Always-on: shadows pi's built-in `edit` tool (extension tools are registered over
// built-ins by name). Same interface and semantics, two behavioral fixes, both in
// runner/edit.js: (1) fuzzy matching is trailing-whitespace-only — pi's NFKC
// normalization corrupts Lean unicode (ℕ→N, x⁻¹→x-1) on fuzzy-matched edits;
// (2) a failed match returns the closest-matching file region so the model can
// correct its oldText in one turn. Schema, description, and success wording follow
// pi's built-in so the model-visible surface changes only where intended.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { applyEdits } from "../runner/edit.js";
import { ToolFailure } from "../runner/common.js";

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "edit",
    label: "edit",
    description:
      "Edit a single file using exact text replacement. Every edits[].oldText must match a unique, " +
      "non-overlapping region of the original file. If two changes affect the same block or nearby lines, " +
      "merge them into one edit instead of emitting overlapping edits. Do not include large unchanged " +
      "regions just to connect distant changes.",
    promptSnippet: "Make precise file edits with exact text replacement, including multiple disjoint edits in one call",
    promptGuidelines: [
      "Use edit for precise changes (edits[].oldText must match exactly)",
      "When changing multiple separate locations in one file, use one edit call with multiple entries in edits[] instead of multiple edit calls",
      "Each edits[].oldText is matched against the original file, not after earlier edits are applied. Do not emit overlapping or nested edits. Merge nearby changes into one edit.",
      "Keep edits[].oldText as small as possible while still being unique in the file. Do not pad with large unchanged regions.",
    ],
    parameters: Type.Object({
      path: Type.String({ description: "Path to the file to edit (relative or absolute)" }),
      edits: Type.Array(
        Type.Object({
          oldText: Type.String({
            description:
              "Exact text for one targeted replacement. It must be unique in the original file and must not overlap with any other edits[].oldText in the same call.",
          }),
          newText: Type.String({ description: "Replacement text for this targeted edit." }),
        }),
        { description: "One or more targeted replacements. Each edit is matched against the original file, not incrementally." },
      ),
    }),
    // pi's compatibility shims, kept: some models send edits as a JSON string, or a
    // single legacy top-level oldText/newText pair.
    prepareArguments(args: any) {
      if (!args || typeof args !== "object") return args;
      if (typeof args.edits === "string") {
        try {
          const parsed = JSON.parse(args.edits);
          if (Array.isArray(parsed)) args.edits = parsed;
        } catch {}
      }
      if (typeof args.oldText === "string" && typeof args.newText === "string") {
        const { oldText, newText, ...rest } = args;
        return { ...rest, edits: [...(Array.isArray(args.edits) ? args.edits : []), { oldText, newText }] };
      }
      return args;
    },
    async execute(_toolCallId, params: any, _signal, _onUpdate, ctx) {
      // Failures THROW (pi ignores a returned isError — see ToolFailure in
      // runner/common.js); applyEdits' messages, closest-region snippet included,
      // become the result text unchanged.
      const { path, edits } = params;
      if (!Array.isArray(edits) || edits.length === 0) {
        throw new ToolFailure("Edit tool input is invalid. edits must contain at least one replacement.");
      }
      const abs = resolve(ctx.cwd, path);
      if (!existsSync(abs)) {
        throw new ToolFailure(`Could not edit file: ${path}. File does not exist.`);
      }
      const { newContent } = applyEdits(readFileSync(abs, "utf8"), edits, path);
      writeFileSync(abs, newContent, "utf8");
      return { content: [{ type: "text", text: `Successfully replaced ${edits.length} block(s) in ${path}.` }] };
    },
  });
}
