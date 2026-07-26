#!/usr/bin/env node
// Extract Formal Conjectures (google-deepmind/formal-conjectures @ bench-v1-lean4.27.0)
// statements into standalone per-problem files that our pipeline can grade.
//
// Per papers/INDEX.md only `research solved` and `textbook` categories are usable for
// our arm comparisons (the open set is a 0%-floor discovery benchmark). One output
// file per tagged statement, shaped like problems-fatem/: `import Mathlib` + context
// + the statement with a `:= by sorry` body.
//
// Transformations (each justified by runner/grade.js internals):
//  - namespaces are flattened (namespace/section/end lines dropped): the stmt probe
//    resolves declarations by the short name benchmarkDecls() reads from the source,
//    which a namespaced decl would break;
//  - `answer(X)` -> `(X)`: the FC elaborator wraps X in an mdata annotation and
//    CMPStmtCanon erases mdata, so the canonical type is identical; `answer(sorry)`
//    statements are ungradable under type equality and are excluded;
//  - `lemma` -> `theorem`: benchmarkDecls only matches abbrev|def|theorem;
//  - @[category ...] attribute blocks (incl. AMS, formal_proof URLs — provenance
//    leaks) are stripped; other attributes are kept;
//  - /- -/ and /-! -/ block comments and all `--` comments are stripped here because
//    classifyLines() only knows line comments and /-- docstrings; /-- docstrings are
//    KEPT for runner/sanitize.js to strip (or keep under --keep-nl);
//  - proof bodies are replaced by `by sorry` (some solved problems carry in-repo
//    proofs);
//  - context defs containing sorry are dropped (a benchmark decl with sorryAx would
//    make the problem unsolvable under the axiom check).
//
// Imports become `import Mathlib` (the lean server pre-imports Mathlib and blanks
// import lines). Statements that need FormalConjecturesForMathlib fail later at
// `grade.js --build-stmt-cache` and are excluded there — this script is lexical only.
//
// Usage: node scripts/extract-fc.js [--src-dir benchmarks/formal-conjectures]
//                                   [--out-dir benchmarks/fc-extracted]
// Writes <out-dir>/fc_<decl>.lean + <out-dir>/index.json (provenance + exclusions).

import { readdirSync, readFileSync, writeFileSync, mkdirSync, rmSync, statSync } from "node:fs";
import { join, dirname, resolve, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { arg } from "../runner/common.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = resolve(arg("src-dir", join(ROOT, "benchmarks/formal-conjectures")));
const OUT = resolve(arg("out-dir", join(ROOT, "benchmarks/fc-extracted")));
const KEEP_CATEGORIES = ["research solved", "textbook"];

// --- comment stripping --------------------------------------------------------
// Removes nested /- -/ and /-! -/ blocks and `--` line comments, keeps /-- -/
// docstrings and string literals intact.
export function stripComments(src) {
  let out = "";
  let i = 0;
  const n = src.length;
  let inStr = false;
  let depth = 0; // block-comment nesting
  let docDepth = 0; // inside a kept docstring
  while (i < n) {
    const two = src.slice(i, i + 2);
    const three = src.slice(i, i + 3);
    if (depth > 0) {
      if (two === "/-") { depth++; i += 2; continue; }
      if (two === "-/") { depth--; i += 2; continue; }
      if (src[i] === "\n") out += "\n"; // keep line count stable-ish for debugging
      i++;
      continue;
    }
    if (docDepth > 0) {
      if (two === "/-") docDepth++;
      if (two === "-/") { docDepth--; out += "-/"; i += 2; continue; }
      out += src[i];
      i++;
      continue;
    }
    if (inStr) {
      if (two === '\\"' || two === "\\\\") { out += two; i += 2; continue; }
      if (src[i] === '"') inStr = false;
      out += src[i];
      i++;
      continue;
    }
    if (src[i] === '"') { inStr = true; out += '"'; i++; continue; }
    if (three === "/--") { docDepth = 1; out += "/--"; i += 3; continue; }
    if (two === "/-") { depth = 1; i += 2; continue; } // covers /-! too
    if (two === "--") { while (i < n && src[i] !== "\n") i++; continue; }
    out += src[i];
    i++;
  }
  return out;
}

// --- block segmentation --------------------------------------------------------
// A Lean file (comments already stripped) is cut into top-level blocks: a block
// starts at a column-0 line opening a docstring, attribute, declaration, or
// structural/context command; continuation lines (indented) belong to the block.
const BLOCK_START = /^(\/--|@\[|theorem\s|lemma\s|def\s|abbrev\s|noncomputable\s|instance[\s:]|example[\s:]|structure\s|inductive\s|class\s|open\s|namespace\s|end\b|section\b|variable[\s(]|set_option\s|universe\s|local\s|notation\s|macro\s|syntax\s|attribute\s|include\s|omit\s|import\s|#)/;

function segment(src) {
  const lines = src.split("\n");
  const blocks = [];
  let cur = null;
  let inDoc = false;
  let attrDepth = 0;
  for (const line of lines) {
    const isStart = !inDoc && attrDepth === 0 && BLOCK_START.test(line);
    if (isStart || cur === null) {
      if (cur) blocks.push(cur);
      cur = { lines: [] };
    }
    cur.lines.push(line);
    // track multi-line docstrings and multi-line @[...] attributes
    if (!inDoc && /^\s*\/--/.test(line) && !/-\//.test(line)) inDoc = true;
    else if (inDoc && /-\//.test(line)) inDoc = false;
    if (!inDoc) {
      for (const ch of line) {
        if (ch === "[") attrDepth = attrDepth > 0 || /^\s*@\[/.test(line) ? attrDepth + 1 : attrDepth;
        else if (ch === "]" && attrDepth > 0) attrDepth--;
      }
    }
  }
  if (cur) blocks.push(cur);
  return blocks.map((b) => ({ text: b.lines.join("\n") }));
}

// A "unit" = docstring? + attribute? + command, reassembled from consecutive blocks.
function units(blocks) {
  const out = [];
  let pending = [];
  for (const b of blocks) {
    const t = b.text.trimStart();
    if (t.startsWith("/--") || t.startsWith("@[") || /^open\s.*\sin\s*$/.test(b.text.trim())) {
      pending.push(b.text);
      continue;
    }
    out.push({ pre: pending, body: b.text });
    pending = [];
  }
  if (pending.length) out.push({ pre: pending, body: "" });
  return out;
}

// --- unit helpers ---------------------------------------------------------------
const DECL_RE = /^\s*(?:noncomputable\s+)?(theorem|lemma|def|abbrev|instance|example|structure|inductive|class)\b\s*([^\s:(\[{⦃⟨«]*)/;

function categoryOf(unit) {
  const attr = unit.pre.find((p) => p.trimStart().startsWith("@["));
  if (!attr) return null;
  const m = attr.match(/@\[\s*category\s+([a-z ]+?)\s*(?:,|\])/);
  return m ? m[1].trim() : null;
}

// Strip FC-custom attribute components (category/AMS/formal_proof — unknown in plain
// Mathlib, and formal_proof carries proof URLs) while keeping standard ones like simp.
// Components are split on depth-0 commas; an emptied @[...] block is dropped.
function keptPre(unit) {
  const out = [];
  for (const p of unit.pre) {
    const t = p.trimStart();
    if (!t.startsWith("@[")) { out.push(p); continue; }
    const inner = t.slice(t.indexOf("[") + 1, t.lastIndexOf("]"));
    const parts = [];
    let depth = 0, cur = "";
    for (const ch of inner) {
      if ("([{⟨".includes(ch)) depth++;
      else if (")]}⟩".includes(ch)) depth--;
      if (ch === "," && depth === 0) { parts.push(cur); cur = ""; } else cur += ch;
    }
    parts.push(cur);
    const kept = parts.map((s) => s.trim()).filter((s) => s && !/^(category|AMS|formal_proof)\b/.test(s));
    if (kept.length) out.push(`@[${kept.join(", ")}]`);
  }
  return out;
}

// replace answer( ... ) with ( ... ); returns null if any answer(sorry)
export function replaceAnswers(text) {
  let out = "";
  let i = 0;
  while (i < text.length) {
    const m = /answer\s*\(/.exec(text.slice(i));
    const idx = m ? i + m.index : -1;
    if (idx < 0) { out += text.slice(i); break; }
    // word boundary: char before must not be identifier-ish
    const before = idx === 0 ? "" : text[idx - 1];
    if (/[\w.]/.test(before)) { out += text.slice(i, idx + 1); i = idx + 1; continue; }
    const open = text.indexOf("(", idx);
    let depth = 0, j = open;
    for (; j < text.length; j++) {
      if (text[j] === "(") depth++;
      else if (text[j] === ")") { depth--; if (depth === 0) break; }
    }
    const inner = text.slice(open + 1, j);
    if (inner.trim() === "sorry") return null;
    out += text.slice(i, idx) + "(" + inner + ")";
    i = j + 1;
  }
  return out;
}

// Cut the proof body: the first `:=` at bracket-depth 0 outside strings that is
// not consumed by a `let`/`have`/`haveI`/`letI` binder inside the statement type
// (each such binder owns the next depth-0 `:=`, e.g. `theorem t : let M := ...`).
export function replaceBody(text) {
  let depth = 0, inStr = false, pendingBinders = 0;
  const OPEN = "([{⟨⦃⟦"; const CLOSE = ")]}⟩⦄⟧";
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (ch === "\\") i++;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') { inStr = true; continue; }
    if (OPEN.includes(ch)) depth++;
    else if (CLOSE.includes(ch)) depth = Math.max(0, depth - 1);
    else if (depth === 0 && /[a-z]/.test(ch) && (i === 0 || !/[\w.]/.test(text[i - 1]))) {
      const m = /^(let|have|haveI|letI)\b/.exec(text.slice(i, i + 6));
      if (m) { pendingBinders++; i += m[1].length - 1; }
    } else if (ch === ":" && text[i + 1] === "=" && depth === 0) {
      if (pendingBinders > 0) { pendingBinders--; i++; continue; }
      return text.slice(0, i).trimEnd() + " := by sorry";
    }
  }
  return null; // no := found
}

// --- main ------------------------------------------------------------------------
function leanFiles(dir) {
  const out = [];
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) out.push(...leanFiles(p));
    else if (e.endsWith(".lean")) out.push(p);
  }
  return out;
}

function main() {
  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(OUT, { recursive: true });
  const files = leanFiles(join(SRC, "FormalConjectures"))
    .filter((f) => !f.includes("/Util/") && !f.includes("/Subsets/"))
    .sort();
  const index = {};
  const skipped = [];
  const seen = new Set();
  let nStatements = 0;
  for (const f of files) {
    const rel = relative(SRC, f);
    const clean = stripComments(readFileSync(f, "utf8"))
      // normalize same-line constructs the segmenter assumes are separate lines:
      // `-/@[...]` (docstring close + attribute) and `@[...] theorem ...`
      .replace(/-\/[ \t]*@\[/g, "-/\n@[")
      .replace(/^(@\[[^\]]*\])[ \t]+(?=(?:noncomputable\s+)?(?:theorem|lemma|def|abbrev|instance)\b)/gm, "$1\n");
    const us = units(segment(clean));
    // namespaces declared in this file get flattened away, so `open` lines naming
    // them must lose those tokens (or be dropped) to avoid unknown-namespace errors
    const localNs = new Set();
    for (const m of clean.matchAll(/^namespace\s+([\w.«»]+)/gm)) {
      localNs.add(m[1]);
      localNs.add(m[1].split(".").pop());
    }
    const pruneOpen = (line) => {
      const m = line.trimEnd().match(/^(\s*open\s+)(scoped\s+)?(.*?)(\s+in)?$/);
      if (!m) return line;
      const kept = m[3].split(/\s+/).filter((tok) => !localNs.has(tok.replace(/[«»]/g, "")));
      return kept.length ? `${m[1]}${m[2] ?? ""}${kept.join(" ")}${m[4] ?? ""}` : null;
    };
    let ncSection = false; // a dropped `noncomputable section` must still mark its defs
    const context = []; // kept context units, in order
    for (const u of us) {
      const decl = u.body.match(DECL_RE);
      const cat = categoryOf(u);
      const kind = decl?.[1];
      const isStatement = (kind === "theorem" || kind === "lemma" || kind === "example") && cat !== null;
      if (!isStatement) {
        // context unit: keep unless it is an import/#command/example, or a def with sorry
        const t = u.body.trim();
        if (t === "" || t.startsWith("import") || t.startsWith("#") || kind === "example") continue;
        // namespaces/sections are flattened: the grader's stmt probe resolves decls
        // by their short source name, which a namespace prefix would break
        if (/^noncomputable\s+section\b/.test(t)) { ncSection = true; continue; }
        if (/^(namespace|section|end)\b/.test(t)) continue;
        if ((kind === "def" || kind === "abbrev" || kind === "instance") && /(^|[^\w.])sorry([^\w]|$)/.test(u.body)) {
          skipped.push({ file: rel, decl: decl?.[2] ?? "?", reason: "context_def_sorry" });
          continue;
        }
        let withAnswers = replaceAnswers(u.body);
        if (withAnswers === null) { skipped.push({ file: rel, decl: decl?.[2] ?? "?", reason: "context_answer_sorry" }); continue; }
        if (t.startsWith("open")) {
          withAnswers = pruneOpen(withAnswers);
          if (withAnswers === null) continue;
        }
        if (ncSection && (kind === "def" || kind === "abbrev" || kind === "instance") && !/^\s*noncomputable\b/.test(withAnswers)) {
          withAnswers = "noncomputable " + withAnswers.trimStart();
        }
        context.push({ pre: keptPre(u).map(pruneOpen).filter(Boolean), body: withAnswers });
        continue;
      }
      nStatements++;
      const name = decl[2];
      if (!KEEP_CATEGORIES.includes(cat)) continue; // other categories: not context, not emitted
      if (kind === "example") { skipped.push({ file: rel, decl: name, reason: "example_unnamed" }); continue; }
      const noAnswer = replaceAnswers(u.body);
      if (noAnswer === null) { skipped.push({ file: rel, decl: name, reason: "answer_sorry", category: cat }); continue; }
      const stmt = replaceBody(noAnswer.replace(/^(\s*)lemma\b/m, "$1theorem"));
      if (stmt === null) { skipped.push({ file: rel, decl: name, reason: "no_body_marker", category: cat }); continue; }
      let id = "fc_" + name.replace(/[^\w]+/g, "_").replace(/^_+|_+$/g, "");
      while (seen.has(id)) id += "_v2";
      seen.add(id);
      const parts = [];
      for (const c of context) parts.push(...c.pre, c.body);
      parts.push(...keptPre(u).map(pruneOpen).filter(Boolean), stmt);
      const src = ("import Mathlib\n\n" + parts.join("\n") + "\n").replace(/\n{3,}/g, "\n\n");
      writeFileSync(join(OUT, `${id}.lean`), src);
      index[id] = { source: rel, decl: name, category: cat };
    }
  }
  writeFileSync(join(OUT, "index.json"), JSON.stringify({ problems: index, skipped }, null, 1));
  const byCat = {};
  for (const v of Object.values(index)) byCat[v.category] = (byCat[v.category] ?? 0) + 1;
  console.log(`scanned ${files.length} files, ${nStatements} tagged statements`);
  console.log(`emitted ${Object.keys(index).length} problems -> ${OUT}`, byCat);
  const byReason = {};
  for (const s of skipped) byReason[s.reason] = (byReason[s.reason] ?? 0) + 1;
  console.log(`skipped:`, byReason);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
