#!/usr/bin/env bash
# Block A (search) on FATE-X, run list problems-fatex/safe87.txt (n = 87).
#
#   ./scripts/blockA-fatex87-0805.sh grep
#
# Launches into its OWN detached tmux session named after the run id, so the run
# outlives the ssh connection that started it, the terminal it was typed in, and
# the Claude session that may have typed it. Nothing to remember at launch time:
# run it from anywhere and it detaches itself. Attach with
#   tmux attach -t grep-fatex87-0805      (detach again with ctrl-b d)
# and read the console log at results/<run-id>.console.log either way.
#
# ONE ARM PER INVOCATION, and never two at once: billed_usd comes from the
# account-wide DeepSeek balance delta sampled either side of the run, so
# concurrent runs on the same key make every delta meaningless (run.js says so
# in its own words). Wait for a cell to finish before launching the next.
#
# Order decided 2026-08-05 (PLAN.md, Next steps): grep -> base -> semantic ->
# loogle. base-vs-grep is the widest contrast in the grid, so those two cells
# also settle the open "does FATE-X floor?" question — read the discordant-pair
# count as soon as the second one grades.
set -u
cd "$(dirname "$0")/.." || exit 1
ROOT="$PWD"

# tmux runs a session command as a NON-INTERACTIVE, non-login bash, which reads
# neither .bashrc nor .profile — and node lives on PATH only via .bashrc. A
# launcher that skips this line dies instantly with "node: command not found"
# inside a pane nobody is watching. (The watchdog carries the same line for the
# same reason.) run.js re-exports it for its own children; this is for us.
export PATH="$HOME/.local/node/bin:$HOME/.elan/bin:$PATH"

ARM="${1:-}"
case "$ARM" in
  base)     COMBO="" ;;
  semantic) COMBO="lean-search" ;;
  grep)     COMBO="lean-grep" ;;
  loogle)   COMBO="lean-loogle" ;;
  *) echo "usage: $0 {grep|base|semantic|loogle}"; exit 2 ;;
esac

RUN_ID="${ARM}-fatex87-0805"
LOG="$ROOT/results/$RUN_ID.console.log"

# ---- prerequisites -------------------------------------------------------
# Checked in the OUTER invocation, before detaching, so a refusal lands in the
# terminal that asked for it rather than in a pane that then vanishes. Each of
# these has cost a run before.
if [ -z "${CMP_IN_TMUX_LAUNCH:-}" ]; then
  command -v tmux >/dev/null || { echo "tmux missing — a run started without it dies with your ssh session"; exit 1; }
  tmux has-session -t watchdog 2>/dev/null || {
    echo "no 'watchdog' tmux session — nothing would restart the lean server if it died mid-run."
    echo "start it first:  tmux new-session -d -s watchdog 'cd $ROOT && ./scripts/lean-server-watchdog.sh 2>&1 | tee -a results/watchdog-console.log'"
    exit 1; }
  tmux has-session -t "$RUN_ID" 2>/dev/null && {
    echo "tmux session '$RUN_ID' already exists — that cell is already running (tmux attach -t $RUN_ID)"; exit 1; }

  health=$(curl -sf --max-time 5 "http://127.0.0.1:${CMP_LEAN_PORT:-8787}/health" 2>/dev/null)
  echo "$health" | grep -q '"ready":true' || { echo "lean server not ready — check the watchdog (tmux attach -t watchdog)"; exit 1; }
  echo "$health" | grep -q '"library_sha256":null' || { echo "server has a library baked in (or predates library baking) — block A needs a plain, current env"; exit 1; }
  git diff --quiet && git diff --cached --quiet || { echo "working tree dirty — harness_git_sha would not describe what ran"; exit 1; }

  # ---- detach --------------------------------------------------------------
  # A session of its own, named for the run: `tmux ls` becomes a live inventory
  # of what is running, and killing a run can never touch the watchdog or the
  # lean server, which live in their own session and must outlive every cell.
  # The pane is kept alive after the run exits so the final summary stays
  # readable — a session that vanished on its own is indistinguishable from one
  # that never started.
  tmux new-session -d -s "$RUN_ID" -c "$ROOT" \
    "CMP_IN_TMUX_LAUNCH=1 '$ROOT/scripts/blockA-fatex87-0805.sh' '$ARM' 2>&1 | tee -a '$LOG'; \
     echo; echo \"=== $RUN_ID exited at \$(date -Is) — full console log: $LOG\"; \
     echo '=== pane kept open on purpose; tmux kill-session -t $RUN_ID when you are done with it'; \
     exec bash" || { echo "tmux refused to start the session"; exit 1; }

  echo "=== $RUN_ID launched in its own tmux session (survives ssh disconnect)"
  echo "    watch:  tmux attach -t $RUN_ID     (ctrl-b d to detach)"
  echo "    or:     tail -f $LOG"
  echo "    status: node runner/status.js results/$RUN_ID"
  exit 0
fi

# ---- the run itself (inside tmux) ----------------------------------------
echo "=== $(date -Is) launching $RUN_ID (combo: ${COMBO:-baseline}) at $(git rev-parse --short HEAD)"
exec node runner/run.js --combo "$COMBO" \
  --problems problems-fatex/safe87.txt --problems-dir problems-fatex \
  --budget-std 1.00 --concurrency 25 --run-id "$RUN_ID"
