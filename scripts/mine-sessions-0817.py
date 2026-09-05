#!/usr/bin/env python3
"""Session miner — recompute everything from raw events, trusting nothing.

For every attempt in the 13 fatex90 cells (patched views, snippetonly-r2 glue),
parse the session event logs (main + workers) and extract:

  * cumulative cost_std timeline (assistant usage re-priced at STD_PRICES,
    worker spend merged by timestamp for spawn arms)
  * the full check trajectory: every lean_check result parsed into
    (status, errors, sorries, stmt flag, md5, cost-at-check, turn)
  * first green (first COMPLETE lean_check) — recomputed, then cross-checked
    against the recorded high_water stamp
  * user messages ≥2 classified: real nudge / output-cutoff nudge / other; each nudge
    also carries whether it named a modified statement and what ended the turn before
    it (stopReason). A GIVE-UP is a nudge after a turn the agent ended itself
    (stopReason == "stop") with the statement intact: cutoffs, transport errors and
    statement-restore nudges are the harness's business, not the agent giving up
    (Mariam, 2026-08-29). first_giveup is what the paper's harness scores on.
  * post-green segment: cost, tool calls, checks, wrecks, final vs green md5
  * error fingerprints (normalized body hash) for stuck-loop detection
  * spawn usage: calls, worker count, worker cost/tools, task text heads
  * pre_giveup: the same tool / turn / compaction / worker counts restricted to what
    happened before the first give-up -- the no-nudge harness's view of the attempt's
    behaviour, which is what paper/data/behaviour.csv reports

Selection of session files: an attempt dir may hold several session files
(promptless resume, or a discarded earlier attempt superseded by keep-last).
We pick the suffix of the time-sorted file list whose summed assistant usage
best matches the row's recorded tokens; the match quality is recorded so
validation can flag the attempts where this was ambiguous.

Writes mined/attempts.jsonl, mined/catalog.json, mined/validation.json
(all under the worktree the script lives in).
"""

import json, os, re, sys, glob, hashlib
from collections import Counter, defaultdict

HERE = os.path.dirname(os.path.abspath(__file__))
WT = os.path.dirname(HERE)
CMP = WT
RES = os.path.join(CMP, "results")
OUTDIR = os.path.join(WT, "mined")
os.makedirs(OUTDIR, exist_ok=True)

STD = {"in": 0.14, "cache_read": 0.0028, "out": 0.28}
def cost_std(tin, tout, tcr):
    return (tin * STD["in"] + tcr * STD["cache_read"] + tout * STD["out"]) / 1e6

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

def load_rows(path):
    out = []
    if os.path.exists(path):
        for l in open(path):
            try:
                out.append(json.loads(l))
            except ValueError:
                pass
    return out

def cell_rows(name):
    """Resolve the patched view of a cell (context-wall rerun > false-green rerun > raw)."""
    d, patched = {}, None
    for rid in CELLS[name]:
        base = os.path.join(RES, rid)
        patch = None
        for suf, kind in (("-cwrerun-patched.results.jsonl", "cwrerun"),
                          ("-fgrerun-patched.results.jsonl", "fgrerun")):
            if os.path.exists(base + suf):
                patch, patched = base + suf, kind
                break
        rows = load_rows(patch) if patch else load_rows(os.path.join(base, "results.jsonl"))
        for r in rows:
            d[r["problem"]] = r
    return d, patched

# ---------------------------------------------------------------- check parsing

CAT = {"unknown_check_heads": Counter(), "other_user_heads": Counter(),
       "stop_reasons": Counter(), "session_pick": Counter()}

RE_MD5 = re.compile(r"md5 ([0-9a-f]{6,})")
RE_BYTES = re.compile(r"\((\d+) bytes")
RE_FAILED = re.compile(r"^FAILED — (\d+) errors?, (\d+) sorr")
RE_FAILED1 = re.compile(r"^FAILED — (\d+) errors?")
RE_INC = re.compile(r"^INCOMPLETE — no errors, (\d+) sorr")

def parse_check(txt):
    """-> dict(status, errors, sorries, stmt_mod, md5, noop) status in C/I/F/S/X"""
    md5 = (RE_MD5.search(txt) or [None, None])[1]
    lines = [l.strip() for l in txt.split("\n") if l.strip()]
    head = ""
    for l in lines:
        if l.startswith("checked ") or l.startswith("NOTE:"):
            continue
        head = l
        break
    stmt_mod = ("STATEMENT MODIFIED" in txt) or ("you modified the theorem statement" in txt)
    noop = "byte-identical to your previous lean_check" in txt
    errors = sorries = 0
    if head.startswith("COMPLETE"):
        status = "C"
    elif head.startswith("INCOMPLETE"):
        status = "I"
        m = RE_INC.match(head)
        sorries = int(m.group(1)) if m else 1
    elif head.startswith("FAILED"):
        status = "F"
        m = RE_FAILED.match(head)
        if m:
            errors, sorries = int(m.group(1)), int(m.group(2))
        else:
            m = RE_FAILED1.match(head)
            errors = int(m.group(1)) if m else 1
    elif head.startswith("CHECK FAILED"):
        status = "S" if stmt_mod else "X"
    elif (head.startswith("lean_check could not compile") or
          head.startswith("lean_check unavailable") or
          head.startswith("CHECK REJECTED")):
        status = "U"  # infrastructure-unavailable / policy rejection, not a compile verdict
    else:
        status = "X"
        CAT["unknown_check_heads"][head[:80]] += 1
    # fingerprint: body minus the volatile "checked <path> (bytes, md5)" line
    body = "\n".join(l for l in lines if not l.startswith("checked "))
    fp = hashlib.md5(body.encode()).hexdigest()[:10]
    return {"status": status, "errors": errors, "sorries": sorries,
            "stmt_mod": stmt_mod, "md5": md5, "noop": noop, "fp": fp}

def classify_user(txt):
    t = txt.lstrip()
    if t.startswith("You are not done."):
        return "nudge"
    if t.startswith("Your last message hit the output-token limit"):
        return "cutoff"
    return "other"

# ---------------------------------------------------------------- session parsing

def read_events(path):
    ev = []
    with open(path) as f:
        for l in f:
            try:
                ev.append(json.loads(l))
            except ValueError:
                pass
    return ev

def content_text(content):
    if isinstance(content, str):
        return content
    out = []
    for c in content or []:
        if isinstance(c, dict) and c.get("type") in (None, "text") and c.get("text"):
            out.append(c["text"])
    return "\n".join(out)

def session_usage_sum(events):
    tin = tout = tcr = 0
    for e in events:
        if e.get("type") != "message":
            continue
        m = e.get("message") or {}
        if m.get("role") != "assistant":
            continue
        u = m.get("usage") or {}
        tin += u.get("input") or 0
        tout += u.get("output") or 0
        tcr += u.get("cacheRead") or 0
    return tin, tout, tcr

def pick_session_files(sdir, want):
    """Choose the suffix of time-sorted session files whose usage best matches
    the recorded tokens (want = dict in/out/cache_read or None). Returns
    (events, pick_desc, rel_err)."""
    files = sorted(glob.glob(os.path.join(sdir, "*.jsonl")))
    if not files:
        return [], "none", None
    per_file = [read_events(f) for f in files]
    # dedupe across files by event id (promptless resume may replay history)
    def merged(suffix):
        seen, out = set(), []
        for evs in suffix:
            for e in evs:
                eid = e.get("id")
                if eid is not None and eid in seen:
                    continue
                if eid is not None:
                    seen.add(eid)
                out.append(e)
        return out
    if want is None:
        return merged(per_file), f"all{len(files)}", None
    tgt = (want.get("in") or 0, want.get("out") or 0, want.get("cache_read") or 0)
    best = None
    for start in range(len(per_file)):
        evs = merged(per_file[start:])
        tin, tout, tcr = session_usage_sum(evs)
        err = sum(abs(a - b) for a, b in zip((tin, tout, tcr), tgt)) / max(1, sum(tgt))
        cand = (err, start, evs)
        if best is None or err < best[0] - 1e-12:
            best = cand
    err, start, evs = best
    desc = f"suffix{start}of{len(per_file)}"
    CAT["session_pick"][desc] += 1
    return evs, desc, round(err, 5)

def mine_worker_curve(wdir):
    """-> (cost_curve [(ts, cum_cost)], summary dict) for one worker."""
    sessions = sorted(glob.glob(os.path.join(wdir, "session", "*.jsonl")))
    pts, tin = [], 0
    tout = tcr = 0
    tools = Counter()
    call_ts = []          # (ts, tool name) for every tool call, for the give-up censor
    for f in sessions:
        for e in read_events(f):
            if e.get("type") != "message":
                continue
            m = e.get("message") or {}
            if m.get("role") == "assistant":
                u = m.get("usage") or {}
                tin += u.get("input") or 0
                tout += u.get("output") or 0
                tcr += u.get("cacheRead") or 0
                pts.append((e.get("timestamp") or "", cost_std(tin, tout, tcr)))
                for c in m.get("content") or []:
                    if isinstance(c, dict) and c.get("type") == "toolCall":
                        tools[c.get("name")] += 1
                        call_ts.append((e.get("timestamp") or "", c.get("name")))
    return pts, {"tokens": {"in": tin, "out": tout, "cache_read": tcr},
                 "cost_std": cost_std(tin, tout, tcr), "tool_calls": dict(tools),
                 "_call_ts": call_ts}

# ---------------------------------------------------------------- attempt miner

def mine_attempt(arm, prob, row):
    rid = row.get("run_id")
    pdir = os.path.join(RES, rid, prob)
    sdir = os.path.join(pdir, "session")
    want = row.get("tokens")
    events, pick, tok_err = pick_session_files(sdir, want)
    out = {"arm": arm, "problem": prob, "run_id": rid,
           "row_solved": bool(row.get("solved")),
           "row_end": row.get("end"), "row_nudges": row.get("nudges"),
           "row_cost_std": row.get("cost_std"),
           "row_workers_cost_std": row.get("workers_cost_std") or 0,
           "row_grade_reason": (row.get("grade") or {}).get("reason"),
           "row_tokens": want, "row_turns": row.get("turns"),
           "row_tool_calls": row.get("tool_calls") or {},
           "hw": (row.get("high_water") or {}),
           "session_pick": pick, "tok_relerr": tok_err,
           "n_session_files": len(glob.glob(os.path.join(sdir, "*.jsonl")))}
    if not events:
        out["no_session"] = True
        return out

    # worker cost curves (spawn arms)
    wcurves, workers = [], []
    for wdir in sorted(glob.glob(os.path.join(pdir, "workers", "w*"))):
        pts, summ = mine_worker_curve(wdir)
        wcurves.append(pts)
        wj = os.path.join(wdir, "worker.json")
        if os.path.exists(wj):
            summ["worker_json"] = {k: v for k, v in json.load(open(wj)).items()
                                   if k in ("idx", "end", "turns", "cost_std", "task")}
            summ["worker_json"]["task"] = (summ["worker_json"].get("task") or "")[:120]
        workers.append(summ)
    def wcost_at(ts):
        # cumulative across workers: sum of each worker's cost at ts
        return sum(max((c for t, c in cur if t <= ts), default=0.0) for cur in wcurves)

    tin = tout = tcr = 0
    turns = 0
    cur_cost = 0.0
    checks = []           # per lean_check dicts
    snippet_checks = 0
    tools = Counter()
    call_ts = []          # (ts, tool name) for every main-agent tool call
    compaction_ts = []
    stop_reasons = Counter()
    truncations = 0
    last_sr = None        # stopReason of the latest assistant message
    users = []            # (idx, ts, class, cost_at, head)
    first_green = None
    compactions = 0
    first_ts = last_ts = None
    cost_curve = []       # sparse (turn, ts, cum_cost) every assistant msg

    for e in events:
        ts = e.get("timestamp") or ""
        et = e.get("type")
        if et == "compaction":
            compactions += 1
            compaction_ts.append(ts)
            continue
        if et != "message":
            continue
        m = e.get("message") or {}
        role = m.get("role")
        if first_ts is None:
            first_ts = ts
        last_ts = ts
        if role == "assistant":
            turns += 1
            u = m.get("usage") or {}
            tin += u.get("input") or 0
            tout += u.get("output") or 0
            tcr += u.get("cacheRead") or 0
            cur_cost = cost_std(tin, tout, tcr)
            sr = m.get("stopReason")
            last_sr = sr
            stop_reasons[sr] += 1
            CAT["stop_reasons"][sr] += 1
            if sr in ("maxTokens", "max_tokens", "length"):
                truncations += 1
            cost_curve.append((turns, ts, round(cur_cost, 6)))
            for c in m.get("content") or []:
                if isinstance(c, dict) and c.get("type") == "toolCall":
                    tools[c.get("name")] += 1
                    call_ts.append((ts, c.get("name")))
                    if c.get("name") == "spawn_subagents":
                        args = c.get("arguments") or {}
                        tasks = args.get("tasks") or []
                        out.setdefault("spawn_calls", []).append(
                            {"turn": turns, "ts": ts, "cost_at": round(cur_cost, 5),
                             "n_tasks": len(tasks),
                             "task_heads": [(str(t.get("task", "")) if isinstance(t, dict) else str(t))[:100]
                                            for t in tasks[:6]]})
        elif role == "toolResult":
            tn = m.get("toolName")
            txt = content_text(m.get("content"))
            if tn == "lean_check":
                pc = parse_check(txt)
                pc.update({"turn": turns, "ts": ts,
                           "cost_at": round(cur_cost + (wcost_at(ts) if wcurves else 0.0), 5),
                           "is_error": bool(m.get("isError"))})
                checks.append(pc)
                if first_green is None and pc["status"] == "C":
                    first_green = pc
                    first_green_idx = len(checks) - 1
            elif tn == "check_snippet":
                snippet_checks += 1
        elif role == "user":
            txt = content_text(m.get("content"))
            cls = classify_user(txt)
            if users:  # beyond the first (the prompt)
                if cls == "other":
                    CAT["other_user_heads"][txt.lstrip()[:80]] += 1
            users.append({"idx": len(users), "ts": ts, "class": cls,
                          "stmt": "IMPORTANT: you modified the theorem statement" in txt,
                          "prev_stop": last_sr,
                          "cost_at": round(cur_cost + (wcost_at(ts) if wcurves else 0.0), 5),
                          "turn": turns})

    total_cost = cur_cost + (wcost_at("9999") if wcurves else 0.0)
    interventions = [u for u in users[1:]]
    nudges = [u for u in interventions if u["class"] == "nudge"]
    giveups = [u for u in nudges if not u["stmt"] and u["prev_stop"] == "stop"]
    cutoffs = [u for u in interventions if u["class"] == "cutoff"]
    others = [u for u in interventions if u["class"] == "other"]

    # post-green segment
    post = None
    if first_green is not None:
        gi = first_green_idx
        post_checks = checks[gi + 1:]
        gturn = first_green["turn"]
        post_turns = turns - gturn
        post = {
            "checks_after": len(post_checks),
            "statuses_after": "".join(c["status"] for c in post_checks)[:200],
            "cost_after": round(total_cost - first_green["cost_at"], 5),
            "turns_after": post_turns,
            "final_md5": checks[-1]["md5"] if checks else None,
            "green_md5": first_green["md5"],
            "final_differs": bool(checks and checks[-1]["md5"] != first_green["md5"]),
            "last_status": checks[-1]["status"] if checks else None,
            "regreened": any(c["status"] == "C" for c in post_checks[-1:]),
            "wrecked_final": bool(checks and checks[-1]["status"] != "C"),
            "nudges_after": sum(1 for u in nudges if u["turn"] >= gturn),
        }

    # stuck loops: longest run of identical fingerprints among non-C checks
    max_streak, cur_s, prev_fp = 0, 0, None
    n_noop = 0
    for c in checks:
        if c["noop"]:
            n_noop += 1
        if c["status"] != "C" and c["fp"] == prev_fp:
            cur_s += 1
        else:
            cur_s = 1
        prev_fp = c["fp"]
        max_streak = max(max_streak, cur_s)

    # trajectory (compact): cost, errors, sorries, status per check
    traj = [[c["cost_at"], c["errors"], c["sorries"], c["status"]] for c in checks]

    # greens before first intervention (for the no-nudge counterfactual)
    fi_any = interventions[0] if interventions else None
    fi_nudge = nudges[0] if nudges else None
    fi_give = giveups[0] if giveups else None
    def green_before(u):
        if u is None:
            return None
        return bool(first_green and first_green["ts"] <= u["ts"])

    # The no-nudge view: everything the attempt did strictly before its first give-up
    # (the give-up nudge is a user message, so every call of the turn before it sorts
    # earlier). Without a give-up the view is the whole attempt. Worker calls are
    # censored on the same clock; a worker's cost is its curve at the give-up.
    give_ts = fi_give["ts"] if fi_give else None
    before = lambda t: give_ts is None or t < give_ts
    pre_workers = []
    for w, cur in zip(workers, wcurves):
        wt = Counter(n for t, n in w["_call_ts"] if before(t))
        pre_workers.append({
            "started": bool(cur) and before(cur[0][0]),
            "cost_std": (max((c for t, c in cur if before(t)), default=0.0)),
            "tool_calls": dict(wt)})
    pre_giveup = {
        "tools": dict(Counter(n for t, n in call_ts if before(t))),
        "turns": fi_give["turn"] if fi_give else turns,
        "compactions": sum(1 for t in compaction_ts if before(t)),
        "n_workers": sum(1 for w in pre_workers if w["started"]),
        "workers_cost_std": round(sum(w["cost_std"] for w in pre_workers), 5),
        "worker_tools": dict(sum((Counter(w["tool_calls"]) for w in pre_workers), Counter())),
    }
    for w in workers:
        w.pop("_call_ts", None)

    out.update({
        "mined_tokens": {"in": tin, "out": tout, "cache_read": tcr},
        "mined_cost_main": round(cur_cost, 5),
        "mined_cost_total": round(total_cost, 5),
        "mined_turns": turns,
        "n_checks": len(checks), "n_snippet_checks": snippet_checks,
        "tools": dict(tools),
        "pre_giveup": pre_giveup,
        "truncations": truncations,
        "compactions": compactions,
        "first_ts": first_ts, "last_ts": last_ts,
        "n_interventions": len(interventions),
        "n_nudges": len(nudges), "n_cutoffs": len(cutoffs), "n_other_user": len(others),
        "n_giveups": len(giveups),
        "first_giveup": ({"ts": fi_give["ts"], "cost_at": fi_give["cost_at"],
                          "turn": fi_give["turn"], "green_before": green_before(fi_give)}
                         if fi_give else None),
        "first_nudge": ({"ts": fi_nudge["ts"], "cost_at": fi_nudge["cost_at"],
                         "turn": fi_nudge["turn"], "green_before": green_before(fi_nudge)}
                        if fi_nudge else None),
        "first_intervention": ({"ts": fi_any["ts"], "cost_at": fi_any["cost_at"],
                                "class": fi_any["class"], "turn": fi_any["turn"],
                                "green_before": green_before(fi_any)}
                               if fi_any else None),
        "nudge_events": [{"ts": u["ts"], "cost_at": u["cost_at"], "turn": u["turn"],
                          "class": u["class"], "stmt": u["stmt"], "prev_stop": u["prev_stop"]}
                         for u in interventions][:400],
        "ever_green": first_green is not None,
        "first_green": (None if first_green is None else
                        {"cost_at": first_green["cost_at"], "turn": first_green["turn"],
                         "ts": first_green["ts"], "md5": first_green["md5"],
                         "check_index": first_green_idx + 1}),
        "post_green": post,
        "max_fp_streak": max_streak, "n_noop_checks": n_noop,
        "traj": traj,
        "n_workers": len(workers), "workers": workers,
        "last_check_status": checks[-1]["status"] if checks else None,
        "last_check_errors": checks[-1]["errors"] if checks else None,
        "last_check_sorries": checks[-1]["sorries"] if checks else None,
    })
    return out


def main():
    attempts = []
    for arm in CELLS:
        rows, patched = cell_rows(arm)
        sys.stderr.write(f"[{arm}] {len(rows)} rows patched={patched}\n")
        for prob in sorted(rows):
            attempts.append(mine_attempt(arm, prob, rows[prob]))
    with open(os.path.join(OUTDIR, "attempts.jsonl"), "w") as f:
        for a in attempts:
            f.write(json.dumps(a) + "\n")
    cat = {k: dict(v.most_common(40)) for k, v in CAT.items()}
    json.dump(cat, open(os.path.join(OUTDIR, "catalog.json"), "w"), indent=2)

    # validation summary
    val = {"n": len(attempts), "no_session": 0, "tok_relerr_gt_1pct": [],
           "solve_mismatch": [], "green_vs_hw_cost": [], "nudge_mismatch": [],
           "turn_mismatch": []}
    for a in attempts:
        key = f'{a["arm"]}/{a["problem"]}'
        if a.get("no_session"):
            val["no_session"] += 1
            continue
        if a.get("tok_relerr") is not None and a["tok_relerr"] > 0.01:
            # spawn arms: row tokens may include worker tokens — recheck with workers added
            mt, rt_ = a["mined_tokens"], a.get("row_tokens") or {}
            wtok = {"in": 0, "out": 0, "cache_read": 0}
            for w in a.get("workers") or []:
                for k2 in wtok:
                    wtok[k2] += (w.get("tokens") or {}).get(k2) or 0
            tot = {k2: mt[k2] + wtok[k2] for k2 in wtok}
            tgt = sum(rt_.get(k2) or 0 for k2 in wtok)
            err2 = sum(abs(tot[k2] - (rt_.get(k2) or 0)) for k2 in wtok) / max(1, tgt)
            if err2 > 0.01:
                val["tok_relerr_gt_1pct"].append([key, a["tok_relerr"], round(err2, 5), a["session_pick"]])
        hw = a.get("hw") or {}
        hw_first = (hw.get("first") or {})
        hw_solved = bool(hw_first.get("solved"))
        if a["ever_green"] != hw_solved:
            val["solve_mismatch"].append([key, "mined_green", a["ever_green"],
                                          "hw", hw_solved, "row", a["row_solved"]])
        if a["ever_green"] and hw_solved and hw_first.get("cost_std") is not None:
            d = abs(a["first_green"]["cost_at"] - hw_first["cost_std"])
            if d > 0.005:
                val["green_vs_hw_cost"].append([key, a["first_green"]["cost_at"],
                                                hw_first["cost_std"]])
        rn = a.get("row_nudges")
        if rn is not None and abs((a["n_interventions"]) - rn) > 0:
            val["nudge_mismatch"].append([key, "mined", a["n_interventions"], "row", rn])
        rt = a.get("row_turns")
        if rt is not None and a["mined_turns"] != rt:
            val["turn_mismatch"].append([key, a["mined_turns"], rt])
    for k in list(val):
        if isinstance(val[k], list):
            val[k + "_n"] = len(val[k])
            val[k] = val[k][:30]
    json.dump(val, open(os.path.join(OUTDIR, "validation.json"), "w"), indent=2)
    sys.stderr.write(json.dumps({k: v for k, v in val.items() if k.endswith("_n") or isinstance(v, int)}, indent=2) + "\n")
    print(f"mined {len(attempts)} attempts -> {OUTDIR}")

if __name__ == "__main__":
    main()
