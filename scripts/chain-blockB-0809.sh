#!/usr/bin/env bash
# The 2026-08-09 block-B chain: semantic finishes -> snippetonly (bold cell first,
# user decision) -> balance floor -> snippet (grep+snippet, the canonical cell).
# Same discipline as chain-next-cell.sh: a vanished run.js without a summary.json
# stops the chain for a human; a balance under $45 stops it before a cell that
# could die of insufficient funds mid-run. snippetonly may overlap the base tail
# (sanctioned; its billed_usd gets annotated meaningless at summary time).
set -u
cd "$(dirname "$0")/.." || exit 1
ROOT="$PWD"
export PATH="$HOME/.local/node/bin:$HOME/.elan/bin:$PATH"
LOG="$ROOT/results/chain-blockB-0809.log"
say() { echo "$(date -Is) $*" | tee -a "$LOG"; }

wait_for_run() { # <run-id>  — true when summary.json lands; exits the chain if the run died
  local rid="$1"
  while true; do
    [ -f "$ROOT/results/$rid/summary.json" ] && { say "$rid finished"; return 0; }
    if ! pgrep -f "run\.js .*--run-id $rid" >/dev/null 2>&1; then
      sleep 60
      [ -f "$ROOT/results/$rid/summary.json" ] && { say "$rid finished"; return 0; }
      say "STOP: $rid's process is gone but no summary.json — it died rather than finished."
      exit 1
    fi
    sleep 120
  done
}

balance_floor() { # stop the chain if the DeepSeek balance is unreadable or under $45
  local bal
  bal=$(set -a; . "$ROOT/.env"; set +a; curl -s -m 20 https://api.deepseek.com/user/balance \
    -H "Authorization: Bearer $DEEPSEEK_API_KEY" \
    | python3 -c "import json,sys;print(json.load(sys.stdin)['balance_infos'][0]['total_balance'])" 2>/dev/null)
  [ -n "$bal" ] || { say "STOP: could not read the DeepSeek balance — not launching blind."; exit 1; }
  say "balance: \$$bal (floor: \$45)"
  [ "$(python3 -c "print(1 if float('$bal') < 45 else 0)")" = "1" ] && {
    say "STOP: balance below \$45 — top up, then run: ./scripts/blockB-fatex87.sh $1"; exit 1; }
  return 0
}

say "chain armed: semantic -> snippetonly -> snippet"
wait_for_run semantic-fatex87-0807

if [ ! -f "$ROOT/results/snippetonly-fatex87-0807/summary.json" ]; then
  balance_floor snippetonly
  say "launching snippetonly (lean-snippet, no search)"
  env -u CMP_IN_TMUX_LAUNCH "$ROOT/scripts/blockB-fatex87.sh" snippetonly 0807 15 2>&1 | tee -a "$LOG"
  sleep 30
  wait_for_run snippetonly-fatex87-0807
fi

balance_floor snippet
say "launching snippet (lean-grep,lean-snippet)"
env -u CMP_IN_TMUX_LAUNCH "$ROOT/scripts/blockB-fatex87.sh" snippet 0807 15 2>&1 | tee -a "$LOG"
say "chain done (snippet now runs in its own tmux session)"
