#!/usr/bin/env node
// Sanitize benchmark problem files: strip `--` comments (in PutnamBench they
// contain the answers) AND /-- docstrings -/ (the informal NL statement — the
// agent should only see the formal Lean by default; pass --keep-nl to retain
// docstrings). Writes <out-dir>/<name>.lean for every problem + <out-dir>/all.txt
// (--out-dir, default problems/).
// --src-dir <dir> reads another corpus of the same shape (default PutnamBench;
// e.g. benchmarks/FATE/FATE-M/FATEM), --prefix <s> prepends to output names
// (FATE files are bare numbers — prefix keeps names globally unique, which the
// shared stmt-types.json cache relies on).
// With --pick N [--seed S] [--out F], also writes a fixed random subset.

import { readdirSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { parseArgs } from "node:util";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { classifyLines } from "./common.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export function sanitize(source, keepNl = false) {
  const drop = keepNl ? ["comment"] : ["comment", "docstring"];
  const kept = classifyLines(source)
    .filter(({ kind }) => !drop.includes(kind))
    .map(({ line }) => line);
  // collapse runs of blank lines left behind by dropped lines
  return kept.join("\n").replace(/\n{3,}/g, "\n\n").replace(/^\n+/, "");
}

// deterministic PRNG so subsets are reproducible
function mulberry32(seed) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function main() {
  let A;
  try {
    A = parseArgs({
      options: {
        pick: { type: "string", default: "0" },
        seed: { type: "string", default: "42" },
        "keep-nl": { type: "boolean", default: false },
        "src-dir": { type: "string", default: join(ROOT, "benchmarks/PutnamBench/lean4/src") },
        prefix: { type: "string", default: "" },
        "out-dir": { type: "string", default: join(ROOT, "problems") },
        out: { type: "string" },
      },
      strict: true, // a mistyped flag must error, not silently sanitize the wrong corpus
    }).values;
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
  const pick = parseInt(A.pick);
  const seed = parseInt(A.seed);
  const keepNl = A["keep-nl"];
  const SRC = resolve(A["src-dir"]);
  const PREFIX = A.prefix;
  const OUT = resolve(A["out-dir"]);
  const outFile = resolve(A.out ?? join(OUT, "dev.txt"));

  mkdirSync(OUT, { recursive: true });
  const names = readdirSync(SRC).filter((f) => f.endsWith(".lean")).sort();
  const banned = keepNl ? ["comment"] : ["comment", "docstring"];
  let leaks = 0;
  for (const f of names) {
    const clean = sanitize(readFileSync(join(SRC, f), "utf8"), keepNl);
    // paranoia: a sanitized file must never contain a stripped-kind line
    leaks += classifyLines(clean).filter(({ kind }) => banned.includes(kind)).length;
    writeFileSync(join(OUT, PREFIX + f), clean);
  }
  const all = names.map((f) => PREFIX + f.replace(".lean", ""));
  writeFileSync(join(OUT, "all.txt"), all.join("\n") + "\n");
  console.log(`sanitized ${all.length} problems${keepNl ? " (NL docstrings kept)" : ""} -> ${OUT} (leak check: ${leaks === 0 ? "clean" : `${leaks} LEAKED LINES!`})`);
  if (leaks > 0) process.exit(1);

  if (pick > 0) {
    const rng = mulberry32(seed);
    const shuffled = [...all];
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    const dev = shuffled.slice(0, pick).sort();
    writeFileSync(outFile, dev.join("\n") + "\n");
    console.log(`subset of ${pick} (seed ${seed}) -> ${outFile}`);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
