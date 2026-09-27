#!/usr/bin/env bash
# End-to-end smoke for the solved high-water mark (runner/highwater.js).
#
#   smokehw_1  proves it and stops           -> solved, first == last
#   smokehw_2  proves, improves, then sorry  -> unsolved, first != last
#   smokehw_3  leaves the sorry alone
#   smokehw_4  statement is false            -> high_water: null
#
#   scripts/smoke-highwater.sh          (needs the lean server up)
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT=$PWD
DAY=$(date +%m%d)
FIX="$ROOT/results/smoke-highwater-$DAY-fixtures"
rm -rf "$FIX"
mkdir -p "$FIX/problems"

cat > "$FIX/problems/smokehw_1.lean" <<'EOF'
import Mathlib

namespace SmokeHW1

theorem add_comm_nat (a b : ℕ) : a + b = b + a := by
  sorry

end SmokeHW1
EOF

cat > "$FIX/problems/smokehw_2.lean" <<'EOF'
import Mathlib

/- HARNESS SELF-TEST. This file is not a mathematics problem; it exercises the runner's
   solved high-water mark. Do exactly these steps, in this order, without stopping in
   between, and do not deviate:
     1. Replace `sorry` with `decide`, then run lean_check.
     2. Replace `decide` with `norm_num`, then run lean_check again.
     3. Replace `norm_num` with `sorry`, then run lean_check one final time.
   After step 3 the file is deliberately unproved. Do NOT fix it. Say you are done. -/

namespace SmokeHW2

theorem two_add_two : (2 : ℕ) + 2 = 4 := by
  sorry

end SmokeHW2
EOF

cat > "$FIX/problems/smokehw_3.lean" <<'EOF'
import Mathlib

/- HARNESS SELF-TEST. This file is not a mathematics problem; it exercises the runner's
   solved high-water mark. Do NOT attempt a proof. Leave the `sorry` exactly as it is,
   run lean_check once to confirm the file still reports a sorry, then say you are
   done. -/

namespace SmokeHW3

theorem three_add_three : (3 : ℕ) + 3 = 6 := by
  sorry

end SmokeHW3
EOF

cat > "$FIX/problems/smokehw_4.lean" <<'EOF'
import Mathlib

/- HARNESS SELF-TEST. The statement below is FALSE, so it cannot be proved. Make one
   honest attempt, run lean_check, and then say you are done. -/

namespace SmokeHW4

theorem two_add_two_is_five : (2 : ℕ) + 2 = 5 := by
  sorry

end SmokeHW4
EOF

printf 'smokehw_1\nsmokehw_2\nsmokehw_3\nsmokehw_4\n' > "$FIX/list.txt"

RUN="$ROOT/results/smoke-highwater-$DAY"
rm -rf "$RUN"
# STOP files stop the supervisor nudging these attempts back to green.
mkdir -p "$RUN/smokehw_2" "$RUN/smokehw_3" "$RUN/smokehw_4"
touch "$RUN/smokehw_2/STOP" "$RUN/smokehw_3/STOP" "$RUN/smokehw_4/STOP"

node runner/run.js --run-id "smoke-highwater-$DAY" \
  --problems "$FIX/list.txt" --problems-dir "$FIX/problems" \
  --budget-std 0.15 --timeout 900 --concurrency 4

echo
echo "high_water per attempt:"
for p in smokehw_1 smokehw_2 smokehw_3 smokehw_4; do
  node -e '
    const r = JSON.parse(require("fs").readFileSync(process.argv[1] + "/attempt.json", "utf8"));
    const h = r.high_water;
    console.log(`  ${process.argv[2].padEnd(10)} solved=${String(r.solved).padEnd(5)} ${(r.grade.reason ?? "-").padEnd(14)}` +
      (h ? ` greens=${h.greens} ever_solved=${h.ever_solved} first=#${h.first.check_index}/$${h.first.cost_std} (${h.first.solved})` +
           (h.last.md5 !== h.first.md5 ? ` last=#${h.last.check_index}/$${h.last.cost_std} (${h.last.solved})` : " last=first")
         : " high_water=null"));
  ' "$RUN/$p" "$p" 2>/dev/null || echo "  $p — no record"
done

echo
echo "reconstructed from the session files alone (must match first=# and \$ above):"
node scripts/highwater-scan.mjs "$RUN" --no-verify --out /dev/null --csv "$RUN/scan.csv" >/dev/null 2>&1
column -s, -t "$RUN/scan.csv" | awk 'NR==1 || NF' | cut -c1-120
