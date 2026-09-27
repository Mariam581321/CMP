// Follows pi session jsonl files by polling, reading incrementally up to the last newline.

import { readdirSync, openSync, readSync, closeSync, statSync } from "node:fs";
import { join } from "node:path";

// onEntry(entry, raw, sessionDir) per appended entry; dirsOf() is re-read every tick. Returns stop().
export function tailSessions(dirsOf, onEntry, { intervalMs = 1000 } = {}) {
  const offsets = new Map();

  const pump = () => {
    let dirs;
    try { dirs = dirsOf(); } catch { return; }
    for (const sessionDir of dirs) {
      let files;
      try {
        files = readdirSync(sessionDir).filter((f) => f.endsWith(".jsonl")).sort();
      } catch {
        continue;
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
        if (lastNl < 0) continue;
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
  return () => { clearInterval(timer); pump(); };
}

export function tailSession(sessionDir, onEntry, opts) {
  return tailSessions(() => [sessionDir], onEntry, opts);
}

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
