#!/usr/bin/env bash
# One-shot launcher: fresh fateh_21 attempt (see drafts 0727 — first attempt hit the
# 14h clock at $0.77 after a 2.7h SIGSTOP). Run from your OWN terminal, not Claude's.
cd "$(dirname "$0")/.." || exit 1
nohup node runner/run.js \
  --combo lean-search \
  --problems problems-fateh/rerun21-0728.txt \
  --problems-dir problems-fateh \
  --budget-std 1.00 --timeout 50400 \
  --concurrency 1 --thinking high \
  --peak-ok \
  --run-id lean-search-think-fateh21-rerun-0728 \
  > results/lean-search-think-fateh21-rerun-0728.launch.log 2>&1 &
echo "launched (pid $!) — tail -f results/lean-search-think-fateh21-rerun-0728.launch.log"
