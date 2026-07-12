#!/usr/bin/env node
// Sanitize PutnamBench problem files: strip full-line `--` comments (they contain
// the answers) while keeping /-- docstrings -/ (the informal statement).
// Writes problems/<name>.lean for every problem + problems/all.txt.
// With --pick N [--seed S], also writes a fixed random subset to problems/dev.txt.

import { readdirSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(ROOT, "benchmarks/PutnamBench/lean4/src");
const OUT = join(ROOT, "problems");

export function sanitize(source) {
  const out = [];
  let inDocstring = false;
  for (const line of source.split("\n")) {
    const stripped = line.trim();
    if (inDocstring) {
      out.push(line);
      if (stripped.endsWith("-/")) inDocstring = false;
      continue;
    }
    if (stripped.startsWith("/--")) {
      out.push(line);
      if (!stripped.endsWith("-/") || stripped === "/--") inDocstring = true;
      continue;
    }
    if (stripped.startsWith("--")) continue; // answer / helper comment: drop
    out.push(line);
  }
  // collapse runs of blank lines left behind by dropped comments
  return out.join("\n").replace(/\n{3,}/g, "\n\n");
}

// deterministic PRNG so the dev subset is reproducible
function mulberry32(seed) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function main() {
  const args = process.argv.slice(2);
  const pick = args.includes("--pick") ? parseInt(args[args.indexOf("--pick") + 1]) : 0;
  const seed = args.includes("--seed") ? parseInt(args[args.indexOf("--seed") + 1]) : 42;
  const outFile = args.includes("--out") ? resolve(args[args.indexOf("--out") + 1]) : join(OUT, "dev.txt");

  mkdirSync(OUT, { recursive: true });
  const names = readdirSync(SRC).filter((f) => f.endsWith(".lean")).sort();
  let leaks = 0;
  for (const f of names) {
    const clean = sanitize(readFileSync(join(SRC, f), "utf8"));
    // paranoia: a sanitized file must never contain a comment outside docstrings
    for (const l of clean.split("\n")) {
      if (l.trim().startsWith("--")) leaks++;
    }
    writeFileSync(join(OUT, f), clean);
  }
  const all = names.map((f) => f.replace(".lean", ""));
  writeFileSync(join(OUT, "all.txt"), all.join("\n") + "\n");
  console.log(`sanitized ${all.length} problems -> problems/ (leak check: ${leaks === 0 ? "clean" : `${leaks} LEAKED LINES!`})`);
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
