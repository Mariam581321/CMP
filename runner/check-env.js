// Everything that decides what a CHECK IS: the text the server injects into every
// submitted file, the bounds that stop one check owning a worker forever, and the
// fingerprint that ties a running server to this checkout.
//
// It lives in its own module because BOTH sides need it: the lean server enforces it,
// and run.js verifies that the server it is about to launch against (the watchdog keeps
// one alive for days, across git pulls) is enforcing THIS checkout's version of it.
// Everything server-side that can move a verdict or a check's visible output is hashed
// into CHECK_SHA and refused on mismatch.

import { createHash } from "node:crypto";
import { MAX_HEARTBEATS } from "./common.js";

// --- what every check gets injected ------------------------------------------

// Style linters, off at source. They are advice about tidiness, none of them can
// change a verdict (the grade is compiles / sorry-free / statement intact / axioms
// clean), and they were a quarter of every byte the check channel spent, the main
// cause of truncated check output. Deliberately NOT in the list:
//   * `linter.deprecated` — `Use \`map_add\` instead` is free retrieval, the compiler
//     handing the agent the modern name;
//   * `linter.dupNamespace` — the only lint here that flags a GRADER-visible fault: a
//     file that nests `Problem1` inside `Problem1` compiles fine and grades as
//     "declaration missing", because the grader looks declarations up by qualified name;
//   * anything blanket (`linter.all`) — it would take both of the above with it.
// Every name is a registered option in the v4.27.0 pin (core, Batteries, Mathlib); an
// unknown option is an ERROR, so a typo here reds every check in a run. scripts/
// probe-check-env.mjs compiles each one against the live server for exactly that reason.
export const LINTERS = [
  "unusedSimpArgs", "unnecessarySimpa", "unusedVariables", "unnecessarySeqFocus",
  "unusedTactic", "unreachableTactic", "unusedSectionVars", "unusedRCasesPattern",
];
const LINTERS_OFF = LINTERS.map((l) => `set_option linter.${l} false`).join(" ");

// Typeclass synthesis gets the same budget as everything else. Lean's default is
// 20 000 heartbeats per instance problem, 20x below our elaboration cap and, on this
// benchmark (quotients, localizations, algebra towers), the most common timeout site and
// the only budget agents ever asked to raise, so a limit nobody chose was deciding what
// compiles. One number now governs both: a search may use up to the whole declaration's
// allowance, and `clampHeartbeats` still lets a file LOWER either. The cost: an instance
// that does NOT exist fails after up to MAX_HEARTBEATS instead of 20 000, so a fast
// "failed to synthesize" can become a timeout at the outer cap.
const SYNTH_INSTANCE_BUDGET = `set_option synthInstance.maxHeartbeats ${MAX_HEARTBEATS}`;

// One physical line, always. Lean parses commands whitespace-separated, so several
// `set_option`s share a line happily — and spending an extra line here would shift every
// reported line number by one against the file the agent is editing.
export const PREPARE_HEAD = `set_option maxHeartbeats ${MAX_HEARTBEATS} ${SYNTH_INSTANCE_BUDGET} ${LINTERS_OFF}`;

// A file that could set its own `maxHeartbeats` would be writing its own verdict, so any
// value it asks for is clamped to the harness cap (0 means "no limit" in Lean and is the
// obvious way out, hence the explicit case). LOWERING is left alone: it can only make the
// file fail sooner, which is the file's business, and `set_option maxHeartbeats 200 in`
// is a legitimate way to keep a `decide` honest. The rewrite is textual and per line, so
// error line numbers stay aligned with the file the agent is looking at; it therefore
// also rewrites the option inside comments and strings, which is the harmless direction.
// `synthInstance.maxHeartbeats` and friends match too — same argument, same clamp.
// Not covered: setting the option from metaprogramming (`run_cmd modifyEnv ...`). Nothing
// lexical can be; that is what the grader's axiom check and the suspicious-keyword
// tripwire are for, and an honest proof contains no metaprogramming at all.
// The numeral matches every form Lean accepts — plain, `_` separators, 0x/0b/0o — or the
// clamp is a lexical gate an agent can walk around with `400_000_000`. Number() parses
// all of those once the underscores are stripped; anything it cannot parse is clamped
// too (a numeral we cannot read must not be one we wave through).
const HEARTBEAT_OPTION = /(\bset_option\s+(?:\w+\.)*maxHeartbeats\s+)((?:0[xXbBoO])?[0-9a-fA-F_]+)/g;
export const clampHeartbeats = (line) =>
  line.replace(HEARTBEAT_OPTION, (whole, head, n) => {
    const v = Number(n.replace(/_/g, ""));
    return Number.isFinite(v) && v > 0 && v <= MAX_HEARTBEATS ? whole : `${head}${MAX_HEARTBEATS}`;
  });

// Replace import lines (Mathlib is already in the env); the first one becomes the
// PREPARE_HEAD so line numbers in errors stay aligned with the agent's file. The cap is
// a file-level `set_option`, so it applies to every declaration BELOW it and each one
// gets the full allowance — the bound is per declaration, not per file (a file with many
// expensive declarations can still cost arbitrarily much CPU in total; that is the CPU
// fuse's business, and no longer any verdict's).
export function prepare(code) {
  const lines = code.split("\n").map(clampHeartbeats);
  let capPlaced = false;
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*import\s/.test(lines[i])) {
      lines[i] = capPlaced ? "" : PREPARE_HEAD;
      capPlaced = true;
    }
  }
  let shifted = 0;
  if (!capPlaced) {
    lines.unshift(PREPARE_HEAD);
    shifted = 1;
  }
  return { text: lines.join("\n"), shifted };
}

// --- the bound chain ---------------------------------------------------------
//
// THE FOUR BOUNDS ARE A CHAIN, AND IT IS DERIVED HERE RATHER THAN ASSERTED IN COMMENTS:
//
//   CPU fuse  <  wall fuse  <  retry deadline  <  client wait
//
// Break the order and raising the CPU fuse makes things WORSE, not better: the client
// hangs up before the fuse fires and the agent gets a connection error, a harsher
// failure than the `unavailable` it replaced. The retry deadline is only tested BETWEEN
// attempts, so the last attempt can run a full wall fuse past it; deriving the outer
// bounds from the inner ones keeps that arithmetic right.
//
// CPU fuse — machine protection, NOT a budget and never a verdict. Any verdict defined
// by a measured quantity has a noise band around its threshold (the same file measured
// repeatedly lands on both sides of it), so deciding is the heartbeat cap's job
// (MAX_HEARTBEATS); this exists only to stop one check occupying a worker indefinitely,
// set far from the action, where tripping it says "this file cannot be compiled on this
// machine at all", not "this file fails". A large FATE-X proof compiles in minutes, and
// a fuse close to that was killing legitimate files at an arm-dependent rate. A worker
// hour is cheap and a lost verdict is not.
export const CPU_FUSE_MS = parseInt(process.env.CMP_CPU_FUSE_MS ?? "3600000");
// Wall-clock backstop. A check consuming no CPU at all (true hang, or .olean page-fault
// thrash under memory pressure) can never reach the CPU fuse, so something has to break
// it. Kept ABOVE the CPU fuse so that a CPU-bound check trips the bound that describes
// it: on a busy box wall >= cpu always, and a wall kill on a file that was in fact
// burning CPU would log the less informative of the two.
export const WALL_FUSE_MS = parseInt(process.env.CMP_WALL_FUSE_MS ?? "5400000");
// Retries are capped because a check that really IS the balloon would otherwise re-kill
// a worker on every attempt — the exact starvation the fuses exist to stop. Retrying is
// worth it when a kill is a machine event (load, memory pressure, a leaking worker); it
// is worth nothing when the cost is a property of the file: something that burns an hour
// of CPU once burns it again. The fuse's SIZE is what keeps kills away from the agent
// now; this only decides how long we take to admit one.
export const MAX_KILLS = 2;
// Slack for the shared queue: a check waits behind its own client's backlog before each
// attempt (round-robin across clients), and both outer bounds have to absorb that.
const QUEUE_SLACK_MS = 30 * 60_000;
// Every kill the server hides has to fit inside this, or the retry it promised never
// happens.
export const RETRY_DEADLINE_MS = MAX_KILLS * WALL_FUSE_MS + QUEUE_SLACK_MS;
// ...and the whole retry story has to fit inside the client's patience, including the
// final attempt that starts just under the deadline. postCheck() sets this as a hard
// socket timeout and destroys the request when it expires, so a client that gives up
// first converts a fuse kill — which the server hides and retries — into a connection
// error the agent DOES see. The queue is serialized; be patient.
export const CLIENT_WAIT_MS = RETRY_DEADLINE_MS + WALL_FUSE_MS + QUEUE_SLACK_MS;

// --- fingerprint -------------------------------------------------------------

// Everything above, as the server would report it. Anything that can change what a
// check decides or what it looks like belongs in here; anything that cannot, must not
// (a run refuses to launch on a mismatch, so a field that moves for unrelated reasons
// would just teach people to bypass the check).
export function checkEnv() {
  return {
    max_heartbeats: MAX_HEARTBEATS,
    prepare_head: PREPARE_HEAD,
    cpu_fuse_ms: CPU_FUSE_MS,
    wall_fuse_ms: WALL_FUSE_MS,
    max_kills: MAX_KILLS,
    retry_deadline_ms: RETRY_DEADLINE_MS,
  };
}
export const CHECK_SHA = createHash("sha256").update(JSON.stringify(checkEnv())).digest("hex").slice(0, 16);

// Field-by-field diff for the launch refusal, so the message names what actually moved
// instead of printing two hashes.
export function checkEnvDiff(theirs) {
  const mine = checkEnv();
  return Object.keys(mine)
    .filter((k) => JSON.stringify(mine[k]) !== JSON.stringify(theirs?.[k]))
    .map((k) => `    ${k}:\n      server:   ${theirs?.[k] ?? "(absent)"}\n      checkout: ${mine[k]}`);
}
