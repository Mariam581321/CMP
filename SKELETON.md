# Skeleton (80/20)

Goal: run `runner --combo lean-search --problems dev.txt` and get solve rate + cost.
First experiment (runnable ~today): baseline vs baseline+**semantic search**, dev subset.

DeepSeek: pi supports it natively — `deepseek/deepseek-v4-flash` is in its catalog and it
reads `DEEPSEEK_API_KEY` (in `.env`, gitignored). No OpenAI-compat shim needed.

## How one attempt works

1. Runner makes a scratch dir containing only the **sanitized** problem file
   (`problem.lean`) + short instructions. No path to the benchmark repo.
2. Spawns the pi CLI in that dir, headless:
   ```
   pi --mode json --session <transcript path> --no-extensions --no-skills -nc \
      --model deepseek/deepseek-v4-flash \
      --tools read,edit,write \
      -e extensions/lean-check.ts [-e extensions/lean-search.ts ...] \
      --append-system-prompt <prover instructions> \
      "Prove the theorem in problem.lean"
   ```
   Baseline = read/edit/write + `lean_check` only (no bash/grep). Combo = extra `-e` flags.
3. Streams all JSON events to `events.jsonl`; kills the process at a wall-clock cap.
4. **Grades independently** after the agent exits (don't trust the agent's own lean_check).
5. Appends one record to the run's `results.jsonl`.

## Verification (open source, not hand-rolled)

- Reuse **[FATE-Eval](https://github.com/frenzymath/FATE-Eval)**'s verifier: static
  precheck + batched **[Lean REPL](https://github.com/leanprover-community/repl)**
  verification (sorry/error detection via the REPL, parallelized). Port its verify module
  to point at our PutnamBench workspace; we don't use its generation side.
- Plus the one check FATE-Eval won't know about: **statement preserved** — ~/lean2's
  `verify.py` already implements this (line-level diff vs original, handles `:= sorry`
  abbrevs) along with no-sorry/no-axiom prechecks; port it rather than rewrite.
- Axiom soundness: check via REPL `#print axioms <thm>` (catches `native_decide` etc.),
  not by grepping.

## Lean without pain

One shared pre-built project. **~/lean2 already has exactly this**: a PutnamBench lean4
checkout with mathlib cache pulled and known-good `lake build` — reuse it as `lean-env/`
instead of building a new one. Agent-facing `lean_check` copies the file in and compiles
(`lake env lean <file>`); each invocation is an independent process, so it parallelizes.

## Concurrency

`--concurrency N` worker pool over problems (default 8): each attempt = own scratch dir +
own pi subprocess; verification is batched REPL, also parallel. LLM calls are I/O-bound and
DeepSeek is rate-limit-friendly; Lean compiles (~1–2 min each) are the real bottleneck —
budget cores accordingly. Ballpark: 673 problems × ~5 min / 8 workers ≈ 7 h per combo.

## Logging (stats computed after the fact, never during)

Per attempt, under `results/<run-id>/<problem>/`: `events.jsonl` (full pi event stream),
pi session file (replayable transcript), `problem.lean` final state, `verify.json`.
Run-level `results.jsonl`, one record per attempt:
```json
{"run_id": "...", "problem": "putnam_1962_a1", "combo": ["lean-search"],
 "model": "deepseek-v4-flash", "started_at": "...", "wall_s": 412, "turns": 14,
 "tokens": {"in": 84000, "out": 9100}, "cost_usd": 0.021,
 "tool_calls": {"lean_check": 6, "search_mathlib": 3},
 "solved": false, "fail_reason": "timeout|error|unsolved|statement_changed",
 "harness_git_sha": "..."}
```
Everything raw is kept, so any stat (tool-use patterns, time-to-first-check, error types)
is computable later without re-running.

## Extension #1: semantic search (only arm for now)

`extensions/lean-search.ts` registers `search_mathlib(query)` → calls the public
**[LeanSearch](https://leansearch.net)** API (natural-language → mathlib lemmas; community-
standard, zero indexing infra on our side). ~/lean2's `lean-search` skill already has the
exact API call working (`POST https://leansearch.net/search`). Fallbacks if the API is
flaky: [LeanExplore](https://arxiv.org/abs/2506.11085) (Python API, self-hostable) or
Loogle (symbolic — that's a separate future arm).

## Files

```
runner/run.ts               spawn pi per problem, worker pool, logging (~250 lines TS)
runner/sanitize.ts          PutnamBench src/*.lean -> problems/*.lean (strip `--` answer comments)
runner/verify/              ported from FATE-Eval (REPL check) + lean2 (statement check)
extensions/lean-check.ts    always-on agent-facing compile tool
extensions/lean-search.ts   arm #1: LeanSearch API
lean-env/                   shared Lean project, reused from ~/lean2 (gitignored)
problems/                   sanitized statements + dev.txt / all.txt
results/                    per-run dirs + results.jsonl (gitignored)
```

## Runner CLI (only knobs that exist)

```
--combo a,b          extension names = filenames in extensions/ ("" = baseline)
--problems <file>    problem list | --timeout <s> (600) | --concurrency <n> (8)
--model <id>         deepseek/deepseek-v4-flash | --run-id <s> (default combo+timestamp)
```

## Build order

1. `lean-env/` from ~/lean2 + verifier port — grade a hand-written proof correctly.
2. `sanitize.ts` + `run.ts` baseline on 1 problem end-to-end.
3. `lean-search.ts` → baseline vs +search on the dev subset. First real datapoint.

## Punted (deliberately)

Turn caps (timeout only), retries/resume, dashboards, lean4checker kernel re-verification
(add before publishing numbers), FATE, all other extension arms.
