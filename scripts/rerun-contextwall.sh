#!/usr/bin/env bash
# Rerun the 13 compaction-wall deaths (audit 2026-08-15, results/context-wall-audit-0815.json)
# on the guarded harness, and glue a patched view beside each affected cell. Follows the
# rerun-falsegreen.sh pattern: reruns get their own run-ids and dirs, the original cell
# records are never edited, and the patched file is a sibling, not a rewrite.
#
# What reruns and why: attempts that hit the ~917.5k admission wall and whose compaction
# summarization request was ALSO refused (dead assistant messages the model never saw
# inflated the payload past the window — see extensions/compaction-guard.ts). They burned
# to the supervisor's error-streak with budget unspent, recorded end=completed. All 13 are
# solved=false, so reruns can only add solves. NOT rerun: the 3 deaths in the invalidated
# 0805 cells, base-fatex87-0807/fatex_33 (already in the fgrerun chain, and its rerun ran
# guarded — rescued at try 3, then failed honestly at the budget cap), and the two
# basequote deaths (cell still open 2026-08-15; rescan it at close).
#
# Comparability: the guard is a strict no-op unless pi's own compaction has already
# failed, so these reruns differ from their frozen cells only in the one state that was
# killing them. Rerun records carry the post-guard harness_git_sha.
#
# Sequencing: queues behind the false-green chain (rerun-falsegreen.sh, in flight at
# launch) the way that chain queued behind block C — its five cells plus snippet-r2 must
# land first, both for the 6 Lean cores and because the glue stacks on the
# *-fgrerun-patched files it writes. Idempotent: a rerun with a summary.json is skipped.
#
#   nohup scripts/rerun-contextwall.sh >> results/rerun-contextwall.console.log 2>&1 &
# MUST run from the main checkout (worktrees lack .env/results — the failure looks
# like a model-catalog error).
set -u
cd "$(dirname "$0")/.." || exit 1
export PATH="$HOME/.local/node/bin:$HOME/.elan/bin:$PATH"
# basequote (or a straggler) may still be mid-run when the gate opens: the pre-run REPL
# recycle would strand its in-flight checks (the 2026-08-10 incident). Concurrency itself
# is safe, the recycle is the hazard.
export CMP_NO_RECYCLE=1

echo "=== $(date -Is) waiting for the fgrerun chain (5 cells) + snippet-r2 to finish"
until [ -f results/semantic-fatex87-0807-fgrerun/summary.json ] \
   && [ -f results/base-fatex87-0807-fgrerun/summary.json ] \
   && [ -f results/base-fatex90-0807-r2-fgrerun/summary.json ] \
   && [ -f results/snippetonly-fatex90-0807-fgrerun/summary.json ] \
   && [ -f results/snippet-fatex90-0807-fgrerun/summary.json ] \
   && [ -f results/snippet-fatex90-0807-r2/summary.json ]; do sleep 300; done

# cell:combo:problems — combo/budget/model must match the cell being patched
# (verified against each cell's run.json 2026-08-15). Disjoint from every fgrerun list.
SPECS=(
  "base-fatex87-0807::fatex_27 fatex_44 fatex_95 fatex_97"
  "base-fatex90-0807-r2::fatex_17 fatex_26 fatex_41 fatex_69 fatex_90"
  "semantic-fatex87-0807:lean-search:fatex_41"
  "snippet-fatex90-0807-r2:lean-grep lean-snippet:fatex_85"
  "snippetonly-fatex90-0807:lean-snippet:fatex_17 fatex_53"
)

for spec in "${SPECS[@]}"; do
  cell="${spec%%:*}"; rest="${spec#*:}"
  combo="${rest%%:*}"; probs="${rest#*:}"
  rid="${cell}-cwrerun"
  if [ -f "results/$rid/summary.json" ]; then echo "=== $rid already done, skipping"; continue; fi
  list="problems-fatex/cwrerun-${cell}.txt"
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
  rid="${cell}-cwrerun"
  # Stack on the most-patched view of the cell: fgrerun-patched > plus-easy3 > raw.
  base="results/$cell/results.jsonl"
  [ -f "results/${cell}-plus-easy3.results.jsonl" ] && base="results/${cell}-plus-easy3.results.jsonl"
  [ -f "results/${cell}-fgrerun-patched.results.jsonl" ] && base="results/${cell}-fgrerun-patched.results.jsonl"
  out="results/${cell}-cwrerun-patched.results.jsonl"
  if [ ! -f "results/$rid/results.jsonl" ]; then echo "=== $cell: rerun results missing, NOT gluing"; continue; fi
  python3 - "$base" "results/$rid/results.jsonl" "$out" <<'PYEOF'
import json, sys
base, rerun, out = sys.argv[1:4]
new = {}
for l in open(rerun):
    if l.strip():
        r = json.loads(l)
        r["cwrerun"] = True  # provenance: this record replaces a compaction-wall death
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

echo "=== $(date -Is) context-wall rerun chain complete — rescan basequote-fatex90-0813 with scripts/context-wall-scan.mjs (2 known deaths, cell was unguarded), then regenerate RUNS.md tables from the *-cwrerun-patched files (scripts/run-report.py) and mark patched cells in the write-up"
