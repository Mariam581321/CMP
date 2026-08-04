// add_fact core (PLAN.md block C, spawn+facts): the append-only bank of verified
// lemmas, written ONLY through this compiler gate. A candidate is compiled as
// [current bank + candidate] on the lean server and admitted iff it produces no
// errors, no sorry, and no axioms beyond the grader's whitelist — so everything in
// the bank is machine-verified, and compiling against the bank prefix lets facts
// build on earlier facts. Because every admitted fact compiled against the bank it
// joined, any error in [bank + candidate] is attributable to the candidate, and
// message positions are re-labeled into the candidate's own coordinates.
//
// The gate is deliberately STRICTER than grading. Grading treats metaprogramming
// keywords as an advisory tripwire (a human reads each hit); the bank has no human in
// the loop and its whole value is that its contents can be trusted blindly — by the
// main agent, by workers, and by every later fact compiled on top. So constructs that
// could smuggle unchecked declarations past the per-name axiom probe (macros, elab,
// run_cmd, axiom/opaque/unsafe, env access) are rejected lexically, with the reason.
// Honest lemmas need none of them.
//
// Concurrency: parent and workers are separate processes sharing one bank file, so
// admission is serialized under an on-disk lock (mkdir is atomic). Without it, two
// candidates could each compile green against the same prefix and append code that
// was never compiled TOGETHER (e.g. both declaring the same name) — breaking the
// invariant that the bank as a whole always compiles.

import { readFileSync, writeFileSync, existsSync, mkdirSync, rmdirSync, statSync } from "node:fs";
import { postCheck, classifyLines } from "./common.js";
import { CLIENT_WAIT_MS, bannedTactic } from "./stmt.js";
import { suspiciousKeywords, ALLOWED_AXIOMS } from "./grade.js";

// What a candidate may declare: named lemma/theorem/def/abbrev/instance heads,
// optionally attributed, scanned over CODE lines only (a name inside a comment must
// not reach `#print axioms`, where it would error as an unknown constant and reject a
// valid fact). Same scope-stack idea as stmt.js benchmarkDecls, extended with `lemma`
// and `instance` (facts are agent-written, not benchmark-generated) and with balance
// tracking: a candidate that leaves a namespace/section open would silently re-scope
// every fact appended after it, so unbalanced candidates are rejected outright.
function scanDecls(code) {
  const codeLines = classifyLines(code).filter((l) => l.kind === "code").map((l) => l.line);
  const names = [];
  const scopes = [];
  let unbalanced = false;
  for (const line of codeLines) {
    let m;
    if ((m = /^\s*namespace\s+(\S+)\s*$/.exec(line))) { scopes.push(m[1].split(".")); continue; }
    if (/^\s*section(\s+\S+)?\s*$/.test(line)) { scopes.push([]); continue; }
    if (/^\s*end(\s+\S+)?\s*$/.test(line)) {
      if (!scopes.length) unbalanced = true;
      scopes.pop();
      continue;
    }
    if ((m = /^\s*(?:@\[[^\]]*\]\s*)?(?:noncomputable\s+)?(?:abbrev|def|theorem|lemma|instance)\s+([^\s:({\[⦃]+)/.exec(line))) {
      names.push([...scopes.flat(), m[1]].join("."));
    }
  }
  if (scopes.length) unbalanced = true;
  return { names, unbalanced };
}

const reject = (why) => ({ ok: false, pretty: `FACT REJECTED (bank unchanged): ${why}` });
const cap = (s, n = 6000) => (s.length > n ? s.slice(0, n) + "\n... (truncated)" : s);

// Serialize [read bank, compile, append] across processes. The hold time is bounded by
// one queued compile (CLIENT_WAIT_MS), so the steal threshold sits just above it: a
// lock older than that belongs to a process that died mid-add (SIGKILL at the budget
// cap), not to a live compile.
async function withBankLock(factsFile, fn) {
  const lockDir = `${factsFile}.lock`;
  const stale = CLIENT_WAIT_MS + 5 * 60_000;
  const deadline = Date.now() + CLIENT_WAIT_MS + 10 * 60_000;
  for (;;) {
    try { mkdirSync(lockDir); break; } catch {
      try { if (Date.now() - statSync(lockDir).mtimeMs > stale) { rmdirSync(lockDir); continue; } } catch {}
      if (Date.now() > deadline) throw new Error("fact bank lock timeout — a concurrent add_fact never released the bank");
      await new Promise((r) => setTimeout(r, 300 + Math.random() * 400));
    }
  }
  try { return await fn(); } finally { try { rmdirSync(lockDir); } catch {} }
}

// Compile-gate one candidate into the bank at factsFile. Returns {ok, pretty, ...};
// server-level failures come back as {error, kind, ...} for the caller to word.
// `blockedNames`: benchmark declaration names are reserved — a bank fact declaring
// one would collide when the bank is baked into the compile env (block D: the 0804
// smoke librarian pre-proved the benchmark theorems under their exact names, and
// every statement then failed to elaborate with "already been declared"; caught by
// drift-check, now rejected at admission where the fix costs one rename).
export async function addFact(code, { factsFile, client, blockedNames }) {
  code = (code ?? "").trim();
  if (!code) return reject("empty code.");
  if (bannedTactic(code))
    return reject(
      "it uses `native_decide`, which is banned — it trusts the native compiler instead of " +
        "the Lean kernel. Close goals with kernel-checked reasoning (`decide`, `norm_num`, `omega`, ... are fine).",
    );
  const susp = suspiciousKeywords(code);
  if (susp.length)
    return reject(
      `it uses ${susp.map((s) => `\`${s}\``).join(", ")}. The bank admits only plain, named ` +
        "lemma/theorem/def/abbrev/instance declarations — no metaprogramming, no axiom/opaque/unsafe, " +
        "nothing that could put an unverified declaration into the environment.",
    );
  if (/^\s*(?:@\[[^\]]*\]\s*)?(?:private|protected)\s/m.test(code))
    return reject("`private`/`protected` declarations cannot be shared — drop the modifier.");
  const scan = scanDecls(code);
  if (scan.unbalanced)
    return reject("its namespace/section/end structure is unbalanced — a fact must close every scope it opens.");
  if (!scan.names.length)
    return reject(
      "no named declaration found. The bank admits named lemma/theorem/def/abbrev/instance " +
        "declarations (a name is required so the fact's axioms can be verified and others can use it).",
    );
  const reserved = scan.names.filter((n) => blockedNames?.has?.(n) ?? blockedNames?.includes?.(n));
  if (reserved.length)
    return reject(
      `${reserved.map((n) => `\`${n}\``).join(", ")} ${reserved.length > 1 ? "are" : "is a"} reserved ` +
        "problem-statement name" + (reserved.length > 1 ? "s" : "") + " — the problems must declare " +
        (reserved.length > 1 ? "these names" : "this name") + " themselves, so the bank may not. " +
        "State your fact under a different name (the statement can be the same).",
    );

  return withBankLock(factsFile, async () => {
    const bank = existsSync(factsFile) ? readFileSync(factsFile, "utf8") : "";
    const bankPart = bank.trim() ? bank.trimEnd() + "\n\n" : "";
    const prefixLines = bankPart ? bankPart.split("\n").length - 1 : 0;
    const full = bankPart + code;
    const fullLines = full.split("\n").length;
    const probes = scan.names.map((n) => `#print axioms ${n}`).join("\n");
    const r = await postCheck({ code: `${full}\n${probes}\n`, client }, CLIENT_WAIT_MS);
    if (r.error) return r; // typed server failure — caller words it for the agent

    // Any error rejects, wherever it lands: in the candidate (its own bug, re-labeled to
    // its coordinates), in the bank region (only reachable as an interaction the
    // candidate caused — the bank alone compiled when it was admitted), or in the probe
    // region (a scanned name that never became a declaration).
    const msgs = (r.messages ?? []).filter((m) => m.severity === "error" || m.line <= fullLines);
    const errs = msgs.filter((m) => m.severity === "error");
    if (errs.length) {
      const rendered = msgs
        .map((m) =>
          m.line > fullLines
            ? `${m.severity}: (axiom probe) ${m.text}`
            : m.line > prefixLines
              ? `${m.severity}: fact:${m.line - prefixLines}:${m.column}: ${m.text}`
              : `${m.severity}: facts.lean:${m.line}:${m.column} (existing bank — this candidate conflicts with it, e.g. a duplicate name): ${m.text}`,
        )
        .join("\n\n");
      return { ok: false, pretty: `FACT REJECTED (bank unchanged) — it does not compile against Mathlib + the current bank:\n${cap(rendered)}` };
    }
    // Sorry gate: the bank prefix is sorry-free by construction, so any sorry is the
    // candidate's. Both surfaces checked — the sorries list catches `sorry` terms, the
    // warning text catches anything the elaborator turned into sorryAx.
    if ((r.sorries ?? []).length || msgs.some((m) => /declaration uses 'sorry'/.test(m.text ?? "")))
      return reject("it contains `sorry`. Only fully proved facts are admitted — prove it or split off the part you can prove.");
    // Axiom gate, same mechanics as the grader: reports are parsed only from messages
    // past the end of the compiled code, where the appended `#print axioms` commands
    // live, so nothing the candidate prints can spoof a verdict (grade.js's line gate).
    const probeText = (r.messages ?? []).filter((m) => (m.line ?? 0) > fullLines).map((m) => m.text).join("\n");
    for (const n of scan.names) {
      const esc = n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const m =
        probeText.match(new RegExp(`'${esc}' depends on axioms: \\[([^\\]]*)\\]`)) ??
        (probeText.match(new RegExp(`'${esc}' does not depend on any axioms`)) ? [null, ""] : null);
      if (!m) return reject(`no axiom report for \`${n}\` — it did not become a checkable declaration.`);
      const bad = (m[1] === "" ? [] : m[1].split(",").map((s) => s.trim())).filter((a) => !ALLOWED_AXIOMS.has(a));
      if (bad.length) return reject(`\`${n}\` depends on disallowed axioms: [${bad.join(", ")}].`);
    }

    const newBank = `${bankPart}${code}\n`;
    writeFileSync(factsFile, newBank);
    const bankNames = scanDecls(newBank).names;
    return {
      ok: true,
      names: scan.names,
      bankNames,
      pretty:
        `Admitted to the fact bank: ${scan.names.join(", ")} — verified (compiles, sorry-free, clean axioms).\n` +
        `The bank now holds ${bankNames.length} declaration(s): ${bankNames.join(", ")}`,
    };
  });
}
