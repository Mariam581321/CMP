#!/usr/bin/env bash
# Rerun the apply?/sorryAx false-green attempts (audit 2026-08-11, RUNS.md §10) on the
# fixed harness, and glue a patched n=90 view beside each affected cell. Follows the
# easy3-supplement pattern: reruns get their own run-ids and dirs, the original cell
# records are never edited, and the patched file is a sibling, not a rewrite.
#
# What reruns and why (results/falsegreen-audit-0811.json has the stamps):
#   * the 14 attempts the old done-gate told COMPLETE on a sorryAx-backed proof
#     (grading correctly failed them, but the agent's behavior after the false green
#     is not a measurement of anything);
#   * base r2 fatex_36 and fatex_50, which recovered and solved genuinely AFTER a
#     false first green — their solves stand but cost-at-first-proof (the AUC input)
#     is stamped at the fake green, so the whole attempt reruns (user decision
#     2026-08-11).
# The knowledge-probe attempts (transcript review, falsegreen-transcript-review-0811.md)
# do NOT rerun: the gate never lied to them and the wording they probed is unchanged.
#
# Comparability: the fix is agent-invisible except on a clean-compiling file whose
# proof reaches sorryAx with no listed sorry — exactly the behavior being excised —
# so these reruns are comparable to their frozen cells everywhere else. Rerun records
# carry the post-fix harness_git_sha; report patched cells as patched.
#
# Sequencing: waits for BOTH block-C cells (spawn, spawnfacts) to land before touching
# the box (6 Lean cores; and with nothing else running, the pre-run REPL recycle is
# safe again — no CMP_NO_RECYCLE needed). Idempotent: a rerun with a summary.json is
# skipped, so the script survives interruption and re-invocation.
#
#   nohup scripts/rerun-falsegreen.sh >> results/rerun-falsegreen.console.log 2>&1 &
# MUST run from the main checkout (worktrees lack .env/results — the failure looks
# like a model-catalog error).
set -u
cd "$(dirname "$0")/.." || exit 1
export PATH="$HOME/.local/node/bin:$HOME/.elan/bin:$PATH"

echo "=== $(date -Is) waiting for block C (spawn + spawnfacts) to finish"
until [ -f results/spawn-fatex90-0807/summary.json ] && [ -f results/spawnfacts-fatex90-0807/summary.json ]; do sleep 300; done

# cell:combo:problems — combo/budget/model must match the cell being patched
# (verified against each cell's run.json 2026-08-11).
SPECS=(
  "semantic-fatex87-0807:lean-search:fatex_43 fatex_79"
  "base-fatex87-0807::fatex_33 fatex_56 fatex_61 fatex_62 fatex_78 fatex_86"
  "base-fatex90-0807-r2::fatex_36 fatex_43 fatex_50 fatex_58 fatex_62 fatex_80"
  "snippetonly-fatex90-0807:lean-snippet:fatex_80"
  "snippet-fatex90-0807:lean-grep lean-snippet:fatex_43"
)

for spec in "${SPECS[@]}"; do
  cell="${spec%%:*}"; rest="${spec#*:}"
  combo="${rest%%:*}"; probs="${rest#*:}"
  rid="${cell}-fgrerun"
  if [ -f "results/$rid/summary.json" ]; then echo "=== $rid already done, skipping"; continue; fi
  list="problems-fatex/fgrerun-${cell}.txt"
  printf '%s\n' $probs > "$list"
  n=$(wc -l < "$list")
  echo "=== $(date -Is) launching $rid (combo: ${combo:-baseline}, $n problems)"
  node runner/run.js --combo "${combo// /,}" --problems "$list" \
    --problems-dir problems-fatex --budget-std 1.00 --concurrency "$n" --run-id "$rid" \
    2>&1 | tee -a "results/$rid.console.log"
done

echo "=== $(date -Is) gluing patched views"
for spec in "${SPECS[@]}"; do
  cell="${spec%%:*}"
  rid="${cell}-fgrerun"
  # The 87-cells' n=90 view lives in the plus-easy3 glue; patch on top of it.
  base="results/$cell/results.jsonl"
  [ -f "results/${cell}-plus-easy3.results.jsonl" ] && base="results/${cell}-plus-easy3.results.jsonl"
  out="results/${cell}-fgrerun-patched.results.jsonl"
  if [ ! -f "results/$rid/results.jsonl" ]; then echo "=== $cell: rerun results missing, NOT gluing"; continue; fi
  python3 - "$base" "results/$rid/results.jsonl" "$out" <<'PYEOF'
import json, sys
base, rerun, out = sys.argv[1:4]
new = {}
for l in open(rerun):
    if l.strip():
        r = json.loads(l)
        r["fgrerun"] = True  # provenance: this record replaces a false-green attempt
        new[r["problem"]] = r
kept, replaced = [], 0
for l in open(base):
    if not l.strip():
        continue
    r = json.loads(l)
    if r["problem"] in new:
        kept.append(new.pop(r["problem"])); replaced += 1
    else:
        kept.append(r)
missing = list(new)
with open(out, "w") as f:
    for r in kept:
        f.write(json.dumps(r) + "\n")
solved = sum(1 for r in kept if r.get("solved"))
print(f"=== {out}: {solved}/{len(kept)} solved after patching {replaced} records"
      + (f" (WARNING: rerun problems not in base: {missing})" if missing else ""))
PYEOF
done
echo "=== $(date -Is) false-green rerun chain complete — regenerate RUNS.md tables from the *-fgrerun-patched files (scripts/run-report.py) and mark patched cells in the write-up"
