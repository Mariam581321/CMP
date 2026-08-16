#!/usr/bin/env bash
# When spawn / spawnfacts land, rebuild the grid chart page and send a push.
#
# The page (drafts/fatex-grid-charts-0811.html + its artifact variant) is
# rebuilt fully offline by scripts/build-grid-charts.py. Publishing the
# artifact needs a live interactive Claude session (the Artifact tool does
# not exist in `claude -p`), so this script can't do that last step itself —
# the push tells you the page is rebuilt; any Claude session can then publish
# it in one message: "republish the grid artifact".
#
#   tmux new -d -s artifact-when-done ~/CMP/scripts/artifact-when-done.sh
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
NOTIFY="/home/mariam/deepseek-price-watch/notify.sh"
MARK="$ROOT/drafts/.artifact-rebuilt-runs"
WANT="spawn-fatex90-0807 spawnfacts-fatex90-0807"
touch "$MARK"

say() { echo "[$(date -Is)] $*"; }

while :; do
  for rid in $WANT; do
    if [ -f "$ROOT/results/$rid/summary.json" ] && ! grep -qx "$rid" "$MARK"; then
      say "$rid landed — rebuilding chart page"
      if python3 "$ROOT/scripts/build-grid-charts.py"; then
        echo "$rid" >> "$MARK"
        SUBJ="grid charts rebuilt: $rid finished"
        BODY="$(python3 -c "import json;s=json.load(open('$ROOT/results/$rid/summary.json'));print(f\"{s['run_id']}: {s['solved']}/{s['problems']} solved, \${s['cost_std']:.2f}\")")
The chart page is rebuilt at drafts/fatex-grid-charts-0811.html.
To update the meeting link, open any Claude session in ~/CMP and say:
  republish the grid artifact"
        say "notifying: $SUBJ"
        if [ -x "$NOTIFY" ]; then printf '%s' "$BODY" | "$NOTIFY" "$SUBJ"; else say "notify.sh missing"; fi
      else
        say "build failed for $rid — will retry next tick"
      fi
    fi
  done
  alldone=1
  for rid in $WANT; do grep -qx "$rid" "$MARK" || alldone=0; done
  [ "$alldone" = 1 ] && { say "both runs rebuilt into the page — exiting"; break; }
  sleep 600
done
