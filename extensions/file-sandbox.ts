// Always-on guard: confine the agent's file tools to its working directory.
// Motivated by baseline-p100/putnam_1965_b6: the agent hallucinated an absolute
// path one level above its cwd (dropped the /work segment), wrote its proof
// there for the entire hour, and every lean_check silently graded the untouched
// work/problem.lean. Blocking out-of-tree paths turns that silent divergence
// into an immediate, self-explanatory error.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { resolve, sep, basename, join } from "node:path";
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
