#!/usr/bin/env bash
# Live dashboard for a run: ./scripts/watch.sh [results/<run-id>]
# With no argument, watches the most recently modified run under results/.
cd "$(dirname "$0")/.." || exit 1
while true; do
  out=$(python3 - "$@" <<'EOF'
import json, os, sys, glob, time

G, R, Y, D, B, N = "\033[32m", "\033[31m", "\033[33m", "\033[2m", "\033[1m", "\033[0m"
run = sys.argv[1].rstrip("/") if len(sys.argv) > 1 else None
if not run:
    dirs = glob.glob("results/*/")
    run = max(dirs, key=os.path.getmtime).rstrip("/") if dirs else None
if not run or not os.path.isdir(run):
    print("no runs found under results/"); sys.exit(0)

meta = {}
if os.path.exists(f"{run}/run.json"):
    meta = json.load(open(f"{run}/run.json"))
total = len(meta.get("problems", [])) or "?"

done = []
if os.path.exists(f"{run}/results.jsonl"):
    done = [json.loads(l) for l in open(f"{run}/results.jsonl") if l.strip()]
solved = [r for r in done if r.get("solved")]
cost = sum(r.get("cost_usd") or 0 for r in done)

print(f"{B}{os.path.basename(run)}{N}  {D}combo={'+'.join(meta.get('combo', [])) or 'baseline'}  model={meta.get('model','?')}{N}")
print(f"finished {B}{len(done)}{N}/{total}   solved {G}{len(solved)}{N}   spent ${cost:.3f}\n")

for r in done[-12:]:
    if r.get("solved"): tag = f"{G}✓ solved{N}          "
    elif r.get("fail_reason") == "timeout": tag = f"{Y}⏱ timeout{N}         "
    else: tag = f"{R}✗ {r.get('fail_reason','?')}{N}" + " " * max(0, 15 - len(str(r.get('fail_reason','?'))))
    print(f"  {r['problem']:<20}{tag}{D}{r.get('turns','?')} turns  ${r.get('cost_usd') or 0:.3f}  {r.get('wall_s','?')}s{N}")

active = []
for d in sorted(glob.glob(f"{run}/*/")):
    name = os.path.basename(d.rstrip("/"))
    if os.path.exists(f"{d}attempt.json") or not os.path.exists(f"{d}events.jsonl"): continue
    age = int(time.time() - os.path.getmtime(f"{d}events.jsonl"))
    last = ""
    try:
        with open(f"{d}events.jsonl", "rb") as f:
            f.seek(max(0, os.path.getsize(f"{d}events.jsonl") - 65536))
            for line in f.read().decode(errors="ignore").splitlines():
                try: e = json.loads(line)
                except Exception: continue
                if e.get("type") == "tool_execution_start": last = f"-> {e.get('toolName')}"
                elif e.get("type") == "turn_end": last = "turn done"
    except Exception: pass
    active.append((name, age, last or "starting"))
if active:
    print(f"\n{B}in flight:{N}")
    for name, age, last in active:
        print(f"  {name:<20}{last:<22}{D}last event {age}s ago{N}")

locks = glob.glob("lean-env/_locks/slot*")
mem = os.popen("free -m | awk 'NR==2{printf \"%d/%dMB\", $3, $2}'").read()
print(f"\n{D}lean slot: {'BUSY' if locks else 'idle'}   mem {mem}{N}")
EOF
  )
  clear
  printf '%s\n\n\033[2m(refreshes every 5s, ctrl-c to quit)\033[0m\n' "$out"
  sleep 5
done
