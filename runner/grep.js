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
const GREP_TIMEOUT_MS = 15_000;
const DECL_MAX_LINES = 10;
const DECL_MAX_CHARS = 600;

function runGrep(pattern, { regex, ci }, signal) {
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
      if (out.split("\n").length > RAW_LINE_CAP) child.kill("SIGKILL");
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

// Main entry. Returns { hits: [{path, line, text}], truncated, ci } — ci flags that
// the case-sensitive pass found nothing and results come from a case-insensitive
// retry (saves the agent a round trip on a wrong-case guess).
export async function grepMathlib(pattern, { regex = false, maxResults = 10 } = {}, signal) {
  if (!pattern || !pattern.trim()) throw new Error("empty pattern");
  if (!existsSync(MATHLIB_SRC)) throw new Error(`Mathlib checkout not found at ${MATHLIB_SRC}`);
  let ci = false;
  let r = await runGrep(pattern, { regex, ci }, signal);
  if (r.lines.length === 0) {
    ci = true;
    r = await runGrep(pattern, { regex, ci }, signal);
    if (r.lines.length === 0) return { hits: [], truncated: false, ci: false };
  }
  // Does the expanded declaration text itself contain the pattern? If yes the hit is
  // (part of) the declaration/signature — what a name query is after. If not, the raw
  // match sits in the proof body below (a usage site): rank it after definition hits
  // and append the matched line, otherwise the output shows a containing lemma with
  // no visible connection to the query (smoke 0729: a query for an exact lemma name
  // returned only baffling-looking lemmas that merely *used* it).
  const inText = regex
    ? (() => { try { const re = new RegExp(pattern, ci ? "i" : ""); return (t) => re.test(t); } catch { return () => true; } })()
    : ci
      ? (t) => t.toLowerCase().includes(pattern.toLowerCase())
      : (t) => t.includes(pattern);

  const fileCache = new Map();
  const seen = new Set();
  const declHits = [];
  const usageHits = [];
  let truncated = r.truncatedRaw;
  for (const raw of r.lines) {
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
    // Decl bucket needs both: the pattern visible in the expanded block AND the block
    // actually being a declaration (expandDecl falls back to the bare matched line
    // when no head is found — those are proof-body usages, not declarations).
    if (inText(text) && HEAD_RE.test(text.split("\n")[0])) {
      declHits.push({ path, line: headLine, text });
    } else if (inText(text)) {
      usageHits.push({ path, line: headLine, text });
    } else {
      const matched = (fileLines[Number(lineStr) - 1] ?? "").trim().slice(0, 200);
      usageHits.push({ path, line: headLine, text: `${text}\n  ↳ matches inside its proof, line ${lineStr}: ${matched}` });
    }
  }
  const hits = [...declHits, ...usageHits].slice(0, maxResults);
  if (declHits.length + usageHits.length > maxResults) truncated = true;
  return { hits, truncated, ci };
}
