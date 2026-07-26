// Statement-probe library: everything about asking Lean "what did this file declare,
// and is it the same statement the benchmark shipped?". Shared by the grader
// (runner/grade.js), the agent-facing checks (extensions/lean-check.ts via
// checkedCompile), and plan_check (runner/plan.js).
//
// Principle: a theorem's statement IS the type of its declaration, so statement
// preservation is decided by elaborated-type equality read out of the environment,
// never by diffing source text (immune to reformatting, notation, binder renames,
// open-shadowing in both directions).

import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { postCheck, classifyLines, cmpConfig } from "./common.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const STMT_CACHE = join(ROOT, "problems", "stmt-types.json");

// timeoutMs bounds REPL execution; clients wait longer since queueing is unbounded.
export const GRADE_TIMEOUT_MS = 480_000;
// Agent-facing checks get a much tighter REPL budget (run.js --check-timeout, via
// CMP_CONFIG): honest proof steps check in seconds; what this bounds is head-of-line
// blocking on the serialized REPL (one stuck attempt costs the others at most ~2 min,
// not the watchdog's 4-5).
export const AGENT_CHECK_TIMEOUT_MS = cmpConfig().check_timeout_ms ?? 120_000;
const CLIENT_WAIT_MS = 30 * 60_000; // server queue is serialized; be patient

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
// one info line:  CMPSTMT|<name>|<kind>|<safety>|<sorry|clean>|<canonical type>
// (or |missing). The canonical type erases binder names (α-equivalence), elaboration
// metadata, and universe param names, then prints the raw kernel expression — fully
// resolved constants, no notation — so string equality on it is exact type equality.
// The sorry field reports whether the declaration's own proof term reaches sorryAx
// without passing through a user-declared helper: it recurses only into constants
// PREFIXED by the declaration's name (compiler-generated auxiliaries like .match_1 /
// .proof_1 / ._unary, where the elaborator hoists branches) — a sorry inside a
// referenced helper lemma lives in the helper's value and reports `clean` here.
// That is exactly plan-validity: "main proof complete in terms of helpers".
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
private partial def CMPSorryGo (env : Environment) (root : Name) : NameSet → List Name → Bool
  | _, [] => false
  | seen, n :: rest =>
    if seen.contains n then CMPSorryGo env root seen rest
    else match (env.find? n).bind (·.value?) with
      | none => CMPSorryGo env root (seen.insert n) rest
      | some v =>
        let used := v.getUsedConstants
        used.contains \`sorryAx ||
          CMPSorryGo env root (seen.insert n) ((used.toList.filter (root.isPrefixOf ·)) ++ rest)

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
      let ds := if CMPSorryGo env n {} [n] then "sorry" else "clean"
      let lvls := ci.levelParams
      let ty := ci.type.instantiateLevelParams lvls
        ((List.range lvls.length).map fun i => Level.param (Name.mkSimple s!"cmpu{i}"))
      logInfo s!"CMPSTMT|{n}|{kind}|{safety}|{ds}|{(CMPStmtCanon ty).dbgToString}"
`;
}

export function parseStmtProbe(messages) {
  const out = {};
  for (const m of messages ?? []) {
    const mm = /^CMPSTMT\|([^|\s]+)\|([\s\S]*)$/.exec((m.text ?? "").trim());
    if (!mm) continue;
    if (mm[2] === "missing") { out[mm[1]] = { missing: true }; continue; }
    const p = /^(\w+)\|(\w+)\|(\w+)\|([\s\S]*)$/.exec(mm[2]);
    if (p) out[mm[1]] = { kind: p[1], safety: p[2], direct_sorry: p[3] === "sorry", type: p[4] };
  }
  return out;
}

// --- lean-server client ------------------------------------------------------
export function serverCheck(code, timeoutMs = GRADE_TIMEOUT_MS, client = "grader") {
  return postCheck({ code, timeoutMs, client }, CLIENT_WAIT_MS);
}

// --- original-side types (cached) -------------------------------------------
// The original's types never change, so they are computed once per problem and kept
// in problems/stmt-types.json keyed by a hash of the original source (derived +
// gitignored like the problem files; `grade.js --build-stmt-cache` rebuilds all, and
// the sha key means a stale entry can only cause a recompute, never a wrong verdict).
// Read-merge-write keeps concurrent
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

// --- statement verification --------------------------------------------------
// `unknown: true` means the probe never ran (file too broken to parse to the end) —
// let the compile error speak in that case rather than scolding the agent on no
// evidence.
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

// --- agent-facing check client ----------------------------------------------
// The ONE way agent-facing tools (lean_check, plan_check) compile the agent's file:
// probe rides on the same request (no separate compile), probe output is stripped
// from what the agent sees, and the statement verdict comes back alongside the
// compile result — so the agent-facing check and the grader cannot drift.
//
// native_decide is pre-rejected lexically WITHOUT touching the REPL: it is banned
// anyway (it trusts the native compiler via ofReduceBool, not the Lean kernel; the
// grader rejects it through #print axioms), and stuck agents demonstrably burn
// minutes of the shared serialized REPL per doomed native_decide attempt. No other
// construct is pre-rejected: everything else compiles in ordinary time and the
// grader's env-level checks stay the single source of truth. Client-side only —
// the grader/regrader must still compile such files honestly.
const NATIVE_DECIDE_RE = /(^|[^\w.])native_decide($|[^\w])/m;

export function bannedTactic(code) {
  const codeOnly = classifyLines(code).filter((l) => l.kind === "code").map((l) => l.line).join("\n");
  return NATIVE_DECIDE_RE.test(codeOnly) ? "native_decide" : null;
}

export async function checkedCompile(code, { original, problemName, client }) {
  if (bannedTactic(code)) {
    return {
      ok: false,
      rejected: "native_decide",
      pretty:
        "CHECK REJECTED (file was NOT compiled): your file uses `native_decide`, which is " +
        "banned — it trusts the native compiler instead of the Lean kernel, and grading " +
        "rejects it via #print axioms no matter what. Remove it and close the goal with " +
        "kernel-checked reasoning (`decide`, `norm_num`, `omega`, ... are all fine).",
      messages: [],
      sorries: [],
    };
  }
  const r = await postCheck(
    { code: `${code}\n${stmtProbe(benchmarkDecls(original))}\n`, timeoutMs: AGENT_CHECK_TIMEOUT_MS, client },
    CLIENT_WAIT_MS,
  );
  if (r.error) return r; // { ok:false, error, kind, pretty, ... } — caller words it for the agent
  const probe = parseStmtProbe(r.messages);
  const stmt = await verifyStatement(problemName, original, r.messages);
  return { ...r, pretty: stripProbeOutput(r.pretty), probe, stmt };
}
