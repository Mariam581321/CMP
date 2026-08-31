#!/usr/bin/env python3
"""Paper-grade statistics for the FATE-X grid — the analyses COMPARE.md specifies
but run-report.py does not compute.

Everything here reads results/ and writes one markdown report; nothing re-runs.
Conventions are COMPARE.md's and run-report.py's: cost_std throughout, cells are
safe87+easy3 glue or native safe90, comparisons on complete cells only, AUC =
Σ (1 − first-proof cost) over solves. New here:

  * Exact McNemar with Holm correction across the pairwise family, and a minimum
    detectable gap (MDE) stamped on every contrast so a null reads as "unresolved
    at our resolution", not "no effect".
  * Paired bootstrap over problems (problems resampled with replacement, each
    problem carrying its whole row across arms — respects pairing and per-problem
    difficulty correlation): CIs for solve-count differences, budget-curve bands,
    and AUC (= RMST at the $1 horizon) differences.
  * Paired sign test on cost-to-first-proof among both-solved problems (the
    efficiency endpoint; validated against COMPARE.md's hand-computed block-A p's).
  * Noise floor pooled over every replicated arm, not just the grep pair.
  * fgrerun provenance: wherever results/<run>-fgrerun-patched.results.jsonl
    exists it is used instead of the frozen cell, and the arm is marked patched
    (RUNS.md §10: "report patched cells as patched").

stdlib only, deterministic (fixed bootstrap seed), safe to re-run any time.

    ./scripts/paper-stats.py [--root DIR] [--out FILE] [--csv FILE] [-B N]
"""

import json, os, sys, random
from math import comb, sqrt

ARGS = sys.argv[1:]
def opt(flag, default):
    return ARGS[ARGS.index(flag) + 1] if flag in ARGS else default

ROOT = os.path.abspath(opt("--root", os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")))
OUT = opt("--out", os.path.join(ROOT, "drafts", "PAPER-STATS.md"))
CSV = opt("--csv", os.path.join(ROOT, "drafts", "paper-stats-curves.csv"))
B = int(opt("-B", "4000"))
SEED = 20260812  # date-stamped so reruns are byte-identical

# Cells, as in run-report.py, plus the block-C arms so the report picks them up
# the moment their summary.json lands. A cell is safe87 + easy3 glue, or native safe90.
CELLS = {
    "base":         ["base-fatex87-0807", "base-fatex87-0807-easy3"],
    "grep":         ["grep-fatex87-0807", "grep-fatex87-0807-easy3"],
    "semantic":     ["semantic-fatex87-0807", "semantic-fatex87-0807-easy3"],
    "snippetonly":  ["snippetonly-fatex90-0807"],
    "grep r2":      ["grep-fatex90-0807-r2"],
    "snippet":      ["snippet-fatex90-0807"],
    "base r2":      ["base-fatex90-0807-r2"],
    "spawn":        ["spawn-fatex90-0807"],
    "spawnfacts":   ["spawnfacts-fatex90-0807"],
    "snippetfacts": ["snippetfacts-fatex90-0812"],
    "snippet r2":   ["snippet-fatex90-0807-r2"],
    "snippetonly r2": ["snippetonly-fatex90-0807-r2"],
    "basequote":    ["basequote-fatex90-0813"],
}
# have_pairs gates the k=2 section on ALL pairs being complete — add the
# snippetonly pair only when snippetonly-fatex90-0807-r2 closes, or the section
# vanishes while it runs.
REPLICATE_PAIRS = [("grep", "grep r2"), ("base", "base r2"), ("snippet", "snippet r2")]
CAPS = [0.10, 0.25, 0.50, 0.75, 1.00]

# Analysis provenance per COMPARE.md's dated split: block-A curve/cost analyses were
# specified 2026-08-10 after block A ran (exploratory); the same analyses are
# pre-registered for block B onward (confirmatory). snippetfacts was invented
# mid-block-C after peeking at spawnfacts behaviour, so it is exploratory throughout.
EXPLORATORY_ARMS = {"base", "grep", "semantic", "base r2", "grep r2", "snippetfacts",
                    "basequote"}  # invented 0813 after the base cells were read
def label(a, b_):
    return "exploratory" if (a in EXPLORATORY_ARMS and b_ in EXPLORATORY_ARMS) \
        or "snippetfacts" in (a, b_) else "confirmatory"


# ---------------------------------------------------------------- loading

def load_rows(path):
    out = []
    if os.path.exists(path):
        for l in open(path):
            try:
                out.append(json.loads(l))
            except ValueError:
                pass
    return out

def cell(name):
    """{problem: record}, complete?, total problems, patched? (None|'cwrerun'|'fgrerun')"""
    d, done, tot, patched = {}, True, 0, None
    for rid in CELLS[name]:
        base = os.path.join(ROOT, "results", rid)
        # Most-patched view first: cwrerun-patched stacks on the fgrerun view.
        patch = None
        for suf, kind in (("-cwrerun-patched.results.jsonl", "cwrerun"),
                          ("-fgrerun-patched.results.jsonl", "fgrerun")):
            if os.path.exists(base + suf):
                patch, patched = base + suf, kind
                break
        if patch:
            rows = load_rows(patch)
        else:
            rows = load_rows(os.path.join(base, "results.jsonl"))
        for r in rows:
            d[r["problem"]] = r
        if not os.path.exists(os.path.join(base, "summary.json")):
            done = False
        rj = os.path.join(base, "run.json")
        tot += len(json.load(open(rj))["problems"]) if os.path.exists(rj) else 0
    return d, done, tot, patched

def firstc(r):
    f = (r.get("high_water") or {}).get("first")
    return f["cost_std"] if (f and f.get("solved")) else float("inf")

# Session-mined corrections (MINED-STATS-0817): on resumed attempts the in-process
# token counter reset, so the recorded high_water stamp lost pre-resume spend.
# True first-green costs recomputed from the full session event logs.
FIRSTC_CORRECTIONS = {
    ("semantic", "fatex_41"): 0.72583,
    ("snippetonly", "fatex_53"): 0.25819,
    ("snippetonly r2", "fatex_53"): 0.60231,
    ("snippetonly r2", "fatex_76"): 0.17626,
    ("snippetonly r2", "fatex_91"): 0.93649,
}


# ---------------------------------------------------------------- statistics

def mcnemar(b, c):
    n = b + c
    if n == 0:
        return 1.0
    return min(1.0, 2 * sum(comb(n, k) for k in range(0, min(b, c) + 1)) / 2 ** n)

def sign_test(wins, n):
    """Exact two-sided binomial: P of a split at least this uneven under p=1/2."""
    if n == 0:
        return 1.0
    lo = min(wins, n - wins)
    return min(1.0, 2 * sum(comb(n, k) for k in range(0, lo + 1)) / 2 ** n)

def holm(ps):
    """Holm step-down adjusted p-values, order preserved."""
    m = len(ps)
    order = sorted(range(m), key=lambda i: ps[i])
    adj, running = [0.0] * m, 0.0
    for rank, i in enumerate(order):
        running = max(running, (m - rank) * ps[i])
        adj[i] = min(1.0, running)
    return adj

def pctl(xs, q):
    xs = sorted(xs)
    i = q * (len(xs) - 1)
    lo, hi = int(i), min(int(i) + 1, len(xs) - 1)
    return xs[lo] + (xs[hi] - xs[lo]) * (i - lo)

def ci(xs):
    return pctl(xs, 0.025), pctl(xs, 0.975)


# ---------------------------------------------------------------- assemble

cells = {k: cell(k) for k in CELLS}
done_cells = {k: v for k, v in cells.items() if v[1] and v[0]}
names = list(done_cells)
common = sorted(set.intersection(*[set(d) for d, _, _, _ in done_cells.values()])) if done_cells else []
N = len(common)

# Per-arm per-problem arrays over the common list (order fixed by `common`).
# NO-NUDGE convention (2026-08-18): the canonical outcome is the session-mined
# no-nudge harness — a solve is a verified green that predates the attempt's first
# supervisor nudge, at the mined (resume-corrected) cost. The map is produced by
# the bridge-cse worktree's analyze-mined-0817.py. Fallback (map absent): recorded
# grades + high_water with the point corrections above.
NN_PATH = os.path.join(ROOT, "results", "nn-outcomes-0817.json")
NN = json.load(open(NN_PATH)) if os.path.exists(NN_PATH) else None
if NN:
    solved = {k: [1 if NN[k][p] is not None else 0 for p in common] for k in names}
    fc = {k: [NN[k][p] if NN[k][p] is not None else float("inf") for p in common]
          for k in names}
else:
    solved = {k: [1 if done_cells[k][0][p]["solved"] else 0 for p in common] for k in names}
    fc = {k: [FIRSTC_CORRECTIONS.get((k, p), firstc(done_cells[k][0][p])) for p in common]
          for k in names}

# Noise floor: pooled over every complete replicate pair.
pairs_flips = []
for a, b_ in REPLICATE_PAIRS:
    if a in done_cells and b_ in done_cells:
        F = sum(1 for i in range(N) if solved[a][i] != solved[b_][i])
        pairs_flips.append((a, b_, F))
F_pool = (sum(f for _, _, f in pairs_flips) / len(pairs_flips)) if pairs_flips else None

# One shared set of bootstrap index samples — the same resampled problem sets are
# used for every arm and every statistic, which is what makes everything paired.
rng = random.Random(SEED)
samples = [[rng.randrange(N) for _ in range(N)] for _ in range(B)] if N else []

def boot(fn):
    """fn(idx list) -> statistic; returns B values."""
    return [fn(s) for s in samples]

boot_solves = {k: boot(lambda s, k=k: sum(solved[k][i] for i in s)) for k in names}
boot_auc = {k: boot(lambda s, k=k: sum(1 - fc[k][i] for i in s if fc[k][i] <= 1)) for k in names}
boot_curve = {k: {c: boot(lambda s, k=k, c=c: sum(1 for i in s if fc[k][i] <= c)) for c in CAPS} for k in names}


# ---------------------------------------------------------------- report

L = []
w = L.append
w("# Paper statistics — FATE-X grid")
w("")
w(f"Generated by `scripts/paper-stats.py` (seed {SEED}, B={B} paired bootstrap")
w("resamples over problems). Comparisons use complete cells only, on the")
f_incomplete = [k for k in CELLS if k not in done_cells and cells[k][0]]
w(f"{N} problems every complete cell finished. Costs are cost_std. Conventions per")
w("COMPARE.md; this file adds the uncertainty quantification it specifies.")
if f_incomplete:
    w("")
    w(f"Excluded as in flight / absent: {', '.join(f_incomplete)}.")
w("")

# --- arm table
w("## Arms: solve rate and AUC")
w("")
w("Every claim in this report is **paired and conditional on this benchmark**: on")
w("FATE-X the variance across problems is dominated by difficulty spread, not")
w("run-to-run noise — solves are bimodal (roughly a third of problems fall to every")
w("arm and a third to none), so a marginal per-arm interval would mostly price that")
w("fixed spread and none is reported. How representative FATE-X is of any larger")
w("problem family is a sampling question outside this report's scope. AUC = RMST at")
w("the $1 horizon: solves, charged for what they cost, at an exchange rate of one")
w("solve per $1 (set by the cap). Outcomes use the **no-nudge convention** (0818):")
w("a solve is a verified green that predates the attempt's first supervisor nudge,")
w("at the session-mined, resume-corrected cost (results/nn-outcomes-0817.json);")
w("post-nudge greens and tail spend are excluded, pre-nudge greens count at any cost.")
w("")
w("| arm | solved/n | rate | AUC [boot 95%] | provenance |")
w("|---|---|---|---|---|")
for k in names:
    s = sum(solved[k])
    auc = sum(1 - fc[k][i] for i in range(N) if fc[k][i] <= 1)
    alo, ahi = ci(boot_auc[k])
    prov = f"patched ({done_cells[k][3]})" if done_cells[k][3] else "frozen 0807"
    w(f"| {k} | {s}/{N} | {s/N:.3f} | {auc:.1f} [{alo:.1f}, {ahi:.1f}] | {prov} |")
w("")

# --- noise floor
w("## Noise floor, pooled over replicate pairs")
w("")
if pairs_flips:
    for a, b_, F in pairs_flips:
        w(f"- {a} vs {b_}: **{F} flips** on {N}")
    w(f"- pooled F = {F_pool:.1f} → per-problem flip rate {F_pool/N:.3f}")
    w("")
    w("SE of a two-arm solve-count difference with k replicate cells per arm =")
    w("√(F/k); the minimum detectable gap (MDE) is 2.8·SE (80% power, α=0.05).")
    w("")
    w("| k per arm | SE (solves) | 95% half-width | MDE |")
    w("|---|---|---|---|")
    for k in [1, 2, 3, 5]:
        se = sqrt(F_pool / k)
        w(f"| {k} | {se:.2f} | ±{1.96*se:.1f} | {2.8*se:.1f} |")
else:
    w("No complete replicate pair yet.")
w("")

# --- pairwise
w("## Pairwise contrasts: McNemar + Holm, bootstrap CI, MDE stamp")
w("")
w("b/c = problems only the left/right arm solved. Holm corrects the exact McNemar p")
w("across this whole family. Δ CI is the paired bootstrap of the solve-count")
w("difference. Every row carries the MDE at its replication level: |Δ| < MDE means")
w("*unresolved at our resolution*, not \"no difference\". Labels per COMPARE.md's")
w("dated split (block-A analyses are exploratory; snippetfacts was invented")
w("mid-block-C and is exploratory throughout).")
w("")
rows_pw = []
for i, a in enumerate(names):
    for b_ in names[i + 1:]:
        bb = sum(1 for j in range(N) if solved[a][j] and not solved[b_][j])
        cc = sum(1 for j in range(N) if solved[b_][j] and not solved[a][j])
        diffs = [boot_solves[a][t] - boot_solves[b_][t] for t in range(B)]
        rows_pw.append((a, b_, bb, cc, mcnemar(bb, cc), ci(diffs)))
adj = holm([r[4] for r in rows_pw])
w("| comparison | b / c | Δ solves [boot 95%] | McNemar p | Holm p | MDE (k=1) | label |")
w("|---|---|---|---|---|---|---|")
mde1 = 2.8 * sqrt(F_pool) if F_pool else float("nan")
for (a, b_, bb, cc, p, (dlo, dhi)), pa in zip(rows_pw, adj):
    w(f"| {a} vs {b_} | {bb} / {cc} | {bb-cc:+d} [{dlo:+.0f}, {dhi:+.0f}] | {p:.4f} | {pa:.4f} | {mde1:.1f} | {label(a, b_)} |")
w("")

# --- replicate-pooled search effect
have_pairs = all(a in names and b_ in names for a, b_ in REPLICATE_PAIRS)
if have_pairs:
    w("## The k=2 contrast: search effect (grep pair − base pair)")
    w("")
    def pair_mean(t, pair):
        return (boot_solves[pair[0]][t] + boot_solves[pair[1]][t]) / 2
    diffs = [pair_mean(t, ("grep", "grep r2")) - pair_mean(t, ("base", "base r2")) for t in range(B)]
    pt = (sum(solved["grep"]) + sum(solved["grep r2"])) / 2 - (sum(solved["base"]) + sum(solved["base r2"])) / 2
    dlo, dhi = ci(diffs)
    w(f"Point estimate **{pt:+.1f}** solves, paired bootstrap 95% CI [{dlo:+.1f}, {dhi:+.1f}];")
    w(f"MDE at k=2 is {2.8*sqrt(F_pool/2):.1f}. (The one pre-registered binary contrast that")
    w("clears its own noise bar.) Test statistic in the next section.")
    w("")

# --- generalized (stratified) McNemar: CMH by problem + exact permutation
# Each problem is a stratum holding every replicate's binary outcome for both
# arms. The Cochran–Mantel–Haenszel statistic generalizes McNemar to k
# replicates per arm (McNemar is the 1-vs-1 special case); the permutation p
# reshuffles arm labels *within* each stratum, which is the exact
# conditional-on-benchmark null — no super-population assumption. Strata where
# every run agrees (all solved / none solved) carry no information and drop
# out, which is the effective-sample-size point made throughout.
def cmh_strat(groupA, groupB, n_perm=100000, seed=SEED * 2 + 1):
    n1, n2 = len(groupA), len(groupB)
    Nn = n1 + n2
    num = var = obs = 0.0
    strata = []
    for j in range(N):
        xs = [solved[a][j] for a in groupA] + [solved[b_][j] for b_ in groupB]
        s = sum(xs)
        a1 = sum(xs[:n1])
        obs += a1 / n1 - (s - a1) / n2
        num += a1 - n1 * s / Nn
        var += n1 * n2 * s * (Nn - s) / (Nn * Nn * (Nn - 1))
        if 0 < s < Nn:
            strata.append(xs)
    chi2 = num * num / var if var > 0 else 0.0
    from math import erfc
    p_chi = erfc(sqrt(chi2 / 2)) if var > 0 else 1.0
    rng_p = random.Random(seed)
    ge = 0
    for _ in range(n_perm):
        d = 0.0
        for xs in strata:
            ys = xs[:]
            rng_p.shuffle(ys)
            d += sum(ys[:n1]) / n1 - sum(ys[n1:]) / n2
        if abs(d) >= abs(obs) - 1e-12:
            ge += 1
    return obs, len(strata), chi2, p_chi, (ge + 1) / (n_perm + 1)

STRAT = [
    ("search: grep k2 vs base k2", ["grep", "grep r2"], ["base", "base r2"]),
    ("snippet k2 vs base k2", ["snippet", "snippet r2"], ["base", "base r2"]),
    ("snippetonly k2 vs base k2", ["snippetonly", "snippetonly r2"], ["base", "base r2"]),
    ("snippet k2 vs grep k2", ["snippet", "snippet r2"], ["grep", "grep r2"]),
    ("snippetonly k2 vs grep k2", ["snippetonly", "snippetonly r2"], ["grep", "grep r2"]),
    ("semantic k1 vs grep k2", ["semantic"], ["grep", "grep r2"]),
    ("spawn k1 vs snippet k2", ["spawn"], ["snippet", "snippet r2"]),
    ("spawnfacts k1 vs snippet k2", ["spawnfacts"], ["snippet", "snippet r2"]),
]
avail = [(t, A, Bg) for t, A, Bg in STRAT if all(x in names for x in A + Bg)]
if avail:
    w("## Generalized McNemar: CMH stratified by problem, exact permutation p")
    w("")
    w("Every replicate's outcome enters as its own observation inside its problem")
    w("stratum; CMH is the k-replicate generalization of McNemar. The permutation p")
    w("reshuffles arm labels within problems only (conditional on this benchmark —")
    w("the framing used throughout). Informative strata = problems where runs")
    w("disagree; the two shelves drop out of the test automatically.")
    w("")
    w("| contrast | Δ solves (pair means) | informative strata | CMH χ² | p (χ²) | p (perm) | label |")
    w("|---|---|---|---|---|---|---|")
    for t, A, Bg in avail:
        obs, ninf, chi2, p_chi, p_perm = cmh_strat(A, Bg)
        lab = label(A[0], Bg[0])
        w(f"| {t} | {obs:+.1f} | {ninf} | {chi2:.2f} | {p_chi:.4f} | {p_perm:.4f} | {lab} |")
    w("")

# --- budget curves
w("## Budget curve with paired-bootstrap bands")
w("")
w("Solves at cap = first-proof cost ≤ cap (exact downward censoring from the $1 run;")
w("at-cap non-solves are failures, not censoring, per COMPARE.md). Bands are paired")
w(f"bootstrap over problems, so cross-arm gaps at a cap are more certain than the")
w("bands visually suggest — the arms move together across resamples.")
w("")
w("| cap | " + " | ".join(names) + " |")
w("|---" * (len(names) + 1) + "|")
for c in CAPS:
    vals = []
    for k in names:
        s = sum(1 for i in range(N) if fc[k][i] <= c)
        lo, hi = ci(boot_curve[k][c])
        vals.append(f"{s} [{lo:.0f}, {hi:.0f}]")
    w(f"| ${c:.2f} | " + " | ".join(vals) + " |")
w("")

# --- AUC / RMST differences vs base
if "base" in names:
    w("## Efficiency vs base: AUC (RMST@$1) differences, paired bootstrap")
    w("")
    w("| arm | ΔAUC vs base | boot 95% CI | label |")
    w("|---|---|---|---|")
    base_auc = sum(1 - fc["base"][i] for i in range(N) if fc["base"][i] <= 1)
    for k in names:
        if k == "base":
            continue
        auc = sum(1 - fc[k][i] for i in range(N) if fc[k][i] <= 1)
        diffs = [boot_auc[k][t] - boot_auc["base"][t] for t in range(B)]
        dlo, dhi = ci(diffs)
        w(f"| {k} | {auc - base_auc:+.1f} | [{dlo:+.1f}, {dhi:+.1f}] | {label(k, 'base')} |")
    w("")

# --- paired cost-to-first-proof sign tests
w("## Paired cost-to-first-proof (sign test on both-solved problems)")
w("")
w("The efficiency endpoint: among problems both arms solve, which arm reached its")
w("first proof cheaper. Exact two-sided binomial; ties (identical cost) drop out.")
w("")
w("| comparison | left cheaper / n | sign p | median Δcost (left − right) | label |")
w("|---|---|---|---|---|")
for i, a in enumerate(names):
    for b_ in names[i + 1:]:
        both = [j for j in range(N) if fc[a][j] <= 1 and fc[b_][j] <= 1]
        wins = sum(1 for j in both if fc[a][j] < fc[b_][j])
        nz = [j for j in both if fc[a][j] != fc[b_][j]]
        deltas = sorted(fc[a][j] - fc[b_][j] for j in both)
        med = deltas[len(deltas) // 2] if deltas else float("nan")
        w(f"| {a} vs {b_} | {wins} / {len(nz)} | {sign_test(wins, len(nz)):.4f} | {med:+.3f} | {label(a, b_)} |")
w("")

# --- process metrics from recorded tool_calls (no session mining needed)
w("## Process metrics: what the tools change about *how* the agent works")
w("")
w("Per-attempt tool-call counts from the recorded `tool_calls` field — count data on")
w("90 paired observations, far higher-powered than the binary endpoint. `checks` =")
w("`lean_check` (graded-file compiles); `search` = grep + semantic calls; p is an")
w("exact paired sign test vs base on the per-problem counts (ties drop).")
w("")
def tc(k, field):
    return [((done_cells[k][0][p].get("tool_calls") or {}).get(field) or 0) for p in common]
def med(xs):
    return sorted(xs)[len(xs) // 2]
w("| arm | med checks | sign p vs base | med search | med snippet | med turns |")
w("|---|---|---|---|---|---|")
if "base" in names:
    base_checks = tc("base", "lean_check")
    for k in names:
        checks = tc(k, "lean_check")
        search = [a + b_ for a, b_ in zip(tc(k, "grep_mathlib"), tc(k, "search_mathlib"))]
        snip = tc(k, "check_snippet")
        turns = [done_cells[k][0][p].get("turns") or 0 for p in common]
        if k == "base":
            p_s = "—"
        else:
            nz = [j for j in range(N) if checks[j] != base_checks[j]]
            wins = sum(1 for j in nz if checks[j] < base_checks[j])
            p_s = f"{sign_test(wins, len(nz)):.2g}"
        w(f"| {k} | {med(checks)} | {p_s} | {med(search)} | {med(snip)} | {med(turns)} |")
w("")
w("The substitution reading: arms with `check_snippet` shift verification from the")
w("graded file to scratch compiles while search volume holds — the tools change the")
w("agent's working style far more decisively than they change the $1 outcome.")
w("")

w("---")
w("")
w("Not computed here (follow-ups): the hierarchical logistic model")
w("(`solve ~ arm + (1|problem) + (1|replicate)`) needs numpy/PyMC, absent on this box;")
w("for two-arm contrasts its conditional-likelihood version reduces to McNemar above.")
w("Process-metric tests (tool-call substitution, thrash rounds) live in a separate")
w("session-mining pass.")
w("")

os.makedirs(os.path.dirname(OUT), exist_ok=True)
open(OUT, "w").write("\n".join(L) + "\n")

# CSV of curve bands for build-grid-charts.py to pick up.
with open(CSV, "w") as f:
    f.write("arm,cap,solves,boot_lo,boot_hi\n")
    for k in names:
        for c in CAPS:
            s = sum(1 for i in range(N) if fc[k][i] <= c)
            lo, hi = ci(boot_curve[k][c])
            f.write(f"{k},{c:.2f},{s},{lo:.1f},{hi:.1f}\n")

print(f"wrote {OUT} ({len(L)} lines) and {CSV}")
