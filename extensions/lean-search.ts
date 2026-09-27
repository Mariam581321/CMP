// @tools search_mathlib
// Semantic search over Mathlib via the public LeanSearch API.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { ToolFailure, cmpConfig, LEAN_URL } from "../runner/common.js";

const API = "https://leansearch.net/search";

// Waits for a LeanSearch rate-limit slot from the lean server (best effort).
const SLOT_WAIT_MS = 120_000;
async function waitForSlot(client: string): Promise<number> {
  try {
    const r = await fetch(`${LEAN_URL}/search-slot`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ client }),
      signal: AbortSignal.timeout(SLOT_WAIT_MS),
    });
    if (!r.ok) return 0;
    return (await r.json())?.waited_ms ?? 0;
  } catch {
    return 0;
  }
}

// Retries 429/5xx with full-jitter exponential backoff.
const RETRY_MAX = 5;
const RETRY_BASE_MS = 2_000;
const RETRY_CAP_MS = 45_000;
const transient = (status: number) => status === 429 || status >= 500;
const backoffMs = (attempt: number, resp: Response) => {
  const after = Number(resp.headers.get("retry-after"));
  if (Number.isFinite(after) && after > 0) return Math.min(after * 1000, 60_000);
  return Math.random() * Math.min(RETRY_CAP_MS, RETRY_BASE_MS * 2 ** attempt);
};

const NUM_RESULTS = 6;

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "search_mathlib",
    label: "Search Mathlib",
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
      let retries = 0;
      let slotMs = 0;
      const t0 = Date.now();
      const client = cmpConfig().problem ?? "anon";
      try {
        let resp!: Response;
        for (let attempt = 0; ; attempt++) {
          slotMs += await waitForSlot(client);
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
          if (resp.ok || !transient(resp.status) || attempt >= RETRY_MAX || signal?.aborted) break;
          retries++;
          await new Promise((r) => setTimeout(r, backoffMs(attempt, resp)));
        }
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
          details: {
            count: hits.length,
            retries,
            slot_ms: slotMs,
            wait_ms: Date.now() - t0,
            results: parsed.map((p) => ({ name: p.name, kind: p.kind, module: p.module, distance: p.distance })),
          },
        };
      } catch (e: any) {
        if (e instanceof ToolFailure) throw e;
        throw new ToolFailure(`LeanSearch request failed: ${e?.message ?? e}`);
      } finally {
        clearTimeout(t);
      }
    },
  });
}
