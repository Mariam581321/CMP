// @tools search_mathlib
// Experimental arm: semantic search over Mathlib via the public LeanSearch API.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { ToolFailure, cmpConfig, LEAN_URL } from "../runner/common.js";

const API = "https://leansearch.net/search";

// Ask the shared lean-server dispenser for permission before calling out. The 429s this
// prevents come from 25 pi processes searching at the same moment, which no per-process
// limiter can see — so the token bucket lives in the one process they all already talk
// to (runner/lean-server.js, slotPump), and this is the whole client side of it.
//
// Best effort by design. No dispenser (older server, ad-hoc use, a slot request that
// errors) means proceed immediately, which is exactly the behaviour that existed before
// it — so this can only ever make things better, never block a search. The wait is
// generous because waiting is free in the currency being measured: it costs wall clock,
// never tokens or turns.
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

// Retry transient failures INSIDE the tool, where waiting costs zero tokens. Bouncing
// one to the model costs a whole turn, with the growing context re-billed as input —
// the same argument that already keeps connection retries inside lean_check. It also
// keeps a harness effect off one side of the comparison: LeanSearch is a public
// endpoint that rate-limits our own concurrency (HTTP 429), while grep runs locally
// and cannot.
//
// The 429s are BURSTS, not volume: the endpoint is comfortable with the sustained rate
// and refuses the spikes, which happen when many attempts search at once. That shape
// decides the retry: **full jitter is the load-bearing part, not the backoff**. A fixed
// delay would have all N rejected requests sleep the same 2 s and fire together — the
// same spike, two seconds later. Sleeping a uniform random slice of the window spreads
// one burst across it instead; the growing window is only there for the case where the
// limiter needs longer than one round to clear.
//
// Waiting is free in the currency that is measured: it costs wall clock, never tokens
// or turns, so a 429 absorbed here cannot move `cost_std` or the solve rate. A 4xx that
// is not 429 is the query's own answer and is never retried. The endpoint sends no
// Retry-After header, but honour it if one ever appears.
const RETRY_MAX = 5;
const RETRY_BASE_MS = 2_000;
const RETRY_CAP_MS = 45_000;
const transient = (status: number) => status === 429 || status >= 500;
const backoffMs = (attempt: number, resp: Response) => {
  const after = Number(resp.headers.get("retry-after"));
  if (Number.isFinite(after) && after > 0) return Math.min(after * 1000, 60_000);
  // Full jitter: uniform over the whole window, so a synchronised burst comes back
  // spread out rather than synchronised.
  return Math.random() * Math.min(RETRY_CAP_MS, RETRY_BASE_MS * 2 ** attempt);
};

// Fixed result count, deliberately not a tool parameter: how deep to retrieve is a
// property of the arm, not a decision for the agent (with the knob exposed, agents set
// it on most calls, so the arm measured a mix of depths rather than one).
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
      // Telemetry only (`details` never reaches the model): records whether the jitter
      // actually absorbed the bursts.
      let retries = 0;
      let slotMs = 0;
      const t0 = Date.now();
      const client = cmpConfig().problem ?? "anon";
      try {
        let resp!: Response;
        for (let attempt = 0; ; attempt++) {
          // One slot per outbound request, retries included — a retry is another call
          // against the same limiter and must be paced like any other.
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
            // How hard this call was to get: `retries` > 0 means the endpoint pushed
            // back and the jitter absorbed it.
            retries,
            slot_ms: slotMs,
            wait_ms: Date.now() - t0,
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
