#!/usr/bin/env node
// Scripted probes for runner/render.js — the invariants the check channel is supposed to
// guarantee, stated as assertions rather than as comments. No Lean, no server: this is
// pure string work, so it runs in milliseconds and can gate every re-freeze.
//
//   node scripts/probe-render.mjs
import { renderCheck, RENDER_CAP } from "../runner/render.js";

let failed = 0;
const check = (name, cond, detail = "") => {
  console.log(`${cond ? "  ok  " : "  FAIL"}  ${name}${cond || !detail ? "" : `\n        ${detail}`}`);
  if (!cond) failed++;
};
const err = (line, text) => ({ severity: "error", line, column: 0, text });
const warn = (line, text) => ({ severity: "warning", line, column: 0, text });
const sorry = (line, goal = "⊢ True") => ({ line, goal });
const big = (n) => "x".repeat(n);

// 1-3. Header states the verdict, and every sorry line is in it.
{
  const { pretty, ok } = renderCheck({ messages: [err(12, "boom")], sorries: [sorry(44), sorry(88)] });
  const head = pretty.split("\n")[0];
  check("header states FAILED with counts", head.startsWith("FAILED — 1 error, 2 sorries at line 44, 88"), head);
  check("ok is false when an error is present", ok === false);
  const clean = renderCheck({ messages: [], sorries: [] });
  check("clean compile says CLEAN", clean.pretty === "CLEAN — no errors, no sorries", clean.pretty);
  const inc = renderCheck({ messages: [], sorries: [sorry(7)] });
  check("no errors but a sorry is INCOMPLETE", inc.pretty.startsWith("INCOMPLETE — no errors, 1 sorry at line 7"), inc.pretty);
}

// 4. Order: errors, then sorries, then warnings.
{
  const { pretty } = renderCheck({ messages: [warn(3, "tidy up"), err(9, "boom")], sorries: [sorry(50)] });
  // Measured in the BODY: the header names the sorry lines too, which is the point of it.
  const body = pretty.slice(pretty.indexOf("\n"));
  const iErr = body.indexOf("boom"), iSorry = body.indexOf("sorry at line 50, goal:"), iWarn = body.indexOf("tidy up");
  check("errors before sorries before warnings", iErr < iSorry && iSorry < iWarn, `${iErr} ${iSorry} ${iWarn}`);
}

// 5-6. Identical messages collapse to one plus a locator list.
{
  const same = [err(1, "unknown identifier 'foo'"), err(5, "unknown identifier 'foo'"), err(9, "unknown identifier 'foo'")];
  const { pretty } = renderCheck({ messages: same, sorries: [] });
  check("duplicate error text printed once", pretty.split("unknown identifier 'foo'").length - 1 === 1, pretty);
  check("every duplicate site still located", pretty.includes("(same message also at 5:0, 9:0)"), pretty);
}

// 7-10. Heartbeat notes: once per check per budget, only when that budget timed out, and
// never telling an agent that a raise it IS allowed to make will not help.
{
  const t = "(deterministic) timeout at `whnf`, maximum number of heartbeats (400000) has been reached";
  const s = "(deterministic) timeout at `typeclass`, maximum number of heartbeats (20000) has been reached\n\nNote: Use `set_option synthInstance.maxHeartbeats <num>` to set the limit.";
  const { pretty } = renderCheck({ messages: [err(1, t), err(2, t.replace("whnf", "elab"))], sorries: [], maxHeartbeats: 400000 });
  check("heartbeat note appears once", pretty.split("NOTE (harness)").length - 1 === 1);
  const none = renderCheck({ messages: [err(1, "boom")], sorries: [], maxHeartbeats: 400000 });
  check("no heartbeat note without a timeout", !none.pretty.includes("NOTE (harness)"));
  const si = renderCheck({ messages: [err(1, s)], sorries: [], maxHeartbeats: 400000 });
  check("a synthInstance timeout is NOT told that raising is futile",
    si.pretty.includes("You MAY raise it") && !si.pretty.includes("can only lower that"), si.pretty.slice(-200));
  const both = renderCheck({ messages: [err(1, t), err(2, s)], sorries: [], maxHeartbeats: 400000 });
  check("a file hitting both budgets gets both notes, one each",
    both.pretty.includes("can only lower that") && both.pretty.includes("You MAY raise it") &&
    both.pretty.split("NOTE (harness)").length - 1 === 2);
}

// 9-12. The cap: errors absorb it, sorries and warnings survive, the header always does.
{
  const messages = Array.from({ length: 40 }, (_, i) => err(i + 1, big(1000) + i));
  const sorries = [sorry(500, "⊢ the goal that decides whether we are done"), sorry(900)];
  const { pretty, full } = renderCheck({ messages, sorries, outputName: ".check/last.txt" });
  check("capped output respects the cap", pretty.length <= RENDER_CAP, `${pretty.length}`);
  check("the cut lands in the errors", pretty.includes("[... errors truncated"), pretty.slice(-200));
  check("every sorry goal survives the cut", pretty.includes("the goal that decides whether we are done") && pretty.includes("sorry at line 900"));
  check("header still lists both sorry lines", pretty.split("\n")[0].includes("at line 500, 900"), pretty.split("\n")[0]);
  check("full output is uncapped and pointer-free", full.length > RENDER_CAP && !full.includes(".check/last.txt"));
  check("pointer is on the header of every check", pretty.split("\n")[0].endsWith("· full output: .check/last.txt"));
}

// 13. Pathological: the sorries alone overflow. The header must still be intact and the
// output must still respect the cap — this is the case the old prefix slice ate first.
{
  const sorries = Array.from({ length: 14 }, (_, i) => sorry(i + 1, big(3000)));
  const { pretty } = renderCheck({ messages: [err(1, big(9000))], sorries, outputName: ".check/last.txt" });
  const head = pretty.split("\n")[0];
  check("overflowing sorries: cap held, header intact", pretty.length <= RENDER_CAP && head.startsWith("FAILED — 1 error, 14 sorries at line 1, 2, 3"), `${pretty.length} / ${head.slice(0, 90)}`);
}

// 14. A snippet is labelled as one (block C workers read `snippet:LINE`, not problem.lean).
{
  const { pretty } = renderCheck({ messages: [err(3, "boom")], sorries: [], label: "snippet" });
  check("snippet label is used for positions", pretty.includes("error: snippet:3:0: boom"), pretty);
}

console.log(failed ? `\n${failed} probe(s) FAILED` : "\nall render probes green");
process.exit(failed ? 1 : 0);
