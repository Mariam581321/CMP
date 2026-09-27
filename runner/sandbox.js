// File-sandbox policy: confines read/write/edit to the attempt's work dir.

import { statSync } from "node:fs";
import { resolve, sep, basename, relative } from "node:path";

const block = (reason) => ({ block: true, reason });
const under = (abs, dir) => dir != null && (abs === dir || abs.startsWith(dir + sep));

// Returns null to allow, or {block: true, reason}.
export function sandboxDecision({ root, toolName, path, libraryFile, mathlibDir, isDir }) {
  if (toolName !== "read" && toolName !== "write" && toolName !== "edit") return null;
  if (typeof path !== "string") return null;
  const abs = resolve(root, path);

  if (abs !== root && !abs.startsWith(root + sep))
    return block(
      `blocked: ${path} is outside your working directory. ` +
        `All your files live in ${root} — use a path relative to it (e.g. "problem.lean").`,
    );

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

  // Symlinked library/Mathlib views are read-only.
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
