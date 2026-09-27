#!/usr/bin/env bash
# Keep one lean server alive: polls /health, starts a server only if none responds.
#   scripts/lean-server-watchdog.sh
#   CMP_REPL_WORKERS=1 scripts/lean-server-watchdog.sh
cd "$(dirname "$0")/.." || exit 1
export PATH="$HOME/.local/node/bin:$HOME/.elan/bin:$PATH"
echo "$(date -Is) watchdog up — polling /health every 10s; silence means the server is healthy"
# Kill a server that answers /health but stays not ready for 120 polls (20 min).
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
