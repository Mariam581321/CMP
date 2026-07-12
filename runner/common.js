// Shared bits: config, lean-server client, CLI/TTY helpers, PutnamBench line classifier.

import { request } from "node:http";

// --- config -----------------------------------------------------------------
export const LEAN_PORT = process.env.CMP_LEAN_PORT ?? "8787";
export const LEAN_URL = `http://127.0.0.1:${LEAN_PORT}`;

// POST JSON to the lean server via node:http. Deliberately NOT fetch(): undici's
// built-in 300s headers-timeout kills any request that queues >5 min at the server,
// which happens routinely when many agents share one serialized REPL.
export function postCheck(body, timeoutMs) {
  return new Promise((resolve, reject) => {
    const req = request(
      { host: "127.0.0.1", port: LEAN_PORT, path: "/check", method: "POST", headers: { "content-type": "application/json" }, timeout: timeoutMs },
      (res) => {
        let data = "";
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

// --- CLI --------------------------------------------------------------------
export function arg(name, dflt) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : dflt;
}

// --- TTY colors -------------------------------------------------------------
const tty = process.stdout.isTTY;
const c = (code, s) => (tty ? `\x1b[${code}m${s}\x1b[0m` : s);
export const green = (s) => c(32, s);
export const red = (s) => c(31, s);
export const yellow = (s) => c(33, s);
export const dim = (s) => c(2, s);
export const bold = (s) => c(1, s);
export const cyan = (s) => c(36, s);
export const money = (x) => `$${x.toFixed(3)}`;
export const secs = (ms) => `${Math.round(ms / 1000)}s`;

// --- Lean source line classification ----------------------------------------
// One definition of "what is a docstring vs a comment vs code" shared by the
// sanitizer (which strips comments = answers) and the grader (which checks the
// statement survived). If these two disagree, the pipeline breaks silently.
// PutnamBench files contain no /- -/ block comments (verified over the corpus).
export function classifyLines(source) {
  const out = [];
  let inDocstring = false;
  for (const line of source.split("\n")) {
    const stripped = line.trim();
    let kind;
    if (inDocstring) {
      kind = "docstring";
      if (stripped.endsWith("-/")) inDocstring = false;
    } else if (stripped.startsWith("/--")) {
      kind = "docstring";
      if (!stripped.endsWith("-/") || stripped === "/--") inDocstring = true;
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
