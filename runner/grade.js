// Independent grading of a finished attempt: statement preserved, file compiles, axioms clean.

import { readFileSync, existsSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { classifyLines, withConnRetry, ALLOWED_AXIOMS } from "./common.js";
import { benchmarkDecls, axiomProbe, axiomReports, parseStmtProbe, originalStmtTypes, serverCheck, renderWithoutProbe } from "./stmt.js";

export { serverCheck } from "./stmt.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export { ALLOWED_AXIOMS };

// Advisory keyword tripwire: hits are logged, never failed.
const SUSPICIOUS = [
  "macro", "macro_rules", "elab", "elab_rules", "syntax", "notation",
  "run_elab", "run_cmd", "#eval", "initialize",
  "axiom", "unsafe", "opaque", "implemented_by", "extern", "native_decide",
  "modifyEnv", "addDecl", "open Lean", "import Lean", "set_option debug",
];
export function suspiciousKeywords(source) {
  const code = classifyLines(source).filter((l) => l.kind === "code").map((l) => l.line).join("\n");
  return SUSPICIOUS.filter((k) => {
    const esc = k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/ /g, "\\s+");
    return new RegExp(`(^|[^\\w.#])${esc}($|[^\\w])`, "m").test(code);
  });
}

// opts.end: the attempt's outcome; after an abnormal end, statement-check failures are reported under it.
export async function grade(problemName, solutionPath, originalPath, opts = {}) {
  const end = opts.end ?? "completed";
  if (!existsSync(solutionPath)) return { solved: false, reason: "no_file", detail: "problem.lean missing" };
  const original = readFileSync(originalPath, "utf8");
  const solution = readFileSync(solutionPath, "utf8");

  const decls = benchmarkDecls(original);
  if (decls.length === 0) return { solved: false, reason: "grader_error", detail: "no declarations found in original" };

  const susp = suspiciousKeywords(solution);
  const base = susp.length ? { suspicious_keywords: susp } : {};
  const fail = (reason, detail) => ({ solved: false, reason, detail, ...base });

  let orig;
  try {
    orig = await withConnRetry(() => originalStmtTypes(problemName, original, decls));
  } catch (e) {
    return fail("grader_error", `original stmt types: ${e.message}`);
  }

  const probes = axiomProbe(decls);
  let r;
  try {
    // force: fresh compile, bypassing the memo.
    r = await withConnRetry(() => serverCheck(`${solution}\n${probes}`, "grader", true));
  } catch (e) {
    return fail("grader_error", `lean server unreachable: ${e.message}`);
  }
  if (r.error) return fail("grader_error", `${r.error}${r.bound ? ` [bound: ${r.bound}]` : ""}`);
  const { pretty } = renderWithoutProbe(r.messages, r.sorries);

  // Order: probe output, statement checks, compile status, axioms.
  const got = parseStmtProbe(r.messages);
  if (Object.keys(got).length === 0) {
    return r.ok
      ? fail("grader_error", "stmt probe produced no output on a clean compile")
      : fail("compile_error", `statement unknown (file did not elaborate to the end)\n${pretty.slice(0, 3500)}`);
  }
  const stmtFail = (detail) =>
    end !== "completed"
      ? fail(end, `${detail}\n  (attempt ended '${end}' — file state at kill time; not graded as statement tampering)`)
      : fail("statement_changed", detail);
  for (const d of decls) {
    const s = got[d];
    if (!s || s.missing)
      return stmtFail(`${d}: declaration missing (renamed/deleted, or its statement fails to elaborate)` + (r.ok ? "" : `\n${pretty.slice(0, 2000)}`));
    if (s.type !== orig[d].type)
      return stmtFail(`${d}: elaborated type differs from original\n  expected: ${orig[d].type.slice(0, 300)}\n  got:      ${s.type.slice(0, 300)}`);
    if (s.kind !== orig[d].kind)
      return stmtFail(`${d}: declaration kind changed (${orig[d].kind} -> ${s.kind})`);
    // Setup-definition bodies must match wherever the original's value is sorry-free.
    if (!orig[d].direct_sorry && orig[d].value != null && orig[d].value !== "-" && s.value !== orig[d].value)
      return stmtFail(
        `${d}: ${orig[d].kind === "induct" ? "class/structure fields differ" : "definition body differs"} from original ` +
          `(setup declarations are part of the statement)\n  expected: ${orig[d].value.slice(0, 300)}\n  got:      ${(s.value ?? "").slice(0, 300)}`,
      );
    if (s.safety !== "safe")
      return fail("unsafe_decl", `${d}: declaration is marked ${s.safety}`);
  }
  if (!r.ok) return fail("compile_error", pretty.slice(0, 4000));

  const allText = (r.messages ?? []).map((m) => m.text).join("\n");
  const axioms = axiomReports(r.messages, solution.split("\n").length, decls);
  for (const d of decls) {
    if (axioms[d] == null) return fail("grader_error", `no axiom report for ${d}\n${allText.slice(0, 2000)}`);
    const bad = axioms[d].filter((a) => !ALLOWED_AXIOMS.has(a));
    if (bad.length > 0) {
      const reason = bad.includes("sorryAx") ? "uses_sorry" : "bad_axioms";
      return { solved: false, reason, detail: `${d}: [${bad.join(", ")}]`, axioms, ...base };
    }
  }
  return { solved: true, axioms, ...base };
}

// CLI: node runner/grade.js <problem_name> <solution.lean>   (needs the lean server up)
//      node runner/grade.js --build-stmt-cache [problems-dir]  precompute all originals
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (process.argv[2] === "--build-stmt-cache") {
    const dir = resolve(process.argv[3] ?? join(ROOT, "problems"));
    const { readdirSync } = await import("node:fs");
    const files = readdirSync(dir).filter((f) => f.endsWith(".lean")).sort();
    let done = 0, failed = 0;
    for (const f of files) {
      const name = f.replace(".lean", "");
      const src = readFileSync(join(dir, f), "utf8");
      try {
        await originalStmtTypes(name, src, benchmarkDecls(src));
        done++;
      } catch (e) {
        failed++;
        console.error(`FAIL ${name}: ${e.message.split("\n")[0]}`);
      }
      if ((done + failed) % 25 === 0) console.log(`${done + failed}/${files.length} (${failed} failed)`);
    }
    console.log(`stmt-type cache: ${done} ok, ${failed} failed`);
    process.exit(failed ? 1 : 0);
  }
  const [name, sol] = process.argv.slice(2);
  const orig = join(ROOT, "problems", `${name}.lean`);
  grade(name, resolve(sol), orig).then((r) => {
    console.log(JSON.stringify(r, null, 2));
    process.exit(r.solved ? 0 : 1);
  });
}
