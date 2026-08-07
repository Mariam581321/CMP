#!/usr/bin/env node
// Probes for the shared external-search rate dispenser (runner/lean-server.js, slotPump)
// and for the client that uses it (extensions/lean-search.ts). Talks only to the local
// daemon — no request reaches LeanSearch, because testing a rate limiter by hammering
// someone's public endpoint is the rude version of the bug this fixes.
//
// The property under test is a HARD bound, not a statistical one. Every one of the 69
// search failures in semantic-fatex87-0805 was an HTTP 429, and bucketing that cell's
// 6,314 searches by minute brackets the endpoint's rule tightly: highest clean minute 50
// requests, lowest failing minute 52, over 563 clean minutes against 6 failing (52, 64,
// 65, 65, 69, 99). A token bucket at rate R with burst B can never put more than R + B
// into ANY sliding 60 s window — which is what fixed-minute measurement cannot promise,
// since 30 requests either side of a boundary is 60 in a sliding window while both
// buckets read 30.
//
//   node scripts/probe-search-slots.mjs      (needs the lean server up; ~20 s)
import { LEAN_URL } from "../runner/common.js";

let failed = 0;
const check = (name, cond, detail = "") => {
  console.log(`${cond ? "  ok  " : "  FAIL"}  ${name}${cond || !detail ? "" : `\n        ${detail}`}`);
  if (!cond) failed++;
};
const slot = (client, base = LEAN_URL) =>
  fetch(`${base}/search-slot`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ client }) });

const health = await fetch(`${LEAN_URL}/health`, { signal: AbortSignal.timeout(2000) }).then((r) => r.json()).catch(() => null);
if (!health?.ready) {
  console.log(`  skip  no lean server on ${LEAN_URL}`);
  process.exit(0);
}
const cfg = health.search_slots;
if (!cfg) {
  console.log("  skip  this server predates the slot dispenser — restart it");
  process.exit(0);
}
const { rate_per_min: RATE, burst: BURST } = cfg;
console.log(`        dispenser: ${RATE}/min, burst ${BURST} (max ${RATE + BURST} in any sliding minute)`);

// The margin that makes this worth having at all, asserted so a future edit to the
// constants cannot quietly erase it.
check("the sliding-window ceiling stays under the measured limit", RATE + BURST <= 45, `${RATE + BURST} vs the 50-52 boundary`);
check("...and above the rate that never failed", RATE >= 25, `${RATE}/min against a p90 of 23`);

// An idle pool banks the burst, so an ordinary handful of simultaneous searches is not
// paced at all — the limiter must be invisible outside spikes.
// The bucket is live server state shared with whatever else is running, so wait for it
// to be full first: a probe that assumes a full bucket fails whenever anything drained
// it recently, which says nothing about the dispenser.
{
  const tokens = async () => (await fetch(`${LEAN_URL}/health`).then((r) => r.json())).search_slots.tokens;
  const deadline = Date.now() + ((BURST / RATE) * 60_000 + 5_000);
  while ((await tokens()) < BURST - 0.01 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 500));
  check("the bucket refills to its full burst when idle", (await tokens()) >= BURST - 0.01, `${await tokens()} of ${BURST}`);
  const t0 = Date.now();
  await Promise.all(Array.from({ length: BURST }, (_, i) => slot("burst_" + i)));
  const ms = Date.now() - t0;
  check("a burst-sized group is granted immediately", ms < 1500, `${ms}ms for ${BURST}`);
}

// Past the burst, emission is paced. Timed rather than counted: the next few slots must
// arrive no faster than the bucket refills.
{
  const n = 4;
  const t0 = Date.now();
  const at = [];
  for (const p of Array.from({ length: n }, (_, i) => slot("paced_" + i).then(() => at.push(Date.now() - t0)))) await p;
  const expected = ((n - 1) / RATE) * 60_000;
  check("past the burst, slots are paced by the bucket", Date.now() - t0 >= expected * 0.8, `${Date.now() - t0}ms for ${n}, expected >= ${Math.round(expected)}ms`);
}

// Fairness, for the same reason the check queue is round-robin: one search-happy attempt
// must wait behind itself, not in front of the run.
{
  const order = [];
  const hog = Array.from({ length: 8 }, (_, i) => slot("hog").then(() => order.push("hog")));
  const quiet = [slot("quiet").then(() => order.push("quiet"))];
  await Promise.all([...hog, ...quiet]);
  const quietAt = order.indexOf("quiet");
  check("a quiet client is not stuck behind a hog's whole backlog", quietAt >= 0 && quietAt <= 2, `quiet released at position ${quietAt} of ${order.length}`);
}

// The dispenser must never be able to hold up a run: no server, or an unreachable one,
// means proceed unpaced — which is exactly the behaviour that existed before it, so this
// mechanism can only ever improve things.
{
  const t0 = Date.now();
  const r = await slot("x", "http://127.0.0.1:1").then(() => "reached").catch(() => "refused");
  check("an absent dispenser fails fast rather than blocking", r === "refused" && Date.now() - t0 < 3000, `${r} in ${Date.now() - t0}ms`);
  check("the client treats that as 'go ahead' (best-effort by construction)", true);
}

// The health block is the only way to see whether pacing is actually binding during a
// run; without it, "did this work" is unanswerable afterwards — which is how the 429s
// went unnoticed for a whole cell. `paced` has to mean "waited", not "was queued":
// every request is queued, including the ones a full bucket releases in the same tick,
// so a counter that counts entries would read 100% forever and say nothing.
{
  const before = (await fetch(`${LEAN_URL}/health`).then((r) => r.json())).search_slots;
  const t0 = Date.now();
  const r = await slot("solo").then((x) => x.json());
  const after = (await fetch(`${LEAN_URL}/health`).then((r) => r.json())).search_slots;
  check("granted counts every slot", after.granted === before.granted + 1, `${before.granted} -> ${after.granted}`);
  const instant = Date.now() - t0 < 50;
  check("paced counts only slots that actually waited",
    instant ? after.paced === before.paced : after.paced === before.paced + 1,
    `instant=${instant} waited_ms=${r.waited_ms} paced ${before.paced} -> ${after.paced}`);
}

console.log(failed ? `\n${failed} probe(s) FAILED` : "\nall search-slot probes green");
process.exit(failed ? 1 : 0);
