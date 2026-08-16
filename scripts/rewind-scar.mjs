#!/usr/bin/env node
// Rewind a dead attempt's session to its last healthy entry so run.js --resume can
// continue it PROMPTLESSLY (runner/pi-continue.mjs) — pi's own retry semantics
// ("remove error message from agent state, keep in session for history",
// agent-session.js _prepareRetry) applied across a process restart. Cuts, in order:
//   1. If a previous resume already injected the generic outage message, cut before
//      it — discarding that scarred segment and the work generated on top of it
//      (contaminated context; the discarded spend is reported).
//   2. Drop the pure tail of {error-stopped assistant messages, user messages that
//      only ever fed the dead API, summary-less compaction stubs}.
//   3. Leaf rule for promptless continuation: the API request must not end on an
//      assistant message (that is a prefill, not a continuation) or an error stub.
//      A toolResult leaf continues mid-work; if the cut lands on a completed
//      assistant message, keep exactly ONE dropped supervisor nudge — a message the
//      harness really sent at that moment — so the leaf is a user message.
// The original file is kept as *.pre-rewind (which *.jsonl globs do NOT match, so
// the runner's byte-0 accounting tail cannot double-count it). Truncation is safe
// per pi source: session load derives leafId from the last line of the file
// (session-manager.js _buildIndex); there is no other pointer.
//
//   node scripts/rewind-scar.mjs <attempt-dir>...
// Refuses attempts with a live pi process.
import { readFileSync, writeFileSync, readdirSync, copyFileSync, existsSync, renameSync, readlinkSync, rmSync } from "node:fs";
import { join, resolve, basename, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUTAGE_MARK = "The infrastructure outage that interrupted you is over.";
const dirs = process.argv.slice(2).map((d) => resolve(d));
if (!dirs.length) { console.error("usage: node scripts/rewind-scar.mjs <attempt-dir>..."); process.exit(1); }

const liveCwds = new Set();
for (const pid of readdirSync("/proc").filter((d) => /^\d+$/.test(d))) {
  try { liveCwds.add(readlinkSync(`/proc/${pid}/cwd`)); } catch {}
}

const isErrStub = (e) => e.type === "message" && e.message?.role === "assistant" && e.message?.stopReason === "error";
const isUserMsg = (e) => e.type === "message" && e.message?.role === "user";
const isDroppable = (e) => isErrStub(e) || isUserMsg(e) || (e.type === "compaction" && !e.summary);
const role = (e) => (e.type === "message" ? e.message?.role : e.type);

const report = [];
for (const dir of dirs) {
  const prob = basename(dir);
  const sess = join(dir, "session");
  const files = readdirSync(sess).filter((f) => f.endsWith(".jsonl"));
  if (files.length !== 1) { console.error(`${prob}: ${files.length} session files — skipped`); continue; }
  const path = join(sess, files[0]);
  if (liveCwds.has(join(dir, "work"))) { console.error(`${prob}: live pi process — skipped`); continue; }

  // Work from the pristine original when a previous (message-injecting) rewind ran.
  const source = existsSync(path + ".pre-rewind") ? path + ".pre-rewind" : path;
  const raw = readFileSync(source, "utf8").split("\n").filter(Boolean);
  const entries = raw.map((l) => JSON.parse(l));
  let cut = entries.length;

  const outageIdx = entries.findIndex((e) => {
    if (!isUserMsg(e)) return false;
    const c = e.message.content;
    const text = typeof c === "string" ? c : (c ?? []).map((b) => b.text ?? "").join(" ");
    return text.includes(OUTAGE_MARK);
  });
  if (outageIdx !== -1) cut = outageIdx;
  while (cut > 0 && isDroppable(entries[cut - 1])) cut--;

  let keptNudge = false;
  const leaf = entries[cut - 1];
  if (leaf?.type === "message" && leaf.message?.role === "assistant" && leaf.message?.stopReason !== "error") {
    // Stopped-agent leaf: restore the first real storm nudge so the leaf is user.
    const firstNudge = entries.slice(cut).find(isUserMsg);
    if (!firstNudge) { console.error(`${prob}: assistant leaf and no nudge to restore — skipped, look by hand`); continue; }
    entries.splice(cut, 0, firstNudge); raw.splice(cut, 0, JSON.stringify(firstNudge));
    cut += 1; keptNudge = true;
  } else if (!(leaf?.type === "message" && (leaf.message?.role === "toolResult" || leaf.message?.role === "user"))) {
    console.error(`${prob}: last kept entry is ${role(leaf)} — skipped, look by hand`);
    continue;
  }

  const dropped = entries.slice(cut);
  const discardedCost = dropped.reduce((s, e) => s + (e.message?.usage?.cost?.total ?? 0), 0);
  if (source === path && !dropped.length) { console.log(JSON.stringify({ problem: prob, unchanged: true })); continue; }
  if (!existsSync(path + ".pre-rewind")) copyFileSync(path, path + ".pre-rewind");
  const tmp = path + ".tmp";
  writeFileSync(tmp, raw.slice(0, cut).join("\n") + "\n");
  renameSync(tmp, path);
  try { rmSync(join(dir, "resume-msg.txt"), { force: true }); } catch {}

  const line = {
    run_id: basename(dirname(dir)), problem: prob, entries_before: entries.length,
    dropped: dropped.length, discarded_cost_usd: +discardedCost.toFixed(5),
    outage_segment_cut: outageIdx !== -1, leaf: role(entries[cut - 1]), kept_nudge: keptNudge,
  };
  report.push(line);
  console.log(JSON.stringify(line));
}
if (report.length)
  writeFileSync(join(ROOT, "results", "rewind-scar-report.jsonl"), report.map((r) => JSON.stringify(r)).join("\n") + "\n", { flag: "a" });
