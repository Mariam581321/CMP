// Always-on tool: compile the agent's problem.lean against mathlib and report errors.
// The Lean project lives in lean-env/ (env CMP_LEAN_ENV overrides); the agent's file is
// copied there so the agent never needs (or gets) access to the project itself.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { execFile } from "node:child_process";
import { copyFileSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const LEAN_ENV =
  process.env.CMP_LEAN_ENV ??
  resolve(dirname(fileURLToPath(import.meta.url)), "../lean-env");
const TIMEOUT_MS = 300_000;

function runLean(file: string, cwd: string, signal?: AbortSignal): Promise<{ out: string; code: number }> {
  return new Promise((res) => {
    const child = execFile(
      "lake",
      ["env", "lean", file],
      { cwd, timeout: TIMEOUT_MS, signal, maxBuffer: 10 * 1024 * 1024 },
      (err, stdout, stderr) => {
        const code = err ? ((err as any).code ?? 1) : 0;
        res({ out: `${stdout ?? ""}${stderr ?? ""}`.trim(), code: typeof code === "number" ? code : 1 });
      },
    );
    void child;
  });
}

export default function (pi: ExtensionAPI) {
  let counter = 0;
  pi.registerTool({
    name: "lean_check",
    label: "Lean check",
    description:
      "Compile problem.lean with Lean 4 + Mathlib and return the compiler output. " +
      "This is the ground truth for whether your proof is accepted. " +
      "Takes ~1 minute; make each check count.",
    promptSnippet: "lean_check - compile problem.lean and get Lean compiler errors/warnings",
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, signal, _onUpdate, ctx) {
      const src = join(ctx.cwd, "problem.lean");
      if (!existsSync(src)) {
        return { content: [{ type: "text", text: "error: problem.lean not found in working directory" }], isError: true };
      }
      const dir = join(LEAN_ENV, "_check");
      mkdirSync(dir, { recursive: true });
      const tmp = join(dir, `check_${process.pid}_${++counter}.lean`);
      copyFileSync(src, tmp);
      try {
        const { out, code } = await runLean(tmp, LEAN_ENV, signal);
        const text =
          code === 0 && out === ""
            ? "compiled successfully: no errors, no warnings"
            : code === 0
              ? `compiled (exit 0) with output:\n${out}`
              : `compilation FAILED (exit ${code}):\n${out}`;
        return { content: [{ type: "text", text }], details: { exitCode: code } };
      } finally {
        rmSync(tmp, { force: true });
      }
    },
  });
}
