#!/usr/bin/env bash
# Keep exactly one lean server alive. Run from YOUR OWN terminal so it survives
# Claude session teardown (anything Claude spawns is session-scoped):
#   ~/CMP/scripts/lean-server-watchdog.sh
# Polls /health; only starts a server if none is responding, so it can be left
# running alongside an existing server without ever creating a second one.
#
# Memory fuses (rss cap 9000MB/worker, avail floor 1200MB) are ON by default in
# lean-server.js. To enable the 2-worker REPL pool (takes effect on the next server
# start; close VS Code first on 2-worker nights — the pool is tight on 12 GB):
#   CMP_REPL_WORKERS=2 ~/CMP/scripts/lean-server-watchdog.sh
cd "$(dirname "$0")/.." || exit 1
export PATH="$HOME/.local/node/bin:$HOME/.elan/bin:$PATH"
echo "$(date -Is) watchdog up — polling /health every 10s; silence means the server is healthy"
# Liveness is not readiness: a server whose only worker is stuck in the forever-retry
# restart loop (repl binary broken, disk full) answers /health indefinitely while every
# check queues and clients time out — a silent multi-hour stall. Kill it after 20 min of
# consecutive not-ready polls (well above the 15 min import bound + recycle margin) so
# the ordinary down-branch restarts it.
notready=0
while true; do
  h=$(curl -sf --max-time 3 "http://127.0.0.1:${CMP_LEAN_PORT:-8787}/health" 2>/dev/null)
  if [ -z "$h" ]; then
    notready=0
    echo "$(date -Is) lean server down — starting one (log: results/lean-server-watchdog.log)"
    node runner/lean-server.js >> results/lean-server-watchdog.log 2>&1
    echo "$(date -Is) lean server exited; restarting in 10s"
  elif echo "$h" | grep -q '"ready":true'; then
    notready=0
  else
    notready=$((notready + 1))
    if [ "$notready" -ge 120 ]; then
      echo "$(date -Is) lean server alive but not ready for 20 min — killing it for a clean restart"
      pkill -f "runner/lean-server\.js"
      notready=0
    fi
  fi
  sleep 10
done
