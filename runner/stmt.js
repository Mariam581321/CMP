// Statement-probe library: everything about asking Lean "what did this file declare,
// and is it the same statement the benchmark shipped?". Shared by the grader
// (runner/grade.js), the agent-facing checks (extensions/lean-check.ts via
// checkedCompile).
//
// Principle: a theorem's statement IS the type of its declaration, so statement
// preservation is decided by elaborated-type equality read out of the environment,
// never by diffing source text (immune to reformatting, notation, binder renames,
// open-shadowing in both directions).

import { readFileSync, writeFileSync, renameSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { postCheck, classifyLines, ALLOWED_AXIOMS, MAX_HEARTBEATS } from "./common.js";
import { CLIENT_WAIT_MS } from "./check-env.js";
import { renderCheck } from "./render.js";

export { CLIENT_WAIT_MS };

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const STMT_CACHE = join(ROOT, "problems", "stmt-types.json");

// ONE definition of "compiles" for agent checks, supervisor and grader: a solve must be
// observable inside the agent's own feedback loop, or a proof the agent's tool rejects
// could secretly count as solved. No client passes a bound: the verdict is the server's
// per-declaration `maxHeartbeats` cap (MAX_HEARTBEATS in common.js), a pure function of
// the file, so agent, supervisor, grader and any later regrade agree on it whoever
// compiles first. CPU is a machine fuse the server owns. The outermost bound of the
// check chain lives in runner/check-env.js and is re-exported here.

// Names of the declarations the benchmark expects (theorem + setup defs/abbrevs),
// FULLY QUALIFIED: FATE-X wraps every file in `namespace ProblemN`, so the environment
// name the probe must look up is `ProblemN.<head>`, not the bare head. The tracker is a
// plain stack — every `end` closes exactly one scope-opening command in well-formed
// Lean, and these are sanitized, machine-generated files (no comments, no `mutual`, no
// modifier forms). Sections push an empty prefix; dotted namespaces and dotted decl
// heads concatenate. Namespace-free corpora emit the bare heads. Lean names are not \w:
// subscripts (eval₂_…), primes (M'), and pure-unicode idents (τ, 𝔽) are all legal, so
// match everything up to a delimiter instead of an ASCII set.
//
// `class`/`structure`/`inductive` are tracked too: a theorem's type references a class
// by NAME only, so a weakened field (a class field replaced by `True`) leaves the
// theorem's own type untouched — the same setup-definition hole the CMPVAL value probe
// closes for def/abbrev. `instance` is deliberately NOT tracked: every instance in the
// corpus is anonymous, so there is no source-level name to look up, and instances are
// covered transitively — they are fully resolved inside the canonical types of the
// decls that use them, so swapping or deleting one changes a tracked type or constructor.
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
// defs by NAME only, so an agent could gut a setup def's body without changing the
// theorem's type. For a class/structure/inductive the same hole exists one level down
// — the field types live in the CONSTRUCTOR, not in the inductive's own type, which is
// just `Type → … → Prop` and stays byte-identical when a field is gutted. So the value
// slot of an inductive carries every constructor's canonical
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

// The probe body the grader and every agent-facing check append, byte-identical: the
// statement probe plus one `#print axioms` per benchmark declaration.
//
// `_root_.` on every name: `#print axioms` takes an identifier and RESOLVES
// it against whatever namespace and `open`s the submitted file left in scope, unlike the
// statement probe, whose `` `Name `` literals are absolute by construction. A solution
// that leaves a namespace open, or opens one that happens to contain a matching prefix,
// would make the report resolve elsewhere or fail as an unknown constant — and an
// unknown-constant ERROR in the probe region reads as the agent's file failing to
// compile. `_root_.` anchors the lookup at the root, and Lean prints the resolved name
// without the prefix, so the report line the parsers match on is unchanged.
export const axiomProbe = (decls) =>
  `${stmtProbe(decls)}\n${decls.map((d) => `#print axioms _root_.${d}`).join("\n")}\n`;

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

// Read `#print axioms` back, for one declaration each. ONE parser, used by the grader
// and by every agent-facing check, so the axiom verdict the agent watches is literally
// the one grading will reach.
//
// Reports are taken ONLY from messages past the end of the submitted code, where the
// appended `#print axioms` commands live. Parsing the whole stream let the agent's own
// file spoof the verdict: a `trace "'decl' depends on axioms: []"` inside the solution
// precedes the real report, and a first-match parse took it — turning a sorry'd proof
// into `solved` with zero tripwire. A line-number gate is stronger than last-wins
// because it does not assume message ordering; agent-emitted messages always carry
// positions inside the solution, so they cannot cross the line.
// `null` for a declaration means no report was printed at all — the decl is missing, and
// the statement verdict is what says so.
export function axiomReports(messages, solLines, decls) {
  const text = (messages ?? []).filter((m) => (m.line ?? 0) > solLines).map((m) => m.text).join("\n");
  const out = {};
  for (const d of decls) {
    const esc = d.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const m =
      text.match(new RegExp(`'${esc}' depends on axioms: \\[([^\\]]*)\\]`)) ??
      (text.match(new RegExp(`'${esc}' does not depend on any axioms`)) ? [null, ""] : null);
    out[d] = m ? (m[1] === "" ? [] : m[1].split(",").map((s) => s.trim())) : null;
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
// The key does NOT include the compile environment, and that is safe only because of a
// launch precondition rather than a mechanism: a baked library elaborates the
// same statements in a richer env, and `runner/drift-check.js` requires ZERO drift in
// canonical types and values before a library cell may run — so a cache entry written
// under either env is by construction the same entry. If drift-check is ever skipped, a
// library run would write library-env types under a bare-env key. Do not skip it.
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
// STRUCTURED messages rather than filtered out of the server's rendered `pretty`:
// text filtering dropped the "compiled with output:" header along with them on a clean
// compile, so lean_check answered "no output" at the exact moment the agent had
// succeeded. Shape and cap live in runner/render.js, shared with lean-server's render()
// and snippet.js's renderSnippet(), so one error format is used everywhere. The verdict
// the header states is computed by runner/verdict.js from the WHOLE result — the
// server's own `ok` and the statement and axiom verdicts included, which the caller
// passes in via `opts` — so the first line of a check cannot say CLEAN about a file
// whose statement was rewritten.
const PROBE_LINE = /^\s*CMP(?:STMT|VAL)\|/;
// `#print axioms` reports are probe internals too (they ride on every checkedCompile):
// the verdict is parsed line-gated and surfaced as an explicit axiom-check message, so
// the raw report lines are stripped from rendered output the same way CMPSTMT lines are.
const AXIOM_LINE = /^'[^']*' (?:depends on axioms|does not depend on any axioms)/;
export function renderWithoutProbe(messages, sorries, opts = {}) {
  const visible = (messages ?? []).filter((m) => !PROBE_LINE.test(m.text ?? "") && !AXIOM_LINE.test(m.text ?? ""));
  return renderCheck({ messages: visible, sorries, maxHeartbeats: MAX_HEARTBEATS, ...opts });
}

// The full, uncapped rendering goes to a file in the work dir on EVERY check, so the
// agent-facing text can be a digest without anything being destroyed: whatever the cap
// leaves out is one `read` away, and the header says where. Failure to write is not a
// check failure — the digest still stands on its own, and a check is not the moment to
// tell an agent about our filesystem.
export const CHECK_OUTPUT_DIR = ".check";
export const CHECK_OUTPUT_FILE = "last.txt";
function writeFullOutput(dir, name, text) {
  try {
    mkdirSync(join(dir, CHECK_OUTPUT_DIR), { recursive: true });
    writeFileSync(join(dir, CHECK_OUTPUT_DIR, name), text);
    return true;
  } catch {
    return false;
  }
}

// --- agent-facing check client ----------------------------------------------
// The ONE way agent-facing tools (lean_check) compile the agent's file:
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

export async function checkedCompile(code, { original, problemName, client, workDir = null, cap = undefined }) {
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
  // in the agent's own loop — the axiom check included, without which a smuggled
  // `axiom` + `exact` passes compile, statement and sorry checks and the supervisor
  // lets the attempt end on a file the grader then fails as bad_axioms.
  const decls = benchmarkDecls(original);
  const probes = axiomProbe(decls);
  const r = await postCheck({ code: `${code}\n${probes}`, client }, CLIENT_WAIT_MS);
  if (r.error) return r; // { ok:false, error, kind, pretty, ... } — caller words it for the agent
  const probe = parseStmtProbe(r.messages);
  const stmt = await verifyStatement(problemName, original, r.messages);
  // Axiom verdict, the grader's own parser (axiomReports). sorryAx is kept OUT of
  // axiomsBad — it is a sorry, not a smuggled axiom, and the axiom-channel wording
  // ("can NEVER count") would be wrong for it — but it is NOT dropped: it feeds
  // `axSorries`, which the verdict (runner/verdict.js) requires empty for `done`: a
  // suggestion tactic (apply?/exact?) admits the goal via sorryAx with no `sorry` the
  // server can list, and `exact sorryAx ...` written out does the same. The grader
  // fails both as uses_sorry (grade.js keeps sorryAx); the gate reads the same report.
  const reports = axiomReports(r.messages, code.split("\n").length, decls);
  const axiomsBad = {};
  const axSorries = [];
  for (const d of decls) {
    if (reports[d] == null) continue; // decl missing — the statement verdict says so
    if (reports[d].includes("sorryAx")) axSorries.push(d);
    const bad = reports[d].filter((a) => !ALLOWED_AXIOMS.has(a) && a !== "sorryAx");
    if (bad.length) axiomsBad[d] = bad;
  }
  // Render twice over the same structured messages: once uncapped for the file, once as
  // the digest the agent reads. The digest only advertises the file if the write landed.
  const verdict = { ok: r.ok, stmt, axiomsBad, axSorries };
  const bare = renderWithoutProbe(r.messages, r.sorries, { cap, ...verdict });
  const wrote = workDir ? writeFullOutput(workDir, CHECK_OUTPUT_FILE, bare.full) : false;
  const shown = wrote
    ? renderWithoutProbe(r.messages, r.sorries, { cap, ...verdict, outputName: `${CHECK_OUTPUT_DIR}/${CHECK_OUTPUT_FILE}` })
    : bare;
  // No `status` field on the way out, deliberately: the result carries the FACTS
  // (ok, sorries, stmt, axiomsBad) and every consumer reads them through
  // checkStatus()/verifiedDone(), so no cached verdict can go stale beside them.
  // `stmtOriginal` rides along so the statement-modified blocker can QUOTE the file to
  // restore (agents that trip it have usually overwritten their only copy of the
  // original and re-guess the line from memory). FLAG-GATED (CMP_STMT_QUOTE=1), default
  // OFF: the quote changes what the agent reads, so it is an experimental arm, not a
  // fix, and the grid ran without it.
  const stmtOriginal = process.env.CMP_STMT_QUOTE === "1" ? original : null;
  return { ...r, pretty: shown.pretty, full: bare.full, probe, stmt, axiomsBad, axSorries, stmtOriginal };
}
