#!/usr/bin/env bash
# Three FATE-X 10-problem pilot runs (2026-08-04), sequential so billed_usd stays
# meaningful (the DeepSeek balance delta is account-wide): snippet -> spawn ->
# spawn+facts, all on lean-search like the 0802 pilot, all at HEAD 435c471.
set -u
cd /home/mariam/CMP
run() {
  local id="$1"; shift
  echo "=== $(date -Is) launching $id ==="
  node runner/run.js --combo "$1" \
    --problems problems-fatex/pilot10-0802.txt --problems-dir problems-fatex \
    --concurrency 10 --run-id "$id" \
    || { echo "=== $id FAILED to complete — stopping the chain ==="; exit 1; }
}
run snippet-fatex10-0804    lean-search,lean-snippet
run spawn-fatex10-0804      lean-search,lean-snippet,lean-spawn
run spawnfacts-fatex10-0804 lean-search,lean-snippet,lean-spawn,lean-facts
echo "=== $(date -Is) all three runs complete ==="
