#!/usr/bin/env bash
# Block A (search) on FATE-X, run list problems-fatex/safe93.txt (n = 93).
#
#   ./scripts/blockA-fatex93-0805.sh grep
#
# ONE ARM PER INVOCATION, and never two at once: billed_usd comes from the
# account-wide DeepSeek balance delta sampled either side of the run, so
# concurrent runs on the same key make every delta meaningless (run.js says so
# in its own words). Wait for a cell to finish before launching the next.
#
# Order decided 2026-08-05 (PLAN.md, Next steps): grep -> base -> semantic ->
# loogle. base-vs-grep is the widest contrast in the grid, so those two cells
# also settle the open "does FATE-X floor?" question — read the discordant-pair
# count as soon as the second one grades.
set -u
cd "$(dirname "$0")/.." || exit 1

ARM="${1:-}"
case "$ARM" in
  base)     COMBO="" ;;
  semantic) COMBO="lean-search" ;;
  grep)     COMBO="lean-grep" ;;
  loogle)   COMBO="lean-loogle" ;;
  *) echo "usage: $0 {grep|base|semantic|loogle}"; exit 2 ;;
esac

RUN_ID="${ARM}-fatex93-0805"

# Launch prerequisites, checked rather than remembered — each of these has cost a
# run before.
health=$(curl -sf --max-time 5 "http://127.0.0.1:${CMP_LEAN_PORT:-8787}/health" 2>/dev/null)
echo "$health" | grep -q '"ready":true' || { echo "lean server not ready — is the watchdog up? (tmux attach -t watchdog)"; exit 1; }
echo "$health" | grep -q '"library_sha256":null' || { echo "server has a library baked in (or predates library baking) — block A needs a plain, current env"; exit 1; }
git diff --quiet && git diff --cached --quiet || { echo "working tree dirty — harness_git_sha would not describe what ran"; exit 1; }

echo "=== $(date -Is) launching $RUN_ID (combo: ${COMBO:-baseline}) at $(git rev-parse --short HEAD)"
exec node runner/run.js --combo "$COMBO" \
  --problems problems-fatex/safe93.txt --problems-dir problems-fatex \
  --budget-std 1.00 --concurrency 25 --run-id "$RUN_ID"
