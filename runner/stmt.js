// Statement-probe library: everything about asking Lean "what did this file declare,
// and is it the same statement the benchmark shipped?". Shared by the grader
// (runner/grade.js), the agent-facing checks (extensions/lean-check.ts via
// checkedCompile), and plan_check (runner/plan.js).
//
// Principle: a theorem's statement IS the type of its declaration, so statement
// preservation is decided by elaborated-type equality read out of the environment,
// never by diffing source text (immune to reformatting, notation, binder renames,
// open-shadowing in both directions).

import { readFileSync, writeFileSync, renameSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { postCheck, classifyLines, ALLOWED_AXIOMS } from "./common.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const STMT_CACHE = join(ROOT, "problems", "stmt-types.json");

// ONE definition of "compiles" for agent checks, supervisor and grader (2026-07-27):
// a solve must be observable inside the agent's own feedback loop, or a proof the
// agent's tool rejects could secretly count as solved. Since 2026-08-01 that is free
// rather than enforced — no client passes a bound at all. The verdict is the server's
// per-declaration `maxHeartbeats` cap (MAX_HEARTBEATS in common.js), a pure function of
// the file, so agent, supervisor, grader and any later regrade necessarily agree on it
// whoever compiles first. What used to differ between them — a measured CPU budget
// passed per request — is gone: CPU is a machine fuse the server owns.
// Outermost bound of the check chain: CPU fuse < wall fuse < retry deadline < this
// (lean-server.js states the invariant). postCheck() sets it as a hard socket timeout and
// destroys the request when it expires, so a client that gives up first converts a fuse
// kill — which the server hides and retries — into a connection error the agent DOES see.
// Raised 30 -> 190 min with the fuses (2026-08-06); the queue is serialized, be patient.
export const CLIENT_WAIT_MS = 190 * 60_000;

// Names of the declarations the benchmark expects (theorem + setup defs/abbrevs),
// FULLY QUALIFIED: FATE-X wraps every file in `namespace ProblemN`, so the environment
// name the probe must look up is `ProblemN.<head>`, not the bare head (all 100 FATE-X
// probes came back `missing` before this tracked scopes, 2026-08-02). The tracker is a
// plain stack — every `end` closes exactly one scope-opening command in well-formed
// Lean, and these are sanitized, machine-generated files (no comments, no `mutual`, no
// modifier forms; the corpus has no `private`/`protected`/`_root_` heads — grep.js
// rung 0 shows what tracking costs when those assumptions fail, and none of them holds
// a benchmark file). Sections push an empty prefix; dotted namespaces and dotted decl
// heads concatenate. Unchanged for namespace-free corpora (PutnamBench, FATE-M/H): no
// scopes ever open, so the emitted names are the bare heads exactly as before.
// Lean names are not \w: subscripts (eval₂_…), primes (M'), and pure-unicode idents
// (τ, 𝔽) are all legal, so match everything up to a delimiter instead of an ASCII set.
//
// `class`/`structure`/`inductive` are tracked too (2026-08-05). They were not, and that
// was the whole hole behind the fatex_74 solve: FATE-X problem 74 ships
// `class IsGorensteinLocalRing … where injDim_le_infity : ∃ n, ∀ i, n ≤ i → Subsingleton …`,
// the attempt shipped `injDim_le_infity : True`, and the grader passed it. The theorem's
// own type was untouched — it still reads `IsGorensteinRing (R ⧸ …)` — because a type
// references a class by NAME only, exactly the setup-definition hole the CMPVAL value
// probe closes for def/abbrev, left open for the field types of a class. 39 declarations
// across FATE-X (36 class, 2 structure, 1 inductive) were unprotected; FATE-H, FATE-M and
// PutnamBench have none, which is why it surfaced only here.
// `instance` is deliberately NOT tracked: every instance in the corpus is anonymous, so
// there is no source-level name to look up, and instances are covered transitively —
// they are fully resolved inside the canonical types of the decls that use them, so
// swapping or deleting one changes a tracked type or constructor.
export function benchmarkDecls(originalSource) {
  const decls = [];
  const scopes = []; // each entry: [] for a section, the dot-split components for a namespace
  for (const line of originalSource.split("\n")) {
    let m;
    if ((m = /^\s*namespace\s+(\S+)\s*$/.exec(line))) { scopes.push(m[1].split(".")); continue; }
    if (/^\s*section(\s+\S+)?\s*$/.test(line)) { scopes.push([]); continue; }
    if (/^\s*end(\s+\S+)?\s*$/.test(line)) { scopes.pop(); continue; }
    if ((m = /^\s*(?:noncomputable\s+)?(?:abbrev|def|theorem|class|structure|inductive)\s+([^\s:({\[⦃]+)/.exec(line))) {
      decls.push([...scopes.flat(), m[1]].join("."));
    }
  }
  return decls;
}

// --- statement probe ---------------------------------------------------------
// Lean code appended to a file before sending it to the REPL. After the file
// elaborates, it reads each benchmark declaration out of the environment and prints
// one info line:  CMPSTMT|<name>|<kind>|<safety>|<sorry|clean>|<canonical type>
// (or |missing), plus one CMPVAL|<name>|<canonical value> line per def/abbrev
// ("-" for theorems — proofs are the agent's to write and can be huge). The value
// line closes the setup-definition hole: a theorem's TYPE references file-local
// defs by NAME only, so an agent could gut a setup def's body (dist_to_int := fun
// _ => 0, verified exploitable 2026-07-28) without changing the theorem's type.
// For a class/structure/inductive the same hole exists one level down — the field
// types live in the CONSTRUCTOR, not in the inductive's own type, which is just
// `Type → … → Prop` and stays byte-identical when a field is gutted (measured on
// fatex_74). So the value slot of an inductive carries every constructor's canonical
// type, `<ctor>|<type>` joined by " ;; ", and the same value comparison that protects
// def bodies protects class fields. `extends` parents are constructor arguments too,
// so they are covered by the same string.
// Which decls must keep their value is decided caller-side: exactly those whose
// ORIGINAL value is sorry-free (setup defs yes; the sorry'd _solution slot no).
// The canonical type erases binder names (α-equivalence), elaboration
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
      let uls := (List.range lvls.length).map fun i => Level.param (Name.mkSimple s!"cmpu{i}")
      let ty := ci.type.instantiateLevelParams lvls uls
      logInfo s!"CMPSTMT|{n}|{kind}|{safety}|{ds}|{(CMPStmtCanon ty).dbgToString}"
      let vs := match ci with
        | .defnInfo v => (CMPStmtCanon (v.value.instantiateLevelParams lvls uls)).dbgToString
        | .inductInfo v => String.intercalate " ;; " (v.ctors.map fun c =>
            match env.find? c with
            | some ci2 =>
              let l2 := ci2.levelParams
              let u2 := (List.range l2.length).map fun i => Level.param (Name.mkSimple s!"cmpu{i}")
              s!"{c}|{(CMPStmtCanon (ci2.type.instantiateLevelParams l2 u2)).dbgToString}"
            | none => s!"{c}|missing")
        | _ => "-"
      logInfo s!"CMPVAL|{n}|{vs}"
`;
}

export function parseStmtProbe(messages) {
  const out = {};
  for (const m of messages ?? []) {
    const t = (m.text ?? "").trim();
    // Values ride on separate CMPVAL lines (emitted right after the decl's CMPSTMT
    // line). Attach-to-existing keeps last-wins: a spoofed line earlier in the file
    // is overwritten by the real probe's, which runs at the end.
    const mv = /^CMPVAL\|([^|\s]+)\|([\s\S]*)$/.exec(t);
    if (mv) {
      if (out[mv[1]] && !out[mv[1]].missing) out[mv[1]].value = mv[2];
      continue;
    }
    const mm = /^CMPSTMT\|([^|\s]+)\|([\s\S]*)$/.exec(t);
    if (!mm) continue;
    if (mm[2] === "missing") { out[mm[1]] = { missing: true }; continue; }
    const p = /^(\w+)\|(\w+)\|(\w+)\|([\s\S]*)$/.exec(mm[2]);
    if (p) out[mm[1]] = { kind: p[1], safety: p[2], direct_sorry: p[3] === "sorry", type: p[4] };
  }
  return out;
}

// --- lean-server client ------------------------------------------------------
// force=true bypasses the server memo: the final grading verdict must come from an
// actual compile, never a cache entry (memo is bounded/evicting, and crashes are
// unmemoized anyway — this closes the remaining gap).
export function serverCheck(code, client = "grader", force = false) {
  return postCheck({ code, client, force }, CLIENT_WAIT_MS);
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
// An entry written before the value probe existed lacks .value on every decl; the
// sha key alone would keep serving it and silently skip the value check — treat it
// as a miss and recompute.
const hasValues = (entry) => Object.values(entry?.decls ?? {}).every((d) => d.value !== undefined);
// An entry written before benchmarkDecls tracked class/structure/inductive covers only
// the def/abbrev/theorem heads, so the sha (which is over the ORIGINAL source, unchanged
// by a tracker fix) would keep serving it and every newly-tracked class would read back
// as `undefined` — i.e. verifyStatement would fail every FATE-X problem with a class as
// "statement no longer elaborates". Treat a cache entry that is missing any requested
// decl as a miss, the same way a missing .value is treated.
const hasAll = (entry, decls) => decls.every((d) => entry?.decls?.[d] !== undefined);
export async function originalStmtTypes(problemName, originalSource, decls) {
  const sha = createHash("sha256").update(originalSource).digest("hex");
  const hit = memoOrig.get(problemName);
  if (hit?.sha === sha && hasAll({ decls: hit.decls }, decls)) return hit.decls;
  let disk = {};
  try { disk = JSON.parse(readFileSync(STMT_CACHE, "utf8")); } catch {}
  if (disk[problemName]?.sha256 === sha && hasValues(disk[problemName]) && hasAll(disk[problemName], decls)) {
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
  // Write-then-rename, because the failure mode of a torn write is not "one lost entry".
  // writeFileSync truncates first, so a concurrent reader (a regrade alongside a run) can
  // see a half-file; that read throws, the catch above resets `disk` to {}, and the very
  // next write replaces the WHOLE cache with a single problem. Rebuilding costs one
  // Mathlib compile per entry (1534 of them today). rename(2) is atomic within a
  // filesystem, so a reader sees either the old file or the new one.
  const tmp = `${STMT_CACHE}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(disk, null, 1));
  renameSync(tmp, STMT_CACHE);
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
    // Value preservation: a setup def's body is part of the statement (the theorem's
    // type references it by name only). Enforced exactly where the original's own
    // value is sorry-free — the sorry'd slots (_solution, the proof) are the agent's.
    if (!orig[d].direct_sorry && orig[d].value != null && orig[d].value !== "-" && s.value !== orig[d].value)
      return {
        ok: false,
        detail:
          orig[d].kind === "induct"
            ? `the fields of ${d} were changed — a class/structure declaration is part of the problem statement (the theorem refers to it by name only, so weakening a field silently weakens the theorem) and must stay exactly as given`
            : `the definition of ${d} was changed — its body is part of the problem statement and must stay exactly as given`,
      };
    if (s.safety !== "safe")
      return { ok: false, detail: `${d} is marked ${s.safety}; unsafe/partial declarations are not accepted` };
  }
  return { ok: true };
}

// The probe's CMPSTMT/CMPVAL lines are harness internals, not compiler feedback about
// the agent's file, so they are removed before anyone sees the output. Rebuilt from the
// STRUCTURED messages rather than filtered out of the server's rendered `pretty`, which
// is what the old stripProbeOutput did: it split on blank lines and dropped whole
// blocks, and render() joins its "compiled with output:" header to the first message
// with a single newline — so on a clean compile, where the probe lines are the ONLY
// output, the header was dropped along with them, the string emptied, and lean_check
// answered "no output" at the exact moment the agent had succeeded. Measured in 31 of
// 50 attempts in the 0730b run and again on 0731: agents responded by re-checking the
// byte-identical file, spending a turn to re-ask a question already answered. It also
// left the statement-changed message quoting an empty "Compiler output:".
// Same shape as lean-server's render() and snippet.js's renderSnippet(), so one error
// format is used everywhere; `ok` is recomputed from the visible messages, which is the
// same verdict since the probe only ever emits info.
const PROBE_LINE = /^\s*CMP(?:STMT|VAL)\|/;
// `#print axioms` reports are probe internals too (since 2026-08-04 they ride on every
// checkedCompile, not only the grader's request): the verdict is parsed line-gated and
// surfaced as an explicit axiom-check message, so the raw report lines are stripped
// from rendered output the same way CMPSTMT lines are.
const AXIOM_LINE = /^'[^']*' (?:depends on axioms|does not depend on any axioms)/;
export function renderWithoutProbe(messages, sorries) {
  const visible = (messages ?? []).filter((m) => !PROBE_LINE.test(m.text ?? "") && !AXIOM_LINE.test(m.text ?? ""));
  const parts = [];
  for (const m of visible) parts.push(`${m.severity}: problem.lean:${m.line}:${m.column}: ${m.text}`);
  for (const s of sorries ?? []) parts.push(`sorry at line ${s.line}, goal:\n  ${s.goal}`);
  const ok = !visible.some((m) => m.severity === "error");
  let pretty = parts.join("\n\n") || "compiled successfully: no errors, no warnings";
  if (ok && parts.length) pretty = `compiled with output:\n${pretty}`;
  if (!ok) pretty = `compilation FAILED:\n${pretty}`;
  if (pretty.length > 8000) pretty = pretty.slice(0, 8000) + "\n... (truncated)";
  return pretty;
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
  // The probe body is built exactly like the grader's (stmtProbe + one `#print
  // axioms` per benchmark decl, grade.js): agent-facing checks and the grading
  // request compile the same bytes, so nothing the grader will decide is invisible
  // in the agent's own loop. The axiom side closed the last gap (2026-08-04): a
  // smuggled `axiom` + `exact` passed compile, statement and sorry checks, so
  // lean_check said green and the supervisor let the attempt end on a file the
  // grader then failed as bad_axioms — the agent-watches-green-gets-graded-red
  // class, on the one axis the heartbeat work didn't cover (spawn-fatex10-0804
  // fatex_99, and the 0802 audit's three axiom-gaming incidents before it).
  const decls = benchmarkDecls(original);
  const probes = `${stmtProbe(decls)}\n${decls.map((d) => `#print axioms ${d}`).join("\n")}\n`;
  const r = await postCheck({ code: `${code}\n${probes}`, client }, CLIENT_WAIT_MS);
  if (r.error) return r; // { ok:false, error, kind, pretty, ... } — caller words it for the agent
  const probe = parseStmtProbe(r.messages);
  const stmt = await verifyStatement(problemName, original, r.messages);
  // Axiom verdict, same mechanics and same line gate as the grader: reports are read
  // only from messages past the end of the submitted code, so printed text inside the
  // file cannot spoof them. sorryAx is excluded here — sorries already reach the agent
  // through the sorries list and warnings, and error-recovery turns every failed proof
  // into sorryAx, which would make this report pure noise on non-compiling files.
  const solLines = code.split("\n").length;
  const probeText = (r.messages ?? []).filter((m) => (m.line ?? 0) > solLines).map((m) => m.text).join("\n");
  const axiomsBad = {};
  for (const d of decls) {
    const esc = d.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const m =
      probeText.match(new RegExp(`'${esc}' depends on axioms: \\[([^\\]]*)\\]`)) ??
      (probeText.match(new RegExp(`'${esc}' does not depend on any axioms`)) ? [null, ""] : null);
    if (!m) continue; // decl missing — the statement verdict reports that on its own
    const bad = (m[1] === "" ? [] : m[1].split(",").map((s) => s.trim()))
      .filter((a) => !ALLOWED_AXIOMS.has(a) && a !== "sorryAx");
    if (bad.length) axiomsBad[d] = bad;
  }
  return { ...r, pretty: renderWithoutProbe(r.messages, r.sorries), probe, stmt, axiomsBad };
}
