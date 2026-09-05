// Always-on guard: confine the agent's file tools to its working directory.
// Thin wrapper — the policy is a pure function in runner/sandbox.js so every branch can
// be probed without booting pi (scripts/probe-sandbox.mjs), the same split as
// runner/edit.js ↔ extensions/cmp-edit.ts. Every branch is a sentence the agent reads
// and acts on, which is why it is worth testing rather than eyeballing.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { join } from "node:path";
import { cmpConfig } from "../runner/common.js";
import { sandboxDecision } from "../runner/sandbox.js";

export default function (pi: ExtensionAPI) {
  const root = process.cwd(); // run.js spawns pi with cwd = the attempt's work dir
  // Read-only views of the compiled environment's sources, exposed as work-dir symlinks
  // to the single canonical originals: library.lean (library cells) and the Mathlib/ tree
  // (grep arm).
  const cfg = cmpConfig();
  const libraryFile: string | null = cfg.library_file ?? null;
  const mathlibDir: string | null = cfg.mathlib_read ? join(root, "Mathlib") : null;
  pi.on("tool_call", (event) =>
    sandboxDecision({
      root,
      toolName: event.toolName,
      path: (event.input as { path?: unknown }).path,
      libraryFile,
      mathlibDir,
    }) ?? undefined,
  );
}
