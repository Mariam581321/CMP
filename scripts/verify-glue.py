#!/usr/bin/env python3
"""Independent re-derivation of the glued grid view from raw results/ dirs, checked
against mined/attempts.jsonl. Rules re-implemented from:
  - the rerun patch views (patched views stack: cwrerun > fgrerun > raw)
  - results/402-rerun-list-0816.json glue_rule       (snippetonly r2 split: keep-last per dir,
                                                       one real verdict per problem across dirs)
"""
import json, os, glob, collections, sys
ROOT = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
R = os.path.join(ROOT, "results")

def rows(p):
    out = []
    if os.path.exists(p):
        for l in open(p):
            l = l.strip()
            if l:
                try: out.append(json.loads(l))
                except ValueError: pass
    return out

def keep_last(rs):
    d = {}
    for r in rs: d[r["problem"]] = r
    return d

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
    "snippetonly r2": ["snippetonly-fatex90-0807-r2", "snippetonly-fatex90-0807-r2-laptop",
                       "snippetonly-fatex90-0807-r2-laptop-mid"],
    "basequote":    ["basequote-fatex90-0813"],
}
SAFE90 = [l.strip() for l in open(os.path.join(ROOT, "problems-fatex/safe90.txt")) if l.strip()]
assert len(SAFE90) == 90

mined = [json.loads(l) for l in open(os.path.join(ROOT, "mined/attempts.jsonl"))]
M = {(r["arm"], r["problem"]): r for r in mined}
problems_mined = sorted({r["problem"] for r in mined})
print(f"safe90 == mined problem set: {set(SAFE90) == set(problems_mined)}")

fails = []
def check(cond, msg):
    if not cond:
        fails.append(msg); print("  FAIL:", msg)

# ---------------------------------------------------------------- 1. rebuild views from scratch
print("\n== 1. Rebuild glued view per arm from raw dirs (reruns stacked by rule), compare to mined")
rerun_dirs = collections.defaultdict(list)   # base cell -> [(rid, kind)]
for d in sorted(os.listdir(R)):
    for kind in ("cwrerun2", "cwrerun", "fgrerun"):
        if d.endswith("-" + kind):
            rerun_dirs[d[: -len(kind) - 1]].append((d, kind))
print("rerun dirs found:", dict(rerun_dirs))

view = {}
for arm, rids in CELLS.items():
    if arm == "snippetonly r2":
        continue  # handled in section 3
    v = {}
    for rid in rids:
        raw = keep_last(rows(os.path.join(R, rid, "results.jsonl")))
        v.update(raw)
        # stack reruns: fgrerun first, then cwrerun, then cwrerun2 (later supersedes)
        for kind in ("fgrerun", "cwrerun", "cwrerun2"):
            for rd, k in rerun_dirs.get(rid, []):
                if k == kind:
                    rr = keep_last(rows(os.path.join(R, rd, "results.jsonl")))
                    for p, r in rr.items():
                        check(p in v, f"{arm}: rerun {rd} has {p} not in base view")
                        v[p] = r
    view[arm] = v
    # Compare to the shipped patched view file, if any
    for rid in rids:
        for suf in ("-cwrerun-patched.results.jsonl", "-fgrerun-patched.results.jsonl"):
            pf = os.path.join(R, rid + suf)
            if os.path.exists(pf) and suf.startswith("-cwrerun"):
                pv = keep_last(rows(pf))
                for p, r in pv.items():
                    mine = v[p]
                    check(mine["run_id"] == r["run_id"] and mine["solved"] == r["solved"]
                          and abs(mine["cost_std"] - r["cost_std"]) < 1e-9,
                          f"{arm}/{p}: shipped patched view {os.path.basename(pf)} run_id={r['run_id']} solved={r['solved']} cost={r['cost_std']} vs rebuilt {mine['run_id']} {mine['solved']} {mine['cost_std']}")
    check(len(v) == 90, f"{arm}: view has {len(v)} problems")
    check(set(v) == set(SAFE90), f"{arm}: view problem set != safe90")

for arm, v in view.items():
    nd = 0
    for p, r in v.items():
        m = M.get((arm, p))
        check(m is not None, f"{arm}/{p}: missing from mined")
        if m is None: continue
        ok = (m["run_id"] == r["run_id"] and m["row_solved"] == r["solved"]
              and m["row_end"] == r["end"] and abs(m["row_cost_std"] - r["cost_std"]) < 1e-9
              and m["row_nudges"] == r["nudges"])
        check(ok, f"{arm}/{p}: mined run_id={m['run_id']} solved={m['row_solved']} end={m['row_end']} cost={m['row_cost_std']} vs rebuilt {r['run_id']} {r['solved']} {r['end']} {r['cost_std']}")
        nd += ok
    print(f"  {arm:14s} {nd}/90 rows identical to rebuilt view; solved={sum(1 for r in v.values() if r['solved'])}; patched rows={sum(1 for r in v.values() if r.get('cwrerun') or r.get('fgrerun') or ('rerun' in r['run_id']))}")

# ---------------------------------------------------------------- 2. every audited death / false green is replaced
print("\n== 2. Every context-wall death and false green is replaced by a rerun row")
cw = json.load(open(os.path.join(R, "context-wall-audit-0815.json")))
deaths = [(x["run"], x["problem"]) for x in cw["dead"]]
deaths += [("basequote-fatex90-0813", "fatex_18"), ("basequote-fatex90-0813", "fatex_20"),
           ("base-fatex87-0807", "fatex_33")]  # round 2
fg = json.load(open(os.path.join(R, "falsegreen-audit-0811.json")))
fgs = [(x["run"], x["problem"]) for x in fg["false_green"]] + [(x["run"], x["problem"]) for x in fg["recovered"]]
arm_of = {rid: arm for arm, rids in CELLS.items() for rid in rids}
for (run, p), want in [(d, "cwrerun") for d in deaths] + [(f, "fgrerun") for f in fgs]:
    if run not in arm_of:  # 0805 invalidated cells etc.
        print(f"  (skip {run}/{p}: not a grid cell)"); continue
    arm = arm_of[run]
    m = M[(arm, p)]
    rid = m["run_id"]
    if (run, p) == ("base-fatex87-0807", "fatex_33"):
        good = rid.endswith("cwrerun2")  # fgrerun of 33 itself died at the wall -> cwrerun2 supersedes
    else:
        good = rid.endswith(want)
    check(good, f"{arm}/{p}: expected a -{want} row, mined uses {rid}")
    check(m["row_end"] != "agent_died", f"{arm}/{p}: rerun row end={m['row_end']}")
    # the rerun dir must have closed (summary.json)
    check(os.path.exists(os.path.join(R, rid, "summary.json")), f"{rid}: no summary.json")
    print(f"  {arm:14s} {p:9s} {want:8s} -> {rid:40s} end={m['row_end']:15s} solved={m['row_solved']} cost={m['row_cost_std']:.3f} nudges={m['row_nudges']}")
print("  partial (compacted once, survived, NOT rerun by design):",
      [(x["run"], x["problem"], x["end"]) for x in cw["partial"]])

# ---------------------------------------------------------------- 3. snippetonly r2 split-cell glue (server A + laptop + laptop-mid)
print("\n== 3. snippetonly r2: server/laptop split + 402 resumes, re-derived from raw dirs")
dirs = CELLS["snippetonly r2"]
per_dir = {rid: keep_last(rows(os.path.join(R, rid, "results.jsonl"))) for rid in dirs}
for rid, d in per_dir.items():
    allr = rows(os.path.join(R, rid, "results.jsonl"))
    print(f"  {rid}: {len(allr)} rows, {len(d)} problems after keep-last, "
          f"ends={dict(collections.Counter(r['end'] for r in d.values()))}, resumed={sum(1 for r in d.values() if r.get('resumed'))}")
glue = {}
for p in SAFE90:
    cands = [(rid, per_dir[rid][p]) for rid in dirs if p in per_dir[rid]]
    real = [(rid, r) for rid, r in cands if r["end"] != "agent_died"]
    check(len(real) == 1, f"snippetonly r2/{p}: {len(real)} real verdicts across dirs: {[(rid, r['end'], r['cost_std']) for rid, r in cands]}")
    if real:
        glue[p] = real[0][1]
lst = json.load(open(os.path.join(R, "402-rerun-list-0816.json")))
laptop_owned = set(lst["cell_snippetonly_r2"]["real_verdicts_banked"]["laptop"]) | set(lst["cell_snippetonly_r2"]["resume_laptop_owned_on_server"]["snippetonly-fatex90-0807-r2-laptop"]) | set(lst["cell_snippetonly_r2"]["resume_laptop_owned_on_server"]["snippetonly-fatex90-0807-r2-laptop-mid"])
for p, r in glue.items():
    if p in laptop_owned:
        check("laptop" in r["run_id"], f"snippetonly r2/{p}: laptop-owned but glued from {r['run_id']}")
    else:
        check(r["run_id"] == "snippetonly-fatex90-0807-r2", f"snippetonly r2/{p}: A-owned but glued from {r['run_id']}")
    m = M[("snippetonly r2", p)]
    ok = (m["run_id"] == r["run_id"] and m["row_solved"] == r["solved"] and m["row_end"] == r["end"]
          and abs(m["row_cost_std"] - r["cost_std"]) < 1e-9)
    check(ok, f"snippetonly r2/{p}: mined {m['run_id']} {m['row_solved']} {m['row_end']} {m['row_cost_std']} vs glue {r['run_id']} {r['solved']} {r['end']} {r['cost_std']}")
shipped = keep_last(rows(os.path.join(R, "snippetonly-fatex90-0807-r2-cwrerun-patched.results.jsonl")))
for p, r in shipped.items():
    g = glue.get(p)
    check(g and g["run_id"] == r["run_id"] and g["solved"] == r["solved"] and abs(g["cost_std"] - r["cost_std"]) < 1e-9,
          f"snippetonly r2/{p}: shipped patched view differs from re-derived glue")
print(f"  glued: {len(glue)}/90; from A={sum(1 for r in glue.values() if r['run_id'].endswith('-r2'))}, "
      f"laptop={sum(1 for r in glue.values() if r['run_id'].endswith('-laptop'))}, laptop-mid={sum(1 for r in glue.values() if r['run_id'].endswith('-laptop-mid'))}; "
      f"solved={sum(1 for r in glue.values() if r['solved'])}; resumed rows={sum(1 for r in glue.values() if r.get('resumed'))}")
resumed_exp = set(lst["cell_snippetonly_r2"]["resume_A_owned"]["problems"]) | set(lst["cell_snippetonly_r2"]["resume_laptop_owned_on_server"]["snippetonly-fatex90-0807-r2-laptop"]) | set(lst["cell_snippetonly_r2"]["resume_laptop_owned_on_server"]["snippetonly-fatex90-0807-r2-laptop-mid"])
resumed_got = {p for p, r in glue.items() if r.get("resumed")}
print(f"  resumed expected per 402 list: {sorted(resumed_exp, key=lambda s:int(s[6:]))}")
print(f"  resumed actually glued:        {sorted(resumed_got, key=lambda s:int(s[6:]))}")
print(f"  diff exp-got={sorted(resumed_exp-resumed_got)} got-exp={sorted(resumed_got-resumed_exp)}")
# fatex_19 regrade
rg = json.load(open(os.path.join(R, "snippetonly-fatex90-0807-r2-fatex19-regrade.json")))
print(f"  fatex_19 regrade file: solved={rg['solved']} reason={rg['reason']}; glued row solved={glue['fatex_19']['solved']} reason={glue['fatex_19']['grade'].get('reason')} end={glue['fatex_19']['end']}")

# ---------------------------------------------------------------- 4. resumed rows everywhere: cost & first-green integrity in mined
print("\n== 4. Resumed attempts (402 outage) across all cells: mined session integrity")
res_rows = []
for m in mined:
    # find the raw row in its run dir
    raw = keep_last(rows(os.path.join(R, m["run_id"], "results.jsonl"))).get(m["problem"])
    if raw and raw.get("resumed"):
        res_rows.append((m, raw))
print(f"  resumed rows in mined grid: {len(res_rows)}")
for m, raw in res_rows:
    hwf = (m["hw"] or {}).get("first") or {}
    fgc = (m["first_green"] or {}).get("cost_at")
    note = ""
    if hwf.get("solved") and fgc is not None and abs(fgc - hwf["cost_std"]) > 0.005:
        note = f"  first-green cost corrected hw={hwf['cost_std']:.3f} -> mined={fgc:.3f}"
    check(m["n_session_files"] == 1, f"{m['arm']}/{m['problem']}: {m['n_session_files']} session files")
    print(f"  {m['arm']:14s} {m['problem']:9s} {m['run_id']:42s} end={raw['end']:15s} solved={raw['solved']} cost={raw['cost_std']:.3f} prior_end={raw.get('prior_end')}{note}")

# ---------------------------------------------------------------- 5. global sanity on mined
print("\n== 5. Global sanity on mined rows")
check(all(m["row_end"] != "agent_died" for m in mined), "some mined row is agent_died")
# tok_relerr compares the MAIN session to the record; spawn rows also carry worker tokens
for m in mined:
    mt = dict(m["mined_tokens"])
    for w_ in m["workers"]:
        for k_, v_ in w_["tokens"].items():
            mt[k_] = mt.get(k_, 0) + v_
    rel = max(abs(mt[k_] - m["row_tokens"][k_]) / max(m["row_tokens"][k_], 1) for k_ in ("in", "out"))
    check(rel <= 0.01, f"{m['arm']}/{m['problem']}: worker-inclusive token mismatch {rel:.3f}")
check(all(m["n_session_files"] == 1 for m in mined), "multi-session attempt")
bad_hw = []
for m in mined:
    hwf = (m["hw"] or {}).get("first") or {}
    if m["ever_green"] and hwf.get("solved") and abs(m["first_green"]["cost_at"] - hwf["cost_std"]) > 0.005:
        bad_hw.append((m["arm"], m["problem"], hwf["cost_std"], m["first_green"]["cost_at"]))
    check(bool(m["ever_green"]) == bool(hwf.get("solved")) or not hwf, f"{m['arm']}/{m['problem']}: ever_green={m['ever_green']} but hw.first.solved={hwf.get('solved')}")
print("  first-green cost differs from recorded high_water (>0.5c):", bad_hw)
# session file actually lives in the run dir the row claims
for m in mined:
    sd = os.path.join(R, m["run_id"], m["problem"], "session")
    check(os.path.isdir(sd) and len(os.listdir(sd)) >= 1, f"{m['arm']}/{m['problem']}: no session dir under {m['run_id']}")

print(f"\n==== {len(fails)} failures")
sys.exit(1 if fails else 0)
