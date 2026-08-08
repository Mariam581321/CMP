#!/usr/bin/env bash
# Block B (scratch verification) on FATE-X, run list problems-fatex/safe87.txt (n = 87).
#
#   ./scripts/blockB-fatex87.sh snippet [cut] [concurrency]
#
# snippet = the block-A winning search + lean-snippet (stateless check_snippet(code):
# compile any scratch snippet, no files involved — PLAN.md, Block B). The winner is
# grep: it clinched on solves before semantic even closed (grep 47/87 final vs
# semantic's reachable maximum of 46 on 2026-08-09), so the combo is
# lean-grep,lean-snippet.
#
# Same launch discipline as blockA-fatex87.sh (own detached tmux session, same
# preconditions), with ONE deliberate difference: block A's "never two arms at once"
# rule is about billed_usd, and this cell was explicitly allowed (user decision,
# 2026-08-08/09) to overlap the base-fatex87-0807 tail — its billed_usd is annotated
# meaningless at summary time; cost_std, the headline metric, is unaffected.
set -u
cd "$(dirname "$0")/.." || exit 1
ROOT="$PWD"

export PATH="$HOME/.local/node/bin:$HOME/.elan/bin:$PATH"

ARM="${1:-}"
case "$ARM" in
  snippet) COMBO="lean-grep,lean-snippet" ;;
  *) echo "usage: $0 {snippet} [cut] [concurrency]   (cut defaults to 0807, the current freeze; concurrency to 15)"; exit 2 ;;
esac

CUT="${2:-0807}"
CONC="${3:-15}"
RUN_ID="${ARM}-fatex87-${CUT}"
LOG="$ROOT/results/$RUN_ID.console.log"

if [ -z "${CMP_IN_TMUX_LAUNCH:-}" ]; then
  command -v tmux >/dev/null || { echo "tmux missing — a run started without it dies with your ssh session"; exit 1; }
  tmux has-session -t watchdog 2>/dev/null || {
    echo "no 'watchdog' tmux session — nothing would restart the lean server if it died mid-run."; exit 1; }
  tmux has-session -t "$RUN_ID" 2>/dev/null && {
    echo "tmux session '$RUN_ID' already exists — that cell is already running (tmux attach -t $RUN_ID)"; exit 1; }

  health=$(curl -sf --max-time 5 "http://127.0.0.1:${CMP_LEAN_PORT:-8787}/health" 2>/dev/null)
  echo "$health" | grep -q '"ready":true' || { echo "lean server not ready — check the watchdog (tmux attach -t watchdog)"; exit 1; }
  echo "$health" | grep -q '"library_sha256":null' || { echo "server has a library baked in — block B needs a plain, current env"; exit 1; }
  git diff --quiet && git diff --cached --quiet || { echo "working tree dirty — harness_git_sha would not describe what ran"; exit 1; }

  want_sha=$(node -e 'import("./runner/check-env.js").then(m=>console.log(m.CHECK_SHA))' 2>/dev/null)
  echo "$health" | grep -q "\"check_sha\":\"$want_sha\"" || {
    echo "lean server is not running this checkout's check environment (want $want_sha)."
    echo "restart it:  pkill -f 'runner/lean-server\\.js'   # the watchdog brings up a fresh pool in ~10s"
    exit 1; }

  tmux new-session -d -s "$RUN_ID" -c "$ROOT" \
    "CMP_IN_TMUX_LAUNCH=1 '$ROOT/scripts/blockB-fatex87.sh' '$ARM' '$CUT' '$CONC' 2>&1 | tee -a '$LOG'; \
     echo; echo \"=== $RUN_ID exited at \$(date -Is) — full console log: $LOG\"; \
     echo '=== pane kept open on purpose; tmux kill-session -t $RUN_ID when you are done with it'; \
     exec bash" || { echo "tmux refused to start the session"; exit 1; }

  echo "=== $RUN_ID launched in its own tmux session (survives ssh disconnect)"
  echo "    watch:  tmux attach -t $RUN_ID     (ctrl-b d to detach)"
  echo "    or:     tail -f $LOG"
  echo "    status: node runner/status.js $RUN_ID"
  exit 0
fi

echo "=== $(date -Is) launching $RUN_ID (combo: $COMBO, concurrency: $CONC) at $(git rev-parse --short HEAD)"
exec node runner/run.js --combo "$COMBO" \
  --problems problems-fatex/safe87.txt --problems-dir problems-fatex \
  --budget-std 1.00 --concurrency "$CONC" --run-id "$RUN_ID"
