// Independent grading of a finished attempt. Never trusts the agent's own lean_check.
// Checks: (1) theorem statement preserved — the elaborated TYPE of every benchmark
//             declaration must match the original's, compared α-invariantly via the
//             probe in runner/stmt.js (a statement means its type), AND the elaborated
//             VALUE of every benchmark decl whose original body is sorry-free (setup
//             defs are referenced by name in the theorem's type, so their bodies are
//             part of the statement; sorry'd slots — proofs, _solution — are exempt),
//         (2) declaration kind (thm/defn) unchanged and not marked unsafe/partial
//             (unsafe code may use kernel bypasses like unsafeCast; the axiom report
//             does not surface those),
//         (3) file compiles (via the persistent lean server),
//         (4) #print axioms for every benchmark declaration is clean
//             (catches sorry via sorryAx, custom axioms, native_decide via ofReduceBool).
// Plus an advisory lexical tripwire: metaprogramming/kernel-adjacent keywords in the
// solution source are logged (suspicious_keywords), never auto-failed — an honest
// competition proof needs zero metaprogramming, so any hit deserves a human read.
//
// Unlike the agent-facing checkedCompile, the grader never pre-rejects anything
// lexically: it must always measure what is actually in the file (regrading old runs
// included), so banned constructs are caught by the env-level checks alone.

import { readFileSync, existsSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { classifyLines, withConnRetry } from "./common.js";
import { benchmarkDecls, stmtProbe, parseStmtProbe, originalStmtTypes, serverCheck, renderWithoutProbe, GRADE_CHECK_CPU_MS } from "./stmt.js";

export { serverCheck } from "./stmt.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ALLOWED_AXIOMS = new Set(["propext", "Classical.choice", "Quot.sound"]);

// --- lexical tripwire (advisory only) ----------------------------------------
// Entry points into compile-time execution / kernel-adjacent features. Presence is
// anomalous in an honest competition proof but NOT proof of cheating (a word can sit
// in a string or block comment) — so hits are logged for a human, never auto-failed.
// The env-level checks stay the gate; this covers what they cannot see
// (environment writes via metaprogramming, kernel-check config tampering).
const SUSPICIOUS = [
  "macro", "macro_rules", "elab", "elab_rules", "syntax", "notation",
  "run_elab", "run_cmd", "#eval", "initialize",
  "axiom", "unsafe", "opaque", "implemented_by", "extern", "native_decide",
  "modifyEnv", "addDecl", "open Lean", "import Lean", "set_option debug",
];
export function suspiciousKeywords(source) {
  const code = classifyLines(source).filter((l) => l.kind === "code").map((l) => l.line).join("\n");
  return SUSPICIOUS.filter((k) => {
    const esc = k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/ /g, "\\s+");
    return new RegExp(`(^|[^\\w.#])${esc}($|[^\\w])`, "m").test(code);
  });
}

/**
 * `cpuMs` is the run's check budget, passed in rather than read from the environment:
 * the grader runs in the RUNNER process, which has no CMP_CONFIG, so an ambient read
 * would pin it to the 120 000 default while the agent used --check-cpu. Same number on
 * both sides is what makes "compiles" one budget (see GRADE_CHECK_CPU_MS in stmt.js).
 * @returns {Promise<{solved: boolean, reason?: string, detail?: string, axioms?: object, suspicious_keywords?: string[]}>}
 */
export async function grade(problemName, solutionPath, originalPath, cpuMs = GRADE_CHECK_CPU_MS) {
  if (!existsSync(solutionPath)) return { solved: false, reason: "no_file", detail: "problem.lean missing" };
  const original = readFileSync(originalPath, "utf8");
  const solution = readFileSync(solutionPath, "utf8");

  const decls = benchmarkDecls(original);
  if (decls.length === 0) return { solved: false, reason: "grader_error", detail: "no declarations found in original" };

  const susp = suspiciousKeywords(solution);
  const base = susp.length ? { suspicious_keywords: susp } : {};
  const fail = (reason, detail) => ({ solved: false, reason, detail, ...base });

  let orig;
  try {
    orig = await withConnRetry(() => originalStmtTypes(problemName, original, decls, cpuMs));
  } catch (e) {
    return fail("grader_error", `original stmt types: ${e.message}`);
  }

  const probes = `${stmtProbe(decls)}\n${decls.map((d) => `#print axioms ${d}`).join("\n")}\n`;
  let r;
  try {
    // force: the official verdict always comes from a fresh compile, not the memo —
    // an agent-side timeout memoized under the same code hash must not stand in for
    // the grader's own run. Connection failures are retried for 5 min (withConnRetry):
    // this verdict is permanent, so a REPL mid-restart must be waited out, not recorded.
    r = await withConnRetry(() => serverCheck(`${solution}\n${probes}`, cpuMs, "grader", true));
  } catch (e) {
    return fail("grader_error", `lean server unreachable: ${e.message}`);
  }
  // Exhausting the CPU budget is a determinate verdict under the one-budget metric
  // ("compiles" = compiles within the shared CPU budget), not a grader malfunction:
  // the file costs more than the budget allows, which fails the same way a compile
  // error does. Every OTHER kill (wall fuse, rss/mem fuse) started as an event on this
  // machine; the server already retried it on a second REPL instance, so reaching here
  // means it reproduced. Still not recorded as the file's fail: this
  // verdict is permanent, and grader_error is visible and re-gradeable where a wrong
  // compile_error would be silent. Deliberately stricter than the agent-facing side.
  if (r.error && r.kind === "check_timeout" && r.bound === "cpu")
    return fail("compile_error", `statement unknown (grading check exhausted the shared CPU budget — file too expensive to compile)\n${r.error}`);
  if (r.error) return fail("grader_error", `${r.error}${r.bound ? ` [bound: ${r.bound}]` : ""}`);
  // Probe/axiom internals stay out of recorded details — only real compiler output.
  const pretty = renderWithoutProbe(r.messages, r.sorries);

  // Classification order (statement first, matching the old grader's priority):
  // probe output → statement checks → compile status → axiom checks.
  const got = parseStmtProbe(r.messages);
  if (Object.keys(got).length === 0) {
    // The probe emits a line per decl even on broken files; total silence means the
    // parser never reached the end of the file (or, on a clean compile, a grader bug).
    return r.ok
      ? fail("grader_error", "stmt probe produced no output on a clean compile")
      : fail("compile_error", `statement unknown (file did not elaborate to the end)\n${pretty.slice(0, 3500)}`);
  }
  for (const d of decls) {
    const s = got[d];
    if (!s || s.missing)
      return fail("statement_changed", `${d}: declaration missing (renamed/deleted, or its statement fails to elaborate)` + (r.ok ? "" : `\n${pretty.slice(0, 2000)}`));
    if (s.type !== orig[d].type)
      return fail("statement_changed", `${d}: elaborated type differs from original\n  expected: ${orig[d].type.slice(0, 300)}\n  got:      ${s.type.slice(0, 300)}`);
    if (s.kind !== orig[d].kind)
      return fail("statement_changed", `${d}: declaration kind changed (${orig[d].kind} -> ${s.kind})`);
    // Setup-definition bodies are part of the statement: the theorem's type references
    // them by NAME, so type equality alone lets a gutted body through (verified with
    // dist_to_int := fun _ => 0, 2026-07-28). Compared exactly where the original's
    // own value is sorry-free — the sorry'd slots (proofs, _solution) stay the agent's.
    if (!orig[d].direct_sorry && orig[d].value != null && orig[d].value !== "-" && s.value !== orig[d].value)
      return fail("statement_changed", `${d}: definition body differs from original (setup definitions are part of the statement)\n  expected: ${orig[d].value.slice(0, 300)}\n  got:      ${(s.value ?? "").slice(0, 300)}`);
    if (s.safety !== "safe")
      return fail("unsafe_decl", `${d}: declaration is marked ${s.safety}`);
  }
  if (!r.ok) return fail("compile_error", pretty.slice(0, 4000));

  // Axiom reports are parsed ONLY from messages the probe itself emitted — those with
  // a line number past the solution's end, where the appended `#print axioms` commands
  // live. Parsing the whole stream let the agent's own file spoof the verdict: a
  // `trace "'decl' depends on axioms: []"` inside the solution precedes the real
  // report, and the old first-match parse took it, turning a sorry'd proof into
  // `solved` with zero tripwire (same attack class parseStmtProbe's last-wins guard
  // exists for; a line-number gate is stronger than last-wins because it does not
  // assume message ordering). Agent-emitted messages always carry positions inside
  // the solution, so they cannot cross this line.
  const solLines = solution.split("\n").length;
  const probeText = (r.messages ?? []).filter((m) => (m.line ?? 0) > solLines).map((m) => m.text).join("\n");
  const allText = (r.messages ?? []).map((m) => m.text).join("\n");
  const axioms = {};
  for (const d of decls) {
    const esc = d.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const m =
      probeText.match(new RegExp(`'${esc}' depends on axioms: \\[([^\\]]*)\\]`)) ??
      (probeText.match(new RegExp(`'${esc}' does not depend on any axioms`)) ? [null, ""] : null);
    if (!m) return fail("grader_error", `no axiom report for ${d}\n${allText.slice(0, 2000)}`);
    axioms[d] = m[1] === "" ? [] : m[1].split(",").map((s) => s.trim());
    const bad = axioms[d].filter((a) => !ALLOWED_AXIOMS.has(a));
    if (bad.length > 0) {
      const reason = bad.includes("sorryAx") ? "uses_sorry" : "bad_axioms";
      return { solved: false, reason, detail: `${d}: [${bad.join(", ")}]`, axioms, ...base };
    }
  }
  return { solved: true, axioms, ...base };
}

// CLI: node runner/grade.js <problem_name> <solution.lean>   (needs the lean server up)
//      node runner/grade.js --build-stmt-cache [problems-dir]  precompute all originals
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (process.argv[2] === "--build-stmt-cache") {
    const dir = resolve(process.argv[3] ?? join(ROOT, "problems"));
    const { readdirSync } = await import("node:fs");
    const files = readdirSync(dir).filter((f) => f.endsWith(".lean")).sort();
    let done = 0, failed = 0;
    for (const f of files) {
      const name = f.replace(".lean", "");
      const src = readFileSync(join(dir, f), "utf8");
      try {
        await originalStmtTypes(name, src, benchmarkDecls(src));
        done++;
      } catch (e) {
        failed++;
        console.error(`FAIL ${name}: ${e.message.split("\n")[0]}`);
      }
      if ((done + failed) % 25 === 0) console.log(`${done + failed}/${files.length} (${failed} failed)`);
    }
    console.log(`stmt-type cache: ${done} ok, ${failed} failed`);
    process.exit(failed ? 1 : 0);
  }
  const [name, sol] = process.argv.slice(2);
  const orig = join(ROOT, "problems", `${name}.lean`);
  grade(name, resolve(sol), orig).then((r) => {
    console.log(JSON.stringify(r, null, 2));
    process.exit(r.solved ? 0 : 1);
  });
}
