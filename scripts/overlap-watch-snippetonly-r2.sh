#!/usr/bin/env bash
# Overlap watcher for the split snippetonly r2 cell: run A (server, eats safe90
# forward) vs run B (laptop, eats the reversed tail). Both write per-problem dirs
# under results/<run-id>/, so "started" is directory existence — the same signal
# cell-fatex90.sh's guards use.
#
# Runs on the laptop; polls the server over ssh every 5 min. stdout is an EVENT
# stream (one line per thing worth acting on), so it can sit under a Claude
# Monitor or just `tee` to a log:
#   - CRITICAL: any problem started by BOTH runs (the duplicate to kill, then
#     glue per-problem at close)
#   - runway warnings when the count of problems started by NEITHER run first
#     drops to 12, 6, 2
#   - a heartbeat every 6h so silence is distinguishable from a dead watcher
#   - an alert after 3 consecutive ssh failures
set -u
cd "$(dirname "$0")/.." || exit 1

SERVER="${CMP_SERVER:-mariam@157.180.101.246}"
RUN_A="snippetonly-fatex90-0807-r2"
RUN_B="snippetonly-fatex90-0807-r2-laptop"
ALL=problems-fatex/safe90.txt
POLL=300
HEARTBEAT_EVERY=$((6 * 3600 / POLL))

warned12=0; warned6=0; warned2=0; sshfail=0; tick=0
while true; do
  a=$(ssh -o BatchMode=yes -o ConnectTimeout=15 "$SERVER" \
        "ls ~/CMP/results/$RUN_A/ 2>/dev/null" | grep '^fatex_' || true)
  if [ -z "$a" ]; then
    sshfail=$((sshfail + 1))
    [ "$sshfail" -eq 3 ] && echo "WATCHER BLIND: 3 consecutive failures reading run A from $SERVER"
  else
    sshfail=0
    b=$(ls "results/$RUN_B/" 2>/dev/null | grep '^fatex_' || true)
    both=$(comm -12 <(sort <<<"$a") <(sort <<<"$b"))
    [ -n "$both" ] && echo "CRITICAL overlap — started by both runs: $(tr '\n' ' ' <<<"$both")"
    runway=$(grep -vxF -f <(printf '%s\n%s\n' "$a" "$b") "$ALL" | grep -c . || true)
    if   [ "$runway" -le 2 ]  && [ "$warned2"  -eq 0 ]; then warned2=1;  echo "runway 2: runs about to meet — stop or retarget run B now"
    elif [ "$runway" -le 6 ]  && [ "$warned6"  -eq 0 ]; then warned6=1;  echo "runway 6: fronts closing (A $(grep -c . <<<"$a") started, B $(grep -c . <<<"$b") started)"
    elif [ "$runway" -le 12 ] && [ "$warned12" -eq 0 ]; then warned12=1; echo "runway 12: fronts converging (A $(grep -c . <<<"$a") started, B $(grep -c . <<<"$b") started)"
    fi
    [ $((tick % HEARTBEAT_EVERY)) -eq 0 ] && [ "$tick" -gt 0 ] && \
      echo "heartbeat: A $(grep -c . <<<"$a") started, B $(grep -c . <<<"$b") started, runway $runway, no overlap"
  fi
  tick=$((tick + 1))
  sleep "$POLL"
done
