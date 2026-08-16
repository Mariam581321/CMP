#!/usr/bin/env bash
# Final apply?/sorryAx integrity pass for block C: when spawn + spawnfacts close
# (same summary.json condition rerun-falsegreen.sh waits on), re-run the stamp scan
# and the transcript sweep over the full record sets and append the result to
# results/falsegreen-transcript-review-0811.md. Read-only against the cells, so it
# is safe to run alongside rerun-falsegreen.sh firing at the same moment.
#
# If NEW false greens appear they are NOT auto-added to the rerun (the 0811 SPECS
# list in rerun-falsegreen.sh is deliberate, human-vetted) — instead this pages via
# the price watcher's notify.sh so they can be added before the fgrerun tables are
# read. Zero new false greens pages nobody; the appended section is the record.
#
#   nohup scripts/rescan-falsegreen-when-done.sh >> results/rescan-falsegreen.console.log 2>&1 &
# MUST run from the main checkout (worktrees lack .env/results).
set -u
cd "$(dirname "$0")/.." || exit 1
export PATH="$HOME/.local/node/bin:$PATH"

echo "=== $(date -Is) waiting for block C (spawn + spawnfacts) summaries"
until [ -f results/spawn-fatex90-0807/summary.json ] && [ -f results/spawnfacts-fatex90-0807/summary.json ]; do sleep 300; done

echo "=== $(date -Is) block C closed — final falsegreen stamp scan + transcript sweep"
node scripts/falsegreen-scan.mjs --json results/spawn-fatex90-0807 results/spawnfacts-fatex90-0807 \
  > results/falsegreen-audit-blockC-final.json
node scripts/falsegreen-scan.mjs results/spawn-fatex90-0807 results/spawnfacts-fatex90-0807
python3 scripts/loophole-sweep-blockc.py

N=$(python3 -c "import json;print(len(json.load(open('results/falsegreen-audit-blockC-final.json'))['false_green']))")
{
  echo
  echo "## Final spawn/spawnfacts rescan — $(date -I) (cells closed, full record sets)"
  echo
  echo "Automated by scripts/rescan-falsegreen-when-done.sh at cell close."
  echo "Stamp scan: ${N} false green(s) — stamps in results/falsegreen-audit-blockC-final.json."
  echo "Transcript sweep: results/loophole-review-blockC-final.txt — attempts NOT covered by"
  echo "the 2026-08-12 interim section above still need a human read of their contexts."
} >> results/falsegreen-transcript-review-0811.md

if [ "$N" -gt 0 ]; then
  /home/mariam/deepseek-price-watch/notify.sh "CMP: ${N} false green(s) in final block-C scan" <<EOF || true
The closed spawn/spawnfacts cells show ${N} false-green attempt(s) the 0811 rerun
list does not cover. Add them to SPECS in scripts/rerun-falsegreen.sh (or rerun by
hand) BEFORE regenerating the fgrerun-patched tables.
Stamps: results/falsegreen-audit-blockC-final.json
EOF
fi
echo "=== $(date -Is) done — new false greens: ${N}"
