#!/usr/bin/env bash
# The easy3 supplement: run fatex_35/46/70 on the three block-A arms that ran without
# them, and glue an n=90 view next to each cell. Decided 2026-08-08 (user decision,
# reversing part of the 0805 cut): the three are faithful-but-Mathlib-free and were
# excluded from safe87 as unable to carry an arm effect — which is also why adding
# them back is harmless to the paired tests (concordant pairs contribute nothing to
# McNemar). They come back as SUPPLEMENT runs with their own run-ids and dirs; the
# 87-cell records are never edited, and the glued file is a sibling, not a rewrite.
#
# Sequencing: waits for semantic-fatex87-0807 to finish, then runs the three
# supplements one at a time (each is 3 problems at concurrency 3), then waits for the
# base 87-cell to finish before gluing. Supplements may overlap the base cell on the
# same DeepSeek key — billed_usd is annotated as meaningless on each supplement
# summary; cost_std is unaffected (PLAN.md, easy3 note).
#
# Idempotent: a supplement with a summary.json is skipped, so the script can be
# rerun after any interruption. Runs in its own tmux session (see PLAN.md) so it
# survives the session that typed it.
set -u
cd "$(dirname "$0")/.." || exit 1
export PATH="$HOME/.local/node/bin:$HOME/.elan/bin:$PATH"

echo "=== $(date -Is) waiting for semantic-fatex87-0807 to finish"
until [ -f results/semantic-fatex87-0807/summary.json ]; do sleep 120; done

for spec in "semantic:lean-search" "grep:lean-grep" "base:"; do
  arm="${spec%%:*}"; combo="${spec#*:}"
  rid="${arm}-fatex87-0807-easy3"
  if [ -f "results/$rid/summary.json" ]; then echo "=== $rid already done, skipping"; continue; fi
  echo "=== $(date -Is) launching $rid (combo: ${combo:-baseline})"
  node runner/run.js --combo "$combo" --problems problems-fatex/easy3.txt \
    --problems-dir problems-fatex --budget-std 1.00 --concurrency 3 --run-id "$rid" \
    2>&1 | tee -a "results/$rid.console.log"
  python3 - "$rid" <<'PYEOF'
import json, sys
p = f"results/{sys.argv[1]}/summary.json"
try:
    d = json.load(open(p))
except FileNotFoundError:
    sys.exit(0)
if not d.get("billed_note"):
    d["billed_note"] = ("easy3 supplement; may overlap other runs on the same key, so the "
                        "balance-delta billed_usd is not meaningful. cost_std is unaffected. "
                        "See PLAN.md, easy3 note (2026-08-08).")
    json.dump(d, open(p, "w"), indent=2)
PYEOF
done

echo "=== $(date -Is) waiting for base-fatex87-0807 (the 87) before gluing"
until [ -f results/base-fatex87-0807/summary.json ]; do sleep 300; done

for arm in semantic grep base; do
  cell="results/${arm}-fatex87-0807"
  supp="results/${arm}-fatex87-0807-easy3"
  out="results/${arm}-fatex87-0807-plus-easy3.results.jsonl"
  if [ ! -f "$supp/results.jsonl" ]; then echo "=== $arm: supplement results missing, NOT gluing"; continue; fi
  cat "$cell/results.jsonl" "$supp/results.jsonl" > "$out"
  python3 - "$arm" "$out" <<'PYEOF'
import json, sys
rows = [json.loads(l) for l in open(sys.argv[2]) if l.strip()]
solved = sum(1 for r in rows if r.get("solved"))
cost = sum(r.get("cost_std") or 0 for r in rows)
print(f"=== {sys.argv[1]} n=90 view: {solved}/{len(rows)} solved, cost_std ${cost:.2f}  ({sys.argv[2]})")
PYEOF
done
echo "=== $(date -Is) easy3 supplement chain complete"
