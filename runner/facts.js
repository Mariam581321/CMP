// add_fact core: compile-gated, append-only bank of verified facts, serialized under an on-disk lock.

import { readFileSync, writeFileSync, existsSync, mkdirSync, rmdirSync, statSync } from "node:fs";
import { postCheck, classifyLines } from "./common.js";
import { CLIENT_WAIT_MS } from "./check-env.js";
import { RENDER_CAP } from "./render.js";
import { bannedTactic } from "./stmt.js";
import { suspiciousKeywords, ALLOWED_AXIOMS } from "./grade.js";

// Declared names in a candidate (code lines only), and whether its scopes balance.
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
const cap = (s, n = RENDER_CAP) => (s.length > n ? s.slice(0, n) + "\n... (truncated)" : s);

// Cross-process lock around [read bank, compile, append]; stale locks are stolen.
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

// Compile-gates one candidate into the bank. Returns {ok, pretty, ...} or a server {error, ...}.
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
    if (r.error) return r;

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
    if ((r.sorries ?? []).length || msgs.some((m) => /declaration uses 'sorry'/.test(m.text ?? "")))
      return reject("it contains `sorry`. Only fully proved facts are admitted — prove it or split off the part you can prove.");
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
