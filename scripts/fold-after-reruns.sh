#!/usr/bin/env bash
# The fold, armed 2026-08-15 night (Mariam: "after all the reruns fold the updated
# results into the summaries, update the artifacts in the end"). Falsegreen is already
# folded (five *-fgrerun-patched files; the final 0815 rescan found 0 new). This waits
# for the context-wall reruns — round 1 (tmux cwrerun) and round 2 (tmux cwrerun2,
# which itself waits for round 1's glue) — then:
#
#   1. VERIFIES every patched view before anything consumes it: record count equals
#      the cell's problem count, no duplicate problems, provenance flags match the
#      rerun sizes. A failed check aborts the fold loudly rather than shipping a
#      half-glued view.
#   2. Regenerates RUNS.md (scripts/run-report.py — now patched-aware, so superseded
#      attempt records drop out of the ledger's numbers automatically).
#   3. Runs the chart/stats refresh once (the */30 cron would do it anyway; this makes
#      "fold done" and "artifacts current" the same moment). The chart scripts already
#      prefer cwrerun-patched > fgrerun-patched > raw.
#   4. Raises the price-watcher banner: the meeting-link artifacts need the Artifact
#      tool, which only an interactive claude.ai-connected session has — open one in
#      ~/CMP and say "republish the grid artifact" (and the cost-diff artifact).
#
#   nohup scripts/fold-after-reruns.sh >> results/fold-after-reruns.console.log 2>&1 &
# MUST run from the main checkout.
set -u
cd "$(dirname "$0")/.." || exit 1
export PATH="$HOME/.local/node/bin:$HOME/.elan/bin:$PATH"

echo "=== $(date -Is) waiting for both context-wall rerun rounds to glue"
until grep -q "round-2 context-wall reruns complete" results/rerun-contextwall2.console.log 2>/dev/null; do
  sleep 300
done

echo "=== $(date -Is) reruns closed — verifying every patched view"
python3 - <<'PYEOF'
import json, os, sys, glob

ok = True
for path in sorted(glob.glob("results/*-cwrerun-patched.results.jsonl") +
                   glob.glob("results/*-fgrerun-patched.results.jsonl")):
    cell = os.path.basename(path).split("-cwrerun-patched")[0].split("-fgrerun-patched")[0]
    rows = [json.loads(l) for l in open(path) if l.strip()]
    probs = [r["problem"] for r in rows]
    n_expected = len(json.load(open(f"results/{cell}/run.json"))["problems"])
    # fatex87 cells merge their -easy3 companion (fatex_35/46/70) into the 90-problem view
    if os.path.exists(f"results/{cell}-easy3/run.json"):
        n_expected += len(json.load(open(f"results/{cell}-easy3/run.json"))["problems"])
    dupes = len(probs) - len(set(probs))
    prov = sum(1 for r in rows if r.get("cwrerun") or r.get("fgrerun"))
    line = f"{os.path.basename(path)}: {len(rows)} records, {prov} patched, {sum(1 for r in rows if r.get('solved'))} solved"
    if len(rows) != n_expected or dupes:
        ok = False
        line += f"  ** FAIL: expected {n_expected} records, {dupes} duplicate problems"
    print(line)
if not ok:
    sys.exit(1)
PYEOF
if [ $? -ne 0 ]; then
  echo "=== $(date -Is) VERIFY FAILED — fold aborted, nothing regenerated"
  printf 'CMP fold ABORTED: a patched view failed verification — see results/fold-after-reruns.console.log\n' \
    >> /home/mariam/deepseek-price-watch/ALERT
  exit 1
fi

echo "=== $(date -Is) regenerating RUNS.md from patched views"
python3 scripts/run-report.py

echo "=== $(date -Is) refreshing charts + paper stats"
/home/mariam/CMP/.claude/worktrees/bridge-cse_01L6Jh9sGmNmQ6uapMTHMLPp/scripts/refresh-charts.sh

{
  echo "======================================================================"
  echo "CMP fold complete $(date -Is): context-wall + falsegreen reruns glued,"
  echo "RUNS.md regenerated, charts/PAPER-STATS rebuilt from patched views."
  echo "To update the meeting links, open a Claude session in ~/CMP and say:"
  echo "  republish the grid artifact, then the cost-diff artifact"
  echo "Clear this banner with:  rm /home/mariam/deepseek-price-watch/ALERT"
  echo "======================================================================"
} >> /home/mariam/deepseek-price-watch/ALERT
echo "=== $(date -Is) fold complete"
