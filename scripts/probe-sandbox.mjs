#!/usr/bin/env node
// Probes for runner/sandbox.js — the always-on confinement of the agent's file tools.
// Pure path logic, plus one pass against a REAL work dir laid out the way run.js lays
// one out (symlinked Mathlib tree included), because the interesting cases are all
// about symlinks and directories and a mocked filesystem would prove nothing about them.
//
// Why this is worth testing rather than eyeballing: every branch is a sentence the agent
// reads and acts on, and the failure this guard exists for was silent —
// baseline-p100/putnam_1965_b6 wrote its proof one directory above its cwd for an entire
// hour while every lean_check graded the untouched file.
//
//   node scripts/probe-sandbox.mjs
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sandboxDecision } from "../runner/sandbox.js";
import { MATHLIB_SRC } from "../runner/grep.js";

let failed = 0;
const check = (name, cond, detail = "") => {
  console.log(`${cond ? "  ok  " : "  FAIL"}  ${name}${cond || !detail ? "" : `\n        ${detail}`}`);
  if (!cond) failed++;
};

// ---------------------------------------------------------- a real work dir
// Laid out exactly as run.js does it for the grep arm: problem.lean, a .check dir, and
// Mathlib/ as a symlink onto the one canonical checkout.
const root = mkdtempSync(join(tmpdir(), "cmp-sandbox-"));
writeFileSync(join(root, "problem.lean"), "import Mathlib\n");
mkdirSync(join(root, ".check"));
writeFileSync(join(root, ".check", "last.txt"), "output\n");
const hasMathlib = existsSync(MATHLIB_SRC);
if (hasMathlib) symlinkSync(MATHLIB_SRC, join(root, "Mathlib"));
const cfg = { root, libraryFile: null, mathlibDir: hasMathlib ? join(root, "Mathlib") : null };
const d = (toolName, path) => sandboxDecision({ ...cfg, toolName, path });
const allowed = (toolName, path) => d(toolName, path) === null;
const why = (toolName, path) => d(toolName, path)?.reason ?? "(allowed)";

// The ordinary case must stay boring.
check("read problem.lean", allowed("read", "problem.lean"));
check("write problem.lean", allowed("write", "problem.lean"));
check("edit problem.lean", allowed("edit", "problem.lean"));
check("write a scratch file", allowed("write", "notes.md"));
check("read the full check output the header points at", allowed("read", ".check/last.txt"));
check("tools we do not own are untouched", allowed("bash", "/etc/passwd") && allowed("lean_check", undefined));

// The failure this exists for: one level up, absolute or relative.
{
  check("the putnam_1965_b6 path is blocked", !allowed("write", join(root, "..", "problem.lean")));
  check("...and says where the agent's files actually live", why("write", "../problem.lean").includes(root));
  check("an absolute path elsewhere is blocked", !allowed("read", "/etc/passwd"));
  check("a traversal that lands back inside is allowed", allowed("read", "./sub/../problem.lean"));
}

// Directories: blocked, but with a sentence instead of an errno.
{
  check("reading the work dir itself is a directory error", why("read", ".").includes("is a directory, not a file"), why("read", "."));
  check("...and names the file that matters", why("read", ".").includes("problem.lean"));
  check("reading a subdirectory too", why("read", ".check").includes("is a directory, not a file"));
  check("no stale EISDIR wording anywhere", !why("read", ".").includes("EISDIR"));
}

// The grep arm's Mathlib tree: readable by full path, not browsable, never writable.
if (hasMathlib) {
  const realFile = "Mathlib/Order/Defs.lean";
  check("a Mathlib source file is readable through the symlink", allowed("read", realFile), why("read", realFile));
  check("a Mathlib directory is not browsable", !allowed("read", "Mathlib/Order"), why("read", "Mathlib/Order"));
  check("...and the message says what WOULD work", why("read", "Mathlib/Order").includes("Mathlib/Order/<file>.lean"), why("read", "Mathlib/Order"));
  check("the Mathlib root is a directory too", !allowed("read", "Mathlib"));
  check("writing into Mathlib is blocked", !allowed("write", realFile) && why("write", realFile).includes("read-only"), why("write", realFile));
  check("editing Mathlib is blocked", !allowed("edit", realFile));
} else {
  console.log("  skip  Mathlib checkout absent — symlink cases not exercised");
}

// Without the grep arm there is no Mathlib view, and the directory message must not
// advertise one.
{
  const bare = (toolName, path) => sandboxDecision({ root, toolName, path, libraryFile: null, mathlibDir: null })?.reason ?? "(allowed)";
  check("no Mathlib arm: the directory message stays generic", !bare("read", ".").includes("Mathlib/"), bare("read", "."));
}

// Block D's library.lean: readable, never writable — a modified view would only mislead
// its own author, since the compiled env is what counts.
{
  writeFileSync(join(root, "library.lean"), "-- facts\n");
  const lib = { root, libraryFile: join(root, "library.lean"), mathlibDir: null };
  const dl = (t, p) => sandboxDecision({ ...lib, toolName: t, path: p });
  check("library.lean is readable", dl("read", "library.lean") === null);
  check("library.lean is not writable", dl("write", "library.lean")?.reason.includes("read-only"), dl("write", "library.lean")?.reason);
  check("...and its declarations are said to be usable by name", dl("edit", "library.lean")?.reason.includes("usable by name"));
}

rmSync(root, { recursive: true, force: true });
console.log(failed ? `\n${failed} probe(s) FAILED` : "\nall sandbox probes green");
process.exit(failed ? 1 : 0);
