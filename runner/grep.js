// grep_mathlib core (extensions/lean-grep.ts is the thin tool wrapper): search the
// pinned local Mathlib checkout — the exact source the REPL compiles against, so a
// hit is guaranteed to exist in the agent's environment (the public LeanSearch index
// tracks a different Mathlib pin). Raw grep hits are expanded to whole declarations:
// a bare matching line usually cuts the signature mid-binder, and the signature is
// what the agent needs.

import { spawn } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "lean-env", ".lake", "packages", "mathlib");
export const MATHLIB_SRC = join(PKG_ROOT, "Mathlib");

// Declaration heads sit at column 0 in Mathlib (attributes included); requiring that
// keeps the upward scan from latching onto `have`/`let` lines inside proof bodies.
const HEAD_RE =
  /^(?:@\[|(?:protected\s+|private\s+|noncomputable\s+|nonrec\s+|unsafe\s+|partial\s+|scoped\s+)*(?:theorem|lemma|def|abbrev|instance|structure|class|inductive|axiom|opaque)\b)/;

const RAW_LINE_CAP = 400; // enough raw hits to fill any maxResults after dedup; bounds memory on patterns like "e"
const ANCHOR_LINE_CAP = 4000; // the cross-line pass filters after grep, so it needs a wider net
const GREP_TIMEOUT_MS = 15_000;
const DECL_MAX_LINES = 10;
const DECL_MAX_CHARS = 600;

function runGrep(pattern, { regex, ci, cap = RAW_LINE_CAP }, signal) {
  return new Promise((resolve, reject) => {
    const args = ["-rnI", "--include=*.lean", regex ? "-E" : "-F"];
    if (ci) args.push("-i");
    args.push("--", pattern, MATHLIB_SRC);
    const child = spawn("grep", args, { stdio: ["ignore", "pipe", "pipe"] });
    let out = "", err = "", done = false;
    const finish = (fn, v) => { if (!done) { done = true; clearTimeout(t); fn(v); } };
    const t = setTimeout(() => { child.kill("SIGKILL"); finish(reject, new Error(`grep timed out after ${GREP_TIMEOUT_MS / 1000}s`)); }, GREP_TIMEOUT_MS);
    signal?.addEventListener("abort", () => { child.kill("SIGKILL"); finish(reject, new Error("aborted")); });
    child.stdout.on("data", (d) => {
      out += d;
      // Early kill once we have plenty of raw lines; grep exits with SIGKILL but the
      // collected prefix is a valid (truncated) result.
      if (out.split("\n").length > cap) child.kill("SIGKILL");
    });
    child.stderr.on("data", (d) => (err += d));
    child.on("error", (e) => finish(reject, e));
    child.on("close", (code, sig) => {
      const lines = out.split("\n").filter(Boolean);
      if (sig === "SIGKILL" || code === 0 || code === 1) return finish(resolve, { lines, truncatedRaw: sig === "SIGKILL" });
      finish(reject, new Error(err.trim() || `grep exited ${code}`)); // code 2 = bad pattern etc.
    });
  });
}

// Expand a raw hit (file, 1-based line) to the whole declaration: scan up to the
// column-0 head, then down to the line carrying `:=` (or the caps). Returns
// { headLine, text } — headLine is the dedup key when several raw hits land in one
// declaration.
function expandDecl(fileLines, hitLine) {
  const i = hitLine - 1;
  let head = -1;
  for (let k = i; k >= 0 && k >= i - 12; k--) {
    if (HEAD_RE.test(fileLines[k])) { head = k; break; }
    // A blank line above the hit means the hit was not inside a declaration signature
    // block after all (e.g. a module docstring) — unless the hit line itself is a head.
    if (k < i && fileLines[k].trim() === "") break;
  }
  if (head === -1) return { headLine: hitLine, text: fileLines[i] ?? "" };
  const parts = [];
  for (let k = head; k < fileLines.length && parts.length < DECL_MAX_LINES; k++) {
    parts.push(fileLines[k]);
    if (fileLines[k].includes(":=") || / by$/.test(fileLines[k])) break;
  }
  let text = parts.join("\n");
  if (text.length > DECL_MAX_CHARS) text = text.slice(0, DECL_MAX_CHARS) + " …";
  return { headLine: head + 1, text };
}

// Turn raw `file:line:` grep output into deduplicated, declaration-expanded hits.
// inText(text) decides bucketing: the pattern visible in the expanded declaration
// means the hit IS the declaration/signature — what a name query is after; otherwise
// the raw match sits in the proof body below (a usage site), which is ranked after
// definitions with its matched line appended, or the output shows a containing lemma
// with no visible connection to the query (smoke 0729: a query for an exact lemma
// name returned only baffling-looking lemmas that merely *used* it).
// declOnly drops anything that is not a matching declaration — the cross-line pass
// uses it, because there grep matched an anchor fragment, not the query.
function collectHits(rawLines, { inText, maxResults, truncatedRaw, declOnly = false }) {
  const fileCache = new Map();
  const seen = new Set();
  const declHits = [];
  const usageHits = [];
  let truncated = truncatedRaw;
  for (const raw of rawLines) {
    // grep output is file:line:text; the path contains no colons (repo-controlled).
    const m = raw.match(/^(.*?):(\d+):/);
    if (!m) continue;
    const [, file, lineStr] = m;
    if (!fileCache.has(file)) {
      try { fileCache.set(file, readFileSync(file, "utf8").split("\n")); } catch { fileCache.set(file, null); }
    }
    const fileLines = fileCache.get(file);
    if (!fileLines) continue;
    const { headLine, text } = expandDecl(fileLines, Number(lineStr));
    const key = `${file}:${headLine}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (declHits.length + usageHits.length >= maxResults * 3) { truncated = true; break; }
    const path = relative(PKG_ROOT, file);
    // Resolved from the ORIGINAL block, before the usage branch below appends its `↳`
    // note — the note is commentary, not part of the declaration the name belongs to.
    const named = nameOfHit(fileLines, headLine, text);
    const loc = { path, line: headLine, name: named?.name ?? null, isPrivate: named?.isPrivate ?? false };
    const isDecl = HEAD_RE.test(text.split("\n")[0]);
    // Decl bucket needs both: the pattern visible in the expanded block AND the block
    // actually being a declaration (expandDecl falls back to the bare matched line
    // when no head is found — those are proof-body usages, not declarations).
    if (inText(text) && isDecl) {
      declHits.push({ ...loc, text });
    } else if (declOnly) {
      continue; // anchor hit that does not satisfy the whole query
    } else if (inText(text)) {
      usageHits.push({ ...loc, text });
    } else {
      const matched = (fileLines[Number(lineStr) - 1] ?? "").trim().slice(0, 200);
      usageHits.push({ ...loc, text: `${text}\n  ↳ matches inside its proof, line ${lineStr}: ${matched}` });
    }
  }
  const hits = [...declHits, ...usageHits].slice(0, maxResults);
  if (declHits.length + usageHits.length > maxResults) truncated = true;
  return { hits, truncated };
}

// --- fully-qualified names ----------------------------------------------------
// A Lean declaration's real name is assembled by the elaborator: `namespace
// IntermediateField` + `protected theorem inv_mem` = `IntermediateField.inv_mem`. That
// string never appears in the source, so a text search for the name the agent must
// WRITE finds nothing, while the declaration plainly exists (0730b: 233 dotted-name
// queries came back empty; the declaration existed for 21 of them). Worse, the name
// often does appear at *usage* sites in other files, so the search half-works and
// returns lemmas that merely mention it — the symptom recorded in the 0729 smoke and
// treated then as a ranking problem. This reconstructs the prefix the way Lean does.
// A Lean identifier is not ASCII: Mathlib names carry subscripts and Greek throughout
// (`d₁`, `ε₁`, `HomologicalComplex₂`), and `!`/`?` are ordinary name characters
// (`Array.get!`, `List.find?`). Matching only [A-Za-z_] silently truncates such a name to
// its ASCII prefix, which is worse than not matching at all — `def d₁` inside
// `namespace HomologicalComplex₂` came out as `HomologicalComplex.d`, a name that EXISTS
// (the differential field of `HomologicalComplex`) and points at an unrelated
// declaration. A near-miss returned as a confirmed hit is precisely what rung 0 promises
// never to do, so the classes below stay Unicode-aware everywhere a name is read.
// `«...»` quotes a segment that would otherwise be a keyword (`namespace «Prop»`).
const SEG = String.raw`(?:«[^»]*»|[\p{L}_][\p{L}\p{N}_'!?]*)`;
const NAME = String.raw`${SEG}(?:\.${SEG})*`;
const QUALIFIED = new RegExp(String.raw`^${SEG}(?:\.${SEG})+$`, "u");
// Split a dotted name into the scopes it opens, unquoting as Lean does: the namespace
// `«Prop»` is named `Prop`. A quoted segment may itself contain dots, so this cannot be
// a plain split(".").
// The same split, keeping each segment exactly as the source writes it. The assembled
// name is what the tool now returns, so it has to parse — and whether a segment needs
// `«»` cannot be recovered from the unquoted text: `end` and `exists` look like ordinary
// identifiers but are Lean keywords, which is why Mathlib writes `def «end»` and
// `namespace «Prop»`. Re-deriving the quotes by testing the shape of the segment yields
// `Quiver.Path.end`, which does not parse; carrying the source form does.
// `n` is the unquoted name Lean matches scopes by, `raw` is what to write in a proof.
const splitPairs = (s) =>
  (s.match(/«[^»]*»|[^.]+/gu) ?? []).map((raw) => ({ n: raw.replace(/^«|»$/gu, ""), raw }));
const DECL_KW = "theorem|lemma|def|abbrev|instance|structure|class|inductive|axiom|opaque";
// Strict, JS-side: grep only generates candidates, this decides what is really a head.
// The name stops at the last dotted segment, so a universe annotation (`theorem foo.{u}`,
// 295 heads in Mathlib) does not leave a trailing dot glued to the captured name.
const DECL_NAME_RE = new RegExp(
  // `class abbrev` / `class inductive` are two-word keywords (9 in Mathlib); listed first
  // so the alternation does not stop at `class` and read the second word as the name.
  String.raw`^(?:@\[[^\]]*\]\s*)?(?:protected\s+|private\s+|noncomputable\s+|nonrec\s+|unsafe\s+|partial\s+|scoped\s+)*(?:class\s+abbrev|class\s+inductive|${DECL_KW})\s+(${NAME})`,
  "u",
);
// `alias` declares a name too, and 3,254 of Mathlib's aliases write it plainly
// (`alias foo := bar`). It is deliberately NOT added to DECL_KW — retrieval must not
// change — but a hit on one is a real, nameable declaration, and leaving it unnamed would
// render it as "no enclosing declaration" and drop the only thing this tool now returns.
// The 1,253 anonymous-constructor aliases (`alias ⟨fwd, rev⟩ := h`) declare two names in
// one line and are left unnamed rather than guessed at.
const ALIAS_NAME_RE = new RegExp(
  String.raw`^(?:@\[[^\]]*\]\s*)?(?:protected\s+|private\s+|scoped\s+)*alias\s+(${NAME})\s*:=`,
  "u",
);

// Scope lines. Every form that Mathlib actually writes has to be recognised, because a
// scope that is opened without being tracked gets closed by an `end` that then pops
// something else. Counted over the checkout: `@[expose] public section` (5564),
// `public section` (1430), `noncomputable section` (1165), `public meta section` (309),
// `meta section` (27), the `@[expose] public noncomputable` combination (20), plus plain
// and named sections. `mutual` opens a scope too, and like an anonymous section it is
// closed by a bare `end` (19 files; missing it mis-attributed all 9 theorems below the
// `mutual` in Mathlib/SetTheory/Nimber/Field.lean).
// Scope names use the same identifier grammar as declaration names, for the same reason:
// a name the pattern cannot represent is a push or a pop that silently goes missing.
// Mathlib closes sections named `Foo₂`/`Foo₀` (59 of them) and opens
// `namespace Mathlib.Tactic.Erw?`, whose `end` line failed to parse at all — leaving the
// namespace open for the rest of the file. Trailing line comments are tolerated
// (`end Foo -- section`).
const NAMESPACE_RE = new RegExp(String.raw`^namespace\s+(${NAME})`, "u");
const SECTION_RE = new RegExp(
  String.raw`^(?:@\[[^\]]*\]\s*)?(?:(?:public|meta|noncomputable|private)\s+)*section(?:\s+(${NAME}))?\s*(?:--.*)?$`,
  "u",
);
const MUTUAL_RE = /^mutual\s*(?:--.*)?$/;
const END_RE = new RegExp(String.raw`^end(?:\s+(${NAME}))?\s*(?:--.*)?$`, "u");

// Depth of open `/- -/` comments after this line (they nest). Prose inside a module
// docstring is not scope structure: Mathlib/CategoryTheory/NatIso.lean wraps a line
// beginning "namespace so that they are available..." in its `/-! -/` header, which
// otherwise pushes a namespace called `so` and mis-qualifies all 25 declarations below it.
function commentDepthAfter(line, depth) {
  for (let j = 0; j < line.length - 1; j++) {
    if (depth === 0 && line[j] === "-" && line[j + 1] === "-") break; // rest is a line comment
    if (line[j] === "/" && line[j + 1] === "-") { depth++; j++; }
    else if (line[j] === "-" && line[j + 1] === "/" && depth > 0) { depth--; j++; }
  }
  return depth;
}

// The name Lean gives the declaration on `declLine`: enclosing namespaces, in order,
// prepended to the name as written. `section`s contribute nothing to the name but DO
// consume an `end`, so they must sit on the stack — popping a namespace on an `end` that
// closed a section silently mis-attributes every declaration below it.
//
// EVERY scope has to be pushed, not just the named sections. Because only those were, a
// bare `end` popped the nearest non-namespace entry — reaching past the scope it actually
// closed to a named section further out, and the truncation took the namespaces stacked
// above that one with it. 360 declarations in 32 files came out unqualified (`zero_mem`
// for `LieSubalgebra.zero_mem`, and likewise `LinearEquiv.neg`, `StarAlgHom.comp`,
// `ContinuousMultilinearMap.pi`), so rung 0 missed them and the query fell through to the
// text rungs that answer with usage sites — the exact failure rung 0 exists to prevent.
//
// A bare `end` pops the TOP of the stack, and only when that is a scope a bare `end` can
// legally close (anonymous section or `mutual`). Lean rejects `end` without a name for
// anything else — verified in the REPL: `section / namespace Foo / end` errors with
// "Missing name after `end`" — so if the top is a named scope, our tracking has drifted
// and the safe move is to leave the stack alone. Searching DOWN for something poppable is
// what the old code did, and an over-eager pop deletes namespaces and yields a wrong name;
// an under-eager one only over-qualifies, which costs a rung-0 hit and nothing else.
//
// `namespace A.B` opens one scope PER COMPONENT, so it is pushed as two entries and may be
// closed either as `end A.B` or as `end B` then `end A` — Mathlib does both, and reading
// the compound name as a single indivisible scope left `Equiv.Perm` open for the rest of
// Mathlib/Algebra/Group/End.lean, qualifying 18 `Equiv.*` lemmas as `Equiv.Perm.*`.
function qualifiedSegsAt(fileLines, declLine, nameAsWritten) {
  if (nameAsWritten.startsWith("_root_.")) return splitPairs(nameAsWritten.slice(7)); // escapes every namespace
  const stack = [];
  let depth = 0; // open /- -/ comments (they nest)
  for (let i = 0; i < declLine - 1; i++) {
    const l = fileLines[i];
    const commented = depth > 0;
    depth = commentDepthAfter(l, depth);
    if (commented) continue;
    let m;
    if ((m = l.match(NAMESPACE_RE))) for (const part of splitPairs(m[1])) stack.push({ ns: true, name: part.n, raw: part.raw });
    else if ((m = l.match(SECTION_RE))) {
      // A dotted section decomposes the same way a dotted namespace does: Mathlib opens
      // `section ModuleCat.Unbundled` and closes it with `end Unbundled`.
      if (m[1] === undefined) stack.push({ ns: false, name: null });
      else for (const part of splitPairs(m[1])) stack.push({ ns: false, name: part.n, raw: part.raw });
    }
    else if (MUTUAL_RE.test(l)) stack.push({ ns: false, name: null });
    else if ((m = l.match(END_RE))) {
      if (m[1]) {
        const parts = splitPairs(m[1]).map((q) => q.n);
        const base = stack.length - parts.length;
        if (base >= 0 && parts.every((p, k) => stack[base + k].name === p)) stack.length = base;
        else {
          // Tracking has drifted (a push we did not see). Fall back to the outermost
          // scope of that name, which is where the old code always looked.
          const at = stack.map((s) => s.name).lastIndexOf(parts.join("."));
          if (at >= 0) stack.length = at;
        }
      } else {
        const top = stack[stack.length - 1];
        if (top && !top.ns && top.name === null) stack.pop();
      }
    }
  }
  return [...stack.filter((s) => s.ns).map((s) => ({ n: s.name, raw: s.raw })), ...splitPairs(nameAsWritten)];
}

// Two readings of the same assembled name. The unquoted join is the matching key — rung 0
// compares it against the query, which arrives unquoted. The raw join is what goes back to
// the agent: the same name, written so that it parses.
const qualifiedNameAt = (f, l, n) => qualifiedSegsAt(f, l, n).map((q) => q.n).join(".");
const pasteableNameAt = (f, l, n) => qualifiedSegsAt(f, l, n).map((q) => q.raw).join(".");

// The name to head a hit with. `text` starts at `headLine`, but its first line can be a
// bare attribute — `@[simp]` alone on a line is a head for HEAD_RE — so the keyword line
// is searched for inside the block rather than assumed to be the first. Returns null when
// the block is not a declaration at all: import lines, docstring prose, wrapped binders
// and proof-body lines all reach here (13% of hits over a 120-query replay of the 0730b
// logs), and there is no name to give for those.
function nameOfHit(fileLines, headLine, text) {
  const lines = text.split("\n");
  for (let k = 0; k < lines.length; k++) {
    const m = lines[k].match(DECL_NAME_RE) ?? lines[k].match(ALIAS_NAME_RE);
    if (!m) continue;
    return {
      name: pasteableNameAt(fileLines, headLine + k, m[1]),
      // `private` binds to the file it is written in, so the assembled name is real but
      // NOT usable from problem.lean. Saying so costs a clause; letting the agent spend a
      // check discovering it costs a compile.
      isPrivate: /(?:^|\s)private\s/.test(" " + lines[k].replace(/^@\[[^\]]*\]\s*/, " ")),
    };
  }
  return null;
}

// Declarations whose assembled name is EXACTLY the query. Exact only, by design: a
// declaration that merely shares the final segment (`Fin.val_lt_val` vs the real
// `Units.val_lt_val`) is a different lemma, and offering it as a lead reads as
// confirmation — the run shows the agent already writes names that do not exist 21%
// of the time in that situation, so a wrong lead makes it worse, not better.
async function qualifiedLookup(pattern, maxResults, signal) {
  // `?` is a legal Lean name character (`List.find?`) and an ERE quantifier, so escape
  // before handing the segment to grep.
  const base = pattern.split(".").pop().replace(/[.[\]{}()*+?^$|\\]/g, "\\$&");
  // Lax ERE: grep finds lines where a declaration keyword is followed by the base name
  // (with or without an explicit prefix). DECL_NAME_RE below throws out the rest. The
  // prefix is any non-space run, not an ASCII identifier: `theorem HomologicalComplex₂.d₁`
  // is written with a prefix grep must be allowed to skip over.
  const ere = `(${DECL_KW})[[:space:]]+([^[:space:]]*\\.)?${base}`;
  let r;
  try { r = await runGrep(ere, { regex: true, ci: false, cap: ANCHOR_LINE_CAP }, signal); } catch { return []; }
  const fileCache = new Map();
  const hits = [];
  for (const raw of r.lines) {
    const m = raw.match(/^(.*?):(\d+):(.*)$/);
    if (!m) continue;
    const [, file, lineStr, lineText] = m;
    const nm = lineText.match(DECL_NAME_RE);
    if (!nm) continue;
    if (!fileCache.has(file)) {
      try { fileCache.set(file, readFileSync(file, "utf8").split("\n")); } catch { fileCache.set(file, null); }
    }
    const fileLines = fileCache.get(file);
    if (!fileLines) continue;
    if (qualifiedNameAt(fileLines, Number(lineStr), nm[1]) !== pattern) continue;
    const { headLine, text } = expandDecl(fileLines, Number(lineStr));
    // Resolved the same way as every other hit rather than reusing `pattern`: the query
    // arrives unquoted, and what goes back has to be the form that parses.
    const named = nameOfHit(fileLines, headLine, text);
    hits.push({ path: relative(PKG_ROOT, file), line: headLine, text, name: named?.name ?? null, isPrivate: named?.isPrivate ?? false });
    if (hits.length >= maxResults) break;
  }
  return hits;
}

const META = /[.*+?|()[\]{}^$\\]/;
const META_RUN = /[.*+?|()[\]{}^$\\]+/g;
const isValidRegex = (p) => { try { new RegExp(p); return true; } catch { return false; } };
// Whitespace-insensitive view of a declaration: Mathlib wraps signatures across lines
// and indents continuations, so `A.*B` can only ever match once the block is flat.
const flatten = (t) => t.replace(/\s+/g, " ").trim();

// The literal chunks of a pattern, longest first. These are what grep can search for
// verbatim to find candidate declarations when the pattern itself spans line breaks.
function anchorsOf(pattern) {
  return (META.test(pattern) ? pattern.split(META_RUN) : pattern.split(/\s+/))
    .map((s) => s.trim())
    .filter((s) => s.length >= 3)
    .sort((a, b) => b.length - a.length);
}

function matcherFor(pattern, ci, regex) {
  if (regex) {
    try { const re = new RegExp(pattern, ci ? "i" : ""); return (t) => re.test(t); } catch { return () => true; }
  }
  const needle = ci ? pattern.toLowerCase() : pattern;
  return (t) => (ci ? t.toLowerCase() : t).includes(needle);
}

// Main entry. Returns { hits: [{path, line, text}], truncated, mode }.
//
// The agent does NOT choose the matching mode — it proved unable to (0730b: 3226 of
// 8309 calls passed a pattern full of regex metacharacters with regex=false, so grep
// matched `GL.*Sylow` as 9 literal characters; 99% of those returned nothing, 38% of
// every call in the run). Mode is a property of the tool, like result depth: try the
// interpretations in order of how literally they take the query and stop at the first
// that finds anything.
//
//   1 literal                     grep -F                 (`(a * b) ^ n` stays literal)
//   2 literal, case-insensitive   grep -F -i              (wrong-case guess)
//   3 regex                       grep -E                 (`GL.*Sylow`, one line)
//   4 regex, case-insensitive     grep -E -i
//   5 across line breaks          anchor grep + whole-declaration match
//
// Rung 5 is what a line-based grep structurally cannot do: Mathlib signatures wrap, so
// `card_GL.*Fin.*ZMod` never matches a single line even as a correct regex (0730b: 73%
// of the calls that DID set regex=true still returned nothing). It greps the longest
// literal fragment to get candidate declarations, then tests the whole query against
// each expanded declaration with its whitespace flattened.
export async function grepMathlib(pattern, { maxResults = 10 } = {}, signal) {
  if (!pattern || !pattern.trim()) throw new Error("empty pattern");
  if (!existsSync(MATHLIB_SRC)) throw new Error(`Mathlib checkout not found at ${MATHLIB_SRC}`);
  const asRegex = META.test(pattern) && isValidRegex(pattern);

  // A dotted identifier is a question about a NAME, so answer it as one, before any
  // text rung. Running this last would only rescue the queries that come back empty;
  // running it first also fixes the more common half, where the qualified string does
  // occur at usage sites in other files and the text rungs answer a "does X exist?"
  // question with lemmas that merely mention X and never the declaration itself
  // (`Nat.card_eq_zero`: 4 hits before this, all usage sites, no declaration).
  if (QUALIFIED.test(pattern)) {
    const exact = await qualifiedLookup(pattern, maxResults, signal);
    if (exact.length) return { hits: exact, truncated: false, mode: "qualified-name" };
  }

  const rungs = [
    { mode: "literal", regex: false, ci: false },
    { mode: "literal-ci", regex: false, ci: true },
    ...(asRegex ? [{ mode: "regex", regex: true, ci: false }, { mode: "regex-ci", regex: true, ci: true }] : []),
  ];
  // A pattern grep rejects (valid JS regex, invalid POSIX ERE — `\d`, `\w`, ...) must
  // not sink the whole call: keep the message and only surface it if nothing else hits,
  // where it is the actionable answer.
  let regexErr = null;
  for (const rung of rungs) {
    let r;
    try {
      r = await runGrep(pattern, rung, signal);
    } catch (e) {
      if (!rung.regex) throw e;
      regexErr ??= e;
      continue;
    }
    if (r.lines.length === 0) continue;
    const got = collectHits(r.lines, {
      inText: matcherFor(pattern, rung.ci, rung.regex),
      maxResults,
      truncatedRaw: r.truncatedRaw,
    });
    if (got.hits.length) return { ...got, mode: rung.mode };
  }

  // Rung 5: only worth trying when the query is built from several fragments — a
  // single-fragment query would already have been found above.
  const anchors = anchorsOf(pattern);
  if (anchors.length >= 2) {
    const match = matcherFor(pattern, true, asRegex); // case-insensitive: the rungs above already tried exact case
    for (const anchor of anchors.slice(0, 2)) {
      let r;
      try {
        r = await runGrep(anchor, { regex: false, ci: true, cap: ANCHOR_LINE_CAP }, signal);
      } catch { continue; }
      if (r.lines.length === 0) continue;
      const got = collectHits(r.lines, {
        inText: (text) => match(flatten(text)),
        maxResults,
        truncatedRaw: r.truncatedRaw,
        declOnly: true,
      });
      if (got.hits.length) return { ...got, mode: "cross-line" };
    }
  }

  if (regexErr) throw regexErr;
  return { hits: [], truncated: false, mode: null };
}
