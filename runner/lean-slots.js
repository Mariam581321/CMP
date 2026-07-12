// Cross-process semaphore for `lake env lean` invocations. One mathlib-loaded lean
// process peaks at ~6 GB RSS, so on small machines only CMP_LEAN_SLOTS (default 1)
// may run at once — across the runner (grading) and every pi subprocess (lean_check).
// Slots are mkdir-based locks under lean-env/_locks; a slot older than STALE_MS is
// treated as leaked (SIGKILL on timeout is routine) and reclaimed.

import { mkdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";

const STALE_MS = 20 * 60_000;
const SLOTS = Math.max(1, parseInt(process.env.CMP_LEAN_SLOTS ?? "1"));

export async function withLeanSlot(leanEnv, fn, signal) {
  const dir = join(leanEnv, "_locks");
  mkdirSync(dir, { recursive: true });
  for (;;) {
    if (signal?.aborted) throw new Error("aborted while waiting for a lean slot");
    for (let i = 0; i < SLOTS; i++) {
      const slot = join(dir, `slot${i}`);
      try {
        mkdirSync(slot); // atomic acquire
      } catch {
        try {
          if (Date.now() - statSync(slot).mtimeMs > STALE_MS) rmSync(slot, { recursive: true, force: true });
        } catch {}
        continue;
      }
      try {
        return await fn();
      } finally {
        rmSync(slot, { recursive: true, force: true });
      }
    }
    await new Promise((r) => setTimeout(r, 1500 + Math.random() * 1500));
  }
}
