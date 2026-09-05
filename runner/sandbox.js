// File-sandbox core (extensions/file-sandbox.ts is the tool wrapper that installs it as
// a `tool_call` hook). Same split as runner/edit.js ↔ extensions/cmp-edit.ts: the policy
// is a pure function so it can be probed exhaustively without booting pi, because every
// branch here is a sentence the agent reads and acts on.
//
// Without it an agent that hallucinates an absolute path one level above its cwd
// writes its proof there for the whole attempt while every lean_check silently grades
// the untouched work/problem.lean. Blocking out-of-tree paths turns that silent
// divergence into an immediate, self-explanatory error.

import { statSync } from "node:fs";
import { resolve, sep, basename, relative } from "node:path";

const block = (reason) => ({ block: true, reason });
const under = (abs, dir) => dir != null && (abs === dir || abs.startsWith(dir + sep));

/**
 * @param {object} o
 * @param {string} o.root         the attempt's work dir; everything is confined to it
 * @param {string} o.toolName     read | write | edit (anything else is not ours)
 * @param {unknown} o.path        whatever the model passed
 * @param {string|null} o.libraryFile  library cells: library.lean, readable but not writable
 * @param {string|null} o.mathlibDir   grep arm: the Mathlib symlink, same deal
 * @param {(p:string)=>boolean} [o.isDir]  injected for probing; defaults to statSync
 * @returns {null | {block: true, reason: string}}  null = allow
 */
export function sandboxDecision({ root, toolName, path, libraryFile, mathlibDir, isDir }) {
  if (toolName !== "read" && toolName !== "write" && toolName !== "edit") return null;
  if (typeof path !== "string") return null;
  const abs = resolve(root, path);

  // Outside the tree, in any direction. path.resolve is lexical, so a symlinked view
  // (Mathlib/, library.lean) is seen at the path the agent wrote — inside the root —
  // and is handled by the rules below rather than by this one.
  if (abs !== root && !abs.startsWith(root + sep))
    return block(
      `blocked: ${path} is outside your working directory. ` +
        `All your files live in ${root} — use a path relative to it (e.g. "problem.lean").`,
    );

  // A directory read would come back as `EISDIR: illegal operation on a directory,
  // read`, a raw Node errno that costs a turn to decode. The capability is deliberately
  // unchanged (no listing: read/write/edit and nothing else is the floor every arm
  // shares, and a directory listing is an `ls`); only the errno becomes a sentence.
  // Under Mathlib/ that sentence also says what WOULD work, because there the agent has
  // a real tree and a plausible reason to be walking it.
  const dirCheck = isDir ?? ((p) => { try { return statSync(p).isDirectory(); } catch { return false; } });
  if (dirCheck(abs))
    return block(
      `blocked: ${path} is a directory, not a file — there is no directory listing in this ` +
        `environment. The file you are asked to prove is problem.lean` +
        (under(abs, mathlibDir)
          ? `; under Mathlib/ you can only read a full file path, e.g. the one a search result ` +
            `names (${relative(root, abs)}/<file>.lean)`
          : "") +
        `.`,
    );

  if (toolName === "read") return null;

  // Read-only views of the compiled environment's sources, exposed as work-dir symlinks
  // to the single canonical originals. Reads follow the links freely; write/edit through
  // them is blocked — the targets are shared by every attempt and by the REPL itself, and
  // a modified view would only mislead its own author (the env is what compiles, not
  // these files).
  if (libraryFile && abs === resolve(root, libraryFile))
    return block(
      `blocked: ${basename(libraryFile)} documents the verified library already compiled into this ` +
        `environment; it is read-only. Its declarations are usable by name as-is.`,
    );
  if (under(abs, mathlibDir))
    return block(
      "blocked: Mathlib/ is the read-only source of the compiled environment — read it freely; " +
        "your own files live at the top level of your working directory.",
    );
  return null;
}
