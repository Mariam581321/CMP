#!/usr/bin/env bash
# Context-wall reruns, round 2 (2026-08-15 night): the three dead attempts the first
# chain (rerun-contextwall.sh, tmux cwrerun) could not know about, found by re-running
# context-wall-scan.mjs over every closed cell after basequote and snippet-r2 closed:
#
#   basequote-fatex90-0813  fatex_18 fatex_20   (the "2 known deaths, cell was
#                                                unguarded" the first chain's exit
#                                                message predicted)
#   base-fatex87-0807       fatex_33            (boundary case the 0815 scan missed;
#                                                its -cwrerun cell is already running
#                                                without it, so this rides as -cwrerun2)
#
# Launches NOW, concurrent with the first chain — concurrency is safe, STARTING a cell
# while others are mid-flight is only safe with the recycle disabled, hence
# CMP_NO_RECYCLE=1 exactly like the first chain. basequote attempts MUST carry
# CMP_STMT_QUOTE=1 (scripts/launch-basequote.sh): without it they would be plain base
# and the patch would splice a different arm into the cell.
#
# The GLUE step, unlike the launches, does wait: base-fatex87's cwrerun2 patch must
# stack on the first chain's base-fatex87-0807-cwrerun-patched.results.jsonl, which
# exists only when that chain finishes. Stacking order everywhere:
# cwrerun-patched > fgrerun-patched > plus-easy3 > raw.
#
#   nohup scripts/rerun-contextwall2.sh >> results/rerun-contextwall2.console.log 2>&1 &
# MUST run from the main checkout (worktrees lack .env/results).
set -u
cd "$(dirname "$0")/.." || exit 1
export PATH="$HOME/.local/node/bin:$HOME/.elan/bin:$PATH"
export CMP_NO_RECYCLE=1

# cell : combo : env : problems
SPECS=(
  "basequote-fatex90-0813::CMP_STMT_QUOTE=1:fatex_18 fatex_20"
  "base-fatex87-0807:::fatex_33"
)
rid_for() { # base-fatex87 already has a -cwrerun in flight from round 1
  case "$1" in base-fatex87-0807) echo "$1-cwrerun2" ;; *) echo "$1-cwrerun" ;; esac
}

for spec in "${SPECS[@]}"; do
  cell="${spec%%:*}"; rest="${spec#*:}"
  combo="${rest%%:*}"; rest="${rest#*:}"
  env="${rest%%:*}"; probs="${rest#*:}"
  rid="$(rid_for "$cell")"
  if [ -f "results/$rid/summary.json" ]; then echo "=== $rid already done, skipping"; continue; fi
  list="problems-fatex/cwrerun2-${cell}.txt"
  printf '%s\n' $probs > "$list"
  n=$(wc -l < "$list")
  echo "=== $(date -Is) launching $rid (combo: ${combo:-baseline}${env:+, $env}, $n problems)"
  env $env node runner/run.js --combo "${combo// /,}" --problems "$list" \
    --problems-dir problems-fatex --budget-std 1.00 --concurrency "$n" --run-id "$rid" \
    2>&1 | tee -a "results/$rid.console.log"
done

echo "=== $(date -Is) reruns done — waiting for round 1's glue before stacking"
until [ -f results/base-fatex87-0807-cwrerun-patched.results.jsonl ]; do sleep 300; done

echo "=== $(date -Is) gluing patched views"
for spec in "${SPECS[@]}"; do
  cell="${spec%%:*}"
  rid="$(rid_for "$cell")"
  base="results/$cell/results.jsonl"
  [ -f "results/${cell}-plus-easy3.results.jsonl" ] && base="results/${cell}-plus-easy3.results.jsonl"
  [ -f "results/${cell}-fgrerun-patched.results.jsonl" ] && base="results/${cell}-fgrerun-patched.results.jsonl"
  [ -f "results/${cell}-cwrerun-patched.results.jsonl" ] && base="results/${cell}-cwrerun-patched.results.jsonl"
  out="results/${cell}-cwrerun-patched.results.jsonl"
  [ "$base" = "$out" ] && { cp "$out" "$out.pre-cwrerun2"; base="$out.pre-cwrerun2"; }
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

echo "=== $(date -Is) round-2 context-wall reruns complete"
