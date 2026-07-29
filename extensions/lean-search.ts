// @tools search_mathlib
// Experimental arm: semantic search over Mathlib via the public LeanSearch API.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const API = "https://leansearch.net/search";

// Fixed result count, deliberately not a tool parameter: how deep to retrieve is a
// property of the arm, not a decision for the agent. With the knob exposed, 91% of
// calls set it (mode 5, then 10, then 3), so the arm was really measuring a mix of
// retrieval depths rather than one. 6 ≈ the old default and the observed median.
const NUM_RESULTS = 6;

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "search_mathlib",
    label: "Search Mathlib",
    // Says what the tool is and what comes back, and nothing about when or why to
    // reach for it: any "use this to find the exact name" / "use this to explore"
    // wording would make the arm a strategy hint rather than a retrieval mode.
    description:
      "Semantic search over Mathlib. Queries are natural language and are matched by meaning " +
      "rather than by exact text (e.g. 'a continuous function on a compact set attains its maximum'). " +
      "Returns Mathlib declarations with their names and type signatures.",
    promptSnippet: "search_mathlib - semantic search over Mathlib",
    parameters: Type.Object({
      query: Type.String({ description: "What to search for, in natural language" }),
    }),
    async execute(_toolCallId, params, signal) {
      const n = NUM_RESULTS;
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
