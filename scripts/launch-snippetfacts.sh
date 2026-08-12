#!/usr/bin/env bash
# The snippetfacts arm: grep + snippet + facts bank, NO spawn — decided 2026-08-12.
# One-variable delta against the complete snippet cell (lean-grep,lean-snippet):
# does a PERSISTENT, NAMED, verified lemma bank beat throwaway verified scratch?
# Motivated mid-block-C: spawnfacts parents used add_fact solo (8 of the first 48
# attempts, 55 calls) while ~never spawning workers, i.e. the bank is being used as
# solo verified memory — this cell measures that mechanism without the unused spawn
# tool confounding the arm. Connects to RUNS.md finding #5 (verified scratch
# compilation looks like the active ingredient).
#
# Guards: refuses while any run.js is alive (one cell at a time — 6 Lean cores) and
# until the fgrerun chain has landed (box + patch discipline). Launch from the MAIN
# checkout, in tmux:
#   tmux new-session -d -s snippetfacts -c /home/mariam/CMP \
#     'scripts/launch-snippetfacts.sh >> results/snippetfacts-fatex90.console.log 2>&1'
set -u
cd "$(dirname "$0")/.." || exit 1
export PATH="$HOME/.local/node/bin:$HOME/.elan/bin:$PATH"

RID="snippetfacts-fatex90-$(date +%m%d)"
if pgrep -f "node runner/run.js" >/dev/null; then
  echo "REFUSING: another run.js is alive (one cell at a time)"; exit 1
fi
if [ ! -f results/snippet-fatex90-0807-fgrerun-patched.results.jsonl ]; then
  echo "REFUSING: fgrerun chain not finished (control cell not patched yet)"; exit 1
fi
if [ -f "results/$RID/summary.json" ]; then echo "$RID already complete"; exit 0; fi

echo "=== $(date -Is) launching $RID (grep+snippet+facts, no spawn)"
node runner/run.js --combo lean-grep,lean-snippet,lean-facts \
  --problems problems-fatex/safe90.txt --problems-dir problems-fatex \
  --budget-std 1.00 --concurrency 12 --run-id "$RID"
echo "=== $(date -Is) $RID done — control: snippet-fatex90-0807-fgrerun-patched (same combo minus lean-facts)"
