#!/usr/bin/env python3
"""What did each lean_check actually tell the agent?

For every lean_check and check_snippet in the attempts the paper uses, parse the compiler
errors out of the tool result and split them into *name errors* (Lean does not know this
constant/identifier -- exactly the question a search tool answers) and everything else.
Name errors are where the compiler is being asked a search tool's question.

Writes mined/check-errors.jsonl, one row per lean_check.
"""
import csv, glob, json, os, re

CMP = "/home/mariam/CMP"
ARMS = {"base", "grep", "semantic", "snippetonly", "snippet"}
TOOLS = {"lean_check", "check_snippet"}
ERR = re.compile(r"^error: [^:]+:\d+:\d+: (.*)$", re.M)
NAMEERR = re.compile(r"^Unknown (constant|identifier) `([^`]*)`")

def text(c):
    if isinstance(c, str):
        return c
    return "\n".join(x.get("text", "") for x in (c or []) if isinstance(x, dict))

rows = 0
with open(os.path.join(CMP, "mined", "check-errors.jsonl"), "w") as out:
    for r in csv.DictReader(open(os.path.join(CMP, "paper", "data", "provenance.csv"))):
        if r["arm"] not in ARMS:
            continue
        d = os.path.join(CMP, "results", r["run_id"], r["problem"])
        for path in sorted(glob.glob(os.path.join(d, "session", "*.jsonl"))):
            i = 0
            for line in open(path):
                try:
                    ev = json.loads(line)
                except Exception:
                    continue
                m = ev.get("message") or {}
                if m.get("role") != "toolResult" or m.get("toolName") not in TOOLS:
                    continue
                t = text(m.get("content"))
                errs = ERR.findall(t)
                names = [NAMEERR.match(e) for e in errs]
                names = [m2.group(2) for m2 in names if m2]
                out.write(json.dumps({
                    "arm": r["arm"], "rep": r["rep"], "problem": r["problem"], "idx": i,
                    "tool": m.get("toolName"), "ts": ev.get("timestamp"),
                    "green": "COMPLETE" in t[:400] or "FAILED" not in t,
                    "n_err": len(errs), "n_name_err": len(names),
                    "all_name": bool(errs) and len(names) == len(errs),
                    "names": names,
                }) + "\n")
                i += 1
                rows += 1
print("checks parsed:", rows)
