#!/usr/bin/env node
// Scripted probes for the block C machinery (PLAN.md): the add_fact gate, the
// check_snippet bank prefix, and (with --worker, costs ~1 cent of DeepSeek) one real
// worker subprocess end-to-end. Needs the lean server up.
//
//   node scripts/probe-blockc.mjs            # gate + prefix probes (free, REPL only)
//   node scripts/probe-blockc.mjs --worker   # plus one live runWorker round-trip

import { mkdtempSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { addFact } from "../runner/facts.js";
import { checkSnippet } from "../runner/snippet.js";
import { postCheck, costStd, green, red, bold } from "../runner/common.js";
import { CLIENT_WAIT_MS } from "../runner/stmt.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
let pass = 0, fail = 0;
const check = (name, ok, detail = "") => {
  console.log(`  ${ok ? green("✓") : red("✗")} ${name}${ok || !detail ? "" : `\n      ${detail.split("\n").join("\n      ")}`}`);
  ok ? pass++ : fail++;
};

const dir = mkdtempSync(join(tmpdir(), "cmp-factprobe-"));
const factsFile = join(dir, "facts.lean");
const opts = { factsFile, client: "probe-blockc" };

// --- add_fact gate -----------------------------------------------------------
{
  const r = await addFact("theorem cmpfact_a : 2 + 2 = 4 := by norm_num", opts);
  check("green fact admitted", r.ok === true && r.names?.join() === "cmpfact_a", r.pretty);
}
{
  const r = await addFact("theorem cmpfact_b : 4 = 2 + 2 := cmpfact_a.symm", opts);
  check("fact building on the bank admitted", r.ok === true, r.pretty);
}
{
  const r = await addFact("theorem cmpfact_c : 1 = 2 := by sorry", opts);
  check("sorry rejected", r.ok === false && /sorry/.test(r.pretty), r.pretty);
}
{
  const r = await addFact("axiom cmpfact_ax : False", opts);
  check("axiom declaration rejected (lexical)", r.ok === false && /axiom/.test(r.pretty), r.pretty);
}
{
  const r = await addFact("theorem cmpfact_nd : (2 : Nat) + 2 = 4 := by native_decide", opts);
  check("native_decide rejected", r.ok === false && /native_decide/.test(r.pretty), r.pretty);
}
{
  const r = await addFact("namespace CmpProbe\ntheorem cmpfact_open : True := trivial", opts);
  check("unbalanced namespace rejected", r.ok === false && /unbalanced/.test(r.pretty), r.pretty);
}
{
  const r = await addFact("example : True := trivial", opts);
  check("nameless code rejected", r.ok === false && /named declaration/.test(r.pretty), r.pretty);
}
{
  const r = await addFact("theorem cmpfact_a : 2 + 2 = 4 := by norm_num", opts);
  check("duplicate name rejected as bank conflict", r.ok === false && /already been declared|conflicts/.test(r.pretty), r.pretty);
}
{
  const r = await addFact("theorem cmpfact_bad : 2 + 2 = 5 := by norm_num", opts);
  const m = /fact:(\d+):/.exec(r.pretty ?? "");
  check("compile error re-labeled to the candidate's line 1", r.ok === false && m?.[1] === "1", r.pretty);
}
{
  // Two concurrent adds through the lock: both must be admitted (serialized), and the
  // bank as a whole must still compile.
  const [r1, r2] = await Promise.all([
    addFact("theorem cmpfact_p1 : 3 + 3 = 6 := by norm_num", opts),
    addFact("theorem cmpfact_p2 : 5 + 5 = 10 := by norm_num", opts),
  ]);
  check("concurrent adds both serialized through the lock", r1.ok === true && r2.ok === true, `${r1.pretty}\n${r2.pretty}`);
  const bank = readFileSync(factsFile, "utf8");
  const whole = await postCheck({ code: bank, client: "probe-blockc" }, CLIENT_WAIT_MS);
  const okWhole = !whole.error && (whole.messages ?? []).every((m) => m.severity !== "error");
  check("bank as a whole compiles after all admissions", okWhole, whole.pretty ?? whole.error);
}

// --- check_snippet with the bank in scope ------------------------------------
{
  const bank = readFileSync(factsFile, "utf8");
  const r = await checkSnippet("theorem cmpfact_use : 2 + 2 = 4 := cmpfact_a", { client: "probe-blockc", prefix: bank });
  check("snippet sees bank facts via prefix", r.ok === true, r.pretty);
  const r2 = await checkSnippet("theorem cmpfact_oops : 2 + 2 = 5 := cmpfact_a", { client: "probe-blockc", prefix: bank });
  const m = /snippet:(\d+):/.exec(r2.pretty ?? "");
  check("prefixed snippet errors re-labeled to snippet coordinates", r2.ok === false && m?.[1] === "1", r2.pretty);
}

// --- one real worker (paid, flag-gated) --------------------------------------
if (process.argv.includes("--worker")) {
  const dotenv = join(ROOT, ".env");
  if (existsSync(dotenv)) process.loadEnvFile(dotenv);
  process.env.PATH = `${process.env.HOME}/.local/node/bin:${process.env.HOME}/.elan/bin:${process.env.PATH}`;
  process.env.CMP_LEAN_ENV = join(ROOT, "lean-env");
  process.env.PI_CODING_AGENT_DIR = join(ROOT, "pi-agent");
  const { runWorker } = await import("../runner/spawn.js");
  const cfg = {
    problem: "probe-blockc",
    original_file: join(dir, "problem.lean"),
    combo: ["lean-facts"],
    model: "deepseek/deepseek-v4-flash",
    thinking: "low",
    max_tokens: 384000,
    workers_dir: join(dir, "workers"),
    facts_file: factsFile,
  };
  const { writeFileSync } = await import("node:fs");
  writeFileSync(cfg.original_file, "import Mathlib\n\ntheorem probe_target : 1 + 1 = 2 := by sorry\n");
  console.log("  … running one live worker (deepseek, ~1 cent)");
  const { promise } = runWorker({
    idx: 1,
    task:
      "Subtask: verify with check_snippet that `theorem probe_two : 1 + 1 = 2 := by norm_num` compiles, " +
      "add it to the fact bank with add_fact, then report. Keep it to these two tool calls plus the report.",
    cfg,
    onTokens: () => {},
  });
  const r = await promise;
  check("worker completed", r.end === "completed", `end=${r.end}`);
  check("worker produced a report", !!r.report, JSON.stringify(r.report)?.slice(0, 300));
  check("worker usage tailed (cost > 0)", costStd(r.stats.tokens) > 0, JSON.stringify(r.stats.tokens));
  const wj = join(cfg.workers_dir, "w1", "worker.json");
  check("worker.json written", existsSync(wj), wj);
  const bank = existsSync(factsFile) ? readFileSync(factsFile, "utf8") : "";
  check("worker's add_fact reached the shared bank", /probe_two/.test(bank), bank.slice(-300));
  console.log(`\n  worker report:\n${(r.report ?? "").split("\n").map((l) => "    " + l).join("\n")}`);
}

console.log(bold(`\n${pass} passed, ${fail} failed`));
rmSync(dir, { recursive: true, force: true });
process.exit(fail ? 1 : 0);
