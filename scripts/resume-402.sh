#!/usr/bin/env bash
# Revive every attempt the 2026-08-16 DeepSeek 402 outage killed, by CONTINUING their
# sessions (runner --resume; pi -c) rather than rerunning from scratch — the session
# jsonl is the durable record and the tail reads it from byte 0, so spend and budget
# bind cumulatively across segments. Inventory: results/402-outage-0816.json.
#
# Gates on the balance actually being back (>$5), so it can be armed before the
# top-up and fires on its own. For snippetonly r2 it also waits for the original
# runner to close (its limbo attempts die on their own error streaks) so exactly one
# process owns each attempt dir. Targets are computed live: last record per problem
# with end=agent_died, minus the laptop-owned range on r2 (71-74, 84-98, 100 — the
# laptop revives its own). Idempotent: resumed rows carry `resumed:true`, and a
# problem whose last row is no longer agent_died is skipped.
#
#   nohup scripts/resume-402.sh >> results/resume-402.console.log 2>&1 &
# MUST run from the main checkout. CMP_NO_RECYCLE: other cells may be live.
set -u
cd "$(dirname "$0")/.." || exit 1
export PATH="$HOME/.local/node/bin:$HOME/.elan/bin:$PATH"
export CMP_NO_RECYCLE=1
set -a; [ -f .env ] && . ./.env; set +a

echo "=== $(date -Is) waiting for DeepSeek balance > \$5"
while :; do
  bal=$(curl -sf -m 15 https://api.deepseek.com/user/balance \
    -H "Authorization: Bearer ${DEEPSEEK_API_KEY:-}" \
    | python3 -c 'import json,sys;d=json.load(sys.stdin);print(next((b["total_balance"] for b in d.get("balance_infos",[]) if b["currency"]=="USD"),"0"))' 2>/dev/null || echo 0)
  awk "BEGIN{exit !($bal > 5)}" && break
  sleep 120
done
echo "=== $(date -Is) balance is \$$bal — reviving"

echo "=== waiting for snippetonly r2's original runner to close (summary.json)"
until [ -f results/snippetonly-fatex90-0807-r2/summary.json ]; do sleep 60; done

# run-id -> problems to skip (laptop-owned on r2; empty elsewhere)
revive() { # $1 run-id  $2 skip-regex (grep -Ev), "" = keep all
  local rid="$1" skip="${2:-^$}"
  local dead
  dead=$(python3 - "$rid" <<'PYEOF'
import json, sys
rid = sys.argv[1]
last = {}
try:
    for l in open(f"results/{rid}/results.jsonl"):
        if l.strip():
            r = json.loads(l); last[r["problem"]] = r
except FileNotFoundError:
    pass
print("\n".join(p for p, r in last.items() if r.get("end") == "agent_died"))
PYEOF
)
  dead=$(echo "$dead" | grep -Ev "$skip" | grep . || true)
  [ -z "$dead" ] && { echo "=== $rid: nothing to revive"; return; }
  local cfg combo budget
  combo=$(python3 -c "import json;print(','.join(json.load(open('results/$rid/run.json'))['combo']))")
  budget=$(python3 -c "import json;print(json.load(open('results/$rid/run.json'))['budget_std'])")
  local list="problems-fatex/resume402-$rid.txt"
  printf '%s\n' $dead > "$list"
  echo "=== $(date -Is) rewinding outage scars for $rid"
  node scripts/rewind-scar.mjs $(printf "results/$rid/%s " $dead)
  echo "=== $(date -Is) resuming $rid (promptless): $(tr '\n' ' ' < "$list")"
  node runner/run.js --resume --combo "$combo" --problems "$list" \
    --problems-dir problems-fatex --budget-std "$budget" --concurrency "$(wc -l < "$list")" \
    --run-id "$rid" 2>&1 | tee -a "results/$rid.console.log"
}

# r2 first (biggest cell), laptop-owned problems excluded.
revive snippetonly-fatex90-0807-r2 '^fatex_(7[1-4]|8[4-9]|9[0-8]|100)$'
revive base-fatex90-0807-r2-cwrerun
revive semantic-fatex87-0807-cwrerun
revive snippet-fatex90-0807-r2-cwrerun
revive snippetonly-fatex90-0807-cwrerun
revive base-fatex87-0807-cwrerun2

echo "=== $(date -Is) resume chain complete — dedup keep-last per problem before any glue/report (resumed rows supersede agent_died rows in results.jsonl)"
