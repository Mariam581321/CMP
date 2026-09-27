// grep_mathlib core: search Mathlib source (and any baked library) and return whole declarations.
import { spawn } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "lean-env", ".lake", "packages", "mathlib");
export const MATHLIB_SRC = join(PKG_ROOT, "Mathlib");

const libFile = () => {
  const f = process.env.CMP_LIB_FILE;
  return f && existsSync(f) ? f : null;
};
const displayPath = (file) => (file === process.env.CMP_LIB_FILE ? "library.lean" : relative(PKG_ROOT, file));

const HEAD_RE =
  /^(?:@\[|(?:protected\s+|private\s+|noncomputable\s+|nonrec\s+|unsafe\s+|partial\s+|scoped\s+)*(?:theorem|lemma|def|abbrev|instance|structure|class|inductive|axiom|opaque)\b)/;

const RAW_LINE_CAP = 20_000;
const ANCHOR_LINE_CAP = 20_000;
const GREP_TIMEOUT_MS = 30_000;
const DECL_MAX_LINES = 24;
const DECL_MAX_CHARS = 1600;

function runGrep(pattern, { regex, ci, cap = RAW_LINE_CAP }, signal) {
  return new Promise((resolve, reject) => {
    const args = ["-rnI", "--include=*.lean", regex ? "-E" : "-F"];
    if (ci) args.push("-i");
    args.push("--", pattern, MATHLIB_SRC, ...(libFile() ? [libFile()] : []));
    const child = spawn("grep", args, { stdio: ["ignore", "pipe", "pipe"] });
    let out = "", err = "", done = false;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    const finish = (fn, v) => { if (!done) { done = true; clearTimeout(t); fn(v); } };
    const t = setTimeout(() => { child.kill("SIGKILL"); finish(reject, new Error(`grep timed out after ${GREP_TIMEOUT_MS / 1000}s`)); }, GREP_TIMEOUT_MS);
    signal?.addEventListener("abort", () => { child.kill("SIGKILL"); finish(reject, new Error("aborted")); });
    let lineCount = 0;
    let killed = false;
    child.stdout.on("data", (d) => {
      out += d;
      for (let i = -1; (i = d.indexOf("\n", i + 1)) !== -1; ) lineCount++;
      if (!killed && lineCount > cap) { killed = true; child.kill("SIGKILL"); }
    });
    child.stderr.on("data", (d) => (err += d));
    child.on("error", (e) => finish(reject, e));
    child.on("close", (code, sig) => {
      const lines = out.split("\n").filter(Boolean);
      if (sig === "SIGKILL" || code === 0 || code === 1) return finish(resolve, { lines, truncatedRaw: sig === "SIGKILL" });
      finish(reject, new Error(err.trim() || `grep exited ${code}`));
    });
  });
}

// Expand a hit to its enclosing declaration signature, if any.
function expandDecl(fileLines, hitLine) {
  const i = hitLine - 1;
  let head = -1;
  for (let k = i; k >= 0 && k >= i - 12; k--) {
    if (HEAD_RE.test(fileLines[k])) { head = k; break; }
    if (k < i && fileLines[k].trim() === "") break;
  }
  if (head === -1) return { headLine: hitLine, text: fileLines[i] ?? "" };
  const parts = [];
  for (let k = head; k < fileLines.length && parts.length < DECL_MAX_LINES; k++) {
    if (k > head && fileLines[k].trim() === "") break;
    parts.push(fileLines[k]);
    if (fileLines[k].includes(":=") || / by$/.test(fileLines[k])) break;
  }
  let text = parts.join("\n");
  if (text.length > DECL_MAX_CHARS) text = text.slice(0, DECL_MAX_CHARS) + " …";
  return { headLine: head + 1, text };
}

// Rank: 0 exact name, 1 exact last component, 2 name contains pattern, 3 other.
function nameTier(name, { pattern, ci, inName }) {
  if (!name) return 3;
  const fold = (s) => (ci ? s.toLowerCase() : s);
  const q = fold(pattern);
  if (fold(name) === q) return 0;
  if (fold(name.split(".").pop()) === q) return 1;
  return inName(name) ? 2 : 3;
}

// Turn raw grep lines into deduplicated, declaration-expanded, ranked hits.
function collectHits(rawLines, { inText, inName, pattern, ci, maxResults, truncatedRaw, declOnly = false }) {
  const fileCache = new Map();
  const seen = new Set();
  const declHits = [];
  const usageHits = [];
  let truncated = truncatedRaw;
  for (const raw of rawLines) {
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
    const path = displayPath(file);
    const named = nameOfHit(fileLines, headLine, text);
    const loc = { path, line: headLine, name: named?.name ?? null, isPrivate: named?.isPrivate ?? false };
    const isDecl = HEAD_RE.test(text.split("\n")[0]);
    if (inText(text) && isDecl) {
      declHits.push({ ...loc, text });
    } else if (declOnly) {
      continue;
    } else if (inText(text)) {
      usageHits.push({ ...loc, text });
    } else {
      const matched = (fileLines[Number(lineStr) - 1] ?? "").trim().slice(0, 200);
      usageHits.push({ ...loc, text: `${text}\n  ↳ matches inside its proof, line ${lineStr}: ${matched}` });
    }
  }
  const rank = { pattern, ci, inName };
  const ranked = declHits
    .map((h, i) => ({ h, tier: nameTier(h.name, rank), i }))
    .sort((a, b) => a.tier - b.tier || a.i - b.i)
    .map((x) => x.h);
  const hits = [...ranked, ...usageHits].slice(0, maxResults);
  if (declHits.length + usageHits.length > maxResults) truncated = true;
  return { hits, truncated };
}

const SEG = String.raw`(?:«[^»]*»|[\p{L}_][\p{L}\p{N}_'!?]*)`;
const NAME = String.raw`${SEG}(?:\.${SEG})*`;
const QUALIFIED = new RegExp(String.raw`^${SEG}(?:\.${SEG})+$`, "u");
const splitPairs = (s) =>
  (s.match(/«[^»]*»|[^.]+/gu) ?? []).map((raw) => ({ n: raw.replace(/^«|»$/gu, ""), raw }));
const DECL_KW = "theorem|lemma|def|abbrev|instance|structure|class|inductive|axiom|opaque";
const DECL_NAME_RE = new RegExp(
  String.raw`^(?:@\[[^\]]*\]\s*)?(?:protected\s+|private\s+|noncomputable\s+|nonrec\s+|unsafe\s+|partial\s+|scoped\s+)*(?:class\s+abbrev|class\s+inductive|${DECL_KW})\s+(${NAME})`,
  "u",
);
const ALIAS_NAME_RE = new RegExp(
  String.raw`^(?:@\[[^\]]*\]\s*)?(?:protected\s+|private\s+|scoped\s+)*alias\s+(${NAME})\s*:=`,
  "u",
);

const NAMESPACE_RE = new RegExp(String.raw`^namespace\s+(${NAME})`, "u");
const SECTION_RE = new RegExp(
  String.raw`^(?:@\[[^\]]*\]\s*)?(?:(?:public|meta|noncomputable|private)\s+)*section(?:\s+(${NAME}))?\s*(?:--.*)?$`,
  "u",
);
const MUTUAL_RE = /^mutual\s*(?:--.*)?$/;
const END_RE = new RegExp(String.raw`^end(?:\s+(${NAME}))?\s*(?:--.*)?$`, "u");

// Nesting depth of `/- -/` comments after this line.
function commentDepthAfter(line, depth) {
  for (let j = 0; j < line.length - 1; j++) {
    if (depth === 0 && line[j] === "-" && line[j + 1] === "-") break;
    if (line[j] === "/" && line[j + 1] === "-") { depth++; j++; }
    else if (line[j] === "-" && line[j + 1] === "/" && depth > 0) { depth--; j++; }
  }
  return depth;
}

// Segments of the fully qualified name for a declaration at declLine, from the namespaces open there.
function qualifiedSegsAt(fileLines, declLine, nameAsWritten) {
  if (nameAsWritten.startsWith("_root_.")) return splitPairs(nameAsWritten.slice(7));
  const stack = [];
  let depth = 0;
  for (let i = 0; i < declLine - 1; i++) {
    const l = fileLines[i];
    const commented = depth > 0;
    depth = commentDepthAfter(l, depth);
    if (commented) continue;
    let m;
    if ((m = l.match(NAMESPACE_RE))) for (const part of splitPairs(m[1])) stack.push({ ns: true, name: part.n, raw: part.raw });
    else if ((m = l.match(SECTION_RE))) {
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

const qualifiedNameAt = (f, l, n) => qualifiedSegsAt(f, l, n).map((q) => q.n).join(".");
const pasteableNameAt = (f, l, n) => qualifiedSegsAt(f, l, n).map((q) => q.raw).join(".");

function nameOfHit(fileLines, headLine, text) {
  const lines = text.split("\n");
  for (let k = 0; k < lines.length; k++) {
    const m = lines[k].match(DECL_NAME_RE) ?? lines[k].match(ALIAS_NAME_RE);
    if (!m) continue;
    return {
      name: pasteableNameAt(fileLines, headLine + k, m[1]),
      isPrivate: /(?:^|\s)private\s/.test(" " + lines[k].replace(/^@\[[^\]]*\]\s*/, " ")),
    };
  }
  return null;
}

// Declarations whose fully qualified name equals the pattern exactly.
async function qualifiedLookup(pattern, maxResults, signal) {
  const base = pattern.split(".").pop().replace(/[.[\]{}()*+?^$|\\]/g, "\\$&");
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
    const named = nameOfHit(fileLines, headLine, text);
    hits.push({ path: displayPath(file), line: headLine, text, name: named?.name ?? null, isPrivate: named?.isPrivate ?? false });
    if (hits.length >= maxResults) break;
  }
  return hits;
}

const META = /[.*+?|()[\]{}^$\\]/;
const META_RUN = /[.*+?|()[\]{}^$\\]+/g;
const isValidRegex = (p) => { try { new RegExp(p); return true; } catch { return false; } };
const flatten = (t) => t.replace(/\s+/g, " ").trim();

// Literal fragments of a pattern, longest first.
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

// Tries qualified name, then literal, case-insensitive and regex rungs, then a cross-line anchor search.
// Returns { hits: [{path, line, text, name, isPrivate}], truncated, mode }.
export async function grepMathlib(pattern, { maxResults = 10 } = {}, signal) {
  if (!pattern || !pattern.trim()) throw new Error("empty pattern");
  if (!existsSync(MATHLIB_SRC)) throw new Error(`Mathlib checkout not found at ${MATHLIB_SRC}`);
  const asRegex = META.test(pattern) && isValidRegex(pattern);

  if (QUALIFIED.test(pattern)) {
    const exact = await qualifiedLookup(pattern, maxResults, signal);
    if (exact.length) return { hits: exact, truncated: false, mode: "qualified-name" };
  }

  const rungs = [
    { mode: "literal", regex: false, ci: false },
    { mode: "literal-ci", regex: false, ci: true },
    ...(asRegex ? [{ mode: "regex", regex: true, ci: false }, { mode: "regex-ci", regex: true, ci: true }] : []),
  ];
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
      inName: matcherFor(pattern, rung.ci, rung.regex),
      pattern,
      ci: rung.ci,
      maxResults,
      truncatedRaw: r.truncatedRaw,
    });
    if (got.hits.length) return { ...got, mode: rung.mode };
  }

  const anchors = anchorsOf(pattern);
  if (anchors.length >= 2) {
    const match = matcherFor(pattern, true, asRegex);
    for (const anchor of anchors.slice(0, 2)) {
      let r;
      try {
        r = await runGrep(anchor, { regex: false, ci: true, cap: ANCHOR_LINE_CAP }, signal);
      } catch { continue; }
      if (r.lines.length === 0) continue;
      const got = collectHits(r.lines, {
        inText: (text) => match(flatten(text)),
        inName: () => false,
        pattern,
        ci: true,
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
