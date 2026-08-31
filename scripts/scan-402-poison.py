#!/usr/bin/env python3
"""Scan runs live during the 0816 DeepSeek 402 outage and classify every
attempt by its last events (stderr tail), not the harness verdict.
Emits a merged picture for the snippetonly-r2 cell (server A + laptop B/C)
and a rerun list of poisoned records that nothing is currently reviving."""
import json, os, sys
from pathlib import Path

RESULTS = Path("/home/mariam/CMP/results")

RUNS = [
    "snippetonly-fatex90-0807-r2",
    "snippetonly-fatex90-0807-r2-laptop",
    "snippetonly-fatex90-0807-r2-laptop-mid",
    "base-fatex90-0807-r2-cwrerun",
    "semantic-fatex87-0807-cwrerun",
    "snippet-fatex90-0807-r2-cwrerun",
    "snippetonly-fatex90-0807-cwrerun",
    "base-fatex87-0807-cwrerun2",
    "basequote-fatex90-0813-cwrerun",
]

def tail_lines(path, n=8):
    try:
        with open(path, "rb") as f:
            f.seek(0, 2)
            size = f.tell()
            f.seek(max(0, size - 16384))
            return f.read().decode("utf-8", "replace").splitlines()[-n:]
    except OSError:
        return []

def poisoned_tail(run, prob):
    """402 in the last events of the attempt's stderr?"""
    lines = tail_lines(RESULTS / run / prob / "stderr.log")
    return any("402" in l or "Insufficient Balance" in l for l in lines)

report = {}
for run in RUNS:
    d = RESULTS / run
    rj = d / "results.jsonl"
    if not rj.exists():
        report[run] = {"missing": True}
        continue
    last = {}  # keep-last per problem (resume supersedes agent_died)
    with open(rj) as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            r = json.loads(line)
            last[r["problem"]] = r
    rows = {}
    for prob, r in sorted(last.items()):
        tail402 = poisoned_tail(run, prob)
        end, grade = r.get("end"), r.get("grade")
        resumed = r.get("resumed", False)
        if resumed and not tail402:
            cls = "ok-resumed"
        elif end == "agent_died":
            cls = "poisoned-nonverdict"
        elif tail402:
            cls = "poisoned-fake-verdict"   # harness grade exists but last events are 402s
        else:
            cls = "ok"
        rows[prob] = {
            "class": cls, "end": end, "grade": grade, "solved": r.get("solved"),
            "cost": r.get("cost_usd"), "turns": r.get("turns"),
            "started_at": r.get("started_at"), "wall_s": r.get("wall_s"),
            "resumed": resumed, "prior_end": r.get("prior_end"),
        }
    # attempts with a dir but no record yet = still running (or synced mid-flight)
    inflight = sorted(p.name for p in d.iterdir()
                      if p.is_dir() and p.name.startswith("fatex_") and p.name not in last)
    report[run] = {"rows": rows, "inflight": inflight,
                   "summary_closed": (d / "summary.json").exists()}

print(json.dumps(report, indent=1))
