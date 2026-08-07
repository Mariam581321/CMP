// Probe the supervisor's continuation policy (extensions/supervisor.ts) — the REAL
// module, not a re-implementation, imported under --experimental-strip-types and driven
// by a fake pi. The check round-trip is real too: a stub HTTP server stands in for the
// lean server via CMP_LEAN_PORT (read at module load in runner/common.js, so the stub
// must be listening BEFORE the import below).
//
// Policy under test (the 0805 incident): a transport-errored turn (stopReason "error",
// zero usage, no tool calls) must NOT spend the nudge budget — three attempts died in
// error,error,NUDGE,... spirals with money unspent — but it gets its own bound
// (max_error_streak), because an errored turn books zero tokens and is therefore
// invisible to the spend cap. Also pinned here: checkStatus(check ?? {ok:false}) — a
// null check result must nudge ("no check result available"), not end the attempt as
// verified-done.
//
// serverCheck path only (no original_file in CMP_CONFIG): the checkedCompile path
// read-merge-writes the repo-root problems/stmt-types.json cache, which a probe must
// never touch.
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

let failed = 0;
function check(name, cond, detail = "") {
  if (cond) console.log(`ok   ${name}`);
  else { failed++; console.log(`FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
}

// --- stub lean server (must precede the extension import) --------------------
const NOT_DONE = { ok: false, messages: [{ severity: "error", line: 3, column: 0, text: "unsolved goals" }], sorries: [], pretty: "unsolved goals" };
const DONE = { ok: true, messages: [], sorries: [], pretty: "COMPLETE" };
let reply = NOT_DONE; // JSON body, or a string for a garbage (unparseable) response
let hits = 0;
const stub = createServer((req, res) => {
  req.resume();
  req.on("end", () => {
    hits++;
    res.setHeader("content-type", "application/json");
    res.end(typeof reply === "string" ? reply : JSON.stringify(reply));
  });
});
await new Promise((r) => stub.listen(0, "127.0.0.1", r));
process.env.CMP_LEAN_PORT = String(stub.address().port);

const { default: supervisor } = await import(join(HERE, "..", "extensions", "supervisor.ts"));

// --- per-scenario harness ----------------------------------------------------
// Fresh supervisor per scenario: every ledger is closure state. cwd is captured at
// registration (supervisor.ts uses process.cwd() as the work dir), so chdir first.
function boot(cfg = {}) {
  const attempt = mkdtempSync(join(tmpdir(), "cmp-sup-"));
  const work = join(attempt, "work");
  mkdirSync(work);
  writeFileSync(join(work, "problem.lean"), "theorem t : True := by sorry\n");
  process.env.CMP_CONFIG = JSON.stringify({ problem: "probe", budget_std: 0, max_nudges: 3, tools: ["lean_check", "read"], ...cfg });
  process.chdir(work);
  const handlers = {};
  const sent = [];
  supervisor({
    on: (e, h) => { (handlers[e] ??= []).push(h); },
    sendUserMessage: (text, opts) => sent.push({ text, opts }),
  });
  const emit = async (e, ev) => { for (const h of handlers[e] ?? []) await h(ev); };
  // One agent-loop turn: optional tool calls, then the run-ending assistant message,
  // then agent_end carrying that run's messages (the shape agent-loop emits).
  const turn = async (stopReason, tools = [], usage = { input: 0, output: 0, cacheRead: 0 }) => {
    for (const t of tools) await emit("tool_execution_start", { toolName: t });
    const m = { role: "assistant", stopReason, usage, content: [] };
    await emit("message_end", { message: m });
    await emit("agent_end", { messages: [m] });
  };
  const done = () => { process.chdir(HERE); rmSync(attempt, { recursive: true, force: true }); };
  return { attempt, work, sent, turn, emit, done };
}

// (a) baseline unchanged: 4 stalls -> 3 nudges, 4th silent
{
  reply = NOT_DONE;
  const s = boot();
  for (let i = 0; i < 4; i++) await s.turn("stop");
  check("a: 3 nudges then give-up on pure stalls", s.sent.length === 3, `sent=${s.sent.length}`);
  s.done();
}

// (b) real tool activity resets the ledger: 3 stalls, 1 working turn, 3 stalls -> 7 nudges
{
  const s = boot();
  for (let i = 0; i < 3; i++) await s.turn("stop");
  await s.turn("stop", ["lean_check"]);
  for (let i = 0; i < 3; i++) await s.turn("stop");
  check("b: progress resets the no-progress ledger", s.sent.length === 7, `sent=${s.sent.length}`);
  s.done();
}

// (b') read does not count as progress
{
  const s = boot();
  for (let i = 0; i < 4; i++) await s.turn("stop", ["read"]);
  check("b': read-only turns still count as no-progress", s.sent.length === 3, `sent=${s.sent.length}`);
  s.done();
}

// (c) THE regression: errors do not spend the nudge budget. 5 errors + 4 stalls ->
// 8 nudges (old code: 3 nudges, dead at turn 4).
{
  const s = boot();
  for (let i = 0; i < 5; i++) await s.turn("error");
  for (let i = 0; i < 4; i++) await s.turn("stop");
  check("c: 5 errors + 4 stalls -> 8 nudges (errors exempt from ledger)", s.sent.length === 8, `sent=${s.sent.length}`);
  s.done();
}

// (d) the error ledger has its own bound, and the give-up branch skips the check round-trip
{
  const s = boot({ max_error_streak: 3 });
  const before = hits;
  for (let i = 0; i < 4; i++) await s.turn("error");
  check("d: error streak past cap goes silent", s.sent.length === 3, `sent=${s.sent.length}`);
  check("d: give-up branch does not hit the server", hits - before === 3, `hits=${hits - before}`);
  s.done();
}

// (e) a successful turn resets the error streak
{
  const s = boot({ max_error_streak: 3 });
  for (let i = 0; i < 3; i++) await s.turn("error");
  await s.turn("stop");
  for (let i = 0; i < 3; i++) await s.turn("error");
  check("e: error streak resets on a non-error turn", s.sent.length === 7, `sent=${s.sent.length}`);
  s.done();
}

// (f) aborted stays silent, before any check
{
  const s = boot();
  const before = hits;
  await s.turn("aborted");
  check("f: aborted turn sends nothing", s.sent.length === 0, `sent=${s.sent.length}`);
  check("f: aborted turn does not hit the server", hits === before, `hits=${hits - before}`);
  s.done();
}

// (h) verified done ends silently and does not consume the ledger
{
  const s = boot();
  reply = DONE;
  await s.turn("stop");
  check("h: done turn sends nothing", s.sent.length === 0, `sent=${s.sent.length}`);
  reply = NOT_DONE;
  for (let i = 0; i < 4; i++) await s.turn("stop");
  check("h: done turn left the full nudge budget", s.sent.length === 3, `sent=${s.sent.length}`);
  s.done();
}

// (i) STOP file aborts before any check
{
  const s = boot();
  writeFileSync(join(s.attempt, "STOP"), "");
  const before = hits;
  await s.turn("stop");
  check("i: STOP file sends nothing", s.sent.length === 0, `sent=${s.sent.length}`);
  check("i: STOP file does not hit the server", hits === before, `hits=${hits - before}`);
  s.done();
}

// (j) spent budget stops nudging, before any check (usage is per-million in costStd)
{
  const s = boot({ budget_std: 0.001 });
  const before = hits;
  await s.turn("stop", [], { input: 100e6, output: 0, cacheRead: 0 });
  check("j: spent budget sends nothing", s.sent.length === 0, `sent=${s.sent.length}`);
  check("j: spent budget does not hit the server", hits === before, `hits=${hits - before}`);
  s.done();
}

// (k) the deciding guard collapses concurrent agent_ends into one decision
{
  const s = boot();
  const m = { role: "assistant", stopReason: "stop", usage: { input: 0, output: 0 }, content: [] };
  await s.emit("message_end", { message: m });
  const p1 = s.emit("agent_end", { messages: [m] });
  const p2 = s.emit("agent_end", { messages: [m] });
  await p1; await p2;
  check("k: re-entrant agent_end yields exactly one nudge", s.sent.length === 1, `sent=${s.sent.length}`);
  s.done();
}

// (l) an unusable check result nudges ("no check result available") instead of
// ending the attempt as done — the checkStatus(check ?? {ok:false}) contract
{
  const s = boot();
  reply = "this is not json";
  await s.turn("stop");
  reply = NOT_DONE;
  check("l: garbage check result still nudges", s.sent.length === 1, `sent=${s.sent.length}`);
  check("l: nudge admits there is no check result", s.sent[0]?.text.includes("no check result available") ?? false);
  s.done();
}

// (m) the error-turn continuation is byte-identical to a stall nudge — the fix must be
// invisible to agents
{
  const s1 = boot();
  await s1.turn("stop");
  s1.done();
  const s2 = boot();
  await s2.turn("error");
  s2.done();
  check("m: error continuation text identical to a stall nudge", s1.sent[0]?.text === s2.sent[0]?.text);
}

stub.close();
if (failed) { console.log(`${failed} check(s) FAILED`); process.exit(1); }
console.log("probe-supervisor: all checks passed");
