// Always-on guard: confine the agent's file tools to its working directory.
// Motivated by baseline-p100/putnam_1965_b6: the agent hallucinated an absolute
// path one level above its cwd (dropped the /work segment), wrote its proof
// there for the entire hour, and every lean_check silently graded the untouched
// work/problem.lean. Blocking out-of-tree paths turns that silent divergence
// into an immediate, self-explanatory error.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { resolve, sep, basename, join, relative } from "node:path";
import { statSync } from "node:fs";
import { cmpConfig } from "../runner/common.js";

export default function (pi: ExtensionAPI) {
  const root = process.cwd(); // run.js spawns pi with cwd = the attempt's work dir
  // Read-only views of the compiled environment's sources, exposed as work-dir
  // symlinks to the single canonical originals: library.lean (block D) and the
  // Mathlib/ tree (grep arm). Reads follow the links freely; write/edit through them
  // is blocked — the targets are shared by every attempt and by the REPL itself, and
  // a modified view would only mislead its own author (the env is what compiles, not
  // these files). path.resolve is lexical, so the checks below see the symlink-side
  // paths the agent writes, inside the ordinary sandbox root.
  const cfg = cmpConfig();
  const libraryFile: string | null = cfg.library_file ?? null;
  const mathlibDir: string | null = cfg.mathlib_read ? join(root, "Mathlib") : null;
  pi.on("tool_call", (event) => {
    if (event.toolName !== "read" && event.toolName !== "write" && event.toolName !== "edit") return;
    const path = (event.input as { path?: unknown }).path;
    if (typeof path !== "string") return;
    const abs = resolve(root, path);
    if (abs !== root && !abs.startsWith(root + sep)) {
      return {
        block: true,
        reason:
          `blocked: ${path} is outside your working directory. ` +
          `All your files live in ${root} — use a path relative to it (e.g. "problem.lean").`,
      };
    }
    // A directory read came back as `EISDIR: illegal operation on a directory, read` —
    // a raw Node errno, 91 times across the two block-A cells (39 grep, 52 semantic),
    // each costing a turn to decode. Both arms do it, but the semantic one does it more
    // per read (2.4% vs 0.9%) for the same reason its reads fail four times as often
    // overall: it is handed no file paths and no tree, so it guesses at a filesystem
    // that is not there. The capability is deliberately unchanged (no listing:
    // `read`/`write`/`edit`
    // and nothing else is the floor every arm shares, and a directory listing is an `ls`),
    // but the errno is replaced by a sentence that says what happened and where the
    // agent's own files are.
    let dir = false;
    try { dir = statSync(abs).isDirectory(); } catch {}
    if (dir)
      return {
        block: true,
        reason:
          `blocked: ${path} is a directory, not a file — there is no directory listing in this ` +
          `environment. The file you are asked to prove is problem.lean${
            mathlibDir && (abs === mathlibDir || abs.startsWith(mathlibDir + sep))
              ? `; under Mathlib/ you can only read a full file path, e.g. the one a search result names ` +
                `(${relative(root, abs)}/<file>.lean)`
              : ""
          }.`,
      };
    if (event.toolName === "read") return;
    if (libraryFile && abs === resolve(root, libraryFile)) {
      return {
        block: true,
        reason:
          `blocked: ${basename(libraryFile)} documents the verified library already compiled into this ` +
          `environment; it is read-only. Its declarations are usable by name as-is.`,
      };
    }
    if (mathlibDir && (abs === mathlibDir || abs.startsWith(mathlibDir + sep))) {
      return {
        block: true,
        reason:
          "blocked: Mathlib/ is the read-only source of the compiled environment — read it freely; " +
          "your own files live at the top level of your working directory.",
      };
    }
  });
}
