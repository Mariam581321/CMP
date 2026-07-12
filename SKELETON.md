# Skeleton (80/20)

Goal: run `runner --combo a,b --problems dev.txt` and get solve rate + cost. Nothing else.

DeepSeek: pi supports it natively — `deepseek/deepseek-v4-flash` is in its catalog and it
reads `DEEPSEEK_API_KEY` (now in `.env`, gitignored). No OpenAI-compat shim needed.

## How one attempt works

1. Runner makes a scratch dir containing only the **sanitized** problem file
   (`problem.lean`) + short instructions. No path to the benchmark repo.
2. Spawns the pi CLI in that dir, headless:
   ```
   pi --mode json --no-session --no-extensions --no-skills -nc \
      --model deepseek/deepseek-v4-flash \
      --tools read,edit,write \
      -e extensions/lean-check.ts [-e extensions/<name>.ts ...] \
      --append-system-prompt <prover instructions> \
      "Prove the theorem in problem.lean"
   ```
   Baseline = read/edit/write + `lean_check` only (no bash, no grep). Each combo adds `-e` flags.
3. Parses the JSON event stream for tokens/cost/turns; kills the process at a wall-clock cap.
4. Grades: `lean_check` passes AND file has no `sorry`/`admit`/`axiom` AND the theorem
   statement (text up to `:=`) is unchanged from the sanitized original.
5. Writes one JSON line to `results/<run>.jsonl`.

## Lean without pain

One shared pre-built Lean project (`lean-env/`, toolchain + mathlib copied from
`benchmarks/PutnamBench/lean4`, `lake exe cache get` once). The `lean_check` tool copies the
agent's file into it and runs `lake env lean <file>` — no per-attempt builds, agent never
touches the shared project directly.

## Files

```
runner/run.ts               the runner (~200 lines, TS, spawns pi subprocesses)
runner/sanitize.ts          PutnamBench src/*.lean -> problems/*.lean (strip `--` comments = answers)
extensions/lean-check.ts    always-on: lean_check tool
extensions/<name>.ts        one file per experimental extension
lean-env/                   shared pinned Lean project (gitignored)
problems/                   sanitized statements + dev.txt / all.txt problem lists
results/                    *.jsonl (gitignored)
```

## API shape

**Runner CLI** (only knobs that exist):
```
--combo a,b,c        extension names = filenames in extensions/ ("" = baseline)
--problems <file>    list of problem names, one per line
--timeout <s>        wall-clock cap per attempt (default 600)
--concurrency <n>    parallel attempts (default 4)
--out <path>         results jsonl (default results/<combo>-<timestamp>.jsonl)
--model <id>         default deepseek/deepseek-v4-flash
```

**Extension contract** (pi's own API, nothing custom):
```ts
export default function (pi: ExtensionAPI) { /* registerTool, on("tool_call"), ... */ }
```
An "arm" of the experiment = one such file. Combos are just sets of `-e` flags.

**lean_check tool** (what the model sees):
```
lean_check(file: string) -> compiler output, or "success"
```

**Result record** (one line per attempt):
```json
{"problem": "putnam_1962_a1", "combo": ["semantic-search"], "solved": false,
 "reason": "timeout|error|unsolved|statement_changed", "turns": 14, "cost_usd": 0.021,
 "tokens": {"in": 84000, "out": 9100}, "wall_s": 412, "transcript": "results/t/..."}
```

## Build order

1. `sanitize.ts` + `lean-env/` setup + `lean_check` as a standalone script — prove we can
   grade a hand-written proof.
2. `run.ts` baseline on 1 problem end-to-end.
3. First real extension + dev subset run.

## Punted (deliberately)

Turn-based caps (timeout only for now), retries, resume, dashboards, stats, semantic-search
indexing (extension design comes later), FATE.
