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
while true; do
  if ! curl -sf --max-time 3 "http://127.0.0.1:${CMP_LEAN_PORT:-8787}/health" >/dev/null; then
    echo "$(date -Is) lean server down — starting one (log: results/lean-server-watchdog.log)"
    node runner/lean-server.js >> results/lean-server-watchdog.log 2>&1
    echo "$(date -Is) lean server exited; restarting in 10s"
  fi
  sleep 10
done
