// Statement probes: what a file declares, whether the statement survived, and the agent-facing check.
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

// Fully qualified names of the declarations in the original problem file.
export function benchmarkDecls(originalSource) {
  const decls = [];
  const scopes = [];
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

// Lean code that logs each decl's kind, safety, sorry use, canonical type and value as CMPSTMT/CMPVAL lines.
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

export const axiomProbe = (decls) =>
  `${stmtProbe(decls)}\n${decls.map((d) => `#print axioms _root_.${d}`).join("\n")}\n`;

export function parseStmtProbe(messages) {
  const out = {};
  for (const m of messages ?? []) {
    const t = (m.text ?? "").trim();
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

// Parse `#print axioms` output per declaration; null when absent.
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

export function serverCheck(code, client = "grader", force = false) {
  return postCheck({ code, client, force }, CLIENT_WAIT_MS);
}

const memoOrig = new Map();
const hasValues = (entry) => Object.values(entry?.decls ?? {}).every((d) => d.value !== undefined);
const hasAll = (entry, decls) => decls.every((d) => entry?.decls?.[d] !== undefined);
// Probe results for the original file, memoized and cached on disk by source hash.
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
  const tmp = `${STMT_CACHE}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(disk, null, 1));
  renameSync(tmp, STMT_CACHE);
  memoOrig.set(problemName, { sha, decls: entry });
  return entry;
}

// Compare a checked file's probe results against the original's.
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

const PROBE_LINE = /^\s*CMP(?:STMT|VAL)\|/;
const AXIOM_LINE = /^'[^']*' (?:depends on axioms|does not depend on any axioms)/;
// Render compiler output with probe and axiom lines hidden.
export function renderWithoutProbe(messages, sorries, opts = {}) {
  const visible = (messages ?? []).filter((m) => !PROBE_LINE.test(m.text ?? "") && !AXIOM_LINE.test(m.text ?? ""));
  return renderCheck({ messages: visible, sorries, maxHeartbeats: MAX_HEARTBEATS, ...opts });
}

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

const NATIVE_DECIDE_RE = /(^|[^\w.])native_decide($|[^\w])/m;

export function bannedTactic(code) {
  const codeOnly = classifyLines(code).filter((l) => l.kind === "code").map((l) => l.line).join("\n");
  return NATIVE_DECIDE_RE.test(codeOnly) ? "native_decide" : null;
}

// Agent-facing check: compile with probes, verify statement and axioms, write full output to .check/.
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
  const decls = benchmarkDecls(original);
  const probes = axiomProbe(decls);
  const r = await postCheck({ code: `${code}\n${probes}`, client }, CLIENT_WAIT_MS);
  if (r.error) return r;
  const probe = parseStmtProbe(r.messages);
  const stmt = await verifyStatement(problemName, original, r.messages);
  const reports = axiomReports(r.messages, code.split("\n").length, decls);
  const axiomsBad = {};
  const axSorries = [];
  for (const d of decls) {
    if (reports[d] == null) continue;
    if (reports[d].includes("sorryAx")) axSorries.push(d);
    const bad = reports[d].filter((a) => !ALLOWED_AXIOMS.has(a) && a !== "sorryAx");
    if (bad.length) axiomsBad[d] = bad;
  }
  const verdict = { ok: r.ok, stmt, axiomsBad, axSorries };
  const bare = renderWithoutProbe(r.messages, r.sorries, { cap, ...verdict });
  const wrote = workDir ? writeFullOutput(workDir, CHECK_OUTPUT_FILE, bare.full) : false;
  const shown = wrote
    ? renderWithoutProbe(r.messages, r.sorries, { cap, ...verdict, outputName: `${CHECK_OUTPUT_DIR}/${CHECK_OUTPUT_FILE}` })
    : bare;
  const stmtOriginal = process.env.CMP_STMT_QUOTE === "1" ? original : null;
  return { ...r, pretty: shown.pretty, full: bare.full, probe, stmt, axiomsBad, axSorries, stmtOriginal };
}
