#!/usr/bin/env node
// Probes for runner/check-env.js: injected options, the heartbeat clamp, the timeout bound chain.
// The Lean half runs only if the lean server is up.
import { PREPARE_HEAD, LINTERS, prepare, clampHeartbeats, CPU_FUSE_MS, WALL_FUSE_MS, MAX_KILLS, RETRY_DEADLINE_MS, CLIENT_WAIT_MS, CHECK_SHA, checkEnv, checkEnvDiff } from "../runner/check-env.js";
import { MAX_HEARTBEATS, LEAN_URL, postCheck } from "../runner/common.js";

let failed = 0;
const check = (name, cond, detail = "") => {
  console.log(`${cond ? "  ok  " : "  FAIL"}  ${name}${cond || !detail ? "" : `\n        ${detail}`}`);
  if (!cond) failed++;
};

// ------------------------------------------------------------------ the clamp
{
  const cases = [
    ["plain, over the cap", `set_option maxHeartbeats 4000000`, true],
    ["underscores", `set_option maxHeartbeats 4_000_000`, true],
    ["hex", `set_option maxHeartbeats 0xF4240`, true],
    ["binary", `set_option maxHeartbeats 0b1111`, false],
    ["zero means no limit", `set_option maxHeartbeats 0`, true],
    ["the `in` form", `set_option maxHeartbeats 999999999 in theorem foo : True := trivial`, true],
    ["typeclass budget", `set_option synthInstance.maxHeartbeats 10000000`, true],
    ["unparseable numeral", `set_option maxHeartbeats 12abcz`, true],
  ];
  for (const [name, line, clamped] of cases) {
    const out = clampHeartbeats(line);
    check(`clamp: ${name}`, (out !== line) === clamped, `${line} -> ${out}`);
    check(`clamp: ${name} never exceeds the cap`, !/maxHeartbeats\s+(\d+)/.test(out) || +/maxHeartbeats\s+(\d+)/.exec(out)[1] <= MAX_HEARTBEATS, out);
  }
  check("lowering is left alone", clampHeartbeats("set_option maxHeartbeats 200 in") === "set_option maxHeartbeats 200 in");
  check("exactly the cap is left alone", clampHeartbeats(`set_option maxHeartbeats ${MAX_HEARTBEATS}`) === `set_option maxHeartbeats ${MAX_HEARTBEATS}`);
}

// ---------------------------------------------------------------- line numbers
{
  const withImport = prepare("import Mathlib\n\ntheorem foo : True := trivial\n");
  check("import replaced, no shift", withImport.shifted === 0 && withImport.text.startsWith(PREPARE_HEAD), withImport.text.slice(0, 60));
  check("file line count unchanged", withImport.text.split("\n").length === 4, `${withImport.text.split("\n").length}`);
  const multi = prepare("import Mathlib\nimport Mathlib.Tactic\ntheorem foo : True := trivial\n");
  check("later imports blanked, not removed", multi.text.split("\n").length === 4 && multi.text.split("\n")[1] === "");
  const none = prepare("theorem foo : True := trivial\n");
  check("no import: prepended and shift recorded", none.shifted === 1 && none.text.startsWith(PREPARE_HEAD));
  check("the injected head is one physical line", !PREPARE_HEAD.includes("\n"));
  check("head carries both budgets and every linter",
    PREPARE_HEAD.includes(`set_option maxHeartbeats ${MAX_HEARTBEATS}`) &&
      PREPARE_HEAD.includes(`synthInstance.maxHeartbeats ${MAX_HEARTBEATS}`) &&
      LINTERS.every((l) => PREPARE_HEAD.includes(`linter.${l} false`)));
  check("deprecated and dupNamespace stay ON",
    !PREPARE_HEAD.includes("linter.deprecated") && !PREPARE_HEAD.includes("linter.dupNamespace") && !PREPARE_HEAD.includes("linter.all"));
}

// ------------------------------------------------------------- the bound chain
{
  check("cpu < wall", CPU_FUSE_MS < WALL_FUSE_MS, `${CPU_FUSE_MS} / ${WALL_FUSE_MS}`);
  check("retry deadline covers every kill the budget promises", RETRY_DEADLINE_MS > MAX_KILLS * WALL_FUSE_MS);
  check("client wait covers the deadline plus one more full fuse", CLIENT_WAIT_MS > RETRY_DEADLINE_MS + WALL_FUSE_MS);
  console.log(`        cpu ${CPU_FUSE_MS / 60000}min < wall ${WALL_FUSE_MS / 60000}min < retry ${RETRY_DEADLINE_MS / 60000}min < client ${CLIENT_WAIT_MS / 60000}min`);
}

// ------------------------------------------------------------- the fingerprint
{
  check("fingerprint is stable", CHECK_SHA === CHECK_SHA && /^[0-9a-f]{16}$/.test(CHECK_SHA), CHECK_SHA);
  check("a matching env diffs to nothing", checkEnvDiff(checkEnv()).length === 0);
  const moved = { ...checkEnv(), prepare_head: "set_option maxHeartbeats 400000" };
  const d = checkEnvDiff(moved);
  check("a moved prepare head is named in the diff", d.length === 1 && d[0].includes("prepare_head"), d.join("\n"));
  check("an absent env (old server) diffs every field", checkEnvDiff(undefined).length === Object.keys(checkEnv()).length);
}

// ----------------------------------------------------------------- against Lean
const up = await fetch(`${LEAN_URL}/health`, { signal: AbortSignal.timeout(2000) }).then((r) => r.json()).catch(() => null);
if (!up?.ready) {
  console.log("  skip  Lean checks (no server on " + LEAN_URL + ")");
} else {
  const r = await postCheck({ code: prepare("import Mathlib\ntheorem cmp_probe_head (n : Nat) : n + 0 = n := by simp\n").text, client: "probe" }, 600_000);
  const errs = (r.messages ?? []).filter((m) => m.severity === "error");
  check("the injected head compiles", r.ok && errs.length === 0, JSON.stringify(errs.map((m) => m.text?.slice(0, 120))));
  if (up.check_sha)
    check(`the running server is this checkout (${up.check_sha})`, up.check_sha === CHECK_SHA, checkEnvDiff(up.check_env).join("\n"));
  else console.log("  skip  server fingerprint (server predates check_sha — restart it)");
}

console.log(failed ? `\n${failed} probe(s) FAILED` : "\nall check-env probes green");
process.exit(failed ? 1 : 0);
