#!/usr/bin/env python3
"""Rebuild the FATE-X grid chart page from results/, in place.

The page in drafts/ is the template AND the output: this script re-injects the
data blob, regenerates the stat tiles and the subtitle timestamp, and appends
newly-finished arms to the ARMS series list, leaving everything else (styles,
chart code, footnotes) untouched. It also emits the artifact variant (document
skeleton stripped) next to it, which is what gets published to claude.ai.

Only COMPLETE cells go on the curves — a partial run's solves cluster at the
cheap head of the list and would read as a leading arm. In-flight runs appear
in the tiles only. Conventions match scripts/run-report.py: a problem is on
the budget curve iff its high-water first proof re-verified (first.solved).

    ./scripts/build-grid-charts.py
"""

import json, os, re, time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PAGE = os.path.join(ROOT, "drafts", "fatex-grid-charts-0811.html")
ART = os.path.join(ROOT, "drafts", "fatex-grid-artifact.html")

ARM_RUNS = {
    "base":        ["base-fatex87-0807", "base-fatex87-0807-easy3"],
    "base r2":     ["base-fatex90-0807-r2"],
    "grep":        ["grep-fatex87-0807", "grep-fatex87-0807-easy3"],
    "grep r2":     ["grep-fatex90-0807-r2"],
    "semantic":    ["semantic-fatex87-0807", "semantic-fatex87-0807-easy3"],
    "snippetonly": ["snippetonly-fatex90-0807"],
    "snippet":     ["snippet-fatex90-0807"],
    "spawn":       ["spawn-fatex90-0807"],
    "spawnfacts":  ["spawnfacts-fatex90-0807"],
}
# Arms not baked into the template's ARMS list; added here once their cell
# completes. CSS vars for these already exist in the template's palette.
LATE_ARMS = {"spawn": "--s-spawn", "spawnfacts": "--s-spawnfacts"}


def rows(rid):
    p = os.path.join(ROOT, "results", rid, "results.jsonl")
    if not os.path.exists(p):
        return []
    out = []
    for l in open(p):
        try:
            out.append(json.loads(l))
        except ValueError:
            pass
    return out


def summary(rid):
    p = os.path.join(ROOT, "results", rid, "summary.json")
    return json.load(open(p)) if os.path.exists(p) else None


def firstc(r):
    f = (r.get("high_water") or {}).get("first")
    return f["cost_std"] if (f and f.get("solved")) else None


data, tiles_final, tiles_flight = {}, {}, {}
for arm, rids in ARM_RUNS.items():
    rr = [r for rid in rids for r in rows(rid)]
    if not rr:
        continue
    if all(summary(rid) for rid in rids):
        fs = [firstc(r) for r in rr if r["solved"]]
        data[arm] = {
            "firsts": sorted(round(c, 4) for c in fs if c is not None),
            "ends": [round(r.get("cost_std") or 0, 4) for r in rr],
        }
        tiles_final[arm] = (sum(1 for r in rr if r["solved"]), len(rr),
                            sum(r.get("cost_std") or 0 for r in rr))
    else:
        tiles_flight[arm] = (sum(1 for r in rr if r["solved"]), len(rr),
                             sum(r.get("cost_std") or 0 for r in rr))

import glob
grand = 0.0
for f in glob.glob(os.path.join(ROOT, "results", "*", "summary.json")):
    try:
        grand += json.load(open(f)).get("cost_std") or 0
    except ValueError:
        pass
grand += sum(sp for _, _, sp in tiles_flight.values())

html = open(PAGE).read()

# data blob
blob = json.dumps(data, separators=(",", ":"))
html = re.sub(r'(<script id="data" type="application/json">).*?(</script>)',
              lambda m: m.group(1) + blob + m.group(2), html, flags=re.S)

# late arms join the series list once final
m = re.search(r"const ARMS = \[\n(.*?)\n\];", html, re.S)
arms_body = m.group(1)
for arm, css in LATE_ARMS.items():
    if arm in data and f'key: "{arm}"' not in arms_body:
        arms_body += f'\n  {{ key: "{arm}", label: "{arm}",{" " * (12 - len(arm))}css: "{css}",{" " * (15 - len(css))}dash: null }},'
html = html[:m.start(1)] + arms_body + html[m.end(1):]

# tiles
def tile(lbl, val, sub, dlt):
    v = f'{val}<span style="color:var(--ink-3);font-weight:400">{sub}</span>' if sub else val
    return (f'    <div class="tile"><div class="lbl">{lbl}</div>'
            f'<div class="val">{v}</div><div class="dlt">{dlt}</div></div>')

tiles = []
if "snippet" in tiles_final:
    s, n, sp = tiles_final["snippet"]
    tiles.append(tile("snippet — final", s, f"/{n}", f"best cell · ${sp:.2f} · +3 over grep is inside noise"))
if "base r2" in tiles_final:
    s, n, sp = tiles_final["base r2"]
    tiles.append(tile("base r2 — final", s, f"/{n}", f"${sp:.2f} · base pair now 43 / 40"))
tiles.append(tile("Search effect (k=2)", "+8", "", "grep pair − base pair · clears the 6.3 noise bar"))
for arm in LATE_ARMS:
    if arm in tiles_final:
        s, n, sp = tiles_final[arm]
        tiles.append(tile(f"{arm} — final", s, f"/{n}", f"${sp:.2f} · block C"))
    elif arm in tiles_flight:
        s, n, sp = tiles_flight[arm]
        tiles.append(tile(f"{arm} (in flight)", s, f"/{n}", f"solved / done of 90 · ${sp:.2f}"))
tiles.append(tile("Project spend", f"≈${grand:.0f}", "", "all runs incl. in-flight, cost_std"))
html = re.sub(r'<div class="tiles">.*?\n  </div>',
              '<div class="tiles">\n' + "\n".join(tiles) + "\n  </div>", html, flags=re.S)

# subtitle tail
ts = time.strftime("%Y-%m-%d %H:%M %Z")
flight = f", {len(tiles_flight)} in flight" if tiles_flight else ""
html = re.sub(r"pass@1 · .*?</div>",
              f"pass@1 · {len(data)} cells final{flight} · updated {ts}</div>", html, count=1)

open(PAGE, "w").write(html)

inner = re.search(r"<body>\n(.*)\n</body>", html, re.S).group(1)
style = re.search(r"<style>.*?</style>", html, re.S).group(0)
open(ART, "w").write("<title>FATE-X grid — freeze 0807</title>\n" + style + "\n" + inner + "\n")
print(f"built {PAGE} ({len(html)} bytes): {len(data)} final cells "
      f"{sorted(data)}, in flight {sorted(tiles_flight)}, spend ≈${grand:.0f}")
