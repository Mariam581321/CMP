import { readFileSync, existsSync } from "node:fs";
import { classifyLines } from "../runner/common.js";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
const ROOT = fileURLToPath(new URL("..", import.meta.url));

const solved = JSON.parse(readFileSync("/tmp/solved.json", "utf8"));
const map = JSON.parse(execSync(`python3 -c "
import json,glob,os
out={}
for f in glob.glob('results/*/*/attempt.json')+glob.glob('results/_archive/*/*/attempt.json'):
    d=json.load(open(f))
    if not d.get('solved'): continue
    w=os.path.join(os.path.dirname(f),'work','problem.lean')
    if os.path.exists(w): out.setdefault(d['problem'],[]).append(w)
print(json.dumps(out))
"`, { cwd: ROOT, encoding: "utf8" }));

const DECL = /^\s*(?:@\[[^\]]*\]\s*)?(?:noncomputable\s+|private\s+|protected\s+|local\s+)*(abbrev|def|theorem|lemma|class|structure|instance|inductive|axiom|opaque)\b/;
// split code-only source into declaration blocks
function decls(src) {
  const lines = classifyLines(src).filter(l => l.kind === "code").map(l => l.line);
  const out = []; let cur = null;
  for (const l of lines) {
    const m = DECL.exec(l);
    if (m) { if (cur) out.push(cur); cur = { kind: m[1], lines: [l] } }
    else if (cur) cur.lines.push(l);
  }
  if (cur) out.push(cur);
  return out.map(d => ({ kind: d.kind, text: d.lines.join("\n").replace(/\s+/g, " ").trim() }));
}

const findings = [];
for (const p of solved) {
  const dir = p.startsWith("fatex") ? "problems-fatex" : "problems-fateh";
  const orig = readFileSync(`${ROOT}${dir}/${p}.lean`, "utf8");
  const setup = decls(orig).filter(d => d.kind !== "theorem" && d.kind !== "lemma");
  if (!setup.length) continue;
  for (const w of map[p] ?? []) {
    if (!existsSync(w)) continue;
    const sol = readFileSync(w, "utf8").replace(/\s+/g, " ");
    const missing = setup.filter(d => !sol.includes(d.text));
    if (missing.length) findings.push({ p, w, missing });
  }
}
console.log(`solved problems with setup declarations: checked\n`);
for (const f of findings) {
  console.log(`### ${f.p}   (${f.w})`);
  for (const m of f.missing) console.log(`   ALTERED [${m.kind}]: ${m.text.slice(0, 160)}`);
}
console.log(`\nsolved solutions that altered a benchmark setup declaration: ${findings.length}`);
