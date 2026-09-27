// Solved high-water mark: snapshots of verified-green files an attempt held, graded separately from its final file.

import { createHash } from "node:crypto";
import { writeFileSync, renameSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

export const FIRST_FILE = "highwater-first.lean";
export const LAST_FILE = "highwater-last.lean";
export const STAMP_FILE = "highwater.json";

export { verifiedDone } from "./verdict.js";

function writeAtomic(path, content) {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, content);
  renameSync(tmp, path);
}

// Records one green check: the first snapshot is written once, the last is refreshed every time.
export function recordHighWater(dir, code, at) {
  try {
    const stamp = {
      ...at,
      md5: createHash("md5").update(code).digest("hex"),
      bytes: Buffer.byteLength(code),
      wall_at: new Date().toISOString(),
    };
    let prev = {};
    try { prev = JSON.parse(readFileSync(join(dir, STAMP_FILE), "utf8")); } catch {}
    const isFirst = !prev.first && !existsSync(join(dir, FIRST_FILE));
    if (isFirst) writeAtomic(join(dir, FIRST_FILE), code);
    writeAtomic(join(dir, LAST_FILE), code);
    const next = { first: isFirst ? stamp : prev.first, last: stamp, greens: (prev.greens ?? 0) + 1 };
    writeAtomic(join(dir, STAMP_FILE), JSON.stringify(next, null, 1));
    return next;
  } catch {
    return null;
  }
}

export function readHighWater(dir) {
  try { return JSON.parse(readFileSync(join(dir, STAMP_FILE), "utf8")); } catch { return null; }
}

// Grades the first/last snapshots with the injected grader; null if the attempt never held a proof.
export async function gradeHighWater(dir, grade) {
  const hw = readHighWater(dir);
  if (!hw) return null;
  const gradeSnap = async (file, stamp) => {
    if (!stamp || !existsSync(join(dir, file))) return null;
    const r = await grade(join(dir, file));
    return { ...stamp, solved: r.solved, reason: r.solved ? null : r.reason, detail: r.solved ? null : (r.detail ?? "").slice(0, 500) };
  };
  const first = await gradeSnap(FIRST_FILE, hw.first);
  const last = first && hw.last?.md5 === hw.first?.md5 ? first : await gradeSnap(LAST_FILE, hw.last);
  return { greens: hw.greens ?? 0, ever_solved: !!(first?.solved || last?.solved), first, last };
}
