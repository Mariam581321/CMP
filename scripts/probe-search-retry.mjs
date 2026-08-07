#!/usr/bin/env node
// Probes for search_mathlib's retry policy (extensions/lean-search.ts), driven by a
// FAKE fetch — testing a rate limiter by hammering someone's public endpoint would be
// the rude version of the bug this is fixing.
//
// What it is for. Every one of the 69 search failures in semantic-fatex87-0805 was an
// HTTP 429, and they are BURSTS: 8.0 calls/min average and p90 23/min over the cell, but
// all 69 fall inside six minutes of 569, each carrying 65-99 calls. So the property that
// matters is not "does it retry" — it is that N simultaneously-rejected callers come
// back SPREAD OUT. A fixed backoff would have them all sleep the same interval and fire
// together, reproducing the spike one interval later.
//
//   node scripts/probe-search-retry.mjs
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const SRC = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "extensions", "lean-search.ts"), "utf8");

let failed = 0;
const check = (name, cond, detail = "") => {
  console.log(`${cond ? "  ok  " : "  FAIL"}  ${name}${cond || !detail ? "" : `\n        ${detail}`}`);
  if (!cond) failed++;
};

// The policy is a handful of pure expressions in the extension; lift them out rather
// than booting pi, and assert the source still defines them the way this probe assumes.
const num = (name) => Number(new RegExp(`const ${name} = ([0-9_]+)`).exec(SRC)?.[1].replace(/_/g, ""));
const RETRY_MAX = num("RETRY_MAX"), BASE = num("RETRY_BASE_MS"), CAP = num("RETRY_CAP_MS");
check("policy constants are readable from the source", [RETRY_MAX, BASE, CAP].every(Number.isFinite), `${RETRY_MAX} ${BASE} ${CAP}`);
check("full jitter is used, not a fixed schedule", /Math\.random\(\) \* Math\.min\(RETRY_CAP_MS/.test(SRC));
check("Retry-After is honoured when present", /retry-after/i.test(SRC));
check("only 429 and 5xx retry", /status === 429 \|\| status >= 500/.test(SRC));

const backoff = (attempt, after = null) => {
  if (Number.isFinite(after) && after > 0) return Math.min(after * 1000, 60_000);
  return Math.random() * Math.min(CAP, BASE * 2 ** attempt);
};

// The burst property: 40 callers rejected at the same instant must not come back at the
// same instant. With full jitter their first retry is spread over the whole window.
{
  const first = Array.from({ length: 40 }, () => backoff(0));
  const spread = Math.max(...first) - Math.min(...first);
  const distinct = new Set(first.map((x) => Math.round(x / 100))).size;
  check("a synchronised burst retries spread out, not together", spread > BASE * 0.5 && distinct > 10, `spread ${Math.round(spread)}ms over ${distinct} distinct 100ms slots`);
}

// The window grows, so a limiter that needs more than one round still clears.
{
  const means = Array.from({ length: RETRY_MAX }, (_, i) => Math.min(CAP, BASE * 2 ** i) / 2);
  check("each retry waits longer on average than the last", means.every((m, i) => i === 0 || m >= means[i - 1]), JSON.stringify(means));
  const total = means.reduce((a, b) => a + b, 0);
  check("total expected wait clears a per-minute window", total > 25_000 && total < 90_000, `${Math.round(total / 1000)}s expected`);
  const worst = Array.from({ length: RETRY_MAX }, (_, i) => Math.min(CAP, BASE * 2 ** i)).reduce((a, b) => a + b, 0);
  check("worst case stays well inside the attempt backstop", worst < 120_000, `${Math.round(worst / 1000)}s worst`);
}

// Retry-After wins when the server sends one, and is bounded.
{
  check("Retry-After is used verbatim", backoff(0, 7) === 7000);
  check("...and capped, so a hostile value cannot park a turn", backoff(0, 9999) === 60_000);
}

// Waiting must be free in the currency the experiment measures. This is the reason a
// 429 absorbed here cannot bias the arm comparison, so it is stated as an assertion
// about the code: nothing in the retry path touches usage, cost or the tool result.
{
  const retryBlock = SRC.slice(SRC.indexOf("for (let attempt = 0"), SRC.indexOf("if (!resp.ok)"));
  check("the retry loop books no tokens and returns no partial result",
    !/content:|usage|cost|tokens/.test(retryBlock), retryBlock.slice(0, 120));
}

console.log(failed ? `\n${failed} probe(s) FAILED` : "\nall search-retry probes green");
process.exit(failed ? 1 : 0);
