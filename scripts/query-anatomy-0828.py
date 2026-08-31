#!/usr/bin/env python3
"""Classify every retrieval query by shape: does it name a declaration, or describe one?

A *name token* is one Lean would accept as an identifier and that no English writer
would type: it is dotted, carries an underscore, or has internal CamelCase.  A *prose
token* is an ordinary word.  Each query is then name-only, mixed, or prose-only.
grep patterns are stripped of regex metacharacters first and alternations are counted
as one query.  Also: for the semantic arm, whether a name the query asked for came
back in the results at all."""
import json, re, sys
from collections import Counter, defaultdict

NAME = re.compile(r"^[A-Za-z_À-ɏ][A-Za-z0-9_.'₀-₉À-ɏ!?]*$")
def is_name(t):
    if not NAME.match(t) or len(t) < 2:
        return False
    if "." in t or "_" in t:
        return True
    body = t[1:]
    return any(ch.isupper() for ch in body) and any(ch.islower() for ch in t)

META = re.compile(r"[\\^$.*+?()\[\]{}|]")
def tokens(q, tool):
    if tool == "grep_mathlib":
        q = q.replace("|", " ").replace(".*", " ")
        q = META.sub(" ", q)
    return [t for t in re.split(r"[\s,;:/\"`]+", q.strip()) if t]

def shape(q, tool):
    ts = tokens(q, tool)
    if not ts:
        return None, 0
    n = sum(is_name(t) for t in ts)
    p = len(ts) - n
    return ("name-only" if p == 0 else "prose-only" if n == 0 else "mixed"), len(ts)

rows = defaultdict(lambda: {"shape": Counter(), "len": [], "asked": 0, "unconfirmed": 0})
for line in open("/home/mariam/CMP/mined/queries.jsonl"):
    d = json.loads(line)
    if d["worker"]:
        continue
    k = (d["arm"], d["rep"])
    s, n = shape(d["query"], d["tool"])
    if s is None:
        continue
    r = rows[k]
    r["shape"][s] += 1
    r["len"].append(n)
    # did the query ask for a specific declaration, and did it come back?
    names = [t for t in tokens(d["query"], d["tool"]) if is_name(t) and ("_" in t or "." in t)]
    if names:
        r["asked"] += 1
        res = d["result"]
        if not any(t in res for t in names):
            r["unconfirmed"] += 1

hdr = f"{'arm/rep':16} {'queries':>8} {'name-only':>10} {'mixed':>8} {'prose':>8} {'med.words':>10} {'asked-name':>11} {'unconfirmed':>12}"
print(hdr); print("-" * len(hdr))
for k in sorted(rows):
    r = rows[k]; tot = sum(r["shape"].values())
    med = sorted(r["len"])[len(r["len"]) // 2]
    pc = lambda x: f"{100*x/tot:.0f}%"
    print(f'{k[0]+"/"+k[1]:16} {tot:8d} {pc(r["shape"]["name-only"]):>10} '
          f'{pc(r["shape"]["mixed"]):>8} {pc(r["shape"]["prose-only"]):>8} {med:10d} '
          f'{pc(r["asked"]):>11} {(str(round(100*r["unconfirmed"]/r["asked"]))+"%" if r["asked"] else "-"):>12}')
