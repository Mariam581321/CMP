// Edit-tool core: exact replacement, trailing-whitespace-only fuzzy matching, closest-region hint on failure.

// Normalizes stringified `edits` and legacy top-level oldText/newText.
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

// Region of the file most similar to a failed oldText (bigram Dice over line windows).
export function closestRegion(content, oldText) {
  const lines = content.split("\n");
  const W = Math.min(Math.max(oldText.split("\n").length, 1), lines.length);
  const target = bigrams(oldText.split("\n").map((l) => l.trim()).join("\n"));
  const trimmed = lines.map((l) => l.trim());
  let best = { score: -1, start: 0 };
  for (let s = 0; s + W <= lines.length; s++) {
    const score = diceSimilarity(bigrams(trimmed.slice(s, s + W).join("\n")), target);
    if (score > best.score) best = { score, start: s };
  }
  const from = Math.max(0, best.start - 1);
  const to = Math.min(lines.length, best.start + W + 1);
  let snippet = lines.slice(from, to).join("\n");
  if (snippet.length > 2000) snippet = snippet.slice(0, 2000) + " …";
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

function findIn(hay, needle) {
  const idx = hay.indexOf(needle);
  return idx === -1 ? null : { index: idx, length: needle.length };
}

const countIn = (hay, needle) => hay.split(needle).length - 1;

// Applies replacements from `base` onto `original`, rewriting only touched lines.
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
