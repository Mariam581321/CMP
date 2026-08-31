#!/usr/bin/env python3
"""Draft figure set for the blog plan (2026-08-17). stdlib only.

Reads the canonical patched views in results/, writes drafts/figs-draft-0817.html
(self-contained SVG). Draft quality: light mode only, native <title> tooltips.
"""
import json, os, statistics as st, html

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RES = os.path.join(ROOT, 'results')
OUT = os.path.join(ROOT, 'drafts', 'figs-draft-0817.html')

ARMS = {
 'base':        ['base-fatex87-0807-cwrerun-patched.results.jsonl', 'base-fatex87-0807-easy3/results.jsonl'],
 'base r2':     ['base-fatex90-0807-r2-cwrerun-patched.results.jsonl'],
 'grep':        ['grep-fatex87-0807-plus-easy3.results.jsonl'],
 'grep r2':     ['grep-fatex90-0807-r2/results.jsonl'],
 'semantic':    ['semantic-fatex87-0807-cwrerun-patched.results.jsonl', 'semantic-fatex87-0807-easy3/results.jsonl'],
 'snippetonly': ['snippetonly-fatex90-0807-cwrerun-patched.results.jsonl'],
 'snippetonly r2': ['snippetonly-fatex90-0807-r2-cwrerun-patched.results.jsonl'],
 'snippet':     ['snippet-fatex90-0807-fgrerun-patched.results.jsonl'],
 'snippet r2':  ['snippet-fatex90-0807-r2-cwrerun-patched.results.jsonl'],
 'spawn':       ['spawn-fatex90-0807/results.jsonl'],
 'snippetfacts':['snippetfacts-fatex90-0812/results.jsonl'],
 'spawnfacts':  ['spawnfacts-fatex90-0807/results.jsonl'],
 'basequote':   ['basequote-fatex90-0813-cwrerun-patched.results.jsonl'],
}
# entity-stable arm hues (reference palette, fixed order); basequote folds to muted
HUE = {'base':'#2a78d6','grep':'#eb6834','semantic':'#1baf7a','snippetonly':'#eda100',
       'snippet':'#e87ba4','spawn':'#008300','snippetfacts':'#4a3aa7','spawnfacts':'#e34948',
       'basequote':'#898781'}
def hue(arm): return HUE[arm.replace(' r2','')]
INK, INK2, MUT, GRID, BASE_AX = '#0b0b0b', '#52514e', '#898781', '#e1e0d9', '#c3c2b7'

def load(fs):
    d = {}
    for f in fs:
        for line in open(os.path.join(RES, f)):
            r = json.loads(line)
            d[r['problem']] = r
    return d

DATA = {a: load(fs) for a, fs in ARMS.items()}
PROBS = sorted(DATA['base'].keys())

def fp(r):
    f = (r.get('high_water') or {}).get('first')
    return f['cost_std'] if f and f.get('solved') else None

def solves_at(arm, cap):
    return sum(1 for p in PROBS if (fp(DATA[arm][p]) or 9e9) <= cap)

CAPS = [i/100 for i in range(0, 101)]
CURVE = {a: [solves_at(a, c) for c in CAPS] for a in ARMS}
SOLVED = {a: sum(1 for r in DATA[a].values() if r['solved']) for a in ARMS}
SPEND = {a: sum(r['cost_std'] for r in DATA[a].values()) for a in ARMS}

S = []  # html chunks
def svg(w, h, body):
    return f'<svg viewBox="0 0 {w} {h}" width="{w}" height="{h}" style="max-width:100%">{body}</svg>'
def sec(title, caption, body):
    S.append(f'<section><h2>{html.escape(title)}</h2>{body}<p class="cap">{caption}</p></section>')
def T(x, y, s, fill=INK2, size=11, anchor='start', weight='400', tab=False):
    fam = ';font-variant-numeric:tabular-nums' if tab else ''
    return f'<text x="{x:.1f}" y="{y:.1f}" fill="{fill}" font-size="{size}" text-anchor="{anchor}" font-weight="{weight}" style="font-family:system-ui{fam}">{html.escape(str(s))}</text>'

# ---------- F6 stat tiles ----------
CORE = {'read','edit','write','lean_check','grep_mathlib','search_mathlib','check_snippet',
        'spawn_subagents','add_fact','loogle_mathlib'}
def phantom(arm):
    return sum(1 for r in DATA[arm].values() if any(k not in CORE and v > 0 for k, v in (r.get('tool_calls') or {}).items()))
def medwrites(arm):
    return st.median((r.get('tool_calls') or {}).get('write', 0) for r in DATA[arm].values())
tiles = [
 ('Attempts calling a tool they don’t have', f'base {phantom("base")}/90 · basequote {phantom("basequote")}/90 · snippetonly {phantom("snippetonly")}/90', f'every search arm: 0'),
 ('Median whole-file rewrites of the graded file', f'base {medwrites("base"):.0f} → snippet {medwrites("snippet"):.0f}', 'the graded file as scratchpad'),
 ('The grid', '13 cells × 90 problems · $1/problem', f'total spend $815'),
 ('The one certified effect', '+8.5 solves [+4.0, +13.0]', 'search vs base, k=2'),
]
tile_html = '<div class="tiles">' + ''.join(
    f'<div class="tile"><div class="tl">{html.escape(a)}</div><div class="tv">{html.escape(b)}</div><div class="ts">{html.escape(c)}</div></div>'
    for a, b, c in tiles) + '</div>'
sec('F6 · Revealed demand (the hook tiles)',
    'No-search agents reach for tools that don’t exist and burn the graded file as a scratchpad — they name the missing tool before any comparison is run.',
    tile_html)

# ---------- F1 budget curves, three states ----------
def curve_panel(title, arms_in, w=320, h=260):
    L, R, Tm, B = 40, 10, 22, 30
    pw, ph = w - L - R, h - Tm - B
    xs = lambda c: L + c * pw
    ys = lambda s: Tm + ph - s / 60 * ph
    b = [T(w/2, 13, title, INK, 12, 'middle', '600')]
    for gv in range(0, 61, 20):
        b.append(f'<line x1="{L}" y1="{ys(gv):.1f}" x2="{w-R}" y2="{ys(gv):.1f}" stroke="{GRID}" stroke-width="1"/>')
        b.append(T(L-4, ys(gv)+4, gv, MUT, 10, 'end', tab=True))
    for cv in (0, 0.5, 1.0):
        b.append(T(xs(cv), h-12, f'${cv:.2f}', MUT, 10, 'middle', tab=True))
    # envelope of all 13 cells
    mx = [max(CURVE[a][i] for a in ARMS) for i in range(101)]
    mn = [min(CURVE[a][i] for a in ARMS) for i in range(101)]
    pts = ' '.join(f'{xs(CAPS[i]):.1f},{ys(mx[i]):.1f}' for i in range(101))
    pts += ' ' + ' '.join(f'{xs(CAPS[i]):.1f},{ys(mn[i]):.1f}' for i in range(100, -1, -1))
    b.append(f'<polygon points="{pts}" fill="#f0efec" opacity="0.7"><title>envelope of all 13 cells</title></polygon>')
    for arm in arms_in:
        d = ' '.join(f'{"M" if i==0 else "L"}{xs(CAPS[i]):.1f},{ys(CURVE[arm][i]):.1f}' for i in range(101))
        dash = ' stroke-dasharray="5,3"' if arm.endswith('r2') else ''
        b.append(f'<path d="{d}" fill="none" stroke="{hue(arm)}" stroke-width="2"{dash}><title>{arm}: {SOLVED[arm]}/90 at $1</title></path>')
        b.append(T(xs(1.0)-2, ys(CURVE[arm][100])-4, f'{arm} {CURVE[arm][100]}', hue(arm), 10, 'end', '600'))
    b.append(f'<line x1="{L}" y1="{ys(0):.1f}" x2="{w-R}" y2="{ys(0):.1f}" stroke="{BASE_AX}"/>')
    return svg(w, h, ''.join(b))
p1 = curve_panel('A · does search help?', ['base', 'base r2', 'grep', 'grep r2', 'semantic'])
p2 = curve_panel('B · what is search for?', ['base', 'grep', 'snippetonly', 'snippetonly r2', 'snippet', 'snippet r2'])
p3 = curve_panel('C · does orchestration matter?', ['base', 'snippet', 'snippet r2', 'spawn', 'spawnfacts'])
sec('F1 · Solves vs budget cap — the primary object (three states)',
    'Solved at cap c = first verified proof cost ≤ c. Grey envelope = all 13 cells. Dashed = second replicate of the same arm. '
    'Arms are furthest apart at low caps and converge by $1.00; the replicate gap (solid vs dashed, same hue) is the visual noise floor.',
    f'<div class="row">{p1}{p2}{p3}</div>')

# ---------- F2 flip strips + MDE ladder ----------
PAIRS = [('base','base r2'), ('grep','grep r2'), ('snippetonly','snippetonly r2'), ('snippet','snippet r2')]
rows = []
y = 24
w2 = 760
cell = 7.2
for a, b_ in PAIRS:
    cells = []
    fl = 0
    for i, p in enumerate(PROBS):
        sa, sb = DATA[a][p]['solved'], DATA[b_][p]['solved']
        if sa and sb: col = '#9ec5f4'
        elif not sa and not sb: col = '#f0efec'
        else: col, fl = '#eb6834', fl + 1
        cells.append(f'<rect x="{110+i*cell:.1f}" y="{y}" width="{cell-1.2:.1f}" height="14" rx="2" fill="{col}"><title>{p}: {a} {"✓" if sa else "·"} / r2 {"✓" if sb else "·"}</title></rect>')
    rows.append(T(104, y+11, a, INK2, 11, 'end') + ''.join(cells) + T(110+90*cell+6, y+11, f'{fl} flips', INK, 11, 'start', '600'))
    y += 22
y += 8
rows.append(T(110, y+10, 'legend:', MUT, 10))
rows.append(f'<rect x="155" y="{y}" width="12" height="12" rx="2" fill="#9ec5f4"/>' + T(171, y+10, 'both solved', INK2, 10))
rows.append(f'<rect x="245" y="{y}" width="12" height="12" rx="2" fill="#f0efec"/>' + T(261, y+10, 'neither', INK2, 10))
rows.append(f'<rect x="320" y="{y}" width="12" height="12" rx="2" fill="#eb6834"/>' + T(336, y+10, 'flip — identical runs disagree', INK2, 10))
y += 34
# MDE ladder 0..16 solves
lx = lambda v: 110 + v / 16 * (w2 - 200)
rows.append(T(104, y+4, 'effect size (solves)', INK2, 11, 'end'))
rows.append(f'<line x1="{lx(0)}" y1="{y}" x2="{lx(16)}" y2="{y}" stroke="{BASE_AX}" stroke-width="1.5"/>')
for v in range(0, 17, 2):
    rows.append(f'<line x1="{lx(v)}" y1="{y-3}" x2="{lx(v)}" y2="{y+3}" stroke="{BASE_AX}"/>')
    rows.append(T(lx(v), y+16, v, MUT, 9, 'middle', tab=True))
for mde, lab in [(8.7, 'MDE k=1'), (6.2, 'k=2'), (5.0, 'k=3')]:
    rows.append(f'<line x1="{lx(mde)}" y1="{y-26}" x2="{lx(mde)}" y2="{y}" stroke="{MUT}" stroke-dasharray="3,3"/>')
    rows.append(T(lx(mde), y-30, lab, MUT, 9, 'middle'))
claims = [(8.5, '+8.5 search (k=2)', '#2a78d6'), (0.5, 'Δ0.5 semantic−grep', '#1baf7a'), (2.0, '−2 spawn−snippet', '#008300')]
for i, (v, lab, c) in enumerate(claims):
    rows.append(f'<circle cx="{lx(v)}" cy="{y-10-i*1}" r="4.5" fill="{c}"><title>{lab}</title></circle>')
    rows.append(T(lx(v)+8, y-8-i*13, lab, c, 10, 'start', '600'))
sec('F2 · The ruler — replicate flips and what they gate',
    'Four byte-identical replicate pairs flip 8–11 problems of 90 each (pooled F=9.7). The ladder converts that to the minimum detectable effect; '
    'this post’s own claims are plotted against it — only the search effect clears its bar.',
    svg(w2, y+30, ''.join(rows)))

# ---------- F2b noise as a function of the cap ----------
# flips_c[pair][i] = # problems where the two byte-identical runs disagree on
# "first proof <= cap"; pooled F(c) = mean over pairs; MDE(c;k) = 2.8*sqrt(F/k).
FLIPPAIRS = {a: (a, f'{a} r2') for a in ('base', 'grep', 'snippetonly', 'snippet')}
def fpc(arm, p):
    v = fp(DATA[arm][p]); return v if v is not None else 9e9
flips_c = {a: [sum(1 for p in PROBS if (fpc(r1, p) <= c) != (fpc(r2, p) <= c)) for c in CAPS]
           for a, (r1, r2) in FLIPPAIRS.items()}
POOLF = [sum(flips_c[a][i] for a in flips_c) / len(flips_c) for i in range(101)]
def smooth(vals, bw=5):
    """moving average over ±bw cents (window truncated at the edges)."""
    out = []
    for i in range(len(vals)):
        lo, hi = max(0, i - bw), min(len(vals), i + bw + 1)
        out.append(sum(vals[lo:hi]) / (hi - lo))
    return out
POOLF_S = smooth(POOLF)
# sampling SE of the pooled mean of 4 integer flip counts: Var(F_a) ≈ F_a(1−F_a/90)
SE_F = [ (sum(flips_c[a][i] * (1 - flips_c[a][i] / 90) for a in flips_c) / 16) ** 0.5 for i in range(101)]
SE_F = smooth(SE_F)
MDE1 = [2.8 * POOLF_S[i] ** 0.5 for i in range(101)]
MDE2 = [2.8 * (POOLF_S[i] / 2) ** 0.5 for i in range(101)]
def noise_panel(title, series, ymax, ylab, w=360, h=250, band=None):
    L_, R_, T_, B_ = 42, 96, 22, 30
    pw, ph = w - L_ - R_, h - T_ - B_
    xs = lambda c: L_ + c * pw
    ys = lambda v: T_ + ph - min(max(v, 0), ymax) / ymax * ph
    bb = [T(w/2 - 40, 13, title, INK, 12, 'middle', '600')]
    for gv in range(0, ymax + 1, 4):
        bb.append(f'<line x1="{L_}" y1="{ys(gv):.1f}" x2="{w-R_}" y2="{ys(gv):.1f}" stroke="{GRID}"/>')
        bb.append(T(L_-4, ys(gv)+4, gv, MUT, 10, 'end', tab=True))
    for cv in (0, 0.5, 1.0):
        bb.append(T(xs(cv), h-12, f'${cv:.2f}', MUT, 10, 'middle', tab=True))
    if band:
        mid, se = band
        pts = ' '.join(f'{xs(CAPS[i]):.1f},{ys(mid[i]+1.96*se[i]):.1f}' for i in range(101))
        pts += ' ' + ' '.join(f'{xs(CAPS[i]):.1f},{ys(mid[i]-1.96*se[i]):.1f}' for i in range(100, -1, -1))
        bb.append(f'<polygon points="{pts}" fill="#9ec5f4" opacity="0.35"><title>±1.96·SE of the pooled mean (approx.)</title></polygon>')
    for lab, vals, col, wd, dash, op in series:
        d = ' '.join(f'{"M" if i==0 else "L"}{xs(CAPS[i]):.1f},{ys(vals[i]):.1f}' for i in range(101))
        dd = ' stroke-dasharray="4,3"' if dash else ''
        bb.append(f'<path d="{d}" fill="none" stroke="{col}" stroke-width="{wd}" opacity="{op}"{dd}><title>{lab}</title></path>')
        if op == 1:
            bb.append(T(xs(1.0)+4, ys(vals[100])+4, lab, col, 9.5, 'start', '600'))
    bb.append(T(w/2 - 40, h-2, 'budget cap', MUT, 10, 'middle'))
    bb.append(T(12, T_-8, ylab, MUT, 9))
    return svg(w, h, ''.join(bb))
pa = noise_panel('flips between identical runs',
    [(a, flips_c[a], MUT, 1, False, 0.3) for a in flips_c] +
    [('pooled F (±$0.05 smooth)', POOLF_S, INK, 2.5, False, 1)],
    16, 'flips /90', band=(POOLF_S, SE_F))
pb = noise_panel('minimum detectable effect',
    [('MDE k=1', MDE1, '#2a78d6', 2, False, 1), ('MDE k=2', MDE2, '#2a78d6', 2, True, 1)], 12, 'solves')

# ---------- F2c: per-arm noise + signal-vs-noise decomposition ----------
# Identity: E[between-arm discordance] - avg within-arm discordance = Σ_i (p_A - p_B)².
def discord(r1, r2, c):
    return sum(1 for p in PROBS if (fpc(r1, p) <= c) != (fpc(r2, p) <= c))
W_ARM = {a: smooth([discord(r1, r2, c) for c in CAPS]) for a, (r1, r2) in FLIPPAIRS.items()}
POOLW = [sum(W_ARM[a][i] for a in W_ARM) / 4 for i in range(101)]
def signal2(runsA, runsB, WA, WB):
    raw = []
    for i, c in enumerate(CAPS):
        Dbar = sum(discord(a, b, c) for a in runsA for b in runsB) / (len(runsA) * len(runsB))
        raw.append(Dbar - (WA[i] + WB[i]) / 2)
    return smooth(raw)
SIG = [
 ('grep vs base', signal2(['grep', 'grep r2'], ['base', 'base r2'], W_ARM['grep'], W_ARM['base']), '#eb6834',
  (['grep', 'grep r2'], ['base', 'base r2'])),
 ('snippet vs base', signal2(['snippet', 'snippet r2'], ['base', 'base r2'], W_ARM['snippet'], W_ARM['base']), '#e87ba4',
  (['snippet', 'snippet r2'], ['base', 'base r2'])),
 ('semantic vs grep', signal2(['semantic'], ['grep', 'grep r2'], POOLW, W_ARM['grep']), '#1baf7a',
  (['semantic'], ['grep', 'grep r2'])),
 ('spawn vs snippet', signal2(['spawn'], ['snippet', 'snippet r2'], POOLW, W_ARM['snippet']), '#008300',
  (['spawn'], ['snippet', 'snippet r2'])),
]

# per-cap one-sided permutation p for signal²>0 (unsmoothed estimator, informative strata only)
import random as _random
def _sigstat(xs_list, n1):
    tot = 0.0
    for xs in xs_list:
        A, Bs = xs[:n1], xs[n1:]
        n2 = len(Bs)
        Dbar = sum(1 for a in A for b in Bs if a != b) / (n1 * n2)
        Ws = []
        if n1 > 1: Ws.append(sum(1 for i in range(n1) for j in range(i+1, n1) if A[i] != A[j]) / (n1*(n1-1)/2))
        if n2 > 1: Ws.append(sum(1 for i in range(n2) for j in range(i+1, n2) if Bs[i] != Bs[j]) / (n2*(n2-1)/2))
        tot += Dbar - sum(Ws) / len(Ws)
    return tot
def sig_pvals(runsA, runsB, nperm=1500, step=2):
    n1 = len(runsA)
    ps = {}
    rng = _random.Random(20260817)
    for ci in range(0, 101, step):
        c = CAPS[ci]
        xs_list = [[1 if fpc(r, p) <= c else 0 for r in runsA + runsB] for p in PROBS]
        xs_list = [xs for xs in xs_list if 0 < sum(xs) < len(xs)]
        if not xs_list:
            ps[ci] = 1.0; continue
        obs = _sigstat(xs_list, n1)
        ge = 0
        for _ in range(nperm):
            perm = []
            for xs in xs_list:
                ys = xs[:]; rng.shuffle(ys); perm.append(ys)
            if _sigstat(perm, n1) >= obs - 1e-12: ge += 1
        ps[ci] = (ge + 1) / (nperm + 1)
    return ps
SIGP = {lab: sig_pvals(*groups) for lab, _, _, groups in SIG}
pc = noise_panel('within-arm noise, per arm (smoothed)',
    [(a, W_ARM[a], hue(a), 2, False, 1) for a in W_ARM], 16, 'flips /90')
def sig_panel(w=360, h=250):
    L_, R_, T_, B_ = 42, 110, 22, 30
    pw, ph = w - L_ - R_, h - T_ - B_
    xs = lambda c: L_ + c * pw
    ys = lambda v: T_ + ph - (min(max(v, -3), 12) + 3) / 15 * ph
    bb = [T(w/2 - 50, 13, 'genuine per-problem difference Σ(pA−pB)²', INK, 12, 'middle', '600')]
    for gv in (0, 4, 8, 12):
        bb.append(f'<line x1="{L_}" y1="{ys(gv):.1f}" x2="{w-R_}" y2="{ys(gv):.1f}" stroke="{GRID}"/>')
        bb.append(T(L_-4, ys(gv)+4, gv, MUT, 10, 'end', tab=True))
    bb.append(f'<line x1="{L_}" y1="{ys(0):.1f}" x2="{w-R_}" y2="{ys(0):.1f}" stroke="{BASE_AX}" stroke-width="1.5"/>')
    for cv in (0, 0.5, 1.0):
        bb.append(T(xs(cv), h-12, f'${cv:.2f}', MUT, 10, 'middle', tab=True))
    d = ' '.join(f'{"M" if i==0 else "L"}{xs(CAPS[i]):.1f},{ys(POOLW[i]):.1f}' for i in range(101))
    bb.append(f'<path d="{d}" fill="none" stroke="{MUT}" stroke-width="1.5" stroke-dasharray="3,3"><title>disagreements two IDENTICAL runs produce (coin share of any between-arm disagreement count)</title></path>')
    bb.append(T(xs(1.0)+4, ys(POOLW[100])+4, 'coin share', MUT, 9.5, 'start'))
    for lab, vals, col, _g in SIG:
        d = ' '.join(f'{"M" if i==0 else "L"}{xs(CAPS[i]):.1f},{ys(vals[i]):.1f}' for i in range(101))
        bb.append(f'<path d="{d}" fill="none" stroke="{col}" stroke-width="2"><title>{lab}: extra disagreeing problems beyond coin noise = Σ(pA−pB)²</title></path>')
        bb.append(T(xs(1.0)+4, ys(vals[100])+4, lab, col, 9.5, 'start', '600'))
        for ci, pv in SIGP[lab].items():
            if pv < 0.05:
                bb.append(f'<circle cx="{xs(CAPS[ci]):.1f}" cy="{ys(vals[ci]):.1f}" r="3" fill="{col}" stroke="#fcfcfb" stroke-width="1"><title>{lab} at ${CAPS[ci]:.2f}: permutation p={pv:.3f} — per-problem difference detectable</title></circle>')
    bb.append(T(w/2 - 50, h-2, 'budget cap', MUT, 10, 'middle'))
    return svg(w, h, ''.join(bb))
sec('F2c · Coin flips or genuinely different arms? A decomposition',
    'Identity: two runs of the SAME arm disagree with prob 2p(1−p); runs of DIFFERENT arms with pA+pB−2pApB; the difference is exactly '
    'Σ(pA−pB)². Units: both curves count PROBLEMS — the dashed line is how many problems two identical runs disagree on (the coin share), '
    'a solid curve is how many EXTRA disagreements a cross-arm comparison adds because the p’s genuinely differ. Read as a decomposition of '
    'between-arm disagreement into coins + real, NOT as “signal must clear the dashed line”: detectability is the dots — filled dots mark caps '
    'where a one-sided within-problem permutation test gives p<0.05. grep-vs-base is per-problem-detectable only near $0.10 (its $1 advantage '
    'is a diffuse ~+0.1 drizzle: big Σd, tiny Σd²); snippet-vs-base is detectable at every cap; semantic-vs-grep and spawn-vs-snippet never are. '
    'The TOTAL solve-count effect Δ=Σd is a different (easier) question — tested by CMH/McNemar, where search-vs-base is p=0.0003 at $1. '
    'Left panel: per-arm within-noise (one pair each; ordering suggestive, counting noise ±3).',
    f'<div class="row">{pc}{sig_panel()}</div>')
sec('F2b · The ruler is itself a function of the cap',
    'Left: pooled flips across the 4 replicate pairs, moving-average smoothed over ±$0.05, with an approximate 95% sampling band; '
    'faint grey lines are the raw per-pair integer counts (context only — their jitter is counting noise, ±2–3). '
    'Most of the plateau is reached by ~$0.10; beyond that the band cannot distinguish slow growth from flat. F is not monotone by nature — '
    'a flip closes when the slower run catches up. Right: the resulting MDE(c): at $0.10 a k=1 comparison resolves ~7.4 solves (the low-cap search gap clears this); at $1, ~9.',
    f'<div class="row">{pa}{pb}</div>')

# ---------- F3 tool mix + checks-to-green + out/turn ----------
TOOLS = [('lean_check', '#2a78d6', 'compile graded file'), ('check_snippet', '#1baf7a', 'compile scratch snippet'),
         ('search', '#eb6834', 'search (grep+semantic)'), ('add_fact', '#4a3aa7', 'fact bank')]
ORDER = ['base','base r2','grep','grep r2','semantic','snippetonly','snippetonly r2','snippet','snippet r2','spawn','snippetfacts','spawnfacts','basequote']
def medtool(arm, key):
    if key == 'search':
        return st.median(((r.get('tool_calls') or {}).get('grep_mathlib', 0) + (r.get('tool_calls') or {}).get('search_mathlib', 0)) for r in DATA[arm].values())
    return st.median((r.get('tool_calls') or {}).get(key, 0) for r in DATA[arm].values())
b3 = []
y = 26
bx = lambda v: 130 + v / 200 * 480
for arm in ORDER:
    x = 130
    b3.append(T(124, y+11, arm, INK2, 11, 'end'))
    for key, col, lab in TOOLS:
        v = medtool(arm, key)
        wpx = v / 200 * 480
        if wpx > 0.5:
            b3.append(f'<rect x="{x:.1f}" y="{y}" width="{max(wpx-2,1):.1f}" height="14" rx="3" fill="{col}"><title>{arm}: median {lab} = {v:.0f}/attempt</title></rect>')
            if wpx > 26: b3.append(T(x+4, y+11, f'{v:.0f}', '#ffffff', 9, 'start', '600', tab=True))
        x += wpx
    b3.append(T(640, y+11, f'{SOLVED[arm]}', INK, 11, 'start', '600', tab=True))
    y += 21
b3.append(T(640, 16, 'solves', MUT, 10))
lg = 130
for key, col, lab in TOOLS:
    b3.append(f'<rect x="{lg}" y="{y+6}" width="12" height="12" rx="2" fill="{col}"/>')
    b3.append(T(lg+16, y+16, lab, INK2, 10))
    lg += 150
panel1 = svg(700, y+34, ''.join(b3))
# checks-to-first-green + out/turn dot plots
def dotplot(vals, title, xmax, unit, w=340):
    bb = [T(w/2, 13, title, INK, 12, 'middle', '600')]
    yy = 32
    for arm in ORDER:
        v = vals[arm]
        bb.append(T(124, yy+4, arm, INK2, 10, 'end'))
        bb.append(f'<line x1="130" y1="{yy}" x2="{w-14}" y2="{yy}" stroke="{GRID}"/>')
        cx = 130 + v / xmax * (w - 150)
        bb.append(f'<circle cx="{cx:.1f}" cy="{yy}" r="5" fill="{hue(arm)}"><title>{arm}: {v:.0f}{unit}</title></circle>')
        bb.append(T(cx+8, yy+4, f'{v:.0f}', INK, 10, 'start', tab=True))
        yy += 19
    return svg(w, yy+8, ''.join(bb))
c2g = {a: st.median(r['high_water']['first']['check_index'] for r in DATA[a].values()
                    if r['solved'] and (r.get('high_water') or {}).get('first')) for a in ORDER}
opt = {a: st.median(r['tokens']['out'] / max(r['turns'], 1) for r in DATA[a].values()) for a in ORDER}
panel2 = dotplot(c2g, 'graded-file compiles before first proof (solves)', 32, ' checks')
panel3 = dotplot(opt, 'output tokens per turn (median, all attempts)', 4200, ' tok/turn')
sec('F3 · How the arms actually work — tool mix, verification address, verbosity',
    'Top: median tool calls per attempt — the composition rotates completely (base: 73 graded compiles; snippetonly: 93 scratch compiles; spawnfacts: 2 graded compiles) '
    'while the solve rail (right) barely moves. Bottom-left: with scratch verification the graded compile becomes a notarization (28→2). '
    'Bottom-right: search arms think ~30% fewer tokens per step — lookup substitutes for chat-space derivation.',
    panel1 + f'<div class="row">{panel2}{panel3}</div>')

# ---------- F4 (spend, solves) plane ----------
b4 = []
W4, H4 = 640, 380
L4, R4, T4, B4 = 52, 14, 16, 36
xs4 = lambda v: L4 + (v - 38) / (54 - 38) * (W4 - L4 - R4)
ys4 = lambda v: T4 + (58 - v) / (58 - 38) * (H4 - T4 - B4)
for gv in range(38, 59, 4):
    b4.append(f'<line x1="{L4}" y1="{ys4(gv):.1f}" x2="{W4-R4}" y2="{ys4(gv):.1f}" stroke="{GRID}"/>')
    b4.append(T(L4-6, ys4(gv)+4, gv, MUT, 10, 'end', tab=True))
for gx in range(38, 55, 4):
    b4.append(T(xs4(gx), H4-14, f'${gx}', MUT, 10, 'middle', tab=True))
b4.append(T(W4/2, H4-2, 'spend at the $1 cap (cost_std, 90 problems)', MUT, 10, 'middle'))
b4.append(T(14, H4/2, 'solves', MUT, 10, 'middle') )
for a, b_ in PAIRS:
    b4.append(f'<line x1="{xs4(SPEND[a]):.1f}" y1="{ys4(SOLVED[a]):.1f}" x2="{xs4(SPEND[b_]):.1f}" y2="{ys4(SOLVED[b_]):.1f}" stroke="{INK2}" stroke-width="1.5" stroke-dasharray="4,3"><title>replicate pair {a}: same arm run twice</title></line>')
offs = {'base': (8,4),'base r2':(8,4),'grep':(8,4),'grep r2':(8,12),'semantic':(8,-6),'snippetonly':(8,4),
        'snippetonly r2':(8,4),'snippet':(8,-6),'snippet r2':(8,4),'spawn':(8,4),'snippetfacts':(-8,-8),
        'spawnfacts':(8,4),'basequote':(8,4)}
for arm in ORDER:
    x, yv = xs4(SPEND[arm]), ys4(SOLVED[arm])
    b4.append(f'<circle cx="{x:.1f}" cy="{yv:.1f}" r="6" fill="{hue(arm)}" stroke="#fcfcfb" stroke-width="2"><title>{arm}: {SOLVED[arm]}/90, ${SPEND[arm]:.2f}</title></circle>')
    dx, dy = offs[arm]
    anch = 'end' if dx < 0 else 'start'
    b4.append(T(x+dx, yv+dy, arm, INK2, 10, anch))
sec('F4 · The (spend, solves) plane — noise drawn on the same axes as effects',
    'Each dot is one complete cell; dashed segments join byte-identical replicate pairs. Same-arm distance is comparable to different-arm distance — '
    'that is the whole argument in one picture. Up and left is better.',
    svg(W4, H4, ''.join(b4)))

# ---------- F5 failure shape ----------
b5 = []
y = 26
for arm in ORDER:
    uns = [r for r in DATA[arm].values() if not r['solved']]
    capd = sum(1 for r in uns if r['end'] == 'budget_exceeded')
    frac = capd / len(uns)
    b5.append(T(124, y+11, arm, INK2, 11, 'end'))
    b5.append(f'<rect x="130" y="{y}" width="{frac*300:.1f}" height="14" rx="3" fill="#2a78d6"><title>{arm}: {capd}/{len(uns)} unsolved attempts ran to the $1 cap</title></rect>')
    b5.append(T(136+frac*300, y+11, f'{capd}/{len(uns)}', INK, 10, 'start', tab=True))
    mt = st.median(r['turns'] for r in uns)
    cx = 500 + mt / 420 * 220
    b5.append(f'<circle cx="{cx:.1f}" cy="{y+7}" r="5" fill="#eb6834"><title>{arm}: median {mt:.0f} turns among unsolved</title></circle>')
    b5.append(T(cx+8, y+11, f'{mt:.0f}', INK, 10, 'start', tab=True))
    y += 21
b5.append(T(130, 14, 'unsolved attempts that burned to the $1 cap', INK, 11, 'start', '600'))
b5.append(T(500, 14, 'median turns when unsolved', INK, 11, 'start', '600'))
sec('F5 · Block C failure shape — fewer turns, more dollars',
    'spawnfacts almost never gives up (its failures run to the cap) yet fails in the fewest turns: it fails by spending, not by thrashing. '
    'base gives up voluntarily on 45% of its failures with a median $0.65 still unspent.',
    svg(760, y+10, ''.join(b5)))

# ---------- F7b difficulty spectrum ----------
CELLS13 = list(ARMS)
frac = {p: sum(1 for a in CELLS13 if DATA[a][p]['solved']) / 13 for p in PROBS}
order7 = sorted(PROBS, key=lambda p: -frac[p])
b7 = []
W7 = 860
bw = (W7 - 130) / 90
SEQ = ['#cde2fb', '#9ec5f4', '#6da7ec', '#3987e5', '#256abf', '#184f95']
for i, p in enumerate(order7):
    f_ = frac[p]
    col = '#f0efec' if f_ == 0 else SEQ[min(int(f_ * 6), 5)]
    hpx = max(f_ * 150, 2)
    b7.append(f'<rect x="{60+i*bw:.1f}" y="{170-hpx:.1f}" width="{bw-1:.1f}" height="{hpx:.1f}" fill="{col}"><title>{p}: solved by {sum(1 for a in CELLS13 if DATA[a][p]["solved"])}/13 cells</title></rect>')
n_all = sum(1 for p in PROBS if frac[p] == 1)
n_none = sum(1 for p in PROBS if frac[p] == 0)
b7.append(T(60, 14, f'solved by all 13 cells: {n_all}', INK2, 11, 'start', '600'))
b7.append(T(60+n_all*bw+((90-n_all-n_none)/2)*bw, 14, f'contested: {90-n_all-n_none}', '#eb6834', 11, 'middle', '600'))
b7.append(T(W7-10, 14, f'by none: {n_none}', INK2, 11, 'end', '600'))
b7.append(f'<line x1="{60+n_all*bw:.1f}" y1="20" x2="{60+n_all*bw:.1f}" y2="172" stroke="{MUT}" stroke-dasharray="3,3"/>')
b7.append(f'<line x1="{60+(90-n_none)*bw:.1f}" y1="20" x2="{60+(90-n_none)*bw:.1f}" y2="172" stroke="{MUT}" stroke-dasharray="3,3"/>')
b7.append(f'<line x1="60" y1="170" x2="{W7-10}" y2="170" stroke="{BASE_AX}"/>')
b7.append(T(30, 100, 'share of', MUT, 9, 'start')); b7.append(T(30, 111, 'cells', MUT, 9, 'start'))
b7.append(T(W7/2, 192, '90 problems, sorted by how many of the 13 cells solved them', MUT, 10, 'middle'))
sec('F7b · The difficulty spectrum — where the experiment’s information lives',
    'Both shelves stay in frame: the middle band is the entire effective sample. This is why the noise floor is ~9 solves — '
    'and it is the honest version of any “contested problems” zoom.',
    svg(W7, 200, ''.join(b7)))

# ---------- F12 delta curves ----------
def dcurve(name):
    if name == 'search':   # (grep k2) - (base k2)
        return [(CURVE['grep'][i] + CURVE['grep r2'][i]) / 2 - (CURVE['base'][i] + CURVE['base r2'][i]) / 2 for i in range(101)]
    if name == 'spawn':
        return [CURVE['spawn'][i] - (CURVE['snippet'][i] + CURVE['snippet r2'][i]) / 2 for i in range(101)]
    return [CURVE['semantic'][i] - (CURVE['grep'][i] + CURVE['grep r2'][i]) / 2 for i in range(101)]
b12 = []
W12, H12 = 700, 300
L12, R12, T12, B12 = 48, 150, 16, 34
xs12 = lambda c: L12 + c * (W12 - L12 - R12)
ys12 = lambda v: T12 + (14 - v) / (14 - -8) * (H12 - T12 - B12)
band = ' '.join(f'{xs12(CAPS[i]):.1f},{ys12(min(MDE2[i],14)):.1f}' for i in range(101))
band += ' ' + ' '.join(f'{xs12(CAPS[i]):.1f},{ys12(max(-MDE2[i],-8)):.1f}' for i in range(100, -1, -1))
b12.append(f'<polygon points="{band}" fill="#f0efec" opacity="0.85"><title>±MDE(c) at k=2, pooled over the 4 replicate pairs</title></polygon>')
b12.append(T(xs12(0.02), ys12(5.4), 'inside this band = unresolved at k=2 (band = ±MDE at each cap)', MUT, 10))
for gv in range(-8, 15, 4):
    b12.append(f'<line x1="{L12}" y1="{ys12(gv):.1f}" x2="{W12-R12}" y2="{ys12(gv):.1f}" stroke="{GRID}"/>')
    b12.append(T(L12-6, ys12(gv)+4, f'{gv:+d}' if gv else '0', MUT, 10, 'end', tab=True))
b12.append(f'<line x1="{L12}" y1="{ys12(0):.1f}" x2="{W12-R12}" y2="{ys12(0):.1f}" stroke="{BASE_AX}" stroke-width="1.5"/>')
for cv in (0, 0.25, 0.5, 0.75, 1.0):
    b12.append(T(xs12(cv), H12-16, f'${cv:.2f}', MUT, 10, 'middle', tab=True))
CON = [('search', 'search − base (both k=2)', '#2a78d6'), ('spawn', 'spawn − snippet (k=2)', '#008300'), ('sem', 'semantic − grep (k=2)', '#1baf7a')]
for key, lab, col in CON:
    dv = dcurve(key)
    d = ' '.join(f'{"M" if i==0 else "L"}{xs12(CAPS[i]):.1f},{ys12(dv[i]):.1f}' for i in range(101))
    b12.append(f'<path d="{d}" fill="none" stroke="{col}" stroke-width="2"><title>{lab}</title></path>')
    b12.append(T(xs12(1.0)+6, ys12(dv[100])+4, f'{lab} {dv[100]:+.1f}', col, 10, 'start', '600'))
b12.append(T(W12/2, H12-2, 'budget cap', MUT, 10, 'middle'))
sec('F12 · Δsolves as a continuous function of the cap',
    'The search effect is large and positive at every cap and biggest around $0.10–$0.50 — the pre-registered $1 readout is its weakest point. '
    'spawn−snippet never leaves the noise band at any cap: the block C null is uniform in budget. Band = ±MDE at k=2 (draft; permutation band later).',
    svg(W12, H12, ''.join(b12)))

# ---------- F13 dollar decomposition ----------
b13 = []
y = 26
PARTS = [('thinking + writing (output tokens)', '#2a78d6'), ('re-reading the transcript (cache reads)', '#eb6834'), ('fresh input', '#1baf7a')]
for arm in ORDER:
    rows_ = DATA[arm].values()
    co = sum(r['tokens']['out'] * 0.28 / 1e6 for r in rows_)
    cc = sum(r['tokens'].get('cache_read', 0) * 0.0028 / 1e6 for r in rows_)
    ci = sum(r['tokens']['in'] * 0.14 / 1e6 for r in rows_)
    tot = co + cc + ci
    x = 130
    b13.append(T(124, y+11, arm, INK2, 11, 'end'))
    for share, (lab, col) in zip((co/tot, cc/tot, ci/tot), PARTS):
        wpx = share * 460
        b13.append(f'<rect x="{x:.1f}" y="{y}" width="{max(wpx-2,1):.1f}" height="14" rx="3" fill="{col}"><title>{arm}: {lab} = {share*100:.0f}% of ${tot:.2f}</title></rect>')
        if wpx > 34: b13.append(T(x+4, y+11, f'{share*100:.0f}%', '#ffffff', 9, 'start', '600', tab=True))
        x += wpx
    y += 21
lg = 130
for lab, col in PARTS:
    b13.append(f'<rect x="{lg}" y="{y+6}" width="12" height="12" rx="2" fill="{col}"/>')
    b13.append(T(lg+16, y+16, lab, INK2, 10))
    lg += 240
sec('F13 · Where the dollar goes',
    'Half to two-thirds of every arm’s spend is re-processing its own accumulated transcript, not thinking. '
    'spawnfacts inverts the ratio (short attempts, dense turns); semantic pays the most to re-read (search results bloat context).',
    svg(760, y+34, ''.join(b13)))

# ---------- write page ----------
page = f'''<!doctype html><html><head><meta charset="utf-8"><title>CMP draft figures 2026-08-17</title>
<style>
:root {{ color-scheme: light; }}
body {{ background:#f9f9f7; color:#0b0b0b; font-family:system-ui,-apple-system,"Segoe UI",sans-serif; margin:0; padding:28px; }}
section {{ background:#fcfcfb; border:1px solid rgba(11,11,11,0.10); border-radius:10px; padding:18px 22px; margin:0 auto 22px; max-width:960px; }}
h1 {{ font-size:20px; max-width:960px; margin:0 auto 6px; }}
.sub {{ color:#52514e; font-size:13px; max-width:960px; margin:0 auto 20px; }}
h2 {{ font-size:14px; margin:0 0 10px; }}
.cap {{ color:#52514e; font-size:12px; margin:8px 0 0; max-width:820px; }}
.row {{ display:flex; flex-wrap:wrap; gap:10px; }}
.tiles {{ display:flex; flex-wrap:wrap; gap:12px; }}
.tile {{ flex:1 1 180px; border:1px solid rgba(11,11,11,0.10); border-radius:8px; padding:12px 14px; }}
.tl {{ font-size:11px; color:#52514e; }}
.tv {{ font-size:17px; font-weight:650; margin:4px 0 2px; }}
.ts {{ font-size:11px; color:#898781; }}
</style></head><body>
<h1>CMP — draft figure set (2026-08-17)</h1>
<p class="sub">Working drafts for the blog plan — real numbers from the patched views, draft styling. Hover any mark for details.
Conditional-on-benchmark framing: bands/ladders come from replicate noise, not bootstrap.</p>
{''.join(S)}
</body></html>'''
os.makedirs(os.path.dirname(OUT), exist_ok=True)
open(OUT, 'w').write(page)
print(f'wrote {OUT} ({os.path.getsize(OUT)//1024} KB)')
print('sanity:', {a: SOLVED[a] for a in ORDER})
