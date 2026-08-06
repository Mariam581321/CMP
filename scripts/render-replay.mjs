#!/usr/bin/env node
// Replay recorded lean_check outputs through the current renderer.
//
// The two block-A cells shipped 13,058 real check results into agent context; they are
// the only corpus that says what this channel actually carries. Parse each recorded
// rendering back into structured messages/sorries, re-render with runner/render.js, and
// report what changed. Reconstruction is lossy in exactly one direction — a recorded
// check that was truncated lost its tail forever — so every number here is a LOWER bound
// on what the new renderer recovers.
//
//   node scripts/render-replay.mjs results/grep-fatex87-0805 [results/...]
import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { renderCheck } from "../runner/render.js";

const HDR = /^(error|warning|information): (?:problem\.lean|snippet):(-?\d+):(\d+): /;
const SORRY = /^sorry at line (-?\d+), goal:$/;
const LINT = /set_option linter\.(\w+) false/;
const KEEP = /set_option linter\.dupNamespace false/;

// Recorded text -> {messages, sorries}. Parts are separated by blank lines, but goals and
// message bodies contain blank lines too, so parts are cut at the next part HEADER, not
// at the next blank line.
function parseRecorded(text) {
  const lines = text.split("\n");
  const messages = [];
  const sorries = [];
  let cur = null;
  for (const line of lines) {
    const h = HDR.exec(line);
    const s = SORRY.exec(line);
    if (h) {
      cur = { kind: "msg", severity: h[1], line: +h[2], column: +h[3], text: line.slice(h[0].length) };
      messages.push(cur);
    } else if (s) {
      cur = { kind: "sorry", line: +s[1], goal: "" };
      sorries.push(cur);
    } else if (cur?.kind === "msg") cur.text += "\n" + line;
    else if (cur?.kind === "sorry") cur.goal += (cur.goal ? "\n" : "") + line.replace(/^ {2}/, "");
  }
  return {
    messages: messages.map(({ kind, ...m }) => ({ ...m, text: m.text.trimEnd() })),
    sorries: sorries.map(({ kind, ...s }) => ({ ...s, goal: s.goal.trim() })),
  };
}

const cells = process.argv.slice(2);
if (!cells.length) {
  console.error("usage: node scripts/render-replay.mjs <results/cell> [...]");
  process.exit(2);
}

let checks = 0, truncOld = 0, truncNew = 0, oldBytes = 0, newBytes = 0;
let lostOld = 0, lostNew = 0, headerOnlyDone = 0;
for (const cell of cells) {
  for (const prob of readdirSync(cell)) {
    const sd = join(cell, prob, "session");
    if (!existsSync(sd) || !statSync(sd).isDirectory()) continue;
    for (const fn of readdirSync(sd)) {
      for (const raw of readFileSync(join(sd, fn), "utf8").split("\n")) {
        if (!raw.trim()) continue;
        let d;
        try { d = JSON.parse(raw); } catch { continue; }
        if (d.type !== "message" || d.message?.role !== "toolResult" || d.message?.toolName !== "lean_check") continue;
        const text = (d.message.content ?? []).map((b) => b.text ?? "").join("");
        checks++;
        const wasTrunc = text.trimEnd().endsWith("... (truncated)");
        const hadSorry = /declaration uses 'sorry'/.test(text);
        const showedSorry = /^sorry at line /m.test(text);
        if (wasTrunc) truncOld++;
        if (wasTrunc && hadSorry && !showedSorry) lostOld++;
        const { messages, sorries } = parseRecorded(text);
        // What the run WOULD have carried with the linters off at source.
        const kept = messages.filter((m) => !LINT.test(m.text) || KEEP.test(m.text));
        const r = renderCheck({
          messages: kept, sorries, maxHeartbeats: 400000, outputName: ".check/last.txt",
        });
        oldBytes += text.length;
        newBytes += r.pretty.length;
        const cut = r.pretty.includes("[... errors truncated");
        if (cut) truncNew++;
        if (cut && sorries.length && !/^sorry at line /m.test(r.pretty)) lostNew++;
        // The invariant the header exists for: every sorry's line number in line 1.
        if (sorries.length && sorries.every((s) => r.pretty.split("\n")[0].includes(String(s.line)))) headerOnlyDone++;
      }
    }
  }
}
const pct = (n) => `${((100 * n) / checks).toFixed(1)}%`;
console.log(`checks replayed            ${checks}`);
console.log(`truncated, old renderer    ${truncOld} (${pct(truncOld)})`);
console.log(`truncated, new renderer    ${truncNew} (${pct(truncNew)})   [lower bound: recorded tails are gone]`);
console.log(`sorry goals lost, old      ${lostOld}`);
console.log(`sorry goals lost, new      ${lostNew}`);
console.log(`sorry lines in the header  ${headerOnlyDone} of the checks that had sorries`);
console.log(`agent-visible bytes        ${(oldBytes / 1e6).toFixed(1)} MB -> ${(newBytes / 1e6).toFixed(1)} MB`);
