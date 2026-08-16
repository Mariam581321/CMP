#!/usr/bin/env bash
# Kill run A's (snippetonly-fatex90-0807-r2) duplicate attempts on problems the
# laptop runs already own (2026-08-16 coordination, first-started-wins):
#   C (mid, fixed):  fatex_72 73 74            (71 already killed by hand 18:05)
#   B (tail):        fatex_84..98, 100          (B started all 16 before A got there)
# Contested ground (76 78 79 80 82 83) is NOT auto-killed — first-started-wins there
# needs B's live start times, which this server can't see until the laptop rsyncs.
# A start there is logged so a human (or a later session) can adjudicate.
#
# A killed attempt still leaves a solved=false row in A's results.jsonl (the runner
# grades the file it left behind) — the final glue must prefer the laptop record for
# any problem in the claim set. Exits when A's run closes.
set -u
cd "$(dirname "$0")/.." || exit 1
RUN=results/snippetonly-fatex90-0807-r2
LOG=results/a-duplicate-kills.log
CLAIMED=" fatex_72 fatex_73 fatex_74 fatex_84 fatex_85 fatex_86 fatex_87 fatex_88 fatex_89 fatex_90 fatex_91 fatex_92 fatex_93 fatex_94 fatex_95 fatex_96 fatex_97 fatex_98 fatex_100 "
CONTESTED=" fatex_76 fatex_78 fatex_79 fatex_80 fatex_82 fatex_83 "
log() { echo "$(date -Is) $*" | tee -a "$LOG"; }
log "watcher up (pid $$)"
declare -A seen
while [ ! -f "$RUN/summary.json" ]; do
  for d in "$RUN"/fatex_*/; do
    p=$(basename "$d")
    [ -n "${seen[$p]:-}" ] && continue
    seen[$p]=1
    if [[ "$CLAIMED" == *" $p "* ]]; then
      killed=""
      for pid in $(pgrep -x pi); do
        if [ "$(readlink /proc/$pid/cwd 2>/dev/null)" = "$PWD/$RUN/$p/work" ]; then
          kill -9 "$pid" && killed="$pid"
        fi
      done
      if [ -n "$killed" ]; then log "KILLED A's $p (pid $killed) — owned by laptop"
      else log "WARNING: A started claimed $p but no pi process found (retry next sweep)"; unset "seen[$p]"; fi
    elif [[ "$CONTESTED" == *" $p "* ]]; then
      log "CONTESTED: A started $p — check whether laptop B got there first"
    fi
  done
  sleep 60
done
log "run A closed — watcher exiting"
