// Regenerate problems/env-names.txt: every non-internal constant name of the resident
// compiled environment (the exact pin the REPL serves). Used by extensions/lean-loogle.ts
// to filter public-Loogle hits down to names that exist here — see the skew rationale in
// that file and SEARCH.md. Derived + gitignored, like stmt-types.json; rebuild whenever
// the Mathlib pin moves. Needs the lean server up (runner/lean-server.js).
import { postCheck } from "../runner/common.js";

const OUT = new URL("../problems/env-names.txt", import.meta.url).pathname;
const code = `open Lean in
#eval show CoreM Unit from do
  let env ← getEnv
  let h ← IO.FS.Handle.mk "${OUT}" IO.FS.Mode.write
  let mut n := 0
  for (name, _) in env.constants.toList do
    unless name.isInternal do
      h.putStrLn name.toString
      n := n + 1
  h.flush
  IO.println s!"wrote {n} names"`;

const r = await postCheck({ code, cpuMs: 300_000, client: "env-dump" }, 600_000);
if (r.error || !r.ok) {
  console.error("dump failed:", JSON.stringify(r).slice(0, 500));
  process.exit(1);
}
console.log((r.messages ?? []).map((m) => m.text).join("\n") || "done");
