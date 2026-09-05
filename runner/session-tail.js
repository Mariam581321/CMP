// Follow an attempt's pi session file.
//
// pi's session jsonl IS the durable, linear record of an attempt: one entry per
// completed message (assistant with full `usage`, toolResult, user), appended as they
// happen. Everything the runner accounts for — turns, tool calls, nudges, tokens,
// cost — reconstructs from it byte-exactly.
//
// Not pi's `--mode json` event stream: that stream re-emits the WHOLE accumulated
// assistant message once per token delta, so one message of T deltas costs O(T^2)
// bytes, and pi's writer queues them in memory with no backpressure
// (core/output-guard.js), so a long thinking block kills the child with a V8 heap
// abort. Reading the file instead makes the accounting linear in what actually
// happened, and the child no longer has to say anything on stdout.
//
// Polling, not fs.watch: one stat() per second per attempt is nothing next to the run,
// and watch semantics on appended files vary by platform. Reads are incremental (byte
// offset per file) and cut at the last newline, so a half-written line is simply picked
// up on the next tick. Splitting on 0x0A is UTF-8 safe: a newline byte cannot occur
// inside a multi-byte sequence.

import { readdirSync, openSync, readSync, closeSync, statSync } from "node:fs";
import { join } from "node:path";

// onEntry(entry, raw, sessionDir) is called for every appended session entry, in file
// order; sessionDir says which session it came from, so a caller following several
// (an attempt plus its spawned workers) can bucket parent and child usage separately.
// dirsOf() re-resolves the directory list every tick, because worker session dirs
// appear mid-attempt — the first spawn_subagents call creates them long after the tail
// started. Returns a stop() that clears the timer. Never throws into the caller: a
// malformed or truncated line is skipped, a vanished file is retried on the next tick.
export function tailSessions(dirsOf, onEntry, { intervalMs = 1000 } = {}) {
  const offsets = new Map(); // path -> bytes consumed

  const pump = () => {
    let dirs;
    try { dirs = dirsOf(); } catch { return; }
    for (const sessionDir of dirs) {
      let files;
      try {
        files = readdirSync(sessionDir).filter((f) => f.endsWith(".jsonl")).sort();
      } catch {
        continue; // pi has not created the dir/file yet
      }
      for (const f of files) {
        const path = join(sessionDir, f);
        let size;
        try { size = statSync(path).size; } catch { continue; }
        const off = offsets.get(path) ?? 0;
        if (size <= off) continue;
        let buf, n;
        try {
          const fd = openSync(path, "r");
          try {
            buf = Buffer.alloc(size - off);
            n = readSync(fd, buf, 0, buf.length, off);
          } finally { closeSync(fd); }
        } catch { continue; }
        const lastNl = buf.lastIndexOf(10, n - 1);
        if (lastNl < 0) continue; // no complete line yet
        offsets.set(path, off + lastNl + 1);
        for (const line of buf.toString("utf8", 0, lastNl + 1).split("\n")) {
          if (!line.trim()) continue;
          let entry;
          try { entry = JSON.parse(line); } catch { continue; }
          try { onEntry(entry, line, sessionDir); } catch {}
        }
      }
    }
  };

  const timer = setInterval(pump, intervalMs);
  if (timer.unref) timer.unref();
  // A final synchronous drain, for the tail written between the last tick and exit.
  return () => { clearInterval(timer); pump(); };
}

// The single-directory form everything predating workers uses.
export function tailSession(sessionDir, onEntry, opts) {
  return tailSessions(() => [sessionDir], onEntry, opts);
}

// The accounting the runner keeps per attempt, fed one session entry at a time.
//   tool_calls means "returned a result": a SIGKILL mid-tool leaves a toolCall block
//   with no result, indistinguishable from a final call the agent loop never began.
//   turns counts assistant messages, so the last turn is counted even when the budget
//   kill lands between the message landing and its turn_end.
export function newStats() {
  return { turns: 0, userMsgs: 0, toolCalls: {}, tokens: { in: 0, out: 0, cache_read: 0 }, cost: 0 };
}

export function applyEntry(stats, entry) {
  const m = entry?.message;
  if (!m) return stats;
  if (m.role === "toolResult") {
    stats.toolCalls[m.toolName] = (stats.toolCalls[m.toolName] ?? 0) + 1;
  } else if (m.role === "assistant") {
    stats.turns++;
    const u = m.usage;
    if (u) {
      stats.tokens.in += u.input ?? 0;
      stats.tokens.out += u.output ?? 0;
      stats.tokens.cache_read += u.cacheRead ?? 0;
      stats.cost += u.cost?.total ?? 0;
    }
  } else if (m.role === "user") {
    stats.userMsgs++;
  }
  return stats;
}
