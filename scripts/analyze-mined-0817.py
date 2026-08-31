#!/usr/bin/env python3
"""Analysis battery over mined/attempts.jsonl — everything computed from the
session-mined ground truth, not the recorded summaries.

Estimand throughout: EVER-GREEN — the attempt held a verified COMPLETE check —
with cost = mined cost_std at that first green (main + worker spend at that
instant). This is "the harness stops the model at its first solve". Post-green
behaviour is analysed separately (postgreen section). Final-grade `solved` is
reported only as a cross-check (the difference = wrecked/lost proofs).

Sections (all results also dumped to mined/analysis.json for plotting):
  grid          recomputed per-arm table + resumed-cost corrections
  auc           AUC/RMST exact definition, per arm, paired bootstrap, sensitivity
  curves        budget curves on a fine cap grid + pairwise dominance
  logcost       paired Δlog2 cost among both-green problems
  discord       3x3 discordance tables for k=2 pairs + consistency vs noise floor
  fliploc       flip location vs cost (tail solves vs low-cap flips)
  ordinal       best-state ordinal outcome, paired vs base
  shapefit      NPMLE mixture: no-effect vs uniform-shift vs jump-mixture
  irt           Rasch fit: arm ability, problem difficulty, DIF residuals
  nudges        no-nudge counterfactual, ROI, depth decay, harm, calibration
  postgreen     what agents do after the first verified solve
  spawnuse      spawn tool usage per problem
"""

import json, os, sys
import numpy as np
from collections import Counter, defaultdict
from scipy import stats as sps

HERE = os.path.dirname(os.path.abspath(__file__))
WT = os.path.dirname(HERE)
MINED = os.path.join(WT, "mined")
SEED = 20260817
rng = np.random.default_rng(SEED)
B = 4000

A = [json.loads(l) for l in open(os.path.join(MINED, "attempts.jsonl"))]
ARMS = ["base", "base r2", "grep", "grep r2", "snippet", "snippet r2",
        "snippetonly", "snippetonly r2", "semantic", "snippetfacts",
        "basequote", "spawn", "spawnfacts"]
byarm = {a: {} for a in ARMS}
for r in A:
    byarm[r["arm"]][r["problem"]] = r
PROBS = sorted(set.intersection(*[set(byarm[a]) for a in ARMS]))
N = len(PROBS)
IDX = {p: i for i, p in enumerate(PROBS)}

PAIRS = {"base": ("base", "base r2"), "grep": ("grep", "grep r2"),
         "snippet": ("snippet", "snippet r2"), "snippetonly": ("snippetonly", "snippetonly r2")}
K1 = ["semantic", "snippetfacts", "basequote", "spawn", "spawnfacts"]

def att(arm, p):
    return byarm[arm][p]

# NO-NUDGE convention (Mariam, 2026-08-18): the canonical outcome censors every
# attempt at its first supervisor nudge ("You are not done."). A green counts only
# if it predates the first nudge; post-nudge greens (10 across the grid) and
# post-nudge spend are dropped. Output-cutoff splices and transport continuations
# are NOT censoring points (they are not give-up interventions). Greens are kept
# regardless of cost (a pre-nudge green at >$1 counts as a solve; AUC integrates
# only to $1 so it contributes ~nothing there).
def nn_cost(a):
    """no-nudge first-green cost, or None if no pre-nudge green."""
    if not a["ever_green"]:
        return None
    fn = a.get("first_nudge")
    if fn is None or fn.get("green_before"):
        return a["first_green"]["cost_at"]
    return None

def green(a):        # green under the no-nudge harness
    return nn_cost(a) is not None

def gcost(a):        # no-nudge first-green cost, inf if none
    c = nn_cost(a)
    return c if c is not None else float("inf")

def green_full(a):   # full-harness ever-green (reference only)
    return bool(a["ever_green"])

# per-arm arrays
g = {a: np.array([1 if green(att(a, p)) else 0 for p in PROBS]) for a in ARMS}
fc = {a: np.array([gcost(att(a, p)) for p in PROBS]) for a in ARMS}
rows_solved = {a: np.array([1 if att(a, p)["row_solved"] else 0 for p in PROBS]) for a in ARMS}

OUT = {"meta": {"N": N, "arms": ARMS, "seed": SEED, "B": B,
                "estimand": "NO-NUDGE: green iff first green predates first supervisor "
                            "nudge; cost at that green (mined, corrected)"}}
MD = []
w = MD.append

# shared bootstrap index samples (paired over problems)
BOOT = rng.integers(0, N, size=(B, N))

def bci(vals):
    return [float(np.percentile(vals, 2.5)), float(np.percentile(vals, 97.5))]

# ------------------------------------------------------------------ grid
w("# Mined statistics — FATE-X grid, session-mined ground truth (0817)")
w("")
w(f"All numbers recomputed from raw session events ({len(A)} attempts, {N} problems, "
  f"13 cells). Estimand: **no-nudge harness** — a solve is a verified COMPLETE "
  "lean_check that predates the attempt's first supervisor nudge; cost = mined "
  "cumulative cost_std at that check (worker spend included). Post-nudge greens "
  "(10 grid-wide) and post-nudge tail spend are excluded; pre-nudge greens count "
  "at any cost. Validation: mined tokens/turns/nudges match recorded rows exactly "
  "on all 1170 attempts; mined first-green agrees with high_water except 5 resumed "
  "attempts where the recorded stamp lost pre-resume spend (mined value used).")
w("")
w("## Grid, recomputed (no-nudge)")
w("")
w("| arm | green (no-nudge) | ever-green (full) | final-solved | median green cost | spend to censor |")
w("|---|---|---|---|---|---|")
grid = {}
for a in ARMS:
    eg = int(g[a].sum())
    egf = sum(1 for p in PROBS if green_full(att(a, p)))
    fs = int(rows_solved[a].sum())
    med = float(np.median(fc[a][np.isfinite(fc[a])])) if eg else float("nan")
    spend = 0.0
    for p in PROBS:
        r = att(a, p)
        fn = r.get("first_nudge")
        spend += fn["cost_at"] if fn else r["mined_cost_total"]
    full_spend = float(sum(att(a, p)["mined_cost_total"] for p in PROBS))
    grid[a] = {"green_nn": eg, "ever_green_full": egf, "final_solved": fs,
               "median_green_cost": med, "spend_censored": spend,
               "total_spend": full_spend}
    w(f"| {a} | {eg} | {egf} | {fs} | {med:.3f} | {spend:.1f} |")
w("")
# resumed corrections detail
corr = []
for r in A:
    hwf = (r.get("hw") or {}).get("first") or {}
    if r["ever_green"] and hwf.get("solved") and hwf.get("cost_std") is not None:
        d = r["first_green"]["cost_at"] - hwf["cost_std"]
        if abs(d) > 0.005:
            corr.append({"arm": r["arm"], "problem": r["problem"],
                         "hw": hwf["cost_std"], "mined": r["first_green"]["cost_at"]})
OUT["grid"] = grid
OUT["corrections"] = corr
w("Resumed-attempt cost corrections (recorded high_water understates — pre-resume "
  "spend was dropped by the in-process counter):")
w("")
for c in corr:
    w(f"- {c['arm']}/{c['problem']}: recorded ${c['hw']:.3f} → true ${c['mined']:.3f}")
w("")

# ------------------------------------------------------------------ AUC
w("## AUC — exact definition and recomputation")
w("")
w("AUC here is the area under the solve-count-vs-cap curve on caps c ∈ [0, $1]:")
w("")
w("    AUC = ∫₀¹ S(c) dc,   S(c) = #{problems whose first green cost ≤ c}")
w("")
w("S is a step function that jumps +1 at each first-green cost cᵢ, so the integral")
w("collapses to AUC = Σ_{solves with cᵢ ≤ 1} (1 − cᵢ). Units are solve-dollars:")
w("each solve contributes the length of the cap interval on which it counts as")
w("solved. Equivalently AUC/N is the expected solve rate under a budget drawn")
w("uniformly from [0,$1], and AUC = RMST at the $1 horizon in survival terms")
w("(restricted mean 'solved time' with cost as the clock). It rewards both *more*")
w("solves and *earlier* solves; a solve at $0.95 adds almost nothing.")
w("")
auc_tab = {}
w("| arm | AUC (mined) [boot 95%] | AUC/N | AUC (recorded hw) | Δ from corrections |")
w("|---|---|---|---|---|")
for a in ARMS:
    v = np.where(np.isfinite(fc[a]) & (fc[a] <= 1), 1 - fc[a], 0.0)
    auc = float(v.sum())
    bs = v[BOOT].sum(axis=1)
    lo, hi = bci(bs)
    # recorded-hw version
    hw = []
    for p in PROBS:
        f = (att(a, p).get("hw") or {}).get("first") or {}
        hw.append(1 - f["cost_std"] if (f.get("solved") and f.get("cost_std", 9) <= 1) else 0.0)
    auc_hw = float(np.sum(hw))
    auc_tab[a] = {"auc": auc, "ci": [lo, hi], "auc_hw": auc_hw, "boot": None}
    w(f"| {a} | {auc:.2f} [{lo:.2f}, {hi:.2f}] | {auc/N:.3f} | {auc_hw:.2f} | {auc - auc_hw:+.2f} |")
w("")
OUT["auc"] = auc_tab

# pooled-pair AUC and deltas vs base pair
def pair_v(pair):
    a1, a2 = PAIRS[pair]
    v1 = np.where(np.isfinite(fc[a1]) & (fc[a1] <= 1), 1 - fc[a1], 0.0)
    v2 = np.where(np.isfinite(fc[a2]) & (fc[a2] <= 1), 1 - fc[a2], 0.0)
    return (v1 + v2) / 2
w("### ΔAUC vs base (k=2 pairs pooled; k=1 arms vs base pair), paired bootstrap")
w("")
w("| contrast | ΔAUC | boot 95% | verdict at 95% |")
w("|---|---|---|---|")
vb = pair_v("base")
dauc = {}
for name in ["grep", "snippet", "snippetonly"]:
    v = pair_v(name)
    d = v - vb
    dboot = d[BOOT].sum(axis=1)
    lo, hi = bci(dboot)
    dauc[f"{name} k2"] = {"d": float(d.sum()), "ci": [lo, hi]}
    verdict = "excludes 0" if lo > 0 or hi < 0 else "unresolved"
    w(f"| {name} (k2) − base (k2) | {d.sum():+.2f} | [{lo:+.2f}, {hi:+.2f}] | {verdict} |")
for a in K1:
    v = np.where(np.isfinite(fc[a]) & (fc[a] <= 1), 1 - fc[a], 0.0)
    d = v - vb
    dboot = d[BOOT].sum(axis=1)
    lo, hi = bci(dboot)
    dauc[a] = {"d": float(d.sum()), "ci": [lo, hi]}
    verdict = "excludes 0" if lo > 0 or hi < 0 else "unresolved"
    w(f"| {a} (k1) − base (k2) | {d.sum():+.2f} | [{lo:+.2f}, {hi:+.2f}] | {verdict} |")
w("")
OUT["dauc"] = dauc

# ------------------------------------------------------------------ curves + dominance
CAPG = np.round(np.arange(0.05, 1.0001, 0.05), 2)
curves = {}
for a in ARMS:
    curves[a] = [int((fc[a] <= c).sum()) for c in CAPG]
OUT["curves"] = {"caps": CAPG.tolist(), "arms": curves}

w("## Budget curves and dominance")
w("")
w("Solves-by-cap on a $0.05 grid (mined first-green costs). Dominance verdicts per")
w("contrast: at which caps does the paired bootstrap 95% CI of Δ exclude 0.")
w("")
dom = {}
contrasts = [("snippet k2", pair_v("snippet"), "base k2", vb),
             ("grep k2", pair_v("grep"), "base k2", vb),
             ("snippetonly k2", pair_v("snippetonly"), "base k2", vb),
             ("snippet k2", pair_v("snippet"), "grep k2", pair_v("grep"))]
# for cap curves need indicator at caps, not 1-c values — rebuild per cap
def cap_ind(arm_pair, c):
    if arm_pair in PAIRS:
        a1, a2 = PAIRS[arm_pair]
        return ((fc[a1] <= c).astype(float) + (fc[a2] <= c).astype(float)) / 2
    return (fc[arm_pair] <= c).astype(float)
for la, _, lb, _ in contrasts:
    aa, bb_ = la.replace(" k2", ""), lb.replace(" k2", "")
    sig_caps, deltas = [], []
    for c in CAPG:
        d = cap_ind(aa, float(c)) - cap_ind(bb_, float(c))
        dboot = d[BOOT].sum(axis=1)
        lo, hi = bci(dboot)
        deltas.append([float(c), float(d.sum()), lo, hi])
        if lo > 0 or hi < 0:
            sig_caps.append(float(c))
    dom[f"{la} vs {lb}"] = {"deltas": deltas, "sig_caps": sig_caps}
    w(f"- **{la} vs {lb}**: Δ significant at caps {sig_caps if sig_caps else 'none'}; "
      f"Δ@$0.25 = {deltas[4][1]:+.1f}, Δ@$0.50 = {deltas[9][1]:+.1f}, Δ@$1 = {deltas[-1][1]:+.1f}")
w("")
for a in K1:
    sig_caps, deltas = [], []
    for c in CAPG:
        d = cap_ind(a, float(c)) - cap_ind("base", float(c))
        dboot = d[BOOT].sum(axis=1)
        lo, hi = bci(dboot)
        deltas.append([float(c), float(d.sum()), lo, hi])
        if lo > 0 or hi < 0:
            sig_caps.append(float(c))
    dom[f"{a} vs base k2"] = {"deltas": deltas, "sig_caps": sig_caps}
    w(f"- **{a} (k1) vs base (k2)**: significant caps {sig_caps if sig_caps else 'none'}; "
      f"Δ@$0.25 = {deltas[4][1]:+.1f}, Δ@$0.50 = {deltas[9][1]:+.1f}, Δ@$1 = {deltas[-1][1]:+.1f}")
w("")
OUT["dominance"] = dom

# ------------------------------------------------------------------ paired log-cost
w("## Are problems getting cheaper? Paired Δlog₂ first-green cost")
w("")
w("Among problems green in BOTH arms of a contrast (k=2 arms: green in ≥1 replicate; "
  "cost = mean over green replicates of log₂ cost). Median Δlog₂ with bootstrap CI, "
  "Wilcoxon signed-rank p, and the sign-test fraction cheaper. Heavy-tail-safe: a "
  "−1.0 means 2× cheaper on the median problem.")
w("")
def arm_logc(name):
    """log2 cost per problem (nan if no green); k=2: mean over green replicates."""
    if name in PAIRS:
        a1, a2 = PAIRS[name]
        out = np.full(N, np.nan)
        for i in range(N):
            vals = [np.log2(fc[a][i]) for a in (a1, a2) if np.isfinite(fc[a][i])]
            if vals:
                out[i] = np.mean(vals)
        return out
    v = np.where(np.isfinite(fc[name]), fc[name], np.nan)
    return np.log2(v)
w("| contrast | n both-green | median Δlog₂ [boot 95%] | cheaper on m/n | Wilcoxon p | sign p |")
w("|---|---|---|---|---|---|")
logc = {}
base_lc = arm_logc("base")
for name in ["grep", "snippet", "snippetonly"] + K1:
    lc = arm_logc(name)
    both = ~np.isnan(lc) & ~np.isnan(base_lc)
    d = lc[both] - base_lc[both]
    n = int(both.sum())
    if n < 5:
        continue
    med = float(np.median(d))
    boots = [float(np.median(rng.choice(d, size=n))) for _ in range(1000)]
    lo, hi = bci(boots)
    wstat = sps.wilcoxon(d) if n >= 10 else None
    nz = d[d != 0]
    cheaper = int((nz < 0).sum())
    sp = sps.binomtest(cheaper, len(nz), 0.5).pvalue if len(nz) else 1.0
    logc[name] = {"n": n, "median_dlog2": med, "ci": [lo, hi],
                  "cheaper": cheaper, "nz": len(nz),
                  "wilcoxon_p": float(wstat.pvalue) if wstat else None, "sign_p": float(sp),
                  "deltas": d.tolist()}
    w(f"| {name} vs base | {n} | {med:+.2f} [{lo:+.2f}, {hi:+.2f}] | {cheaper}/{len(nz)} | "
      f"{wstat.pvalue:.3g} | {sp:.3g} |")
w("")
OUT["logcost"] = logc

# ------------------------------------------------------------------ discordance 3x3
w("## Shape of the effect: 3×3 discordance tables (k=2 vs k=2)")
w("")
w("Rows = solves in the left pair (0/1/2), cols = right pair. Under 'few problems "
  "genuinely jump', gains concentrate in the (0,2) corner (gained AND replicated); "
  "under 'small uniform shift', gains sit at 1 like replicate noise. The noise "
  "benchmark: within-pair replicate flips.")
w("")
def pair_counts(name):
    a1, a2 = PAIRS[name]
    return g[a1] + g[a2]
disc = {}
noise = {}
for name in PAIRS:
    x = pair_counts(name)
    a1, a2 = PAIRS[name]
    flips = int((g[a1] != g[a2]).sum())
    noise[name] = flips
w("Within-pair replicate flips (noise floor): " +
  ", ".join(f"{k}: {v}/90" for k, v in noise.items()))
w("")
OUT["noise_flips"] = noise
k2pairs = [("base", "snippet"), ("base", "grep"), ("base", "snippetonly"),
           ("grep", "snippet"), ("snippet", "snippetonly"), ("grep", "snippetonly")]
for la, lb in k2pairs:
    xa, xb = pair_counts(la), pair_counts(lb)
    tab = np.zeros((3, 3), dtype=int)
    for i in range(N):
        tab[xa[i], xb[i]] += 1
    gains = [(i_, j_) for i_ in range(3) for j_ in range(3) if j_ > i_]
    strict_gain = int(tab[0, 2])
    soft_gain = int(tab[0, 1] + tab[1, 2])
    strict_loss = int(tab[2, 0])
    soft_loss = int(tab[1, 0] + tab[2, 1])
    # consistency of gains: among problems where right>left and left==0:
    gained = [i for i in range(N) if xa[i] == 0 and xb[i] > 0]
    consistent = sum(1 for i in gained if xb[i] == 2)
    disc[f"{la}->{lb}"] = {"table": tab.tolist(), "strict_gain": strict_gain,
                           "soft_gain": soft_gain, "strict_loss": strict_loss,
                           "soft_loss": soft_loss,
                           "gained0": len(gained), "gained0_consistent": consistent}
    w(f"**{la} → {lb}**  (rows {la} 0/1/2, cols {lb} 0/1/2)")
    w("")
    w("```")
    for i_ in range(3):
        w("  " + "  ".join(f"{tab[i_, j_]:3d}" for j_ in range(3)))
    w("```")
    w(f"strict gains (0→2): {strict_gain}, soft gains (0→1,1→2): {soft_gain}; "
      f"strict losses (2→0): {strict_loss}, soft losses: {soft_loss}. "
      f"Of {len(gained)} problems gained from 0: {consistent} replicated (x=2).")
    w("")
OUT["discordance"] = disc

# ------------------------------------------------------------------ flip location vs cost
w("## Where do flips live on the cost axis?")
w("")
w("For each contrast: problems solved by one side only — at what cost did the "
  "solving side go green? Flips whose green sits near the $1 cap are 'tail solves' "
  "(the losing side plausibly just ran out of budget — noise-like); flips green at "
  "low cost are genuine capability differences. Benchmark row: within-pair replicate "
  "noise flips.")
w("")
def flip_costs(sa, sb):
    """problems green in a (any replicate if pair) but not in b at all -> green costs in a"""
    def pg(name):
        if name in PAIRS:
            a1, a2 = PAIRS[name]
            return np.minimum(fc[a1], fc[a2])  # earliest green across replicates
        return fc[name]
    ca, cb = pg(sa), pg(sb)
    out = [float(ca[i]) for i in range(N) if np.isfinite(ca[i]) and not np.isfinite(cb[i])]
    return sorted(out)
fliploc = {}
rows_fl = [("base", "snippet"), ("base", "grep"), ("base", "snippetonly"),
           ("base", "spawn"), ("base", "spawnfacts"), ("base", "basequote"),
           ("base", "snippetfacts"), ("base", "semantic"),
           ("grep", "snippet"), ("snippet", "spawnfacts")]
w("| contrast | gained by right (n) | median green cost | >$0.50 share | lost by right (n) | median | noise? |")
w("|---|---|---|---|---|---|---|")
for la, lb in rows_fl:
    gained = flip_costs(lb, la)   # right solves, left doesn't
    lostc = flip_costs(la, lb)
    def s(v):
        return f"{np.median(v):.2f}" if v else "—"
    def hi_share(v):
        return f"{np.mean([x > 0.5 for x in v]):.0%}" if v else "—"
    fliploc[f"{la}->{lb}"] = {"gained_costs": gained, "lost_costs": lostc}
    w(f"| {la} → {lb} | {len(gained)} | {s(gained)} | {hi_share(gained)} | "
      f"{len(lostc)} | {s(lostc)} | |")
# noise benchmark: within-pair flips
noise_costs = []
for name in PAIRS:
    a1, a2 = PAIRS[name]
    for i in range(N):
        if g[a1][i] != g[a2][i]:
            c = fc[a1][i] if g[a1][i] else fc[a2][i]
            noise_costs.append(float(c))
noise_costs.sort()
fliploc["noise"] = {"costs": noise_costs}
w(f"| **replicate noise flips (pooled)** | {len(noise_costs)} | {np.median(noise_costs):.2f} | "
  f"{np.mean([x > 0.5 for x in noise_costs]):.0%} | | | ← benchmark |")
w("")
OUT["fliploc"] = fliploc

# ------------------------------------------------------------------ ordinal best-state
w("## Ordinal progress (exploratory, scale fixed before computing)")
w("")
w("Best state reached per attempt: 3 = green; 2 = compiles with only sorries "
  "(INCOMPLETE); 1 = parses but errors (FAILED); 0 = never better than "
  "statement-modified / policy / no check. k=2 arms: mean of replicates.")
w("")
def best_state(a):
    if nn_cost(a) is not None:
        return 3
    fn = a.get("first_nudge")
    cutoff = fn["cost_at"] if fn else float("inf")
    stat = set(c[3] for c in a["traj"] if c[0] <= cutoff)
    if "I" in stat:
        return 2
    if "F" in stat:
        return 1
    return 0
bs_arm = {}
for a in ARMS:
    bs_arm[a] = np.array([best_state(att(a, p)) for p in PROBS])
def pool_bs(name):
    if name in PAIRS:
        a1, a2 = PAIRS[name]
        return (bs_arm[a1] + bs_arm[a2]) / 2
    return bs_arm[name].astype(float)
w("| contrast | mean Δstate | Wilcoxon p | state histogram (0/1/2/3, right arm r1) |")
w("|---|---|---|---|")
ordinal = {}
bb = pool_bs("base")
for name in ["grep", "snippet", "snippetonly"] + K1:
    v = pool_bs(name)
    d = v - bb
    nz = d[d != 0]
    try:
        p = float(sps.wilcoxon(nz).pvalue) if len(nz) >= 10 else float("nan")
    except ValueError:
        p = float("nan")
    r1 = name if name not in PAIRS else PAIRS[name][0]
    hist = np.bincount(bs_arm[r1], minlength=4).tolist()
    ordinal[name] = {"mean_d": float(d.mean()), "p": p, "hist_r1": hist}
    w(f"| {name} vs base | {d.mean():+.2f} | {p:.3g} | {hist} |")
w("")
OUT["ordinal"] = ordinal

# ------------------------------------------------------------------ shape fit (NPMLE mixtures)
w("## Distribution-level shape fit (k=2 pairs)")
w("")
w("For each contrast of k=2 pairs, fit by maximum likelihood over paired counts "
  "(x_A, x_B) ∈ {0,1,2}²: (i) NULL — same π per problem, x~Bin(2,π), π from a "
  "nonparametric mixture on a grid; (ii) SHIFT — π_B = σ(σ⁻¹(π_A)+β), one β for all "
  "problems; (iii) JUMP — a fraction ρ of problems flips to π_B = π*, the rest keep "
  "π_A. AIC compares (parameters: mixture weights shared; +1 for β; +2 for ρ,π*). "
  "k=2 per arm is thin — treat as evidence direction, not a verdict.")
w("")
GRID = np.linspace(0.02, 0.98, 25)
from scipy.special import expit, logit as slogit
def bin2(k, p):
    """Bin(2,p) pmf, vectorized over p (k scalar array-compatible)."""
    k = np.asarray(k)[..., None]
    return np.where(k == 0, (1 - p) ** 2, np.where(k == 1, 2 * p * (1 - p), p ** 2))
def npmle_ll(xa, xb, mode, params, iters=200):
    """EM over mixture weights only — likelihood matrix is constant per params."""
    pa = bin2(xa, GRID)                      # n x grid
    if mode == "null":
        pb = bin2(xb, GRID)
    elif mode == "shift":
        pg = expit(slogit(GRID) + params[0])
        pb = bin2(xb, pg)
    else:
        rho, pstar = params
        pb = (1 - rho) * bin2(xb, GRID) + rho * bin2(xb, np.full_like(GRID, pstar))
    L = pa * pb                              # n x grid
    Wt = np.ones(len(GRID)) / len(GRID)
    for _ in range(iters):
        post = Wt * L
        post /= np.maximum(post.sum(axis=1, keepdims=True), 1e-300)
        Wt = post.mean(axis=0)
    return float(np.sum(np.log(np.maximum((Wt * L).sum(axis=1), 1e-300))))
def npmle_fit(xa, xb, mode, iters=200):
    if mode == "null":
        return npmle_ll(xa, xb, "null", (), iters), ()
    if mode == "shift":
        best = (-1e18, None)
        for beta in np.linspace(-2.5, 2.5, 41):
            ll = npmle_ll(xa, xb, "shift", (beta,), iters)
            if ll > best[0]:
                best = (ll, (float(beta),))
        return best
    best = (-1e18, None)
    for rho in [0.02, 0.05, 0.08, 0.12, 0.18, 0.25, 0.35]:
        for pstar in [0.5, 0.65, 0.8, 0.9, 0.97]:
            ll = npmle_ll(xa, xb, "jump", (rho, pstar), iters)
            if ll > best[0]:
                best = (ll, (float(rho), float(pstar)))
    return best
shapefit = {}
w("| contrast | LL null | LL shift (β̂) | LL jump (ρ̂, π*) | AIC winner |")
w("|---|---|---|---|---|")
for la, lb in [("base", "snippet"), ("base", "grep"), ("base", "snippetonly"), ("grep", "snippet")]:
    xa, xb = pair_counts(la), pair_counts(lb)
    ll0, _ = npmle_fit(xa, xb, "null", iters=120)
    lls, ps = npmle_fit(xa, xb, "shift", iters=60)
    llj, pj = npmle_fit(xa, xb, "jump", iters=60)
    aics = {"null": 2 * 0 - 2 * ll0, "shift": 2 * 1 - 2 * lls, "jump": 2 * 2 - 2 * llj}
    win = min(aics, key=aics.get)
    shapefit[f"{la}->{lb}"] = {"ll_null": ll0, "ll_shift": lls, "beta": ps,
                               "ll_jump": llj, "jump_params": pj, "aic": aics, "winner": win}
    w(f"| {la} → {lb} | {ll0:.1f} | {lls:.1f} (β={ps[0]:+.2f}) | {llj:.1f} "
      f"(ρ={pj[0]:.2f}, π*={pj[1]:.2f}) | **{win}** |")
w("")
OUT["shapefit"] = shapefit

# ------------------------------------------------------------------ IRT / Rasch
w("## Rasch (IRT) fit over all 13 cells")
w("")
w("Model: P(attempt on problem i in cell j is green) = σ(θ_j − b_i), fitted by "
  "penalized MLE (ridge λ=0.05 on both parameter sets to keep never/always-solved "
  "problems finite), identification: mean(θ)=0. Cells = 13 runs (replicates enter "
  "as separate cells; their θ̂ gap is a noise readout). DIF: Pearson residuals of "
  "cell×problem outcomes vs fit; parametric bootstrap for the max-residual null.")
w("")
Y = np.array([[1 if green(att(a, p)) else 0 for p in PROBS] for a in ARMS])  # J x N
J = len(ARMS)
theta = np.zeros(J)
b = np.zeros(N)
lam = 0.05
for it in range(500):
    eta = theta[:, None] - b[None, :]
    p_ = 1 / (1 + np.exp(-eta))
    gth = (Y - p_).sum(axis=1) - lam * theta
    gb = -(Y - p_).sum(axis=0) - lam * b
    wj = (p_ * (1 - p_)).sum(axis=1) + lam
    wi = (p_ * (1 - p_)).sum(axis=0) + lam
    theta += gth / wj
    b += gb / wi
    theta -= theta.mean()
eta = theta[:, None] - b[None, :]
p_ = 1 / (1 + np.exp(-eta))
resid = (Y - p_) / np.sqrt(np.maximum(p_ * (1 - p_), 1e-9))
ll_fit = float((Y * np.log(np.maximum(p_, 1e-12)) + (1 - Y) * np.log(np.maximum(1 - p_, 1e-12))).sum())
# parametric bootstrap for max |resid|
maxr_obs = float(np.abs(resid).max())
maxr_null = []
for _ in range(200):
    Ysim = (rng.random(p_.shape) < p_).astype(int)
    th2, b2 = theta.copy(), b.copy()
    for it in range(80):
        e2 = th2[:, None] - b2[None, :]
        q = 1 / (1 + np.exp(-e2))
        th2 += ((Ysim - q).sum(axis=1) - lam * th2) / ((q * (1 - q)).sum(axis=1) + lam)
        b2 += (-(Ysim - q).sum(axis=0) - lam * b2) / ((q * (1 - q)).sum(axis=0) + lam)
        th2 -= th2.mean()
    e2 = th2[:, None] - b2[None, :]
    q = 1 / (1 + np.exp(-e2))
    r2 = (Ysim - q) / np.sqrt(np.maximum(q * (1 - q), 1e-9))
    maxr_null.append(float(np.abs(r2).max()))
p_dif = float(np.mean([m >= maxr_obs for m in maxr_null]))
se_theta = 1 / np.sqrt((p_ * (1 - p_)).sum(axis=1) + lam)
w("| cell | θ̂ (ability) | SE | ever-green |")
w("|---|---|---|---|")
order = np.argsort(-theta)
for j in order:
    w(f"| {ARMS[j]} | {theta[j]:+.2f} | {se_theta[j]:.2f} | {int(Y[j].sum())} |")
w("")
w(f"Replicate θ̂ gaps (pure noise in ability units): "
  + ", ".join(f"{a}−{b_}: {theta[ARMS.index(a)]-theta[ARMS.index(b_)]:+.2f}"
              for a, b_ in [("base", "base r2"), ("grep", "grep r2"),
                            ("snippet", "snippet r2"), ("snippetonly", "snippetonly r2")]))
w("")
w(f"DIF test: max |Pearson residual| = {maxr_obs:.2f}; parametric-bootstrap null "
  f"P(max ≥ obs) = {p_dif:.2f} (200 sims). Individual cells with |resid| > 2.5:")
w("")
hot = []
for j in range(J):
    for i in range(N):
        if abs(resid[j, i]) > 2.5:
            hot.append((ARMS[j], PROBS[i], float(resid[j, i]), int(Y[j, i]), float(p_[j, i])))
for h in sorted(hot, key=lambda x: -abs(x[2]))[:20]:
    w(f"- {h[0]} × {h[1]}: resid {h[2]:+.2f} (outcome {h[3]}, fitted π {h[4]:.2f})")
w("")
OUT["irt"] = {"arms": ARMS, "theta": theta.tolist(), "se_theta": se_theta.tolist(),
              "b": b.tolist(), "problems": PROBS, "max_resid": maxr_obs,
              "p_dif": p_dif, "hot": hot, "ll": ll_fit}

# difficulty vs empirical solve counts sanity
tot_solve = Y.sum(axis=0)
r_corr = float(np.corrcoef(-b, tot_solve)[0, 1])
w(f"Sanity: corr(−b̂, total solves across cells) = {r_corr:.3f}.")
w("")

# ------------------------------------------------------------------ nudges
w("## Nudges and give-ups")
w("")
nud = {}
w("### The no-nudge counterfactual")
w("")
w("Censor each attempt at its first supervisor nudge ('You are not done.'): would "
  "the green have happened anyway? green_before = first green strictly before the "
  "first nudge. Upper-bound framing: a model that was ALLOWED to stop might have "
  "stopped even earlier elsewhere; and the system prompt says 'do not stop until "
  "COMPLETE' throughout, so this censors harness pressure only partially.")
w("")
w("| arm | greens | green before 1st nudge | attempts nudged | conversions (green after 1st nudge) | spend after 1st nudge | $ / converted solve |")
w("|---|---|---|---|---|---|---|")
for a in ARMS:
    rows = [att(a, p) for p in PROBS]
    greens = sum(1 for r in rows if r["ever_green"])
    nudged = [r for r in rows if r["n_nudges"] > 0]
    conv = 0
    pre = 0
    spend_after = 0.0
    for r in rows:
        if r["n_nudges"] == 0:
            if r["ever_green"]:
                pre += 1
            continue
        fn = r["first_nudge"]
        if r["ever_green"]:
            if fn["green_before"]:
                pre += 1
            else:
                conv += 1
        spend_after += max(0.0, r["mined_cost_total"] - fn["cost_at"])
    cps = spend_after / conv if conv else float("nan")
    nud[a] = {"greens": greens, "green_pre_nudge": pre, "n_nudged": len(nudged),
              "conversions": conv, "spend_after": spend_after, "cost_per_conv": cps}
    w(f"| {a} | {greens} | {pre} | {len(nudged)} | {conv} | ${spend_after:.1f} | "
      f"{'$%.1f' % cps if conv else '—'} |")
w("")
OUT["nudges"] = nud

# conversion depth: for converted attempts, nudges before green
depth = Counter()
depth_tot = Counter()
for r in A:
    if r["n_nudges"] == 0:
        continue
    evs = [u for u in r["nudge_events"] if u["class"] == "nudge"]
    gts = r["first_green"]["ts"] if r["ever_green"] else None
    if gts and r["first_nudge"] and not r["first_nudge"]["green_before"]:
        nbefore = sum(1 for u in evs if u["ts"] < gts)
        depth[min(nbefore, 10)] += 1
for r in A:
    evs = [u for u in r["nudge_events"] if u["class"] == "nudge"]
    depth_tot[min(len(evs), 10)] += 1 if evs else 0
w("### Conversion depth")
w("")
w("Among nudge-converted greens (all arms pooled): number of nudges received before "
  "the green. 10 = '10 or more'.")
w("")
w("| nudges before green | " + " | ".join(str(k) for k in sorted(depth)) + " |")
w("|---" * (len(depth) + 1) + "|")
w("| conversions | " + " | ".join(str(depth[k]) for k in sorted(depth)) + " |")
w("")
OUT["nudge_depth"] = {str(k): depth[k] for k in sorted(depth)}

# nudge harm: wrecks after nudges
harm = []
for r in A:
    pg_ = r.get("post_green")
    if pg_ and pg_["nudges_after"] > 0 and pg_["wrecked_final"]:
        harm.append(f'{r["arm"]}/{r["problem"]}')
w(f"### Harm: attempts nudged after their green that ended wrecked: "
  f"{len(harm)} ({', '.join(harm) if harm else 'none'})")
w("")
OUT["nudge_harm"] = harm

# give-up calibration
w("### Give-up calibration")
w("")
w("Unsolved attempts: 'gave up' (end=completed — supervisor let it stop after "
  "MAX_NUDGES consecutive no-progress turns) vs 'ran to cap' (budget_exceeded). "
  "Compare their last check state and budget left.")
w("")
def unsolved_rows(kind):
    out = []
    for r in A:
        if r["ever_green"]:
            continue
        if kind == "gaveup" and r["row_end"] == "completed":
            out.append(r)
        if kind == "cap" and r["row_end"] == "budget_exceeded":
            out.append(r)
    return out
gu, cap_ = unsolved_rows("gaveup"), unsolved_rows("cap")
def state_hist(rows):
    h = Counter()
    for r in rows:
        s = r.get("last_check_status") or "-"
        h[s] += 1
    return dict(h)
w(f"- gave up: n={len(gu)}, median budget left "
  f"${np.median([1 - r['mined_cost_total'] for r in gu]):.2f}, last-check states {state_hist(gu)}")
w(f"- ran to cap: n={len(cap_)}, last-check states {state_hist(cap_)}")
sorries_gu = [r["last_check_sorries"] for r in gu if r.get("last_check_status") == "I"]
sorries_cap = [r["last_check_sorries"] for r in cap_ if r.get("last_check_status") == "I"]
w(f"- among INCOMPLETE enders: median sorries at give-up "
  f"{np.median(sorries_gu) if sorries_gu else float('nan'):.0f} vs at cap "
  f"{np.median(sorries_cap) if sorries_cap else float('nan'):.0f}")
w("")
OUT["giveup"] = {"gaveup_n": len(gu), "cap_n": len(cap_),
                 "gaveup_states": state_hist(gu), "cap_states": state_hist(cap_),
                 "gaveup_budget_left": [round(1 - r["mined_cost_total"], 3) for r in gu]}

# ------------------------------------------------------------------ post-green
w("## After the first verified solve: do agents simplify/refactor?")
w("")
pg_tab = {}
w("| arm | greens | any activity after | checks after (med) | cost after (med) | file changed at end | wrecked at end | re-greened |")
w("|---|---|---|---|---|---|---|---|")
for a in ARMS:
    rows = [att(a, p) for p in PROBS if att(a, p)["ever_green"]]
    P_ = [r["post_green"] for r in rows if r.get("post_green")]
    if not P_:
        continue
    act = sum(1 for x in P_ if x["checks_after"] > 0 or x["turns_after"] > 1)
    med_ck = float(np.median([x["checks_after"] for x in P_]))
    med_cost = float(np.median([x["cost_after"] for x in P_]))
    changed = sum(1 for x in P_ if x["final_differs"])
    wreck = sum(1 for x in P_ if x["wrecked_final"])
    regr = sum(1 for x in P_ if x["final_differs"] and not x["wrecked_final"] and x["checks_after"] > 0)
    pg_tab[a] = {"greens": len(P_), "active_after": act, "med_checks_after": med_ck,
                 "med_cost_after": med_cost, "changed": changed, "wrecked": wreck,
                 "regreened_changed": regr,
                 "cost_after_all": [x["cost_after"] for x in P_]}
    w(f"| {a} | {len(P_)} | {act} | {med_ck:.0f} | ${med_cost:.3f} | {changed} | {wreck} | {regr} |")
w("")
OUT["postgreen"] = pg_tab

# ------------------------------------------------------------------ spawn usage
w("## Spawn usage per problem")
w("")
sp_use = {}
for a in ["spawn", "spawnfacts"]:
    per = []
    for p in PROBS:
        r = att(a, p)
        calls = r.get("spawn_calls") or []
        per.append({"problem": p, "n_calls": len(calls),
                    "n_tasks": sum(c["n_tasks"] for c in calls),
                    "first_call_cost": calls[0]["cost_at"] if calls else None,
                    "n_workers": r["n_workers"],
                    "worker_cost": round(sum(w_["cost_std"] for w_ in r["workers"]), 4) if r["workers"] else 0,
                    "green": r["ever_green"], "b": float(b[IDX[p]])})
    used = [x for x in per if x["n_calls"] > 0]
    sp_use[a] = per
    w(f"**{a}**: {len(used)}/90 attempts ever spawned; "
      f"{sum(x['n_workers'] for x in per)} workers total; "
      f"worker spend ${sum(x['worker_cost'] for x in per):.2f} of "
      f"${grid[a]['total_spend']:.1f} total.")
    if used:
        used_b = [x["b"] for x in used]
        unused_b = [x["b"] for x in per if x["n_calls"] == 0]
        w(f"Median difficulty b̂ of spawned problems {np.median(used_b):+.2f} vs "
          f"not-spawned {np.median(unused_b):+.2f} "
          f"(Mann-Whitney p={sps.mannwhitneyu(used_b, unused_b).pvalue:.3g}).")
        w(f"Greens among spawned: {sum(1 for x in used if x['green'])}/{len(used)}; "
          f"first spawn call at median ${np.median([x['first_call_cost'] for x in used]):.2f} in.")
    w("")
OUT["spawn_use"] = sp_use

# tool mix per arm (mined)
tools_arm = {}
for a in ARMS:
    c = Counter()
    for p in PROBS:
        c.update(att(a, p)["tools"])
    tools_arm[a] = dict(c)
OUT["tools"] = tools_arm

# behavioural extras: check cadence + stuck loops + noop checks
w("## Behavioural metrics (exploratory family, FDR within this table)")
w("")
beh = {}
w("| arm | med checks | med $/check gap | max same-error streak (med) | noop checks/attempt | truncations | compactions |")
w("|---|---|---|---|---|---|---|")
for a in ARMS:
    rows = [att(a, p) for p in PROBS]
    ncks = [r["n_checks"] for r in rows]
    gaps = []
    for r in rows:
        cs = [t[0] for t in r["traj"]]
        gaps += list(np.diff(cs)) if len(cs) > 1 else []
    streaks = [r["max_fp_streak"] for r in rows]
    noop = float(np.mean([r["n_noop_checks"] for r in rows]))
    trunc = sum(r["truncations"] for r in rows)
    comp = sum(r["compactions"] for r in rows)
    beh[a] = {"med_checks": float(np.median(ncks)), "med_gap": float(np.median(gaps)) if gaps else None,
              "med_streak": float(np.median(streaks)), "noop_per_attempt": noop,
              "truncations": trunc, "compactions": comp}
    w(f"| {a} | {np.median(ncks):.0f} | {np.median(gaps) if gaps else float('nan'):.4f} | "
      f"{np.median(streaks):.0f} | {noop:.1f} | {trunc} | {comp} |")
w("")
OUT["behaviour"] = beh

w("## Notes, caveats, provenance")
w("")
w("- **Estimand edge case**: grep r2/fatex_47 fixed its final compile error after "
  "its last lean_check and hit the cap before re-checking; the grader passed the "
  "final file. It is final-solved but never-green — counted 0 here (would add "
  "≤0.002 AUC). The only such case in 1170 attempts.")
w("- **Resumed attempts** (402 outage / context-wall): recorded high_water cost "
  "stamps lost pre-resume spend on 5 solved attempts (corrected above, largest "
  "$0.06→$0.94). Published PAPER-STATS AUC/budget-curve numbers for snippetonly r2, "
  "snippetonly, semantic are slightly optimistic for the same reason.")
w("- **Ordinal + behavioural caveat for spawn arms**: the main-session check "
  "trajectory understates progress where work happens inside workers (spawnfacts "
  "median 2 main-session checks); the state-0 excess for spawnfacts in the ordinal "
  "table is a measurement artifact, not regression.")
w("- **Exploratory labels**: discordance/flip-location/ordinal/shape-fit/IRT-DIF, "
  "nudge and post-green sections were specified 2026-08-17 after the data existed — "
  "all exploratory. Confirmatory endpoints remain those pre-registered in "
  "COMPARE.md (paired solve contrasts, AUC, cost sign tests for block B+).")
w("- **Multiplicity**: the behavioural table and flip tables are descriptive; no "
  "p-values are quoted there. Where p-values appear (Δlog₂ cost, ordinal) treat "
  "the family as exploratory; the Δlog₂ result survives any correction "
  "(all six tool arms p<0.01, same direction).")
w("- **Nudge counterfactual** is an upper bound on nudge value: the prompt already "
  "says 'do not stop until COMPLETE', so behaviour under a true stop-allowed "
  "harness could differ from censoring at the first nudge.")
w("- **No-nudge default (0818)**: all solve/cost endpoints above use the no-nudge "
  "censoring. The nudge and post-green sections intentionally use the full harness "
  "data (they analyse what the censoring removes). The behavioural table describes "
  "the harness as actually run (uncensored).")
w("- Figures: figs-0817/fig1..fig7. Machine-readable numbers: mined/analysis.json; "
  "per-attempt ground truth: mined/attempts.jsonl (validation in mined/validation.json); "
  "no-nudge outcome map: results/nn-outcomes-0817.json (consumed by paper-stats.py).")
w("")
# export the no-nudge outcome map for paper-stats.py (cost at pre-nudge green, else None)
nnmap = {a: {p: nn_cost(att(a, p)) for p in PROBS} for a in ARMS}
json.dump(nnmap, open(os.path.join(MINED, "nn-outcomes.json"), "w"))
json.dump(nnmap, open("/home/mariam/CMP/results/nn-outcomes-0817.json", "w"))
json.dump(OUT, open(os.path.join(MINED, "analysis.json"), "w"))
open(os.path.join(WT, "drafts", "MINED-STATS-0817.md"), "w").write("\n".join(MD) + "\n")
print(f"wrote {os.path.join(WT, 'drafts', 'MINED-STATS-0817.md')} and mined/analysis.json")
