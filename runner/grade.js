// Independent grading of a finished attempt. Never trusts the agent's own lean_check.
// Checks: (1) theorem statement preserved — the elaborated TYPE of every benchmark
//             declaration must match the original's, compared α-invariantly via a
//             probe that reads the environment after the file elaborates (immune to
//             reformatting, notation, and open-shadowing; a statement means its type),
//         (2) declaration kind (thm/defn) unchanged and not marked unsafe/partial
//             (unsafe code may use kernel bypasses like unsafeCast; the axiom report
//             does not surface those),
//         (3) file compiles (via the persistent lean server),
//         (4) #print axioms for every benchmark declaration is clean
//             (catches sorry via sorryAx, custom axioms, native_decide via ofReduceBool).
// Plus an advisory lexical tripwire: metaprogramming/kernel-adjacent keywords in the
// solution source are logged (suspicious_keywords), never auto-failed — an honest
// competition proof needs zero metaprogramming, so any hit deserves a human read.

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { postCheck, classifyLines } from "./common.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ALLOWED_AXIOMS = new Set(["propext", "Classical.choice", "Quot.sound"]);
const GRADE_TIMEOUT_MS = 480_000;
const STMT_CACHE = join(ROOT, "problems", "stmt-types.json");

// Names of the declarations the benchmark expects (theorem + optional _solution abbrev).
export function benchmarkDecls(originalSource) {
  const decls = [];
  for (const m of originalSource.matchAll(/^\s*(?:noncomputable\s+)?(?:abbrev|def|theorem)\s+([\w.]+)/gm)) {
    decls.push(m[1]);
  }
  return decls;
}

// --- statement probe ---------------------------------------------------------
// Lean code appended to a file before sending it to the REPL. After the file
// elaborates, it reads each benchmark declaration out of the environment and prints
// one info line: CMPSTMT|<name>|<kind>|<safety>|<canonical type>  (or |missing).
// The canonical type erases binder names (α-equivalence), elaboration metadata, and
// universe param names, then prints the raw kernel expression — fully resolved
// constants, no notation — so string equality on it is exact type equality.
// Runs even when the file has errors: Lean's recovery still adds a declaration whose
// signature elaborates (proof failures become sorryAx), so statement preservation is
// checkable on non-compiling solutions too.
export function stmtProbe(decls) {
  const names = decls.map((d) => "`" + d).join(", ");
  return `
private partial def CMPStmtCanon : Lean.Expr → Lean.Expr
  | .forallE _ t b bi => .forallE .anonymous (CMPStmtCanon t) (CMPStmtCanon b) bi
  | .lam _ t b bi => .lam .anonymous (CMPStmtCanon t) (CMPStmtCanon b) bi
  | .letE _ t v b nd => .letE .anonymous (CMPStmtCanon t) (CMPStmtCanon v) (CMPStmtCanon b) nd
  | .app f a => .app (CMPStmtCanon f) (CMPStmtCanon a)
  | .mdata _ b => CMPStmtCanon b
  | .proj s i e => .proj s i (CMPStmtCanon e)
  | e => e

open Lean in
run_cmd do
  let env ← getEnv
  for n in [${names}] do
    match env.find? n with
    | none => logInfo s!"CMPSTMT|{n}|missing"
    | some ci =>
      let (kind, safety) := match ci with
        | .thmInfo _ => ("thm", "safe")
        | .defnInfo v => ("defn", match v.safety with
            | .safe => "safe" | .«unsafe» => "unsafe" | .«partial» => "partial")
        | .axiomInfo v => ("axiom", if v.isUnsafe then "unsafe" else "safe")
        | .opaqueInfo v => ("opaque", if v.isUnsafe then "unsafe" else "safe")
        | .quotInfo _ => ("quot", "safe")
        | .inductInfo v => ("induct", if v.isUnsafe then "unsafe" else "safe")
        | .ctorInfo v => ("ctor", if v.isUnsafe then "unsafe" else "safe")
        | .recInfo v => ("rec", if v.isUnsafe then "unsafe" else "safe")
      let lvls := ci.levelParams
      let ty := ci.type.instantiateLevelParams lvls
        ((List.range lvls.length).map fun i => Level.param (Name.mkSimple s!"cmpu{i}"))
      logInfo s!"CMPSTMT|{n}|{kind}|{safety}|{(CMPStmtCanon ty).dbgToString}"
`;
}

export function parseStmtProbe(messages) {
  const out = {};
  for (const m of messages ?? []) {
    const mm = /^CMPSTMT\|([^|\s]+)\|([\s\S]*)$/.exec((m.text ?? "").trim());
    if (!mm) continue;
    if (mm[2] === "missing") { out[mm[1]] = { missing: true }; continue; }
    const p = /^(\w+)\|(\w+)\|([\s\S]*)$/.exec(mm[2]);
    if (p) out[mm[1]] = { kind: p[1], safety: p[2], type: p[3] };
  }
  return out;
}

// --- original-side types (cached) -------------------------------------------
// The original's types never change, so they are computed once per problem and kept
// in problems/stmt-types.json keyed by a hash of the original source (committed, so
// grading is reproducible without recomputation). Read-merge-write keeps concurrent
// graders from clobbering each other's entries within a process; a cross-process race
// at worst drops an entry, which is then recomputed.
const memoOrig = new Map();
export async function originalStmtTypes(problemName, originalSource, decls) {
  const sha = createHash("sha256").update(originalSource).digest("hex");
  const hit = memoOrig.get(problemName);
  if (hit?.sha === sha) return hit.decls;
  let disk = {};
  try { disk = JSON.parse(readFileSync(STMT_CACHE, "utf8")); } catch {}
  if (disk[problemName]?.sha256 === sha) {
    memoOrig.set(problemName, { sha, decls: disk[problemName].decls });
    return disk[problemName].decls;
  }
  const r = await serverCheck(`${originalSource}\n${stmtProbe(decls)}\n`);
  if (r.error) throw new Error(`lean server: ${r.error}`);
  if (!r.ok) throw new Error(`original does not compile: ${(r.pretty ?? "").slice(0, 500)}`);
  const probe = parseStmtProbe(r.messages);
  const entry = {};
  for (const d of decls) {
    if (!probe[d] || probe[d].missing) throw new Error(`no probe result for ${d} in original`);
    entry[d] = probe[d];
  }
  try { disk = JSON.parse(readFileSync(STMT_CACHE, "utf8")); } catch { disk = {}; }
  disk[problemName] = { sha256: sha, decls: entry };
  writeFileSync(STMT_CACHE, JSON.stringify(disk, null, 1));
  memoOrig.set(problemName, { sha, decls: entry });
  return entry;
}

// --- lexical tripwire (advisory only) ----------------------------------------
// Entry points into compile-time execution / kernel-adjacent features. Presence is
// anomalous in an honest competition proof but NOT proof of cheating (a word can sit
// in a string or block comment) — so hits are logged for a human, never auto-failed.
// The env-level checks above stay the gate; this covers what they cannot see
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

// timeoutMs bounds REPL execution; the client waits longer since queueing is unbounded.
export function serverCheck(code, timeoutMs = GRADE_TIMEOUT_MS) {
  return postCheck({ code, timeoutMs }, 30 * 60_000);
}

// --- agent-facing statement verification (lean-check.ts, plan.js) ------------
// Callers append stmtProbe(benchmarkDecls(original)) to their own check request and
// pass the response messages here — one REPL round trip, no separate compile. After
// the corpus cache is built the original side is a disk hit. `unknown: true` means
// the probe never ran (file too broken to parse to the end) — let the compile error
// speak in that case rather than scolding the agent on no evidence.
export async function verifyStatement(problemName, originalSource, messages) {
  const decls = benchmarkDecls(originalSource);
  const orig = await originalStmtTypes(problemName, originalSource, decls);
  const got = parseStmtProbe(messages);
  if (Object.keys(got).length === 0) return { ok: true, unknown: true };
  for (const d of decls) {
    const s = got[d];
    if (!s || s.missing)
      return { ok: false, detail: `${d} is missing — renamed, deleted, or its statement no longer elaborates` };
    if (s.type !== orig[d].type)
      return { ok: false, detail: `the statement of ${d} no longer elaborates to the original type` };
    if (s.kind !== orig[d].kind)
      return { ok: false, detail: `${d} changed declaration kind (${orig[d].kind} -> ${s.kind})` };
    if (s.safety !== "safe")
      return { ok: false, detail: `${d} is marked ${s.safety}; unsafe/partial declarations are not accepted` };
  }
  return { ok: true };
}

// Remove the probe's CMPSTMT info lines from server pretty-output before showing it
// to the agent (grader internals are not part of the compiler feedback).
export function stripProbeOutput(pretty) {
  return (pretty ?? "").split("\n\n").filter((p) => !p.includes("CMPSTMT")).join("\n\n");
}

/**
 * @returns {Promise<{solved: boolean, reason?: string, detail?: string, axioms?: object, suspicious_keywords?: string[]}>}
 */
export async function grade(problemName, solutionPath, originalPath) {
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
    orig = await originalStmtTypes(problemName, original, decls);
  } catch (e) {
    return fail("grader_error", `original stmt types: ${e.message}`);
  }

  const probes = `${stmtProbe(decls)}\n${decls.map((d) => `#print axioms ${d}`).join("\n")}\n`;
  let r;
  try {
    r = await serverCheck(`${solution}\n${probes}`);
  } catch (e) {
    return fail("grader_error", `lean server unreachable: ${e.message}`);
  }
  if (r.error) return fail("grader_error", r.error);

  // Classification order (statement first, matching the old grader's priority):
  // probe output → statement checks → compile status → axiom checks.
  const got = parseStmtProbe(r.messages);
  if (Object.keys(got).length === 0) {
    // The probe emits a line per decl even on broken files; total silence means the
    // parser never reached the end of the file (or, on a clean compile, a grader bug).
    return r.ok
      ? fail("grader_error", "stmt probe produced no output on a clean compile")
      : fail("compile_error", `statement unknown (file did not elaborate to the end)\n${(r.pretty ?? "").slice(0, 3500)}`);
  }
  for (const d of decls) {
    const s = got[d];
    if (!s || s.missing)
      return fail("statement_changed", `${d}: declaration missing (renamed/deleted, or its statement fails to elaborate)` + (r.ok ? "" : `\n${(r.pretty ?? "").slice(0, 2000)}`));
    if (s.type !== orig[d].type)
      return fail("statement_changed", `${d}: elaborated type differs from original\n  expected: ${orig[d].type.slice(0, 300)}\n  got:      ${s.type.slice(0, 300)}`);
    if (s.kind !== orig[d].kind)
      return fail("statement_changed", `${d}: declaration kind changed (${orig[d].kind} -> ${s.kind})`);
    if (s.safety !== "safe")
      return fail("unsafe_decl", `${d}: declaration is marked ${s.safety}`);
  }
  if (!r.ok) return fail("compile_error", (r.pretty ?? "").slice(0, 4000));

  const allText = (r.messages ?? []).map((m) => m.text).join("\n");
  const axioms = {};
  for (const d of decls) {
    const esc = d.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const m =
      allText.match(new RegExp(`'${esc}' depends on axioms: \\[([^\\]]*)\\]`)) ??
      (allText.match(new RegExp(`'${esc}' does not depend on any axioms`)) ? [null, ""] : null);
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
    console.log(`stmt-type cache: ${done} ok, ${failed} failed -> ${STMT_CACHE}`);
    process.exit(failed ? 1 : 0);
  }
  const [name, sol] = process.argv.slice(2);
  const orig = join(ROOT, "problems", `${name}.lean`);
  grade(name, resolve(sol), orig).then((r) => {
    console.log(JSON.stringify(r, null, 2));
    process.exit(r.solved ? 0 : 1);
  });
}
