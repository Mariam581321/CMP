// @tools search_mathlib
// Experimental arm: semantic search over Mathlib via the public LeanSearch API.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { ToolFailure } from "../runner/common.js";

const API = "https://leansearch.net/search";

// Retry transient failures INSIDE the tool, where waiting costs zero tokens. Bouncing
// one to the model costs a whole turn, with the growing context re-billed as input —
// the same argument that already keeps connection retries inside lean_check.
// This is not hypothetical and it was not symmetric: every one of the 69 search_mathlib
// failures in semantic-fatex87-0805 was an HTTP **429**. LeanSearch is a public endpoint
// and the runner points 25 concurrent attempts at it, so the arm was losing 69 turns to
// OUR concurrency — a harness effect landing on exactly one side of the block-A
// comparison, since grep runs locally and cannot rate-limit. A 4xx that is not 429 is the
// query's own answer and is never retried.
const RETRY_DELAYS_MS = [2_000, 6_000, 15_000];
const transient = (status: number) => status === 429 || status >= 500;

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
      let ac: AbortController;
      let t: ReturnType<typeof setTimeout> | undefined;
      try {
        let resp!: Response;
        for (let attempt = 0; ; attempt++) {
          ac = new AbortController();
          clearTimeout(t);
          t = setTimeout(() => ac.abort(), 30_000);
          signal?.addEventListener("abort", () => ac.abort());
          resp = await fetch(API, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ query: [params.query], num_results: n }),
            signal: ac.signal,
          });
          if (resp.ok || !transient(resp.status) || attempt >= RETRY_DELAYS_MS.length || signal?.aborted) break;
          await new Promise((r) => setTimeout(r, RETRY_DELAYS_MS[attempt]));
        }
        // Failures THROW; pi ignores a returned isError (see runner/common.js).
        // "No results." is a result, not a failure, and still returns normally.
        if (!resp.ok) {
          throw new ToolFailure(`LeanSearch API error: HTTP ${resp.status}`);
        }
        const data = (await resp.json()) as any[][];
        const hits = data[0] ?? [];
        if (hits.length === 0) return { content: [{ type: "text", text: "No results." }] };
        const parsed = hits.map((h: any) => {
          const r = h.result ?? h;
          return {
            name: Array.isArray(r.name) ? r.name.join(".") : String(r.name),
            sig: r.signature ?? r.type ?? "",
            informal: r.informal_name ?? null,
            kind: r.kind ?? null,
            module: Array.isArray(r.module_name) ? r.module_name.join(".") : (r.module_name ?? null),
            distance: typeof h.distance === "number" ? h.distance : null,
          };
        });
        const lines = parsed.map((p) => `• ${p.name} : ${p.sig}${p.informal ? ` — ${p.informal}` : ""}`);
        return {
          content: [{ type: "text", text: lines.join("\n") }],
          // Telemetry only — `details` is not serialized to the model on the
          // openai-completions path, so recording more here cannot change the arm.
          // The API returns its own relevance score (`distance`) and a `kind`, and both
          // are unrecoverable after the run: worth keeping for the analysis (how
          // confident was retrieval, and is it returning theorems or generated
          // artefacts like `ctorIdx`). The API exposes no index version, so what the
          // index contained is only ever reconstructible from these records.
          details: {
            count: hits.length,
            results: parsed.map((p) => ({ name: p.name, kind: p.kind, module: p.module, distance: p.distance })),
          },
        };
      } catch (e: any) {
        if (e instanceof ToolFailure) throw e; // already classified (HTTP status above)
        throw new ToolFailure(`LeanSearch request failed: ${e?.message ?? e}`);
      } finally {
        clearTimeout(t);
      }
    },
  });
}
