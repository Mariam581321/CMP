// Shared config, lean-server client, CLI/TTY helpers and Lean line classifier.
import { request } from "node:http";
import { readFileSync } from "node:fs";
import { join } from "node:path";

export const LEAN_PORT = process.env.CMP_LEAN_PORT ?? "8787";
export const LEAN_URL = `http://127.0.0.1:${LEAN_PORT}`;

export const MAX_HEARTBEATS = 400_000;

export const ALLOWED_AXIOMS = new Set(["propext", "Classical.choice", "Quot.sound"]);

// Fixed $/1M-token table used for cost_std.
export const STD_PRICES = { in: 0.14, cacheRead: 0.0028, out: 0.28 };
export const costStd = (t) =>
  ((t?.in ?? 0) * STD_PRICES.in + (t?.cache_read ?? 0) * STD_PRICES.cacheRead + (t?.out ?? 0) * STD_PRICES.out) / 1e6;

// cost_std spent so far by this attempt's spawned workers.
export function workerSpendStd(cfg, cwd) {
  const dir = cfg?.workers_dir ?? join(cwd ?? process.cwd(), "..", "workers");
  try { return costStd(JSON.parse(readFileSync(join(dir, "ledger.json"), "utf8")).tokens); } catch { return 0; }
}

export function postCheck(body, timeoutMs) {
  return new Promise((resolve, reject) => {
    const req = request(
      { host: "127.0.0.1", port: LEAN_PORT, path: "/check", method: "POST", headers: { "content-type": "application/json" }, timeout: timeoutMs },
      (res) => {
        let data = "";
        res.setEncoding("utf8");
        res.on("data", (d) => (data += d));
        res.on("end", () => {
          try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
        });
      },
    );
    req.on("timeout", () => req.destroy(new Error(`lean server did not respond within ${Math.round(timeoutMs / 1000)}s`)));
    req.on("error", reject);
    req.end(JSON.stringify(body));
  });
}

// Retry fn() on connection-level failures until deadlineMs.
export async function withConnRetry(fn, deadlineMs = 5 * 60_000) {
  const deadline = Date.now() + deadlineMs;
  for (;;) {
    try {
      return await fn();
    } catch (e) {
      const connErr = /ECONNREFUSED|ECONNRESET|EPIPE|socket hang up/i.test(`${e?.code ?? ""} ${e?.message ?? ""}`);
      if (!connErr || Date.now() + 10_000 > deadline) throw e;
      await new Promise((r) => setTimeout(r, 10_000));
    }
  }
}

// A tool error that is already classified; outer catches rethrow it unchanged.
export class ToolFailure extends Error {}

export function arg(name, dflt) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : dflt;
}

// Per-attempt config passed by run.js in the CMP_CONFIG env var.
export function cmpConfig() {
  try { return JSON.parse(process.env.CMP_CONFIG ?? "{}"); } catch { return {}; }
}

const tty = process.stdout.isTTY || !!process.env.FORCE_COLOR;
const c = (code, s) => (tty ? `\x1b[${code}m${s}\x1b[0m` : s);
export const green = (s) => c(32, s);
export const red = (s) => c(31, s);
export const yellow = (s) => c(33, s);
export const dim = (s) => c(2, s);
export const bold = (s) => c(1, s);
export const cyan = (s) => c(36, s);
export const money = (x) => `$${x.toFixed(3)}`;
export const secs = (ms) => `${Math.round(ms / 1000)}s`;

// Classify each Lean source line as code, comment or docstring.
export function classifyLines(source) {
  const out = [];
  let inDocstring = false;
  let blockDepth = 0;
  const opens = (s) => (s.match(/\/-/g) ?? []).length;
  const closes = (s) => (s.match(/-\//g) ?? []).length;
  for (const line of source.split("\n")) {
    const stripped = line.trim();
    let kind;
    if (blockDepth > 0) {
      kind = "comment";
      blockDepth += opens(stripped) - closes(stripped);
      if (blockDepth < 0) blockDepth = 0;
    } else if (inDocstring) {
      kind = "docstring";
      if (stripped.endsWith("-/")) inDocstring = false;
    } else if (stripped.startsWith("/--")) {
      kind = "docstring";
      if (!stripped.endsWith("-/") || stripped === "/--") inDocstring = true;
    } else if (stripped.startsWith("/-")) {
      kind = "comment";
      blockDepth += opens(stripped) - closes(stripped);
      if (blockDepth < 0) blockDepth = 0;
    } else if (stripped.startsWith("--")) {
      kind = "comment";
    } else if (stripped === "") {
      kind = "blank";
    } else {
      kind = "code";
    }
    out.push({ line, kind });
  }
  return out;
}
