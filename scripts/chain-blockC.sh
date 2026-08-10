#!/usr/bin/env bash
# Overnight: wait for the snippet cell, then launch block C's spawn cell.
#
#   ./scripts/chain-blockC.sh
#
# spawn stacks on the block-B winner, so snippet finishing is not just a scheduling
# trigger -- it is what DEFINES spawn's base config (lean-grep,lean-snippet,lean-spawn,
# committed in cell-fatex90.sh). That is why this waits on snippet specifically and not
# on the queue emptying.
#
# The launch goes through cell-fatex90.sh with CMP_ALLOW_CONCURRENT_LAUNCH=1 set
# unconditionally: if another cell is still live the launcher turns that into
# CMP_NO_RECYCLE=1, which is what makes a concurrent launch safe (5539995); if nothing
# is live the guard never fires and the normal between-runs recycle happens as usual.
#
# What it deliberately does NOT do: decide whether snippet actually WON block B. With
# F = 10 measured, arms landing within a few problems of each other are not separable,
# so "the winner" is a stated choice rather than a measurement. The notification carries
# the three block-B numbers so that choice can be reviewed in the morning; spawn costs
# ~$40 and can be killed if snippet came out badly.
set -u
cd "$(dirname "$0")/.." || exit 1
ROOT="$PWD"
export PATH="$HOME/.local/node/bin:$HOME/.elan/bin:$PATH"

NOTIFY="/home/mariam/deepseek-price-watch/notify.sh"
LOG="$ROOT/results/chain-blockC.log"
WAIT_FOR="snippet-fatex90-0807"
FLOOR=45
say() { echo "$(date -Is) $*" | tee -a "$LOG"; }
push() { [ -x "$NOTIFY" ] && printf '%s' "$2" | "$NOTIFY" "$1"; }

if [ -z "${CMP_IN_TMUX_LAUNCH:-}" ]; then
  tmux has-session -t chain-blockC 2>/dev/null && { echo "chain-blockC already running"; exit 1; }
  tmux new-session -d -s chain-blockC -c "$ROOT" \
    "CMP_IN_TMUX_LAUNCH=1 '$ROOT/scripts/chain-blockC.sh'; exec bash"
  echo "=== chain-blockC armed: waiting on $WAIT_FOR, then launching spawn"
  echo "    tail -f $LOG"
  exit 0
fi

say "armed: waiting on $WAIT_FOR, then spawn"
while true; do
  [ -f "$ROOT/results/$WAIT_FOR/summary.json" ] && { say "$WAIT_FOR finished"; break; }
  if ! pgrep -f "run\.js .*--run-id $WAIT_FOR" >/dev/null 2>&1; then
    sleep 90
    [ -f "$ROOT/results/$WAIT_FOR/summary.json" ] && { say "$WAIT_FOR finished"; break; }
    say "STOP: $WAIT_FOR died without a summary.json"
    push "CMP: chain stopped — $WAIT_FOR died" "No summary.json and no process. spawn NOT launched."
    exit 1
  fi
  sleep 120
done

# Block B, as it will be read in the morning.
BLOCKB=$(python3 - <<'PY'
import json, os
out = []
for label, ids in [("grep", ["grep-fatex87-0807", "grep-fatex87-0807-easy3"]),
                   ("grep r2", ["grep-fatex90-0807-r2"]),
                   ("snippetonly", ["snippetonly-fatex90-0807"]),
                   ("snippet", ["snippet-fatex90-0807"])]:
    d = {}
    for i in ids:
        p = f"results/{i}/results.jsonl"
        if os.path.exists(p):
            for l in open(p):
                r = json.loads(l); d[r["problem"]] = r
    if d:
        out.append(f"  {label}: {sum(1 for r in d.values() if r['solved'])}/{len(d)} "
                   f"(${sum(r.get('cost_std') or 0 for r in d.values()):.2f})")
print("\n".join(out))
PY
)
say "block B standings:"; echo "$BLOCKB" | tee -a "$LOG"

BAL=$(set -a; . "$ROOT/.env"; set +a; curl -s -m 20 https://api.deepseek.com/user/balance \
  -H "Authorization: Bearer $DEEPSEEK_API_KEY" \
  | python3 -c "import json,sys;print(json.load(sys.stdin)['balance_infos'][0]['total_balance'])" 2>/dev/null)
[ -n "$BAL" ] || { say "STOP: balance unreadable"; push "CMP: chain stopped — balance unreadable" "spawn NOT launched."; exit 1; }
say "balance \$$BAL (floor \$$FLOOR)"
if [ "$(python3 -c "print(1 if float('$BAL') < $FLOOR else 0)")" = "1" ]; then
  say "STOP: balance below floor"
  push "CMP: chain stopped — balance \$$BAL below \$$FLOOR" \
       "snippet finished but spawn was NOT launched.

Block B:
$BLOCKB

Top up, then: ./scripts/cell-fatex90.sh spawn 0807 15"
  exit 1
fi

say "launching spawn (lean-grep,lean-snippet,lean-spawn)"
env -u CMP_IN_TMUX_LAUNCH CMP_ALLOW_CONCURRENT_LAUNCH=1 \
  "$ROOT/scripts/cell-fatex90.sh" spawn 0807 15 2>&1 | tee -a "$LOG"

push "CMP: snippet done, spawn launched" \
"Block B:
$BLOCKB

spawn-fatex90-0807 launched (grep+snippet+spawn), balance \$$BAL.

spawn's base is a STATED choice, not a measured winner — F=10 means arms within a
few problems are not separable. If snippet came out badly, kill it:
  tmux kill-session -t spawn-fatex90-0807"
say "done"
