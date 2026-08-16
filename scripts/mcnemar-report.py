#!/usr/bin/env python3
"""All pairwise exact McNemar tests across the grid, sorted by significance.

Reads each arm's CURRENT glued view with the same resolution chain as
scripts/run-report.py — cwrerun-patched > fgrerun-patched > raw — and glues the
easy3 supplement wherever a cell is safe87 + easy3. Only cells whose every
constituent run has a summary.json enter the table; in-flight cells are listed
as skipped. Triage runs are a different measurement (judge passes, no compiler)
and are deliberately out.

The p is the exact binomial McNemar: the chance of a b/c split at least this
uneven if every discordant problem were a fair coin. Holm-adjusted p controls
the familywise error across all pairs printed — with ~50 pairs on 90 problems,
a raw p < .05 alone is not evidence. Read both against the noise floor
(grep r1 vs r2 flips 10/90 with p = 1.0).

    ./scripts/mcnemar-report.py [--root DIR] [--all-pairs | --vs ARM]
"""

import json, os, sys
from math import comb

ROOT = (sys.argv[sys.argv.index("--root") + 1] if "--root" in sys.argv
        else os.environ.get("CMP_ROOT")
        or os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

# Arm -> constituent runs, run-report.py's convention, plus the arms that
# landed after its list was cut.
CELLS = {
    "base":           ["base-fatex87-0807", "base-fatex87-0807-easy3"],
    "grep":           ["grep-fatex87-0807", "grep-fatex87-0807-easy3"],
    "semantic":       ["semantic-fatex87-0807", "semantic-fatex87-0807-easy3"],
    "snippetonly":    ["snippetonly-fatex90-0807"],
    "grep r2":        ["grep-fatex90-0807-r2"],
    "snippet":        ["snippet-fatex90-0807"],
    "base r2":        ["base-fatex90-0807-r2"],
    "spawn":          ["spawn-fatex90-0807"],
    "spawnfacts":     ["spawnfacts-fatex90-0807"],
    "basequote":      ["basequote-fatex90-0813"],
    "snippet r2":     ["snippet-fatex90-0807-r2"],
    "snippetonly r2": ["snippetonly-fatex90-0807-r2"],
}
FLAGS = ("cwrerun", "fgrerun", "regraded")


def rows(rid):
    p = os.path.join(ROOT, "results", rid, "results.jsonl")
    view = "raw"
    for suffix in ("-cwrerun-patched.results.jsonl", "-fgrerun-patched.results.jsonl"):
        patched = os.path.join(ROOT, "results", rid + suffix)
        if os.path.exists(patched):
            p, view = patched, suffix.split("-")[1].split(".")[0] + "-patched"
            break
    if not os.path.exists(p):
        return [], view
    out = []
    for l in open(p):
        try:
            out.append(json.loads(l))
        except ValueError:
            pass
    return out, view


def cell(name):
    """{problem: solved}, completeness, view labels, provenance-flag counts."""
    d, done, views, prov = {}, True, [], {f: 0 for f in FLAGS}
    for rid in CELLS[name]:
        rs, view = rows(rid)
        for r in rs:
            d[r["problem"]] = bool(r.get("solved"))
            for f in FLAGS:
                prov[f] += bool(r.get(f))
        views.append(view)
        if not os.path.exists(os.path.join(ROOT, "results", rid, "summary.json")):
            done = False
    return d, done, views, prov


def mcnemar(b, c):
    n = b + c
    if n == 0:
        return 1.0
    return min(1.0, 2 * sum(comb(n, k) for k in range(0, min(b, c) + 1)) / 2 ** n)


def stars(p):
    return "***" if p < .001 else "**" if p < .01 else "*" if p < .05 else "." if p < .1 else ""


cells = {k: cell(k) for k in CELLS}
done = {k: v for k, v in cells.items() if v[1] and v[0]}
skipped = [k for k in cells if k not in done]

only = sys.argv[sys.argv.index("--vs") + 1] if "--vs" in sys.argv else None
if only and only not in done:
    sys.exit(f"--vs {only!r}: not a complete cell (have: {', '.join(done)})")

names = list(done)
pairs = []
for i, a in enumerate(names):
    for bn in names[i + 1:]:
        if only and only not in (a, bn):
            continue
        da, db = done[a][0], done[bn][0]
        shared = set(da) & set(db)
        b = sum(1 for p in shared if da[p] and not db[p])
        c = sum(1 for p in shared if db[p] and not da[p])
        sa = sum(da[p] for p in shared)
        sb = sum(db[p] for p in shared)
        pairs.append(dict(a=a, b_arm=bn, n=len(shared), sa=sa, sb=sb,
                          b=b, c=c, p=mcnemar(b, c)))

pairs.sort(key=lambda r: (r["p"], -(r["b"] + r["c"])))

# Holm step-down over exactly the family printed.
m = len(pairs)
running = 0.0
for rank, r in enumerate(pairs):
    running = max(running, min(1.0, (m - rank) * r["p"]))
    r["holm"] = running

out = []
w = out.append
w("# Pairwise exact McNemar — every complete cell, sorted by significance")
w("")
w("b = problems only the LEFT arm solved, c = only the RIGHT. Winner is the arm")
w(f"ahead on shared problems. Holm adjusts for all {m} pairs below; the noise")
w("floor (grep r1 vs r2: 10 flips, p = 1.0) is the floor under all of it.")
w("")
w("| # | comparison | solves | b / c | disc. | p (exact) | p (Holm) | winner | |")
w("|---|---|---|---|---|---|---|---|---|")
for i, r in enumerate(pairs, 1):
    lead = r["a"] if r["b"] > r["c"] else r["b_arm"] if r["c"] > r["b"] else "—"
    ptxt = f"{r['p']:.4f}" if r["p"] >= 0.0005 else f"{r['p']:.1e}"
    w(f"| {i} | {r['a']} vs {r['b_arm']} | {r['sa']}–{r['sb']} /{r['n']} "
      f"| {r['b']} / {r['c']} | {r['b'] + r['c']} "
      f"| {ptxt} | {r['holm']:.3f} | {lead} | {stars(r['p'])} |")
w("")
w("`***` p<.001 `**` p<.01 `*` p<.05 `.` p<.1 — on the RAW p; trust nothing the")
w("Holm column and the noise floor don't both back.")
w("")
w("## Views read")
w("")
for k in names:
    d, _, views, prov = done[k]
    pv = ", ".join(f"{v} {n}" for v, n in prov.items() if n)
    w(f"- **{k}**: {sum(d.values())}/{len(d)} — {' + '.join(views)}"
      + (f" (patched rows: {pv})" if pv else ""))
if skipped:
    w("")
    w("Skipped (incomplete or missing): " + ", ".join(
        f"{k} ({len(cells[k][0])} rows)" for k in skipped))
print("\n".join(out))
