// Compile a stranded attempt's current problem.lean through the SAME path the agent's
// lean_check uses, so the server memo is warm for those exact bytes.
//
//   node scripts/prewarm-memo.mjs <run-id> <problem> [<problem> ...]
//
// Why this exists: a cell launched under a running one recycles the REPL pool and can
// strand the running cell's in-flight checks (2026-08-10, grep-fatex90-0807-r2's
// fatex_91/95). The parked HTTP request cannot be answered from outside the server, so
// the client has to ride out its socket timeout and the agent sees one transient
// ToolFailure. What this removes is the SECOND cost: without a warm memo the agent's
// retry recompiles a 1400-line file from scratch. Memo hits skip the queue, so the
// retry returns immediately instead.
import { checkedCompile } from "../runner/stmt.js";
import { readFileSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const [runId, ...problems] = process.argv.slice(2);
if (!runId || !problems.length) {
  console.error("usage: node scripts/prewarm-memo.mjs <run-id> <problem> [<problem> ...]");
  process.exit(1);
}

for (const name of problems) {
  const work = join(ROOT, "results", runId, name, "work");
  const t0 = Date.now();
  try {
    const code = readFileSync(join(work, "problem.lean"), "utf8");
    const original = readFileSync(join(ROOT, "problems-fatex", `${name}.lean`), "utf8");
    const r = await checkedCompile(code, { original, problemName: name, client: name, workDir: work });
    const secs = ((Date.now() - t0) / 1000).toFixed(0);
    console.log(`${name}: ok=${r.ok} sorries=${(r.sorries ?? []).length} error=${r.error ?? "-"} (${secs}s) — memo warm`);
  } catch (e) {
    console.log(`${name}: FAILED after ${((Date.now() - t0) / 1000).toFixed(0)}s — ${e?.message ?? e}`);
  }
}
