import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { classifyLines } from "../runner/common.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const OPEN = "([{⟨⦃", CLOSE = ")]}⟩⦄";

// Walk the binder body from `start`; report if a top-level ↔ appears before the
// binder's enclosing bracket closes. That is exactly the fatex_81 shape.
function swallows(text, start) {
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (OPEN.includes(c)) depth++;
    else if (CLOSE.includes(c)) { if (depth === 0) return null; depth--; }
    else if (depth === 0 && text.startsWith("↔", i)) return i;
  }
  return null;
}

const CORPORA = [["FATE-X","benchmarks/FATE/FATE-X/FATEX","Problem"],["FATE-H","benchmarks/FATE/FATE-H/FATEH",null]];
for (const [name, dir] of CORPORA) {
  const flagged = [];
  for (const f of readdirSync(join(ROOT, dir)).filter(x => x.endsWith(".lean")).sort((a,b)=>parseInt(a)-parseInt(b))) {
    const src = readFileSync(join(join(ROOT, dir), f), "utf8");
    const code = classifyLines(src).filter(l => l.kind === "code").map(l => l.line).join("\n");
    // statement text: from the theorem head to `:= by`
    const m = /\btheorem\b([\s\S]*?):=\s*by/.exec(code);
    if (!m) continue;
    const stmt = m[1];
    for (const bm of [...stmt.matchAll(/[∃∀]/g)]) {
      const comma = stmt.indexOf(",", bm.index);
      if (comma < 0) continue;
      const hit = swallows(stmt, comma + 1);
      if (hit !== null) {
        // does the bound variable appear on the right of the ↔ ?
        const binder = stmt.slice(bm.index + 1, comma).replace(/[(){}\[\]:]/g, " ").trim().split(/\s+/)[0] ?? "";
        const rhs = stmt.slice(hit + 1);
        const usesVar = binder && new RegExp(`(^|\\W)${binder.replace(/[.*+?^${}()|[\]\\]/g,"\\$&")}(\\W|$)`).test(rhs);
        flagged.push({ f, kind: bm[0], binder, usesVar, ctx: stmt.slice(bm.index, Math.min(hit + 40, stmt.length)).replace(/\s+/g," ").slice(0,170) });
      }
    }
  }
  console.log(`\n### ${name}: binders whose body swallows a top-level '↔': ${flagged.length}`);
  for (const x of flagged) console.log(`  ${x.f}  ${x.kind}${x.binder}  rhs-uses-binder=${x.usesVar}\n     ${x.ctx}`);
}
