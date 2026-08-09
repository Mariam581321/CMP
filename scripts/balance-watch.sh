#!/usr/bin/env python3
"""Alert before the DeepSeek balance kills a live cell.

A cell that runs out of funds mid-flight does not fail cleanly -- it leaves a
partial results.jsonl and no summary.json, which is the one shape the chain
scripts treat as "it died rather than finished". The cost of missing that is a
whole cell's spend, so this watcher exists to buy top-up lead time.

Delivery is the price watcher's notify.sh (sticky login banner + wall + ntfy
phone push, same topic you are already subscribed to). If that script is gone
this one still logs and still writes its own banner -- a watcher whose only
channel has silently disappeared looks exactly like a watcher saying "all fine".

Thresholds are tiered and edge-triggered: each fires once when the balance
crosses down through it, and re-arms only when the balance climbs back above it,
so a top-up resets the alarm and a long run does not page you every 15 minutes.
Alerts carry the burn rate and the live cells' remaining need, because "$18 left"
means something different with one cell finishing than with two just launched.

Install (every 15 min):
    (crontab -l 2>/dev/null; echo '*/15 * * * * /home/mariam/CMP/scripts/balance-watch.sh >/dev/null 2>&1  # cmp-balance-watch') | crontab -
Run by hand to see the current reading without touching state:
    ./scripts/balance-watch.sh --dry-run
"""

import json
import os
import re
import subprocess
import sys
import urllib.request
import urllib.error
from datetime import datetime, timezone

CMP = "/home/mariam/CMP"
STATE_DIR = "/home/mariam/cmp-balance-watch"
STATE = os.path.join(STATE_DIR, "state.json")
LOG = os.path.join(STATE_DIR, "watch.log")
BANNER = os.path.join(STATE_DIR, "ALERT")
NOTIFY = "/home/mariam/deepseek-price-watch/notify.sh"

BALANCE_URL = "https://api.deepseek.com/user/balance"

# Tiers, richest first. Crossing down through one fires it. Overridable so the
# alert path can be exercised for real (CMP_BALANCE_LOW=999 ./scripts/balance-watch.sh)
# without waiting for the account to actually drain.
TIERS = [
    (float(os.environ.get("CMP_BALANCE_LOW", 25.0)), "LOW"),
    (float(os.environ.get("CMP_BALANCE_CRITICAL", 10.0)), "CRITICAL"),
]

# Mean cost_std per problem, from grep-fatex87-0807 (the fullest post-freeze cell).
# Only used to turn "problems left" into "dollars still needed" in the alert body.
COST_PER_PROBLEM = 0.47

# Notify after this many consecutive failed reads (4 x 15 min = 1h blind).
FAIL_ALERT_AFTER = 4

DRY = "--dry-run" in sys.argv


def log(msg):
    line = f"{datetime.now(timezone.utc):%FT%TZ} {msg}"
    if DRY:
        print(line)
        return
    os.makedirs(STATE_DIR, exist_ok=True)
    with open(LOG, "a") as f:
        f.write(line + "\n")


def load_state():
    try:
        with open(STATE) as f:
            return json.load(f)
    except (OSError, ValueError):
        return {}


def save_state(state):
    if DRY:
        return
    os.makedirs(STATE_DIR, exist_ok=True)
    tmp = STATE + ".tmp"
    with open(tmp, "w") as f:
        json.dump(state, f, indent=2)
    os.replace(tmp, STATE)


def api_key():
    """DEEPSEEK_API_KEY out of CMP's .env, without sourcing the whole file."""
    with open(os.path.join(CMP, ".env")) as f:
        for line in f:
            m = re.match(r"\s*(?:export\s+)?DEEPSEEK_API_KEY\s*=\s*(.*)", line)
            if m:
                return m.group(1).strip().strip("'\"")
    raise RuntimeError("DEEPSEEK_API_KEY not found in CMP/.env")


def fetch_balance():
    req = urllib.request.Request(
        BALANCE_URL, headers={"Authorization": f"Bearer {api_key()}"}
    )
    with urllib.request.urlopen(req, timeout=30) as r:
        data = json.load(r)
    return float(data["balance_infos"][0]["total_balance"])


def live_runs():
    """Cells with a run.json, no summary.json, and a run.js process still alive."""
    out = []
    results = os.path.join(CMP, "results")
    for rid in sorted(os.listdir(results)):
        d = os.path.join(results, rid)
        if not os.path.isdir(d):
            continue
        if not os.path.exists(os.path.join(d, "run.json")):
            continue
        if os.path.exists(os.path.join(d, "summary.json")):
            continue
        alive = subprocess.run(
            ["pgrep", "-f", rf"run\.js .*--run-id {re.escape(rid)}"],
            capture_output=True,
        ).returncode == 0
        if not alive:
            continue
        try:
            with open(os.path.join(d, "run.json")) as f:
                total = len(json.load(f)["problems"])
        except (OSError, ValueError, KeyError):
            total = 0
        done = spent = 0
        try:
            with open(os.path.join(d, "results.jsonl")) as f:
                for line in f:
                    try:
                        row = json.loads(line)
                    except ValueError:
                        continue
                    done += 1
                    spent += row.get("cost_std") or 0
        except OSError:
            pass
        out.append(
            {"run_id": rid, "done": done, "total": total, "spent": spent,
             "need": max(0, total - done) * COST_PER_PROBLEM}
        )
    return out


def notify(subject, body):
    log(f"ALERT {subject}")
    if DRY:
        print(f"--- would send ---\n{subject}\n\n{body}\n------------------")
        return
    os.makedirs(STATE_DIR, exist_ok=True)
    with open(BANNER, "w") as f:
        f.write(f"{subject}\n\n{body}\n\nClear this banner with:  rm {BANNER}\n")
    if os.access(NOTIFY, os.X_OK):
        try:
            subprocess.run([NOTIFY, subject], input=body, text=True, timeout=120)
        except (subprocess.SubprocessError, OSError) as e:
            log(f"notify.sh failed ({e}) -- banner still set at {BANNER}")
    else:
        log(f"notify.sh missing or not executable at {NOTIFY} -- banner only")


def main():
    state = load_state()
    try:
        balance = fetch_balance()
    except Exception as e:  # noqa: BLE001 -- any failure is the same failure here
        fails = state.get("fails", 0) + 1
        state["fails"] = fails
        save_state(state)
        log(f"balance read FAILED ({type(e).__name__}: {e}) -- {fails} in a row")
        if fails == FAIL_ALERT_AFTER:
            notify(
                "CMP: balance watcher is blind",
                f"{fails} consecutive failures reading the DeepSeek balance.\n"
                f"Last error: {type(e).__name__}: {e}\n\n"
                "Until this clears, nothing is watching the funds under your live cells.",
            )
        return

    prev = state.get("balance")
    prev_at = state.get("checked_at")
    runs = live_runs()
    need = sum(r["need"] for r in runs)

    burn = ""
    if prev is not None and prev_at:
        try:
            dt = (datetime.now(timezone.utc)
                  - datetime.fromisoformat(prev_at)).total_seconds() / 3600
            if dt > 0 and prev > balance:
                rate = (prev - balance) / dt
                hours = balance / rate if rate > 0 else float("inf")
                burn = f"Burn: ${rate:.2f}/h -> ~{hours:.1f}h to zero at this rate.\n"
        except ValueError:
            pass

    if runs:
        lines = "\n".join(
            f"  {r['run_id']}: {r['done']}/{r['total']} done, ${r['spent']:.2f} spent,"
            f" ~${r['need']:.0f} still needed"
            for r in runs
        )
        runs_txt = f"Live cells:\n{lines}\n\nThey still need ~${need:.0f} between them.\n"
    else:
        runs_txt = "No live cells right now.\n"

    log(f"balance ${balance:.2f}; {len(runs)} live cell(s) needing ~${need:.0f}")

    fired = state.get("fired", [])
    newly = []
    for threshold, name in TIERS:
        was_armed = name not in fired
        if balance < threshold and was_armed:
            newly.append((threshold, name))
            fired.append(name)
        elif balance >= threshold and not was_armed:
            fired.remove(name)  # re-arm: a top-up resets the alarm
            log(f"{name} re-armed (balance back above ${threshold:.0f})")

    if newly:
        threshold, name = newly[-1]  # the deepest tier crossed this run
        shortfall = need - balance
        verdict = (
            f"SHORT by ~${shortfall:.0f} -- a live cell will die before it finishes.\n"
            if shortfall > 0
            else "Enough to finish the live cells, but not much behind them.\n"
        )
        notify(
            f"CMP: DeepSeek balance {name} (${balance:.2f})",
            f"Balance ${balance:.2f}, below the ${threshold:.0f} {name} line.\n"
            f"{burn}\n{runs_txt}\n{verdict}\n"
            "Top up: https://platform.deepseek.com/top_up",
        )

    state.update(
        {"balance": balance, "checked_at": datetime.now(timezone.utc).isoformat(),
         "fails": 0, "fired": fired}
    )
    save_state(state)


if __name__ == "__main__":
    main()
