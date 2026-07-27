#!/usr/bin/env bash
# One-shot launcher for tonight's run (2026-07-26). Delete after the run.
cd "$(dirname "$0")/.." || exit 1
setsid nohup node runner/run.js \
  --combo lean-search \
  --problems problems-fateh/night20-0726.txt \
  --problems-dir problems-fateh \
  --budget-std 1.00 \
  --timeout 21600 \
  --concurrency 10 \
  --run-id lean-search-fateh20-0726 \
  > results/lean-search-fateh20-0726.launch.log 2>&1 &
echo "launched (pid $!)"
echo "dashboard:  ./scripts/watch.sh lean-search-fateh20-0726"
echo "log:        tail -f results/lean-search-fateh20-0726.launch.log"
