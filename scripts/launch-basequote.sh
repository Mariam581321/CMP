#!/usr/bin/env bash
# The basequote arm: base (no tools) + CMP_STMT_QUOTE=1 — the statement-modified
# blocker quotes the original file byte-exact instead of only instructing "restore
# the original statement exactly".
#
# WHY THIS IS AN ARM, NOT A FIX (decision 2026-08-12). The 0807-freeze audit found
# the blocker fired in 357 of ~640 attempts (2,745 flagged checks, ~75 h of REPL;
# 49 attempts thrashed >=10 rounds, worst 159; snippet fatex_33 died failing to
# recover a one-token universe change). Error-message affordance is agent-facing
# scaffolding of exactly the same genus as retrieval or snippet compilation — so it
# gets measured like one. All seven frozen cells are the control: they ran without
# the quote, and base ran TWICE (k=2, min detectable gap 6.3 solves).
#
# Comparison plan (COMPARE.md conventions):
#   control:  base r1 + base r2 — after the fgrerun patch, i.e. the
#             *-fgrerun-patched files, so both sides sit on the fixed sorryAx gate
#             and differ by the quote ONLY.
#   primary:  per-problem paired cost deltas (sign test), AUC, and
#             statement-thrash volume (grep the sessions for the blocker text —
#             mechanically guaranteed to move; this is the endpoint).
#   secondary: solves. Be honest in the write-up: only 9 attempts in the whole
#             grid DIED of statement damage, so the solve effect is likely under
#             the noise floor — the quote buys budget, not theorems, and AUC is
#             where freed budget shows.
#
# Refuses to launch until the fgrerun chain has finished (box contention + the
# patched control files must exist first). Launch from the MAIN checkout, in tmux:
#   tmux new-session -d -s basequote -c /home/mariam/CMP \
#     'scripts/launch-basequote.sh >> results/basequote-fatex90.console.log 2>&1'
set -u
cd "$(dirname "$0")/.." || exit 1
export PATH="$HOME/.local/node/bin:$HOME/.elan/bin:$PATH"

RID="basequote-fatex90-$(date +%m%d)"
for f in results/base-fatex87-0807-fgrerun-patched.results.jsonl \
         results/base-fatex90-0807-r2-fgrerun-patched.results.jsonl; do
  if [ ! -f "$f" ]; then
    echo "REFUSING: $f missing — the fgrerun chain (tmux fgrerun) has not finished; the control cells are not patched yet."
    exit 1
  fi
done
if [ -f "results/$RID/summary.json" ]; then echo "$RID already complete"; exit 0; fi

echo "=== $(date -Is) launching $RID (base + CMP_STMT_QUOTE=1)"
CMP_STMT_QUOTE=1 node runner/run.js --combo "" \
  --problems problems-fatex/safe90.txt --problems-dir problems-fatex \
  --budget-std 1.00 --concurrency 15 --run-id "$RID"
echo "=== $(date -Is) $RID done — compare against the base *-fgrerun-patched files (k=2 control)"
