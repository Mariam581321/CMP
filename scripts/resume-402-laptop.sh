#!/usr/bin/env bash
# Revive the LAPTOP-owned casualties of the 2026-08-16 DeepSeek 402 outage on the
# server — the laptop is retired, its run dirs were synced into results/ at ~19:08
# CEST, and run.js --resume only needs each attempt's session dir (pi -c continues
# the session; spend/budget bind cumulatively via the byte-0 tail).
#
# Targets are EXPLICIT lists, not computed from agent_died records, because
#   (a) -laptop/results.jsonl also holds zero-cost 402 rows for A-owned fatex_47..83
#       (the laptop queue insta-dying after balance hit zero) — those problems belong
#       to snippetonly-fatex90-0807-r2 and its resume chain, never to this one; and
#   (b) fatex_95 has a session but NO record — it was mid-flight and healthy at sync.
# Inventory + glue rule: results/402-rerun-list-0816.json.
#
# Gates: balance back above $8 (headroom — the A chain and rerun-cell resumes draw
# from the same pool), then the four resume402-now segments closing
# (summary-resume.json) so this load queues behind them on the 6 cores.
#
#   tmux new-session -d -s resume402-laptop \
#     'cd /home/mariam/CMP && scripts/resume-402-laptop.sh 2>&1 | tee -a results/resume-402-laptop.console.log'
# MUST run from the main checkout. CMP_NO_RECYCLE: other cells are live.
set -u
cd "$(dirname "$0")/.." || exit 1
export PATH="$HOME/.local/node/bin:$HOME/.elan/bin:$PATH"
export CMP_NO_RECYCLE=1
set -a; [ -f .env ] && . ./.env; set +a

echo "=== $(date -Is) waiting for DeepSeek balance > \$8"
while :; do
  bal=$(curl -sf -m 15 https://api.deepseek.com/user/balance \
    -H "Authorization: Bearer ${DEEPSEEK_API_KEY:-}" \
    | python3 -c 'import json,sys;d=json.load(sys.stdin);print(next((b["total_balance"] for b in d.get("balance_infos",[]) if b["currency"]=="USD"),"0"))' 2>/dev/null || echo 0)
  awk "BEGIN{exit !($bal > 8)}" && break
  sleep 120
done
echo "=== $(date -Is) balance is \$$bal"

echo "=== waiting for the resume402-now segments to close (summary-resume.json x4)"
for rid in base-fatex90-0807-r2-cwrerun semantic-fatex87-0807-cwrerun \
           snippet-fatex90-0807-r2-cwrerun snippetonly-fatex90-0807-cwrerun; do
  until [ -f "results/$rid/summary-resume.json" ]; do sleep 60; done
done

revive() { # $1 run-id  $2.. problems
  local rid="$1"; shift
  local combo budget
  combo=$(python3 -c "import json;print(','.join(json.load(open('results/$rid/run.json'))['combo']))")
  budget=$(python3 -c "import json;print(json.load(open('results/$rid/run.json'))['budget_std'])")
  local list="problems-fatex/resume402-$rid.txt"
  printf '%s\n' "$@" > "$list"
  echo "=== $(date -Is) resuming $rid: $*"
  node runner/run.js --resume --combo "$combo" --problems "$list" \
    --problems-dir problems-fatex --budget-std "$budget" --concurrency "$#" \
    --run-id "$rid" 2>&1 | tee -a "results/$rid.console.log"
}

revive snippetonly-fatex90-0807-r2-laptop \
  fatex_85 fatex_86 fatex_87 fatex_88 fatex_90 fatex_91 fatex_95 fatex_98 fatex_100
revive snippetonly-fatex90-0807-r2-laptop-mid \
  fatex_71 fatex_72 fatex_74

echo "=== $(date -Is) laptop revival complete — glue takes real verdicts per 402-rerun-list-0816.json"
