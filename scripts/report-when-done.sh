#!/usr/bin/env bash
# Wait for the named runs to finish, regenerate RUNS.md, then notify.
#
#   ./scripts/report-when-done.sh <run-id> [<run-id> ...]
#
# Detaches into its own tmux session so it outlives the terminal and the Claude
# session that launched it, same discipline as the cell launchers. Delivery is the
# price watcher's notify.sh (login banner + wall + ntfy push).
#
# A run whose process has vanished without a summary.json did not finish, it died --
# the balance hitting zero mid-cell is the live version of that. Say so in the
# notification rather than waiting forever for a summary that is never coming.
set -u
cd "$(dirname "$0")/.." || exit 1
ROOT="$PWD"
export PATH="$HOME/.local/node/bin:$HOME/.elan/bin:$PATH"

NOTIFY="${CMP_NOTIFY:-$HOME/deepseek-price-watch/notify.sh}"
LOG="$ROOT/results/report-when-done.log"
say() { echo "$(date -Is) $*" | tee -a "$LOG"; }

[ $# -ge 1 ] || { echo "usage: $0 <run-id> [<run-id> ...]"; exit 2; }
RUNS=("$@")
SESSION="report-when-done"

if [ -z "${CMP_IN_TMUX_LAUNCH:-}" ]; then
  tmux has-session -t "$SESSION" 2>/dev/null && {
    echo "session '$SESSION' already exists (tmux attach -t $SESSION)"; exit 1; }
  tmux new-session -d -s "$SESSION" -c "$ROOT" \
    "CMP_IN_TMUX_LAUNCH=1 '$ROOT/scripts/report-when-done.sh' ${RUNS[*]}; exec bash"
  echo "=== waiting on: ${RUNS[*]}"
  echo "    watch:  tmux attach -t $SESSION   |   tail -f $LOG"
  exit 0
fi

say "armed, waiting on: ${RUNS[*]}"
DIED=()
for rid in "${RUNS[@]}"; do
  while true; do
    if [ -f "$ROOT/results/$rid/summary.json" ]; then say "$rid finished"; break; fi
    if ! pgrep -f "run\.js .*--run-id $rid" >/dev/null 2>&1; then
      sleep 90   # a summary can land in the gap between the last attempt and exit
      if [ -f "$ROOT/results/$rid/summary.json" ]; then say "$rid finished"; break; fi
      say "$rid DIED — process gone, no summary.json"
      DIED+=("$rid"); break
    fi
    sleep 120
  done
done

say "regenerating RUNS.md"
./scripts/run-report.py >>"$LOG" 2>&1

# Pull the headline numbers straight out of the report inputs, so the push says
# something instead of just "done".
BODY=$(python3 - "${RUNS[@]}" <<'PY'
import json, os, sys
out=[]
for rid in sys.argv[1:]:
    d=f'results/{rid}'
    s=os.path.join(d,'summary.json')
    if os.path.exists(s):
        j=json.load(open(s))
        out.append(f"{rid}: {j['solved']}/{j['problems']} solved, ${j['cost_std']:.2f}")
    else:
        rows=[json.loads(l) for l in open(f'{d}/results.jsonl')] if os.path.exists(f'{d}/results.jsonl') else []
        out.append(f"{rid}: DIED at {len(rows)} problems, "
                   f"{sum(1 for r in rows if r.get('solved'))} solved, "
                   f"${sum(r.get('cost_std') or 0 for r in rows):.2f}")
# the number the whole grid rests on
def cell(*ids):
    d={}
    for i in ids:
        p=f'results/{i}/results.jsonl'
        if os.path.exists(p):
            for l in open(p):
                r=json.loads(l); d[r['problem']]=r
    return d
g1=cell('grep-fatex87-0807','grep-fatex87-0807-easy3'); g2=cell('grep-fatex90-0807-r2')
sh=sorted(set(g1)&set(g2))
if sh:
    f=sum(1 for p in sh if g1[p]['solved']!=g2[p]['solved'])
    out.append(f"\nNoise floor: {f} flips on {len(sh)} problems (grep r1 vs r2).")
    out.append(f"k=3 replicates -> 95% CI +/-{1.96*(f/3)**0.5:.1f} solves.")
out.append("\nRUNS.md regenerated.")
print("\n".join(out))
PY
)

SUBJ="CMP: runs finished"
[ ${#DIED[@]} -gt 0 ] && SUBJ="CMP: runs ended (${#DIED[@]} DIED)"
say "notifying: $SUBJ"
if [ -x "$NOTIFY" ]; then printf '%s' "$BODY" | "$NOTIFY" "$SUBJ"; else say "notify.sh missing"; fi
say "done"
printf '%s\n' "$BODY" | tee -a "$LOG"
