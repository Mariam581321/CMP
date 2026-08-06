#!/usr/bin/env bash
# Wait for a running grid cell to finish, then launch the next arm.
#
#   ./scripts/chain-next-cell.sh grep-fatex87-0805 semantic
#
# Cells must NOT overlap: billed_usd is an account-wide DeepSeek balance delta
# sampled either side of a run, so two runs sharing a key make both deltas
# meaningless. This script exists so the next cell can be queued without a human
# awake to press the button, and it starts the next arm ONLY on evidence the
# previous one is genuinely done.
#
# Completion signal is results/<run-id>/summary.json — run.js writes it last
# (run.js:713), after the closing balance sample. A vanished process without
# that file means run.js died rather than finished, which is exactly when a
# human should look before another ~$30 goes out the door, so the chain stops
# and says so instead of launching.
#
# Runs in its own tmux session so it survives the ssh session that queued it.
set -u
cd "$(dirname "$0")/.." || exit 1
ROOT="$PWD"
export PATH="$HOME/.local/node/bin:$HOME/.elan/bin:$PATH"   # tmux gives a bash that reads no rc file

WAIT_FOR="${1:-}"
NEXT_ARM="${2:-}"
[ -n "$WAIT_FOR" ] && [ -n "$NEXT_ARM" ] || { echo "usage: $0 <run-id-to-wait-for> <next-arm>"; exit 2; }

# Refuse to start the next cell on a balance that cannot finish it: a run that
# dies of insufficient funds mid-cell leaves a partly-graded run dir AND makes
# its own billing samples meaningless. 87 x $1 is the hard ceiling; $45 is a
# realistic floor for a cell that goes badly.
MIN_BALANCE=45

LOG="$ROOT/results/chain-$NEXT_ARM.log"
say() { echo "$(date -Is) $*" | tee -a "$LOG"; }

if [ -z "${CMP_IN_TMUX_LAUNCH:-}" ]; then
  tmux has-session -t "chain-$NEXT_ARM" 2>/dev/null && { echo "chain-$NEXT_ARM already queued"; exit 1; }
  tmux new-session -d -s "chain-$NEXT_ARM" -c "$ROOT" \
    "CMP_IN_TMUX_LAUNCH=1 '$ROOT/scripts/chain-next-cell.sh' '$WAIT_FOR' '$NEXT_ARM'; exec bash" \
    || { echo "tmux refused to start the chain session"; exit 1; }
  echo "=== queued: $NEXT_ARM will launch when $WAIT_FOR finishes"
  echo "    watch:  tmux attach -t chain-$NEXT_ARM   |   tail -f $LOG"
  echo "    cancel: tmux kill-session -t chain-$NEXT_ARM"
  exit 0
fi

say "chain armed: waiting for $WAIT_FOR to finish, then launching '$NEXT_ARM'"
while true; do
  if [ -f "$ROOT/results/$WAIT_FOR/summary.json" ]; then
    say "$WAIT_FOR finished (summary.json written)"
    break
  fi
  if ! pgrep -f "run\.js .*--run-id $WAIT_FOR" >/dev/null 2>&1; then
    # Give the closing balance sample its settle time before calling it dead:
    # run.js waits ~20s after the last attempt, and the process is gone only
    # briefly before summary.json lands.
    sleep 60
    if [ ! -f "$ROOT/results/$WAIT_FOR/summary.json" ]; then
      say "STOP: $WAIT_FOR's process is gone but no summary.json — it died rather than finished."
      say "STOP: not launching $NEXT_ARM. Look at results/$WAIT_FOR/ first."
      exit 1
    fi
    say "$WAIT_FOR finished (summary.json written)"
    break
  fi
  sleep 60
done

solved=$(python3 -c "import json;s=json.load(open('$ROOT/results/$WAIT_FOR/summary.json'));print(s.get('solved'),'solved, \$'+str(s.get('cost_std')),'std, billed \$'+str(s.get('billed_usd')))" 2>/dev/null || echo "summary unreadable")
say "$WAIT_FOR: $solved"

bal=$(set -a; . "$ROOT/.env"; set +a; curl -s -m 20 https://api.deepseek.com/user/balance \
  -H "Authorization: Bearer $DEEPSEEK_API_KEY" \
  | python3 -c "import json,sys;print(json.load(sys.stdin)['balance_infos'][0]['total_balance'])" 2>/dev/null)
if [ -z "$bal" ]; then
  say "STOP: could not read the DeepSeek balance — not launching $NEXT_ARM blind."
  exit 1
fi
say "balance: \$$bal (floor for launching a cell: \$$MIN_BALANCE)"
if [ "$(python3 -c "print(1 if float('$bal') < $MIN_BALANCE else 0)")" = "1" ]; then
  say "STOP: balance below \$$MIN_BALANCE — top up, then run: ./scripts/blockA-fatex87-0805.sh $NEXT_ARM"
  exit 1
fi

say "launching $NEXT_ARM"
# env -u, and not a plain call: this script re-execs ITSELF with
# CMP_IN_TMUX_LAUNCH=1, and a child inherits it. The launcher reads that same
# variable to mean "you are already in your own session, run in the foreground
# and skip the prerequisites" — so an inherited copy makes the next cell run
# inside the chain's pane with every guard skipped, under a session named for
# the chain rather than the run. (Observed on the semantic cell, 2026-08-06.)
env -u CMP_IN_TMUX_LAUNCH "$ROOT/scripts/blockA-fatex87-0805.sh" "$NEXT_ARM" 2>&1 | tee -a "$LOG"
say "chain done (the cell now runs in its own tmux session)"
