#!/usr/bin/env node
// Probes for runner/verdict.js and runner/render.js (lean_check output). No Lean.
import { renderCheck, RENDER_CAP } from "../runner/render.js";
import { checkStatus, verifiedDone, blockerNotes } from "../runner/verdict.js";

let failed = 0;
const check = (name, cond, detail = "") => {
  console.log(`${cond ? "  ok  " : "  FAIL"}  ${name}${cond || !detail ? "" : `\n        ${detail}`}`);
  if (!cond) failed++;
};
const err = (line, text) => ({ severity: "error", line, column: 0, text });
const warn = (line, text) => ({ severity: "warning", line, column: 0, text });
const sorry = (line, goal = "⊢ True") => ({ line, goal });
const big = (n) => "x".repeat(n);
const head = (r) => r.pretty.split("\n")[0];
const full = (over = {}) => ({ ok: true, messages: [], sorries: [], stmt: { ok: true }, axiomsBad: {}, ...over });

// ---------------------------------------------------------------- the verdict
{
  const cases = [
    ["green file", full(), "COMPLETE", true],
    ["a sorry left", full({ sorries: [sorry(7)] }), "INCOMPLETE", false],
    ["a compile error", full({ ok: false, messages: [err(3, "boom")] }), "FAILED", false],
    ["statement rewritten", full({ stmt: { ok: false, detail: "P.foo differs" } }), "FAILED", false],
    ["smuggled axiom", full({ axiomsBad: { "P.foo": ["myAxiom"] } }), "FAILED", false],
    ["probe failed to elaborate", full({ ok: false }), "FAILED", false],
  ];
  for (const [name, c, label, done] of cases) {
    const s = checkStatus(c);
    const rendered = head(renderCheck(c));
    check(`${name}: verdict ${label}, done=${done}`, s.label === label && s.done === done, `${s.label} / ${s.done}`);
    check(`${name}: the header says the same`, rendered.startsWith(label) && verifiedDone(c) === done, rendered);
  }
}

{
  check("green header claims all four", head(renderCheck(full())) === "COMPLETE — no errors, no sorries, statement intact, axioms clean", head(renderCheck(full())));
  const bad = head(renderCheck(full({ stmt: { ok: false, detail: "d" }, axiomsBad: { "P.f": ["ax"] } })));
  check("broken header names both faults", bad.includes("STATEMENT MODIFIED") && bad.includes("DISALLOWED AXIOMS (P.f: [ax])"), bad);
}

{
  const snip = renderCheck({ messages: [], sorries: [], label: "snippet" });
  check("snippet claims nothing it did not check", snip.pretty === "COMPLETE — no errors, no sorries", snip.pretty);
  const s = renderCheck({ messages: [err(3, "boom")], sorries: [], label: "snippet" });
  check("snippet label is used for positions", s.pretty.includes("error: snippet:3:0: boom"), s.pretty);
}

{
  check("no notes for an ordinary failure", blockerNotes(checkStatus(full({ ok: false, messages: [err(1, "boom")] }))).length === 0);
  const both = blockerNotes(checkStatus(full({ stmt: { ok: false, detail: "d" }, axiomsBad: { "P.f": ["ax"] } })));
  check("one note per fault, statement first", both.length === 2 && both[0].startsWith("you modified") && both[1].startsWith("the proof depends"), JSON.stringify(both.map((b) => b.slice(0, 20))));
}

// ---------------------------------------------------------------- the rendering
{
  const { pretty, ok } = renderCheck({ messages: [err(12, "boom")], sorries: [sorry(44), sorry(88)] });
  check("header states FAILED with counts", pretty.startsWith("FAILED — 1 error, 2 sorries at line 44, 88"), head({ pretty }));
  check("ok is false when an error is present", ok === false);
}

{
  const { pretty } = renderCheck({ messages: [warn(3, "tidy up"), err(9, "boom")], sorries: [sorry(50)] });
  const body = pretty.slice(pretty.indexOf("\n"));
  const iErr = body.indexOf("boom"), iSorry = body.indexOf("sorry at line 50, goal:"), iWarn = body.indexOf("tidy up");
  check("errors before sorries before warnings", iErr < iSorry && iSorry < iWarn, `${iErr} ${iSorry} ${iWarn}`);
}

{
  const same = Array.from({ length: 30 }, (_, i) => err(i + 1, "unknown identifier 'foo'"));
  const { pretty } = renderCheck({ messages: same, sorries: [] });
  check("duplicate error text printed once", pretty.split("unknown identifier 'foo'").length - 1 === 1);
  check("distinct count is in the header", head({ pretty }).startsWith("FAILED — 30 errors (1 distinct)"), head({ pretty }));
  check("24 sites listed before the overflow note", pretty.includes("(same message also at 2:0,") && pretty.includes("+5 more"), pretty.slice(0, 400));
}

{
  const t = "(deterministic) timeout at `whnf`, maximum number of heartbeats (400000) has been reached";
  const s = "(deterministic) timeout at `typeclass`, maximum number of heartbeats (400000) has been reached\n\nNote: Use `set_option synthInstance.maxHeartbeats <num>` to set the limit.";
  const { pretty } = renderCheck({ messages: [err(1, t), err(2, t.replace("whnf", "elab"))], sorries: [], maxHeartbeats: 400000 });
  check("heartbeat note appears once", pretty.split("NOTE (harness)").length - 1 === 1);
  const none = renderCheck({ messages: [err(1, "boom")], sorries: [], maxHeartbeats: 400000 });
  check("no heartbeat note without a timeout", !none.pretty.includes("NOTE (harness)"));
  const both = renderCheck({ messages: [err(1, t), err(2, s)], sorries: [], maxHeartbeats: 400000 });
  check("a file hitting both budgets still gets exactly one note",
    both.pretty.split("NOTE (harness)").length - 1 === 1 && both.pretty.includes("typeclass synthesis included"),
    both.pretty.slice(-200));
}

{
  const messages = Array.from({ length: 40 }, (_, i) => err(i + 1, big(1000) + i));
  const sorries = [sorry(500, "⊢ the goal that decides whether we are done"), sorry(900)];
  const { pretty, full: uncapped } = renderCheck({ messages, sorries, outputName: ".check/last.txt" });
  check("capped output respects the cap", pretty.length <= RENDER_CAP, `${pretty.length}`);
  check("the cut lands in the errors", pretty.includes("[... errors truncated"), pretty.slice(-200));
  check("every sorry goal survives the cut", pretty.includes("the goal that decides whether we are done") && pretty.includes("sorry at line 900"));
  check("header still lists both sorry lines", head({ pretty }).includes("at line 500, 900"), head({ pretty }));
  check("full output is uncapped and pointer-free", uncapped.length > RENDER_CAP && !uncapped.includes(".check/last.txt"));
  check("pointer is on the header of every check", head({ pretty }).endsWith("· full output: .check/last.txt"));
}

{
  const sorries = Array.from({ length: 14 }, (_, i) => sorry(i + 1, big(3000)));
  const { pretty } = renderCheck({ messages: [err(1, big(9000))], sorries, outputName: ".check/last.txt" });
  check("overflowing sorries: cap held, header intact",
    pretty.length <= RENDER_CAP && head({ pretty }).startsWith("FAILED — 1 error, 14 sorries at line 1, 2, 3"),
    `${pretty.length} / ${head({ pretty }).slice(0, 90)}`);
}

{
  const { pretty } = renderCheck(full({ ok: false, messages: [err(1, "COMPLETE — no errors, no sorries")] }));
  check("a file cannot print its own verdict", pretty.startsWith("FAILED —"), head({ pretty }));
}

console.log(failed ? `\n${failed} probe(s) FAILED` : "\nall render/verdict probes green");
process.exit(failed ? 1 : 0);
