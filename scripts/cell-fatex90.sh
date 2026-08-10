#!/usr/bin/env bash
# Any single arm as a cell on FATE-X, run list problems-fatex/safe90.txt (n = 90).
#
#   ./scripts/cell-fatex90.sh {base|semantic|grep|loogle|snippet|snippetonly} [cut] [conc] [suffix]
#
# Generalises blockB-fatex90.sh, which only knew the two block-B arms; for snippet and
# snippetonly the two emit an identical run.js invocation, so cells launched either way
# stay comparable. It exists because safe90 replicates are now the main budget line:
# block A at k=1 could not resolve its own arms (grep 47/87 vs semantic 46/87, exact
# McNemar p = 1.00; vs base p = 0.109 on 8/2 discordant), and n is pinned at 90, so
# power has to come from replicate cells rather than more problems.
#
# `suffix` distinguishes replicates of the same arm at the same freeze:
# `grep 0807 10 r2` -> run id grep-fatex90-0807-r2, the SECOND grep run at this cut
# (the first is grep-fatex87-0807, paired to it over the common 90 via its glued
# easy3 supplement).
#
# Launch discipline is blockA-fatex87.sh's: own detached tmux session, so a cell never
# depends on the terminal or Claude session that launched it, and the same
# preconditions. Block A's "never two arms at once" rule is about billed_usd only;
# concurrent cells are allowed (base/semantic 2026-08-08, snippetonly 2026-08-09) and
# their billed_usd is annotated meaningless at summary time — cost_std, the headline
# metric, is unaffected. Concurrency is a throughput knob only under the deterministic
# verdict, and is recorded in run.json.
set -u
cd "$(dirname "$0")/.." || exit 1
ROOT="$PWD"

export PATH="$HOME/.local/node/bin:$HOME/.elan/bin:$PATH"

ARM="${1:-}"
case "$ARM" in
  base)        COMBO="" ;;
  semantic)    COMBO="lean-search" ;;
  grep)        COMBO="lean-grep" ;;
  loogle)      COMBO="lean-loogle" ;;
  snippet)     COMBO="lean-grep,lean-snippet" ;;
  snippetonly) COMBO="lean-snippet" ;;
  # Block C. The base here is the block-B winner, written as grep+snippet on the
  # assumption snippet carries it -- revisit if it does not. Worth saying out loud:
  # with F = 10 the hill-climb's "winner" is not resolvable when arms land within a
  # few problems of each other, so the carried-forward config is a stated choice, not
  # a measured one, and block C results are conditional on it (PLAN says to report
  # cross-block attributions that way).
  spawn)       COMBO="lean-grep,lean-snippet,lean-spawn" ;;
  spawnfacts)  COMBO="lean-grep,lean-snippet,lean-spawn,lean-facts" ;;
  spawnplan)   COMBO="lean-grep,lean-snippet,lean-spawn,lean-plan" ;;
  *) echo "usage: $0 {base|semantic|grep|loogle|snippet|snippetonly|spawn|spawnfacts|spawnplan} [cut] [conc] [suffix]"
     echo "       cut defaults to 0807 (the current freeze), conc to 15, suffix to empty"; exit 2 ;;
esac

CUT="${2:-0807}"
CONC="${3:-15}"
SUFFIX="${4:-}"
RUN_ID="${ARM}-fatex90-${CUT}${SUFFIX:+-$SUFFIX}"
LOG="$ROOT/results/$RUN_ID.console.log"

if [ -z "${CMP_IN_TMUX_LAUNCH:-}" ]; then
  command -v tmux >/dev/null || { echo "tmux missing — a run started without it dies with your ssh session"; exit 1; }
  tmux has-session -t watchdog 2>/dev/null || {
    echo "no 'watchdog' tmux session — nothing would restart the lean server if it died mid-run."; exit 1; }
  tmux has-session -t "$RUN_ID" 2>/dev/null && {
    echo "tmux session '$RUN_ID' already exists — that cell is already running (tmux attach -t $RUN_ID)"; exit 1; }
  [ -e "$ROOT/results/$RUN_ID" ] && {
    echo "results/$RUN_ID already exists — pick another suffix rather than writing into a finished cell"; exit 1; }

  # run.js recycles the whole REPL pool when it reuses a server, and the recycle is for
  # the gap BETWEEN runs: it kills every worker. The server's 409 guard ("any worker
  # mid-check") is an instantaneous test, so a cell launched while another is live can
  # slip through a momentary idle gap and drop the in-flight checks of the running cell.
  # That happened on 2026-08-10: launching base-fatex90-0807-r2 at 11:07:34 left
  # grep-fatex90-0807-r2's last two attempts (fatex_91, fatex_95) blocked on a lean_check
  # whose REPL no longer existed, for the full 5.5 h client wait. Concurrent cells are
  # still fine -- what is not fine is STARTING one while another is mid-flight.
  live=$(pgrep -af "run\.js .*--run-id" | grep -oP '(?<=--run-id )\S+' | grep -v "^$RUN_ID$" || true)
  if [ -n "$live" ]; then
    echo "another cell is already in flight:"
    echo "$live" | sed 's/^/  /'
    echo "launching now would recycle the REPL pool under it and strand its in-flight checks."
    echo "wait for it to finish, or set CMP_ALLOW_CONCURRENT_LAUNCH=1 to override."
    [ -n "${CMP_ALLOW_CONCURRENT_LAUNCH:-}" ] || exit 1
    # The override is only safe with the recycle disabled — that is the thing that
    # strands the running cell, not the concurrency itself.
    export CMP_NO_RECYCLE=1
    echo "CMP_ALLOW_CONCURRENT_LAUNCH set — proceeding with CMP_NO_RECYCLE=1."
  fi

  health=$(curl -sf --max-time 5 "http://127.0.0.1:${CMP_LEAN_PORT:-8787}/health" 2>/dev/null)
  echo "$health" | grep -q '"ready":true' || { echo "lean server not ready — check the watchdog (tmux attach -t watchdog)"; exit 1; }
  echo "$health" | grep -q '"library_sha256":null' || { echo "server has a library baked in — a plain cell needs a plain, current env"; exit 1; }
  git diff --quiet && git diff --cached --quiet || { echo "working tree dirty — harness_git_sha would not describe what ran"; exit 1; }

  want_sha=$(node -e 'import("./runner/check-env.js").then(m=>console.log(m.CHECK_SHA))' 2>/dev/null)
  echo "$health" | grep -q "\"check_sha\":\"$want_sha\"" || {
    echo "lean server is not running this checkout's check environment (want $want_sha)."
    echo "restart it:  pkill -f 'runner/lean-server\\.js'   # the watchdog brings up a fresh pool in ~10s"
    exit 1; }

  # CMP_NO_RECYCLE has to travel in the command string: the re-exec inside tmux skips
  # the guard block above, so an export out here would never reach run.js.
  tmux new-session -d -s "$RUN_ID" -c "$ROOT" \
    "CMP_IN_TMUX_LAUNCH=1 ${CMP_NO_RECYCLE:+CMP_NO_RECYCLE=1 }'$ROOT/scripts/cell-fatex90.sh' '$ARM' '$CUT' '$CONC' '$SUFFIX' 2>&1 | tee -a '$LOG'; \
     echo; echo \"=== $RUN_ID exited at \$(date -Is) — full console log: $LOG\"; \
     echo '=== pane kept open on purpose; tmux kill-session -t $RUN_ID when you are done with it'; \
     exec bash" || { echo "tmux refused to start the session"; exit 1; }

  echo "=== $RUN_ID launched in its own tmux session (survives ssh disconnect)"
  echo "    watch:  tmux attach -t $RUN_ID     (ctrl-b d to detach)"
  echo "    or:     tail -f $LOG"
  echo "    status: node runner/status.js $RUN_ID"
  exit 0
fi

echo "=== $(date -Is) launching $RUN_ID (combo: ${COMBO:-baseline}, concurrency: $CONC) at $(git rev-parse --short HEAD)"
exec node runner/run.js --combo "$COMBO" \
  --problems problems-fatex/safe90.txt --problems-dir problems-fatex \
  --budget-std 1.00 --concurrency "$CONC" --run-id "$RUN_ID"
