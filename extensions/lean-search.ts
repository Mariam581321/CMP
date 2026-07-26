// @tools search_mathlib
// Experimental arm: semantic search over Mathlib via the public LeanSearch API.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const API = "https://leansearch.net/search";

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "search_mathlib",
    label: "Search Mathlib",
    description:
      "Semantic search over Mathlib: describe what you need in natural language " +
      "(e.g. 'sum of first n natural numbers', 'a continuous function on a compact set attains its max') " +
      "and get matching lemma names with type signatures. Use this to find the exact " +
      "Mathlib lemma names to use in your proof.",
    promptSnippet: "search_mathlib - find Mathlib lemmas by natural-language description",
    parameters: Type.Object({
      query: Type.String({ description: "Natural-language description of the lemma you need" }),
      num_results: Type.Optional(Type.Number({ description: "How many results (default 6, max 20)" })),
    }),
    async execute(_toolCallId, params, signal) {
      const n = Math.min(params.num_results ?? 6, 20);
      const ac = new AbortController();
      const t = setTimeout(() => ac.abort(), 30_000);
      signal?.addEventListener("abort", () => ac.abort());
      try {
        const resp = await fetch(API, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ query: [params.query], num_results: n }),
          signal: ac.signal,
        });
        if (!resp.ok) {
          return { content: [{ type: "text", text: `LeanSearch API error: HTTP ${resp.status}` }], isError: true };
        }
        const data = (await resp.json()) as any[][];
        const hits = data[0] ?? [];
        if (hits.length === 0) return { content: [{ type: "text", text: "No results." }] };
        const lines = hits.map((h: any) => {
          const r = h.result ?? h;
          const name = Array.isArray(r.name) ? r.name.join(".") : String(r.name);
          const sig = r.signature ?? r.type ?? "";
          const informal = r.informal_name ? ` — ${r.informal_name}` : "";
          return `• ${name} : ${sig}${informal}`;
        });
        return { content: [{ type: "text", text: lines.join("\n") }], details: { count: hits.length } };
      } catch (e: any) {
        return { content: [{ type: "text", text: `LeanSearch request failed: ${e?.message ?? e}` }], isError: true };
      } finally {
        clearTimeout(t);
      }
    },
  });
}
