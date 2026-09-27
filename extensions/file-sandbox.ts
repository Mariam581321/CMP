// Always-on guard: confine the agent's file tools to its working directory.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { join } from "node:path";
import { cmpConfig } from "../runner/common.js";
import { sandboxDecision } from "../runner/sandbox.js";

export default function (pi: ExtensionAPI) {
  const root = process.cwd();
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
