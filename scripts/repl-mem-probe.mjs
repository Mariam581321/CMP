// Measure how a REPL's RSS moves across repeated checks of the SAME file.
// Speaks the same protocol runner/lean-server.js does: import Mathlib once, then
// submit the prepared file with env:0 N times, sampling the process group's RSS
// after each response. Stock repl grows per check; a retention-capped one is flat.
//
//   node repl-mem-probe.mjs --bin <repl> --file <x.lean> --n 8 [--limits]
//
// --limits sets REPL_CMD_SNAPSHOT_LIMIT=1 / REPL_PROOF_SNAPSHOT_LIMIT=0 (what
// lean-server.js will pass); omit it to measure the same binary unbounded.

import { spawn } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";

const arg = (k, d) => {
  const i = process.argv.indexOf(k);
  return i < 0 ? d : process.argv[i + 1];
};
const BIN = arg("--bin");
const FILE = arg("--file");
const N = parseInt(arg("--n", "8"));
const LIMITS = process.argv.includes("--limits");
const LEAN_ENV = "/home/mariam/CMP/lean-env";
const MAX_HEARTBEATS = 400000;

// prepare(), copied from lean-server.js: import lines become the heartbeat cap so
// the file elaborates exactly as it would under the harness.
function prepare(code) {
  const lines = code.split("\n");
  let placed = false;
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*import\s/.test(lines[i])) {
      lines[i] = placed ? "" : `set_option maxHeartbeats ${MAX_HEARTBEATS}`;
      placed = true;
    }
  }
  if (!placed) lines.unshift(`set_option maxHeartbeats ${MAX_HEARTBEATS}`);
  return lines.join("\n");
}

function extractJson(buf) {
  const start = buf.indexOf("{");
  if (start < 0) return null;
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < buf.length; i++) {
    const ch = buf[i];
    if (esc) { esc = false; continue; }
    if (ch === "\\") { esc = inStr; continue; }
    if (ch === '"') inStr = !inStr;
    if (inStr) continue;
    if (ch === "{") depth++;
    if (ch === "}" && --depth === 0) return [JSON.parse(buf.slice(start, i + 1)), buf.slice(i + 1)];
  }
  return null;
}

// RSS of the whole process group (lake wrapper + repl), exactly what the fuse reads.
function groupRssMB(pgid) {
  let pages = 0;
  for (const d of readdirSync("/proc")) {
    if (!/^\d+$/.test(d)) continue;
    try {
      const stat = readFileSync(`/proc/${d}/stat`, "utf8");
      const f = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      if (parseInt(f[2]) !== pgid) continue;
      pages += parseInt(readFileSync(`/proc/${d}/statm`, "utf8").split(" ")[1]);
    } catch {}
  }
  return Math.round((pages * 4096) / 1e6);
}

const env = { ...process.env };
if (LIMITS) {
  env.REPL_CMD_SNAPSHOT_LIMIT = "1";   // keep the Mathlib import env only
  env.REPL_PROOF_SNAPSHOT_LIMIT = "0"; // keep none
}
const proc = spawn("lake", ["env", BIN], { cwd: LEAN_ENV, env, stdio: ["pipe", "pipe", "pipe"], detached: true });
proc.stdout.setEncoding("utf8");
let buf = "", pending = null;
proc.stdout.on("data", (d) => {
  buf += d;
  let hit;
  while ((hit = extractJson(buf)) !== null) { buf = hit[1]; pending?.(hit[0]); }
});
proc.stderr.on("data", (d) => process.stderr.write(`[repl] ${d}`));

const send = (obj) => new Promise((res) => { pending = res; proc.stdin.write(JSON.stringify(obj) + "\n\n"); });

const code = prepare(readFileSync(FILE, "utf8"));
console.log(`bin=${BIN}\nfile=${FILE} (${code.split("\n").length} lines)  limits=${LIMITS}`);

const t0 = Date.now();
const imp = await send({ cmd: "import Mathlib" });
const base = groupRssMB(proc.pid);
console.log(`import: env=${imp.env}  ${Math.round((Date.now() - t0) / 1000)}s  RSS ${base} MB\n`);
console.log("check   wall_s   RSS_MB   delta_vs_base   errors");

for (let i = 1; i <= N; i++) {
  const t = Date.now();
  const r = await send({ cmd: code, env: 0 });
  const rss = groupRssMB(proc.pid);
  const errs = (r.messages ?? []).filter((m) => m.severity === "error").length;
  console.log(
    `${String(i).padStart(5)} ${String(Math.round((Date.now() - t) / 1000)).padStart(8)} ` +
    `${String(rss).padStart(8)} ${String(rss - base).padStart(15)} ${String(errs).padStart(8)}` +
    (r.env != null ? `   (returned env=${r.env})` : ""),
  );
}
try { process.kill(-proc.pid, "SIGKILL"); } catch {}
process.exit(0);
