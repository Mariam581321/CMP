#!/usr/bin/env node
// Probes for runner/sandbox.js path confinement, against a real temp work dir with symlinks.
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

check("read problem.lean", allowed("read", "problem.lean"));
check("write problem.lean", allowed("write", "problem.lean"));
check("edit problem.lean", allowed("edit", "problem.lean"));
check("write a scratch file", allowed("write", "notes.md"));
check("read the full check output the header points at", allowed("read", ".check/last.txt"));
check("tools we do not own are untouched", allowed("bash", "/etc/passwd") && allowed("lean_check", undefined));

{
  check("the putnam_1965_b6 path is blocked", !allowed("write", join(root, "..", "problem.lean")));
  check("...and says where the agent's files actually live", why("write", "../problem.lean").includes(root));
  check("an absolute path elsewhere is blocked", !allowed("read", "/etc/passwd"));
  check("a traversal that lands back inside is allowed", allowed("read", "./sub/../problem.lean"));
}

{
  check("reading the work dir itself is a directory error", why("read", ".").includes("is a directory, not a file"), why("read", "."));
  check("...and names the file that matters", why("read", ".").includes("problem.lean"));
  check("reading a subdirectory too", why("read", ".check").includes("is a directory, not a file"));
  check("no stale EISDIR wording anywhere", !why("read", ".").includes("EISDIR"));
}

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

{
  const bare = (toolName, path) => sandboxDecision({ root, toolName, path, libraryFile: null, mathlibDir: null })?.reason ?? "(allowed)";
  check("no Mathlib arm: the directory message stays generic", !bare("read", ".").includes("Mathlib/"), bare("read", "."));
}

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
