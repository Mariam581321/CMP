#!/usr/bin/env bash
# Keep exactly one lean server alive. Run from YOUR OWN terminal so it survives
# Claude session teardown (anything Claude spawns is session-scoped):
#   ~/CMP/scripts/lean-server-watchdog.sh
# Polls /health; only starts a server if none is responding, so it can be left
# running alongside an existing server without ever creating a second one.
#
# Memory fuses (rss cap 13000MB/worker, avail floor 6000MB) are ON by default in
# lean-server.js. The REPL pool defaults to 8 workers, sized for the 64 GB Ryzen
# 3600 server (see CMP_REPL_WORKERS in lean-server.js for the arithmetic; takes
# effect on the next server start). To run smaller, e.g. on a laptop:
#   CMP_REPL_WORKERS=1 ~/CMP/scripts/lean-server-watchdog.sh
#
# RESTART THIS AFTER PULLING. The server bakes in what a check IS — the injected
# `set_option` head and the fuses (runner/check-env.js) — so a server left running
# across a pull is serving the old harness. run.js refuses to launch on the mismatch
# and names the fields that moved, but the cheap move is to restart here first:
#   pkill -f 'runner/lean-server\.js'    # this loop brings up a fresh one in ~10 s
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
