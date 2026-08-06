// Edit-tool core (extensions/cmp-edit.ts is the tool wrapper that shadows pi's
// built-in `edit`). Reimplements pi's exact-replacement semantics with two fixes:
//
// 1. Fuzzy matching is trailing-whitespace-only. pi (≤0.80.x) normalizes with NFKC +
//    quote/dash folding and writes touched lines back from normalized space, which
//    corrupts Lean unicode on any fuzzy-matched edit: ℕ→N, x⁻¹→x-1 (verified against
//    pi's edit-diff.ts) — a "successful" edit that breaks the file. Trailing
//    whitespace is the only mismatch worth auto-healing in Lean source, and it
//    round-trips losslessly.
// 2. A failed match returns the closest-matching region of the file (best
//    bigram-similarity line window), so the model can fix its oldText in one cheap
//    turn instead of re-reading or thrashing (7.3% of edit calls failed to match in
//    the 0727 81-run). Error wording is harness design surface.
//
// Error messages otherwise mirror pi's so run comparisons before/after the swap stay
// interpretable.

// --- argument shims -----------------------------------------------------------
// pi's compatibility shims for how models actually call the edit tool: some send
// `edits` as a JSON string, some send a single legacy top-level oldText/newText pair.
// Lives here rather than inside the tool because a session transcript records the RAW
// model arguments, so anything replaying an attempt's edits (scripts/highwater-scan.mjs)
// has to normalize them the same way the tool did or it reconstructs a different file.
// Measured: the legacy pair form accounts for every replay divergence in the 0805 grep
// cell — 5 attempts, up to 109 checks each, reconstructed against the wrong bytes.
export function normalizeEditArgs(args) {
  if (!args || typeof args !== "object") return args;
  if (typeof args.edits === "string") {
    try {
      const parsed = JSON.parse(args.edits);
      if (Array.isArray(parsed)) args.edits = parsed;
    } catch {}
  }
  if (typeof args.oldText === "string" && typeof args.newText === "string") {
    const { oldText, newText, ...rest } = args;
    return { ...rest, edits: [...(Array.isArray(args.edits) ? args.edits : []), { oldText, newText }] };
  }
  return args;
}

// --- text helpers ------------------------------------------------------------

const stripTrailingWS = (text) => text.split("\n").map((l) => l.replace(/[ \t]+$/, "")).join("\n");

function bigrams(s) {
  const m = new Map();
  for (let i = 0; i < s.length - 1; i++) {
    const b = s.slice(i, i + 2);
    m.set(b, (m.get(b) ?? 0) + 1);
  }
  return m;
}

function diceSimilarity(a, b) {
  let inter = 0, na = 0, nb = 0;
  for (const v of a.values()) na += v;
  for (const v of b.values()) nb += v;
  for (const [k, v] of a) { const w = b.get(k); if (w) inter += Math.min(v, w); }
  return na + nb === 0 ? 0 : (2 * inter) / (na + nb);
}

// Best-matching window of the file for a failed oldText, as a numbered snippet.
// Window height = oldText's line count; scored by bigram Dice over trimmed lines.
export function closestRegion(content, oldText) {
  const lines = content.split("\n");
  const W = Math.min(Math.max(oldText.split("\n").length, 1), lines.length);
  const target = bigrams(oldText.split("\n").map((l) => l.trim()).join("\n"));
  // Trim once, not once per window: every line used to be re-trimmed, re-joined and
  // re-bigrammed for each of the W windows containing it, so a failed edit on a long
  // file did O(lines x W) string work and allocated a Map per window. Roughly 7% of edit
  // calls miss, and this runs on every one of them.
  const trimmed = lines.map((l) => l.trim());
  let best = { score: -1, start: 0 };
  for (let s = 0; s + W <= lines.length; s++) {
    const score = diceSimilarity(bigrams(trimmed.slice(s, s + W).join("\n")), target);
    if (score > best.score) best = { score, start: s };
  }
  const from = Math.max(0, best.start - 1);
  const to = Math.min(lines.length, best.start + W + 1);
  let snippet = lines.slice(from, to).join("\n");
  if (snippet.length > 600) snippet = snippet.slice(0, 600) + " …";
  return { fromLine: from + 1, toLine: to, snippet, score: best.score };
}

function notFoundError(path, content, oldText, editIndex, totalEdits) {
  const which = totalEdits === 1 ? "the exact text" : `edits[${editIndex}]`;
  let msg = `Could not find ${which} in ${path}. oldText must match the file exactly, including all whitespace and newlines.`;
  const near = closestRegion(content, oldText);
  if (near.score >= 0.3) {
    msg +=
      `\nClosest region in the file (lines ${near.fromLine}-${near.toLine}):\n` +
      `${near.snippet}\n` +
      `Copy oldText verbatim from this region, or read the file again if it does not look familiar.`;
  } else {
    msg += ` Nothing similar found — read the file again; it has likely changed since you last saw it.`;
  }
  return new Error(msg);
}

// --- matching ----------------------------------------------------------------

// Exact match first; if any edit needs it, all matching moves to
// trailing-whitespace-stripped space (same all-or-nothing rule as pi, so offsets
// live in one consistent space).
function findIn(hay, needle) {
  const idx = hay.indexOf(needle);
  return idx === -1 ? null : { index: idx, length: needle.length };
}

const countIn = (hay, needle) => hay.split(needle).length - 1;

// Overlay replacements (offsets in `base`, which differs from `original` only by
// trailing whitespace, so line counts agree) onto the original: only the touched
// line ranges are rewritten from base-space, every other line keeps its bytes.
function applyPreservingUntouchedLines(original, base, reps) {
  const origLines = original.split("\n");
  const baseLines = base.split("\n");
  const starts = [];
  let off = 0;
  for (const l of baseLines) { starts.push(off); off += l.length + 1; }
  const lineOf = (offset) => {
    let lo = 0, hi = starts.length - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (starts[mid] <= offset) lo = mid; else hi = mid - 1; }
    return lo;
  };
  const groups = [];
  for (const r of [...reps].sort((a, b) => a.index - b.index)) {
    const startLine = lineOf(r.index);
    const endLine = lineOf(Math.max(r.index, r.index + r.length - 1)) + 1;
    const cur = groups[groups.length - 1];
    if (cur && startLine < cur.endLine) {
      cur.endLine = Math.max(cur.endLine, endLine);
      cur.reps.push(r);
    } else groups.push({ startLine, endLine, reps: [r] });
  }
  let out = "";
  let lineIdx = 0;
  for (const g of groups) {
    out += origLines.slice(lineIdx, g.startLine).map((l) => l + "\n").join("");
    const gStart = starts[g.startLine];
    // The slice INCLUDES the group's trailing line separator (when one exists), so a
    // match that consumed the newline replaces it too. The old form ended the slice at
    // the last line's text and re-appended "\n" unconditionally — an oldText ending in
    // "\n" then got its newline twice, silently inserting a blank line per fuzzy edit.
    const gEnd = g.endLine - 1 < baseLines.length - 1 ? starts[g.endLine] : base.length;
    let slice = base.slice(gStart, gEnd);
    for (const r of [...g.reps].sort((a, b) => b.index - a.index)) {
      const i = r.index - gStart;
      slice = slice.slice(0, i) + r.newText + slice.slice(i + r.length);
    }
    out += slice;
    lineIdx = g.endLine;
  }
  out += origLines.slice(lineIdx).map((l, i) => (lineIdx + i < origLines.length - 1 ? l + "\n" : l)).join("");
  return out;
}

// --- entry -------------------------------------------------------------------

// edits: [{oldText, newText}]. Returns { newContent }. Throws with model-facing
// messages on: empty oldText, not found (with closest-region snippet), ambiguous,
// overlapping edits, no-op result.
export function applyEdits(rawContent, edits, path) {
  const bom = rawContent.startsWith("﻿") ? "﻿" : "";
  const withoutBom = bom ? rawContent.slice(1) : rawContent;
  const ending = withoutBom.includes("\r\n") ? "\r\n" : "\n";
  const content = withoutBom.replace(/\r\n/g, "\n");
  const norm = edits.map((e) => ({
    oldText: String(e.oldText ?? "").replace(/\r\n/g, "\n"),
    newText: String(e.newText ?? "").replace(/\r\n/g, "\n"),
  }));

  norm.forEach((e, i) => {
    if (e.oldText.length === 0) {
      throw new Error(norm.length === 1 ? `oldText must not be empty in ${path}.` : `edits[${i}].oldText must not be empty in ${path}.`);
    }
  });

  const anyFuzzy = norm.some((e) => findIn(content, e.oldText) === null);
  const base = anyFuzzy ? stripTrailingWS(content) : content;

  const matched = [];
  for (let i = 0; i < norm.length; i++) {
    const needle = anyFuzzy ? stripTrailingWS(norm[i].oldText) : norm[i].oldText;
    const m = findIn(base, needle);
    if (!m) throw notFoundError(path, content, norm[i].oldText, i, norm.length);
    const occurrences = countIn(base, needle);
    if (occurrences > 1) {
      const which = norm.length === 1 ? "the text" : `edits[${i}]`;
      throw new Error(`Found ${occurrences} occurrences of ${which} in ${path}. The text must be unique — include more surrounding context to disambiguate.`);
    }
    matched.push({ editIndex: i, index: m.index, length: m.length, newText: norm[i].newText });
  }

  matched.sort((a, b) => a.index - b.index);
  for (let i = 1; i < matched.length; i++) {
    if (matched[i - 1].index + matched[i - 1].length > matched[i].index) {
      throw new Error(`edits[${matched[i - 1].editIndex}] and edits[${matched[i].editIndex}] overlap in ${path}. Merge them into one edit or target disjoint regions.`);
    }
  }

  let newContent;
  if (anyFuzzy) {
    newContent = applyPreservingUntouchedLines(content, base, matched);
  } else {
    newContent = content;
    for (let i = matched.length - 1; i >= 0; i--) {
      const r = matched[i];
      newContent = newContent.slice(0, r.index) + r.newText + newContent.slice(r.index + r.length);
    }
  }

  if (newContent === content) {
    throw new Error(`No changes made to ${path} — the replacement produced identical content. Check that newText actually differs from oldText.`);
  }

  return { newContent: bom + (ending === "\r\n" ? newContent.replace(/\n/g, "\r\n") : newContent) };
}
