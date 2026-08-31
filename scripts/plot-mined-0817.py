#!/usr/bin/env python3
"""Figures for the mined analysis (0817). Reads mined/analysis.json +
mined/attempts.jsonl, writes PNGs to figs-0817/.

Palette: dataviz reference instance, light mode, categorical slots in fixed
order (validated: adjacent CVD >= 8; aqua/yellow carry direct labels)."""

import json, os
import numpy as np
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt

HERE = os.path.dirname(os.path.abspath(__file__))
WT = os.path.dirname(HERE)
FIG = os.path.join(WT, "figs-0817")
os.makedirs(FIG, exist_ok=True)
AN = json.load(open(os.path.join(WT, "mined", "analysis.json")))
A = [json.loads(l) for l in open(os.path.join(WT, "mined", "attempts.jsonl"))]

# palette roles
S1, S2, S3, S4 = "#2a78d6", "#eb6834", "#1baf7a", "#eda100"   # blue orange aqua yellow
S5, S6, S7, S8 = "#e87ba4", "#008300", "#4a3aa7", "#e34948"
SURF, INK, SEC, MUT = "#fcfcfb", "#0b0b0b", "#52514e", "#898781"
GRID, BASELINE = "#e1e0d9", "#c3c2b7"

plt.rcParams.update({
    "figure.facecolor": SURF, "axes.facecolor": SURF, "savefig.facecolor": SURF,
    "axes.edgecolor": BASELINE, "axes.linewidth": 0.8,
    "axes.grid": True, "grid.color": GRID, "grid.linewidth": 0.6,
    "xtick.color": MUT, "ytick.color": MUT, "text.color": INK,
    "axes.labelcolor": SEC, "font.size": 9.5,
    "axes.titlesize": 10.5, "axes.titleweight": "bold",
    "axes.spines.top": False, "axes.spines.right": False,
    "font.family": "sans-serif",
})

ARMS = AN["meta"]["arms"]
caps = np.array(AN["curves"]["caps"])
curves = AN["curves"]["arms"]
N = AN["meta"]["N"]

# ------------------------------------------------------------------ fig 1: budget curves
fig, axes = plt.subplots(1, 4, figsize=(13, 3.6), sharey=True)
panels = [
    ("Search tools", [("grep", S2), ("grep r2", S2), ("semantic", S3)]),
    ("Snippet compiles", [("snippet", S2), ("snippet r2", S2),
                          ("snippetonly", S3), ("snippetonly r2", S3), ("snippetfacts", S4)]),
    ("Spawn workers", [("spawn", S2), ("spawnfacts", S3)]),
    ("Statement quote", [("basequote", S2)]),
]
for ax, (title, series) in zip(axes, panels):
    for arm in ("base", "base r2"):
        ax.plot(caps, np.array(curves[arm]) / N, color=MUT, lw=1.6,
                alpha=0.85, zorder=2)
    ax.text(1.0, curves["base"][-1] / N - 0.045, "base ×2", color=MUT,
            ha="right", va="top", fontsize=8.5)
    seen = {}
    for arm, col in series:
        lw = 1.6 if arm.endswith("r2") else 2.0
        ax.plot(caps, np.array(curves[arm]) / N, color=col, lw=lw, zorder=3)
        stem = arm.replace(" r2", "")
        if stem not in seen:
            seen[stem] = (col, curves[arm][-1] / N)
    # stagger end labels to avoid collisions (min gap 0.045)
    labels = sorted(seen.items(), key=lambda kv: kv[1][1])
    ys = [v[1] for _, v in labels]
    for li in range(1, len(ys)):
        if ys[li] - ys[li - 1] < 0.045:
            ys[li] = ys[li - 1] + 0.045
    for (stem, (col, _)), y in zip(labels, ys):
        ax.annotate(stem + (" ×2" if (stem + " r2") in curves else ""),
                    (1.0, y), xytext=(4, 0), textcoords="offset points",
                    color=col, fontsize=8.5, va="center", fontweight="bold")
    ax.set_title(title, loc="left", color=INK)
    ax.set_xlim(0, 1.28); ax.set_ylim(0, 0.68)
    ax.set_xticks([0, 0.25, 0.5, 0.75, 1.0])
    ax.set_xlabel("budget cap (cost_std $)")
axes[0].set_ylabel("share of 90 problems green by cap")
fig.suptitle("Solve-by-cost curves, mined first greens — every family beats base early and late, "
             "except statement-quote", x=0.005, ha="left", fontsize=11, fontweight="bold")
fig.tight_layout(rect=[0, 0, 1, 0.92])
fig.savefig(os.path.join(FIG, "fig1-budget-curves.png"), dpi=180)
plt.close(fig)

# ------------------------------------------------------------------ fig 2: tools + spawn per problem
byarm = {}
for r in A:
    byarm.setdefault(r["arm"], {})[r["problem"]] = r
PROBS = AN["irt"]["problems"]
bvec = np.array(AN["irt"]["b"])

fig = plt.figure(figsize=(13, 7.2))
gs = fig.add_gridspec(2, 2, height_ratios=[1, 1.15], hspace=0.42, wspace=0.18)

# (a) tool mix per arm — share of tool calls, stacked horizontal
ax = fig.add_subplot(gs[0, :])
groups = [("lean_check", S1), ("check_snippet", S3), ("search", S2),
          ("file ops", S4), ("spawn/facts", S5), ("other", MUT)]
order = ["base", "base r2", "grep", "grep r2", "semantic", "basequote",
         "snippet", "snippet r2", "snippetonly", "snippetonly r2",
         "snippetfacts", "spawn", "spawnfacts"]
ypos = np.arange(len(order))[::-1]
lefts = np.zeros(len(order))
totals = []
for arm in order:
    t = AN["tools"][arm]
    tot = sum(t.values())
    totals.append(tot)
for (gname, col) in groups:
    vals = []
    for arm in order:
        t = AN["tools"][arm]
        if gname == "search":
            v = t.get("grep_mathlib", 0) + t.get("search_mathlib", 0)
        elif gname == "file ops":
            v = t.get("read", 0) + t.get("edit", 0) + t.get("write", 0)
        elif gname == "spawn/facts":
            v = t.get("spawn_subagents", 0) + t.get("add_fact", 0)
        elif gname == "other":
            known = (t.get("lean_check", 0) + t.get("check_snippet", 0) +
                     t.get("grep_mathlib", 0) + t.get("search_mathlib", 0) +
                     t.get("read", 0) + t.get("edit", 0) + t.get("write", 0) +
                     t.get("spawn_subagents", 0) + t.get("add_fact", 0))
            v = sum(t.values()) - known
        else:
            v = t.get(gname, 0)
        vals.append(v / max(1, sum(AN["tools"][arm].values())))
    ax.barh(ypos, vals, left=lefts, height=0.62, color=col, label=gname,
            edgecolor=SURF, linewidth=1.5)
    lefts += np.array(vals)
for y, arm, tot in zip(ypos, order, totals):
    ax.text(1.012, y, f"{tot:,}", va="center", color=MUT, fontsize=8)
ax.set_yticks(ypos); ax.set_yticklabels(order, fontsize=9, color=INK)
ax.set_xlim(0, 1.1); ax.set_xticks([0, 0.25, 0.5, 0.75, 1.0])
ax.set_title("Tool mix (share of calls; right margin = total calls) — snippet/spawn arms swap "
             "graded checks for scratch compiles and delegation", loc="left", color=INK)
ax.legend(loc="lower right", ncols=6, frameon=False, fontsize=8.5,
          bbox_to_anchor=(1.0, -0.34))
ax.grid(axis="y", visible=False)

# (b,c) spawn usage per problem, sorted by difficulty
diff_order = np.argsort(bvec)
for col_i, arm in enumerate(["spawn", "spawnfacts"]):
    ax = fig.add_subplot(gs[1, col_i])
    per = {x["problem"]: x for x in AN["spawn_use"][arm]}
    xs = np.arange(len(PROBS))
    spawned, notsp = 0, 0
    for xi, pi in enumerate(diff_order):
        p = PROBS[pi]
        x = per[p]
        green = x["green"]
        used = x["n_calls"] > 0
        y = x["n_workers"]
        if used:
            ax.vlines(xi, 0, y, color=S1 if green else S2, lw=2.2, zorder=3)
            spawned += 1
        marker_y = -1.1
        ax.plot(xi, marker_y, marker="s", ms=3.2,
                color=(S6 if green else "#d8d7d0"), zorder=2,
                markeredgecolor="none")
    ax.axhline(0, color=BASELINE, lw=0.8)
    ax.set_xlim(-1, len(PROBS))
    ax.set_ylim(-2.2, 12)
    ax.set_xticks([])
    ax.set_xlabel("90 problems, easy → hard (Rasch b̂)")
    if col_i == 0:
        ax.set_ylabel("workers spawned")
    n_used = sum(1 for x in per.values() if x["n_calls"] > 0)
    wc = sum(x["worker_cost"] for x in per.values())
    ax.set_title(f"{arm}: spawned on {n_used}/90", loc="left", color=INK, fontsize=9.5)
    ax.text(2, 10.6, f"worker spend ${wc:.1f}", color=SEC, fontsize=8.5)
    ax.grid(axis="x", visible=False)
fig.suptitle("The spawn tool is a last resort: invoked almost only on hard problems, "
             "where greens are rare anyway\n(bars: blue = attempt went green, orange = not; "
             "square strip below = green outcome per problem)", x=0.005, ha="left",
             fontsize=11, fontweight="bold")
fig.savefig(os.path.join(FIG, "fig2-tools-spawn.png"), dpi=180, bbox_inches="tight")
plt.close(fig)

# ------------------------------------------------------------------ fig 3: flip locations
fl = AN["fliploc"]
rows = [("base → grep", "base->grep"), ("base → semantic", "base->semantic"),
        ("base → snippet", "base->snippet"), ("base → snippetonly", "base->snippetonly"),
        ("base → snippetfacts", "base->snippetfacts"),
        ("base → spawn", "base->spawn"), ("base → spawnfacts", "base->spawnfacts"),
        ("base → basequote", "base->basequote"),
        ("replicate noise (pooled)", "noise")]
fig, ax = plt.subplots(figsize=(9.5, 5.2))
rng = np.random.default_rng(7)
for yi, (label, key) in enumerate(rows[::-1]):
    if key == "noise":
        costs, lost = fl["noise"]["costs"], []
        cg = MUT
    else:
        costs = fl[key]["gained_costs"]
        lost = fl[key]["lost_costs"]
        cg = S1
    jit = (rng.random(len(costs)) - 0.5) * 0.3
    ax.scatter(costs, yi + jit, s=42, color=cg, alpha=0.85, zorder=3,
               edgecolors=SURF, linewidths=1.2)
    if costs:
        med = float(np.median(costs))
        ax.vlines(med, yi - 0.28, yi + 0.28, color=cg, lw=2.6, zorder=4)
    if lost:
        jit2 = (rng.random(len(lost)) - 0.5) * 0.3
        ax.scatter(lost, yi + jit2, s=42, color=S2, alpha=0.85, zorder=3,
                   marker="D", edgecolors=SURF, linewidths=1.2)
ax.set_yticks(range(len(rows)))
ax.set_yticklabels([r[0] for r in rows[::-1]], color=INK, fontsize=9.5)
ax.set_xlim(0, 1.02)
ax.set_xlabel("first-green cost of the flip's solving side (cost_std $)")
ax.grid(axis="y", visible=False)
from matplotlib.lines import Line2D
ax.legend(handles=[
    Line2D([], [], marker="o", ls="", color=S1, label="gained vs base (dot = one problem)"),
    Line2D([], [], marker="D", ls="", color=S2, label="lost vs base"),
    Line2D([], [], marker="o", ls="", color=MUT, label="replicate noise flip"),
    Line2D([], [], color=INK, lw=2.6, label="median")],
    loc="upper left", frameon=False, fontsize=8.5)
ax.set_title("Where flips live on the cost axis — gained problems cluster toward the tail,\n"
             "like noise flips do; only grep/semantic gains sit clearly cheaper", loc="left", color=INK)
fig.tight_layout()
fig.savefig(os.path.join(FIG, "fig3-flip-locations.png"), dpi=180)
plt.close(fig)

# ------------------------------------------------------------------ fig 4: IRT
theta = np.array(AN["irt"]["theta"]); se = np.array(AN["irt"]["se_theta"])
fig, (ax1, ax2) = plt.subplots(1, 2, figsize=(11.5, 4.6), width_ratios=[1, 1.3])
ordj = np.argsort(theta)
fam = {"base": MUT, "base r2": MUT, "grep": S2, "grep r2": S2, "semantic": S3,
       "snippet": S1, "snippet r2": S1, "snippetonly": S7, "snippetonly r2": S7,
       "snippetfacts": S1, "basequote": S8, "spawn": S6, "spawnfacts": S6}
for yi, j in enumerate(ordj):
    a = ARMS[j]
    ax1.errorbar(theta[j], yi, xerr=se[j], fmt="o", ms=6, color=fam[a],
                 ecolor=BASELINE, elinewidth=1.4, capsize=0, zorder=3)
ax1.set_yticks(range(len(ARMS)))
ax1.set_yticklabels([ARMS[j] for j in ordj], fontsize=9, color=INK)
ax1.set_xlabel("Rasch ability θ̂ (logits) ± SE")
ax1.grid(axis="y", visible=False)
ax1.set_title("Cell abilities — replicate gaps (same color)\nare the noise yardstick", loc="left", color=INK)
ax2.hist(bvec, bins=28, color=S1, edgecolor=SURF, linewidth=1.2)
ax2.set_xlabel("problem difficulty b̂ (logits)")
ax2.set_ylabel("problems")
ax2.set_title("Difficulty spectrum: two shelves — solved-everywhere and\n"
              "solved-nowhere — carry no contrast information", loc="left", color=INK)
ax2.annotate("always solved", (bvec.min() + 0.3, 20), color=SEC, fontsize=9)
ax2.annotate("never solved", (bvec.max() - 3.4, 20), color=SEC, fontsize=9)
fig.suptitle(f"Rasch fit over all 13 cells — DIF test finds NO problem×arm interaction "
             f"(p = {AN['irt']['p_dif']:.2f}): the harness effect is a uniform shift",
             x=0.005, ha="left", fontsize=11, fontweight="bold")
fig.tight_layout(rect=[0, 0, 1, 0.90])
fig.savefig(os.path.join(FIG, "fig4-irt.png"), dpi=180)
plt.close(fig)

# ------------------------------------------------------------------ fig 5: nudges + give-ups
nud = AN["nudges"]
fig = plt.figure(figsize=(12.5, 4.4))
gs = fig.add_gridspec(1, 3, width_ratios=[1.5, 1, 1], wspace=0.32)
ax = fig.add_subplot(gs[0, 0])
order5 = [a for a in order if a in nud]
ypos = np.arange(len(order5))[::-1]
pre = np.array([nud[a]["green_pre_nudge"] for a in order5])
conv = np.array([nud[a]["conversions"] for a in order5])
ax.barh(ypos, pre, height=0.6, color=S1, edgecolor=SURF, linewidth=1.5,
        label="green before any nudge")
ax.barh(ypos, conv, left=pre, height=0.6, color=S2, edgecolor=SURF, linewidth=1.5,
        label="green only after nudging")
for y, a in zip(ypos, order5):
    if nud[a]["conversions"]:
        ax.text(pre[list(order5).index(a)] + conv[list(order5).index(a)] + 0.7, y,
                f'+{nud[a]["conversions"]}', color=S2, va="center", fontsize=8.5,
                fontweight="bold")
ax.set_yticks(ypos); ax.set_yticklabels(order5, fontsize=9, color=INK)
ax.set_xlabel("greens per 90 problems")
ax.grid(axis="y", visible=False)
ax.legend(loc="upper center", bbox_to_anchor=(0.5, -0.16), ncols=2,
          frameon=False, fontsize=8.5)
ax.set_title("Almost every green predates the first nudge", loc="left", color=INK, fontsize=9.5)
ax2 = fig.add_subplot(gs[0, 1])
bl = AN["giveup"]["gaveup_budget_left"]
ax2.hist(bl, bins=20, color=S3, edgecolor=SURF, linewidth=1.2)
ax2.set_xlabel("budget left at voluntary give-up ($)")
ax2.set_ylabel("attempts")
ax2.set_title(f"Give-ups walk away from money\n(n={AN['giveup']['gaveup_n']}, median "
              f"\\${np.median(bl):.2f} unspent)", loc="left", color=INK, fontsize=9.5)
ax3 = fig.add_subplot(gs[0, 2])
spend = [nud[a]["spend_after"] for a in order5]
convs = [nud[a]["conversions"] for a in order5]
ax3.scatter(spend, convs, s=55, color=S1, edgecolors=SURF, linewidths=1.2, zorder=3)
for a, x, y in zip(order5, spend, convs):
    if y >= 2 or x > 14:
        dy = -10 if a == "snippetonly" else 3
        ax3.annotate(a, (x, y), xytext=(4, dy), textcoords="offset points",
                     fontsize=8, color=SEC)
tot_sp, tot_cv = sum(spend), sum(convs)
ax3.set_xlabel("spend after first nudge ($, per arm)")
ax3.set_ylabel("nudge-converted greens")
ax3.set_title(f"Nudge ROI: \\${tot_sp:.0f} bought {tot_cv} greens\n(~\\${tot_sp/tot_cv:.0f} each "
              f"vs \\$0.16 median normal solve)", loc="left", color=INK, fontsize=9.5)
fig.suptitle("Nudging keeps models working but buys almost nothing — give-ups are largely "
             "calibrated (189/191 end blocked on a sorry)", x=0.005, y=1.06, ha="left",
             fontsize=11, fontweight="bold")
fig.tight_layout(rect=[0, 0, 1, 0.97])
fig.savefig(os.path.join(FIG, "fig5-nudges.png"), dpi=180, bbox_inches="tight")
plt.close(fig)

# ------------------------------------------------------------------ fig 6: log-cost + post-green
fig, (ax1, ax2) = plt.subplots(1, 2, figsize=(11.5, 4.3), width_ratios=[1.2, 1])
lc = AN["logcost"]
names = [k for k in ["grep", "semantic", "snippet", "snippetonly", "snippetfacts",
                     "spawn", "spawnfacts", "basequote"] if k in lc]
ypos = np.arange(len(names))[::-1]
rngj = np.random.default_rng(11)
for y, name in zip(ypos, names):
    d = np.array(lc[name]["deltas"])
    jit = (rngj.random(len(d)) - 0.5) * 0.34
    ax1.scatter(d, y + jit, s=26, color=S1, alpha=0.55, edgecolors="none", zorder=2)
    med, (lo, hi) = lc[name]["median_dlog2"], lc[name]["ci"]
    ax1.plot([lo, hi], [y, y], color=INK, lw=2.2, zorder=3)
    ax1.plot(med, y, marker="o", ms=7, color=S2, zorder=4,
             markeredgecolor=SURF, markeredgewidth=1.2)
ax1.axvline(0, color=BASELINE, lw=1)
ax1.set_yticks(ypos); ax1.set_yticklabels([f"{n} vs base" for n in names],
                                          fontsize=9, color=INK)
ax1.set_xlabel("Δlog₂ first-green cost on both-green problems  (−1 = 2× cheaper)")
ax1.grid(axis="y", visible=False)
ax1.set_title("Problems get uniformly cheaper under every tool arm\n"
              "except statement-quote (orange = median, bar = boot 95% CI)",
              loc="left", color=INK, fontsize=9.5)
pg = AN["postgreen"]
arms6 = [a for a in order if a in pg]
allc = []
for a in arms6:
    allc += [max(c, 1e-4) for c in pg[a]["cost_after_all"]]
ax2.hist(np.log10(allc), bins=30, color=S1, edgecolor=SURF, linewidth=1.2)
ax2.set_xticks([-4, -3, -2, -1, 0])
ax2.set_xticklabels(["$0.0001", "$0.001", "$0.01", "$0.1", "$1"])
ax2.set_xlabel("spend after first green (all greens pooled, log scale)")
ax2.set_ylabel("greens")
tot_changed = sum(pg[a]["changed"] for a in arms6)
tot_wreck = sum(pg[a]["wrecked"] for a in arms6)
tot_greens = sum(pg[a]["greens"] for a in arms6)
ax2.set_title(f"After the green: median stop cost ≈ \\$0.003;\n"
              f"{tot_changed}/{tot_greens} touch the file again, {tot_wreck} wreck it",
              loc="left", color=INK, fontsize=9.5)
fig.suptitle("Efficiency and the post-solve question", x=0.005, ha="left",
             fontsize=11, fontweight="bold")
fig.tight_layout(rect=[0, 0, 1, 0.90])
fig.savefig(os.path.join(FIG, "fig6-logcost-postgreen.png"), dpi=180)
plt.close(fig)

print("wrote", sorted(os.listdir(FIG)))
