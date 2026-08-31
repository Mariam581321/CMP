#!/usr/bin/env python3
"""Mine every search_mathlib / grep_mathlib query text from the exact attempts that
paper/data is built from (provenance.csv run_id), plus what came back.
Writes mined/queries.jsonl: one row per tool call."""
import csv, glob, json, os, re

CMP = "/home/mariam/CMP"
PROV = os.path.join(CMP, "paper", "data", "provenance.csv")
OUT = os.path.join(CMP, "mined", "queries.jsonl")
ARMS = {"semantic", "grep", "snippet", "spawn", "spawnfacts", "snippetfacts"}
TOOLS = {"search_mathlib", "grep_mathlib"}

def sessions(run_id, problem):
    d = os.path.join(CMP, "results", run_id, problem)
    return sorted(glob.glob(os.path.join(d, "session", "*.jsonl"))) + \
           sorted(glob.glob(os.path.join(d, "workers", "*", "session", "*.jsonl")))

def text_of(content):
    if isinstance(content, str):
        return content
    out = []
    for c in content or []:
        if isinstance(c, dict) and c.get("type") == "text":
            out.append(c.get("text", ""))
    return "\n".join(out)

n = 0
with open(OUT, "w") as fh:
    for r in csv.DictReader(open(PROV)):
        if r["arm"] not in ARMS:
            continue
        for path in sessions(r["run_id"], r["problem"]):
            worker = "/workers/" in path
            calls, results = {}, {}
            for line in open(path):
                try:
                    d = json.loads(line)
                except Exception:
                    continue
                m = d.get("message") or {}
                if m.get("role") == "assistant":
                    for c in (m.get("content") or []):
                        if isinstance(c, dict) and c.get("type") == "toolCall" \
                           and c.get("name") in TOOLS:
                            a = c.get("arguments") or {}
                            calls[c["id"]] = (c["name"], a.get("query", a.get("pattern", "")), d.get("timestamp"))
                elif m.get("role") == "toolResult" and m.get("toolName") in TOOLS:
                    results[m.get("toolCallId")] = text_of(m.get("content"))
            for i, (cid, (tool, q, ts)) in enumerate(calls.items()):
                fh.write(json.dumps({
                    "arm": r["arm"], "rep": r["rep"], "problem": r["problem"],
                    "run_id": r["run_id"], "worker": worker, "tool": tool,
                    "idx": i, "ts": ts, "query": q,
                    "result": results.get(cid, ""),
                }) + "\n")
                n += 1
print("rows:", n)
