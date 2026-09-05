#!/usr/bin/env python3
"""Build paper/data/ — the one clean table set every paper figure is drawn from.

Source of truth: mined/attempts.jsonl (session-mined, post-fold: false-green reruns,
context-wall reruns, 402-outage resumes and the snippetonly-r2 server/laptop split are
already glued in; scripts/verify-glue.py re-derives that glue from results/ and
checks it). This script only reshapes, it never re-derives outcomes.

Conventions (the paper's, fixed 2026-08-18/20; give-up refined 2026-08-29):
  * NO-NUDGE harness. An attempt counts as solved iff a verified sorry-free
    lean_check (a "green") occurred BEFORE the agent's first GIVE-UP: the first
    supervisor nudge that followed a turn the agent ended itself (stopReason "stop")
    with the statement intact. Nudges after an output cutoff or a transport error,
    and nudges that only ask for the statement to be restored, are the harness
    doing its job -- the attempt continues through them. Cost is the cumulative
    cost_std at that green (main agent + any worker spend at that instant).
    Post-give-up greens are not solves; post-give-up spend is not spend.
  * cost_std throughout (list-price DeepSeek dollars).
  * All 90 safe90 problems are reported. N = 90.
  * Arms are design names; replicates are rep 1/2. No run ids, glue seams
    (safe87+easy3, reruns, laptop tail) or patch flags appear in the analysis
    tables — they live in provenance.csv only.

Outputs (paper/data/):
  attempts.csv    arm, rep, problem, solved, cost, spend    <- the analysis table
  behaviour.csv   same keys + behavioural counts before the first give-up (no-nudge view);
                  the full-harness columns carry a _full suffix
  cells.csv       one row per (arm, rep): tools, solves, spend
  problems.csv    the 90 ids, theorem name, how many runs solve each
  provenance.csv  run id / rerun / resume / laptop / cost-correction per attempt
  README.md       column dictionary

    ./scripts/build-paper-data.py            (stdlib only, deterministic)
"""
import csv, json, os, re, sys, collections

ROOT = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
MINED = os.path.join(ROOT, "mined", "attempts.jsonl")
OUT = os.path.join(ROOT, "paper", "data")
os.makedirs(OUT, exist_ok=True)

EXCLUDED = {}  # nothing — N = 90

# mined arm label -> (paper arm, rep)
ARMS = {
    "base": ("base", 1), "base r2": ("base", 2),
    "grep": ("grep", 1), "grep r2": ("grep", 2),
    "semantic": ("semantic", 1),
    "snippetonly": ("snippetonly", 1), "snippetonly r2": ("snippetonly", 2),
    "snippet": ("snippet", 1), "snippet r2": ("snippet", 2),
    "spawn": ("spawn", 1), "spawnfacts": ("spawnfacts", 1),
    "snippetfacts": ("snippetfacts", 1),
}
ARM_ORDER = ["base", "grep", "semantic", "snippetonly", "snippet", "spawn", "spawnfacts",
             "snippetfacts"]
# tool sets, in the paper's vocabulary (lean_check is in every arm)
TOOLS = {
    "base": "",
    "grep": "grep", "semantic": "search",
    "snippetonly": "check_snippet", "snippet": "grep+check_snippet",
    "spawn": "grep+check_snippet+spawn", "spawnfacts": "grep+check_snippet+spawn+add_fact",
    "snippetfacts": "grep+check_snippet+add_fact",
}
BLOCK = {"base": "A", "grep": "A", "semantic": "A", "snippetonly": "A", "snippet": "A/B",
         "spawn": "B", "spawnfacts": "B", "snippetfacts": "B"}

A = [json.loads(l) for l in open(MINED) if l.strip()]
assert len(A) == 1170, len(A)

def pnum(p):
    return int(p.split("_")[1])

# ------------------------------------------------------------------ outcomes
def nn_cost(a):
    """no-nudge first-solve cost, or None."""
    if not a["ever_green"]:
        return None
    fn = a.get("first_giveup")
    if fn is None or fn.get("green_before"):
        return a["first_green"]["cost_at"]
    return None

def nn_spend(a):
    """spend under the no-nudge harness: everything up to the first give-up, else the
    whole attempt (main + workers)."""
    fn = a.get("first_giveup")
    return fn["cost_at"] if fn else a["mined_cost_total"]

def proof_stats(a):
    """line/declaration counts of the first green file (the proof that was paid for)."""
    if not a["ever_green"]:
        return None, None
    f = os.path.join(ROOT, "results", a["run_id"], a["problem"], "highwater-first.lean")
    src = open(f, encoding="utf-8", errors="replace").read()
    lines = sum(1 for l in src.splitlines() if l.strip())
    decls = len(re.findall(r"^\s*(?:private\s+|protected\s+|noncomputable\s+)*(?:theorem|lemma)\b", src, re.M))
    return lines, decls

def pre_nudge_checks(a):
    """lean_check calls before the first give-up (traj = one entry per lean_check)."""
    fn = a.get("first_giveup")
    if not fn:
        return len(a["traj"])
    return sum(1 for t in a["traj"] if t[0] <= fn["cost_at"])

rows_att, rows_beh, rows_prov = [], [], []
A = [a for a in A if a["arm"] in ARMS]  # the grid only; other mined runs stay local
for a in sorted(A, key=lambda r: (ARM_ORDER.index(ARMS[r["arm"]][0]), ARMS[r["arm"]][1], pnum(r["problem"]))):
    arm, rep = ARMS[a["arm"]]
    p = a["problem"]
    c = nn_cost(a)
    solved = c is not None
    lines, decls = proof_stats(a)
    key = {"arm": arm, "rep": rep, "problem": p}
    if p not in EXCLUDED:
        rows_att.append({**key,
                         "solved": int(solved),
                         "cost": f"{c:.5f}" if solved else "",
                         "spend": f"{nn_spend(a):.5f}"})
        # behavioural counts are the no-nudge harness's: what happened before the first
        # give-up (the miner's pre_giveup view; the whole attempt when there was none)
        pg = a["pre_giveup"]
        t = pg["tools"]
        rows_beh.append({**key,
                         "solved": int(solved),
                         "proof_lines": lines if solved else "",
                         "proof_decls": decls if solved else "",
                         "checks_pre_nudge": pre_nudge_checks(a),
                         "end": a["row_end"],
                         "nudges": a["n_nudges"],
                         "gave_up": int(a["first_giveup"] is not None and not solved),
                         "ever_green_full": int(bool(a["ever_green"])),
                         "cost_full_first_green": f"{a['first_green']['cost_at']:.5f}" if a["ever_green"] else "",
                         "spend_full": f"{a['mined_cost_total']:.5f}",
                         "turns": pg["turns"],
                         "turns_full": a["mined_turns"],
                         "tokens_in_full": a["mined_tokens"]["in"] + sum(w["tokens"]["in"] for w in a["workers"]),
                         "tokens_out_full": a["mined_tokens"]["out"] + sum(w["tokens"]["out"] for w in a["workers"]),
                         "tokens_cache_read_full": a["mined_tokens"]["cache_read"] + sum(w["tokens"]["cache_read"] for w in a["workers"]),
                         "lean_check": t.get("lean_check", 0),
                         "check_snippet": t.get("check_snippet", 0),
                         "grep_mathlib": t.get("grep_mathlib", 0),
                         "search_mathlib": t.get("search_mathlib", 0),
                         "read": t.get("read", 0),
                         "write": t.get("write", 0),
                         "edit": t.get("edit", 0),
                         "spawn_calls": t.get("spawn_subagents", 0),
                         "workers": pg["n_workers"],
                         "worker_spend": f"{pg['workers_cost_std']:.5f}",
                         "add_fact": t.get("add_fact", 0),
                         "add_fact_workers": pg["worker_tools"].get("add_fact", 0),
                         "compactions": pg["compactions"],
                         "compactions_full": a["compactions"],
                         })
    # provenance for every attempt, excluded problem included
    rid = a["run_id"]
    rerun = "context-wall" if "cwrerun" in rid else ("false-green" if "fgrerun" in rid else "")
    src = "laptop" if "laptop" in rid else "server"
    hwf = (a.get("hw") or {}).get("first") or {}
    corr = ""
    if a["ever_green"] and hwf.get("solved") and abs(a["first_green"]["cost_at"] - hwf["cost_std"]) > 0.005:
        corr = f"{hwf['cost_std']:.5f}->{a['first_green']['cost_at']:.5f}"
    rows_prov.append({**key, "run_id": rid, "source": src, "rerun": rerun,
                      "easy3_supplement": int(rid.endswith("-easy3")),
                      "resumed_after_402": "",  # filled below from the raw record
                      "first_green_cost_corrected": corr,
                      "first_giveup_ts": (a.get("first_giveup") or {}).get("ts", "")})

# resumed flag needs the raw record (mined rows don't carry it)
raw_cache = {}
def raw_row(rid, p):
    if rid not in raw_cache:
        d = {}
        f = os.path.join(ROOT, "results", rid, "results.jsonl")
        for l in open(f):
            try:
                r = json.loads(l); d[r["problem"]] = r
            except ValueError:
                pass
        raw_cache[rid] = d
    return raw_cache[rid].get(p, {})
for r in rows_prov:
    r["resumed_after_402"] = int(bool(raw_row(r["run_id"], r["problem"]).get("resumed")))

# ------------------------------------------------------------------ cells / problems
cells = []
for arm in ARM_ORDER:
    for rep in (1, 2):
        sub = [r for r in rows_att if r["arm"] == arm and r["rep"] == rep]
        if not sub:
            continue
        cells.append({"arm": arm, "rep": rep, "tools": TOOLS[arm], "block": BLOCK[arm],
                      "replicated": int(any(r["arm"] == arm and r["rep"] == 2 for r in rows_att)),
                      "n": len(sub), "solved": sum(r["solved"] for r in sub),
                      "spend": f"{sum(float(r['spend']) for r in sub):.2f}"})

problems = []
for p in sorted({a["problem"] for a in A}, key=pnum):
    src = open(os.path.join(ROOT, "problems-fatex", p + ".lean"), encoding="utf-8").read()
    m = re.search(r"^\s*(?:theorem|lemma)\s+(\S+)", src, re.M)
    n_solved = sum(1 for r in rows_att if r["problem"] == p and r["solved"])
    problems.append({"problem": p, "theorem": m.group(1) if m else "",
                     "cells_solving": n_solved})

# ------------------------------------------------------------------ write
def write(name, rows):
    with open(os.path.join(OUT, name), "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=list(rows[0].keys()))
        w.writeheader(); w.writerows(rows)
    print(f"  {name:16s} {len(rows)} rows")

print("writing paper/data/")
write("attempts.csv", rows_att)
write("behaviour.csv", rows_beh)
write("cells.csv", cells)
write("problems.csv", problems)
write("provenance.csv", rows_prov)

README = f"""# paper/data — the tables every figure is built from

Generated by `scripts/build-paper-data.py` from `mined/attempts.jsonl` (session-mined
ground truth; the glue of reruns/resumes/laptop rows into 90-problem cells is verified
independently by `scripts/verify-glue.py`). Regenerate with
`python3 scripts/build-paper-data.py`; never hand-edit.

## Conventions

* **No-nudge harness.** An attempt is *solved* iff a verified sorry-free `lean_check`
  (a green) occurred before the agent's first *give-up*: the first supervisor nudge that
  followed a turn the agent ended itself (`stopReason == "stop"`) with the statement
  intact. Nudges after an output-token cutoff or a transport error, and nudges that only
  ask for a modified statement to be restored, are the harness doing its job — the
  attempt continues through them (decision 2026-08-29). `cost` is the cumulative
  `cost_std` at that green, workers included. Greens and spend after the give-up do not
  count.
* **Costs** are `cost_std`, DeepSeek list price in USD, per problem. The cap was $1.00.
* **N = 90**, the `safe90` list.
* **Arms** are design names; `rep` distinguishes byte-identical replicate runs.
  Four arms are replicated (base, grep, snippetonly, snippet); the rest are single runs.
* Nothing in the analysis tables refers to run ids, the safe87+easy3 glue, reruns,
  outage resumes or the laptop tail — `provenance.csv` carries all of that.

## attempts.csv  — one row per (arm, rep, problem); the analysis table

| column | meaning |
|---|---|
| arm | base, grep, semantic, snippetonly, snippet, spawn, spawnfacts, snippetfacts |
| rep | 1 or 2 |
| problem | fatex_N |
| solved | 1 iff a green exists before the first give-up |
| cost | first-solve cost (USD) if solved, empty otherwise. A solve at cap c is `solved==1 and cost<=c` |
| spend | spend under the no-nudge harness: cost at the first give-up if there was one, else the whole attempt (main + workers). Spend at cap c is `min(spend, c)` |

Budget curve: `S(c) = #{{cost <= c}}`. Total-spend plane at cap c: `sum(min(spend, c))`.
If you want "harness stops at the first solve" spend instead, use `min(cost, spend)` for
solved rows — post-solve spend is ~8% of the total.

## behaviour.csv  — same keys; what the agent did, under the no-nudge harness

Every count is censored at the first give-up, like `cost` and `spend`: it is what the
attempt did *before* the agent first gave up, and the whole attempt when it never did.
Columns with a `_full` suffix are the full-harness (nudges allowed) view instead.

| column | meaning |
|---|---|
| proof_lines, proof_decls | non-blank lines and `theorem`/`lemma` declarations in the first green file (solved rows only) |
| checks_pre_nudge | `lean_check` calls before the first give-up |
| end | how the attempt ended, full harness: completed / budget_exceeded |
| nudges | supervisor nudges received over the whole attempt, of every kind (a full-harness quantity by nature) |
| gave_up | 1 iff the attempt is unsolved and ended, under the no-nudge harness, by the agent giving up (see Conventions); unsolved rows with `gave_up == 0` ran to the cap |
| ever_green_full, cost_full_first_green | full-harness outcome and first-green cost — the "as-recorded" estimand for the appendix reconciliation |
| spend_full | whole-attempt spend, main + workers |
| turns | main-agent turns before the first give-up; `turns_full` the whole attempt |
| tokens_in_full, tokens_out_full, tokens_cache_read_full | whole attempt, workers included (tokens are not tracked at the give-up; use `spend` for the censored quantity) |
| lean_check, check_snippet, grep_mathlib, search_mathlib, read, write, edit, spawn_calls, add_fact | tool-call counts, main agent only, before the first give-up |
| add_fact_workers | `add_fact` calls made by the attempt's workers before the first give-up (spawn arms) |
| workers, worker_spend | subagents started before the first give-up, and their spend up to it |
| compactions | context compactions of the main session before the first give-up; `compactions_full` the whole attempt |

## cells.csv — one row per run: tools, block, replicated flag, n, solves, total no-nudge spend
## problems.csv — the 90 ids with their theorem name and how many of the 12 runs solve each
## provenance.csv — per attempt: run_id, server/laptop, rerun kind (false-green / context-wall), easy3 supplement, 402 resume, first-green cost correction, and `first_giveup_ts` (the timestamp of the first give-up, empty if none) so that scripts reading per-event rows from `mined/` can apply the same censor

Tool vocabulary: `search` = semantic Mathlib search (external API); `grep` = text search
over the local Mathlib (+ `read`); `check_snippet` = compile a scratch snippet;
`spawn` = spawn subagents; `add_fact` = append a compiled lemma to the facts bank.
`lean_check` (compile the solution file) is available in every arm.
"""
open(os.path.join(OUT, "README.md"), "w").write(README)
print("  README.md")

# ------------------------------------------------------------------ summary to stdout
print("\ncells (no-nudge, N=90):")
for c in cells:
    print(f"  {c['arm']:13s} rep{c['rep']}  {c['tools']:36s} solved={c['solved']:2d}  spend=${c['spend']}")
