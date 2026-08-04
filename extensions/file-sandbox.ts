// Always-on guard: confine the agent's file tools to its working directory.
// Motivated by baseline-p100/putnam_1965_b6: the agent hallucinated an absolute
// path one level above its cwd (dropped the /work segment), wrote its proof
// there for the entire hour, and every lean_check silently graded the untouched
// work/problem.lean. Blocking out-of-tree paths turns that silent divergence
// into an immediate, self-explanatory error.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { resolve, sep, basename } from "node:path";
import { cmpConfig } from "../runner/common.js";

export default function (pi: ExtensionAPI) {
  const root = process.cwd(); // run.js spawns pi with cwd = the attempt's work dir
  // Library cell (block D): the library source in the work dir is reference
  // documentation of declarations already baked into the compile env — read freely,
  // never writable (a modified copy would only mislead its own author: the env is
  // what compiles, not this file).
  const libraryFile: string | null = cmpConfig().library_file ?? null;
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
    if (event.toolName !== "read" && libraryFile && abs === resolve(root, libraryFile)) {
      return {
        block: true,
        reason:
          `blocked: ${basename(libraryFile)} documents the verified library already compiled into this ` +
          `environment; it is read-only. Its declarations are usable by name as-is.`,
      };
    }
  });
}
