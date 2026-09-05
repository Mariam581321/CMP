# CMP: which harness tools help a Lean theorem-proving agent?

We took one coding agent ([pi](https://github.com/earendil-works/pi)) and one model
(DeepSeek V4 Flash), added tools to it one at a time, and measured how many of 90
graduate-level abstract-algebra problems from [FATE-X](https://github.com/frenzymath/FATE)
each version proves, and at what cost. Two write-ups:

- `paper/`: the full paper (TMLR format).
- `paper-workshop/`: a 4-page version for the MATH-AI workshop at NeurIPS 2026.

## What we ran

The baseline agent has pi's `read`, `edit` and `write` tools and one tool of ours,
`lean_check`, which compiles the solution file and returns the compiler errors and the
remaining goals at each `sorry`. Five optional tools are added on top, each implemented
as a pi extension:

| tool | extension | what it does |
|---|---|---|
| `search_mathlib` | `lean-search` | semantic search over Mathlib through the LeanSearch API; six results |
| `grep_mathlib` | `lean-grep` | text search over the local Mathlib source; up to 25 declarations with file and line, plus `read` on the source files |
| `check_snippet` | `lean-snippet` | compile a scratch snippet against Mathlib without touching the solution file |
| `spawn_subagents` | `lean-spawn` | run worker agents in parallel on subtasks; a worker gets the statement, its task, `check_snippet` and the search tools, and returns a report |
| `add_fact` | `lean-facts` | append a compiled, sorry-free, axiom-free lemma to a bank shared with the workers |

Eight designs, arranged as two 2x2 grids:

| design | `--combo` |
|---|---|
| base | (none) |
| grep | `lean-grep` |
| search | `lean-search` |
| check_snippet | `lean-snippet` |
| grep + check_snippet | `lean-grep,lean-snippet` |
| grep + check_snippet + spawn | `lean-grep,lean-snippet,lean-spawn` |
| grep + check_snippet + add_fact | `lean-grep,lean-snippet,lean-facts` |
| grep + check_snippet + spawn + add_fact | `lean-grep,lean-snippet,lean-spawn,lean-facts` |

The first grid toggles library search against scratch compilation. The second toggles
subagents against the fact bank, on top of the best design of the first grid. Base,
grep, check_snippet and grep + check_snippet were run twice to measure the noise floor.

The protocol is the same for every design:

- One fresh pi session per problem, DeepSeek V4 Flash with thinking set to high.
- $1 per problem, computed from token counts at DeepSeek's list prices. Worker spend
  counts against the same budget. The agent is not told the budget.
- The agent may stop on its own. The harness replies with the compiler output and asks
  it to continue, up to three times, but the paper scores every attempt as if its first
  give-up had ended it.
- A problem counts as solved if the final file compiles, the statement is unchanged
  (compared as Lean expressions, not text), there is no `sorry`, and no axiom beyond
  `propext`, `Classical.choice` and `Quot.sound` is used.

Benchmark: FATE-X, 100 problems. Ten were excluded after an audit of the formalisations
(four false as stated, four easier than intended, two unconfirmed); the remaining 90 are
`problems-fatex/safe90.txt`. The list with reasons is in the paper's appendix.

## Results

Solves out of 90 and total spend per run, at the $1 cap:

| design | run 1 | run 2 |
|---|---|---|
| base | 43 ($35) | 40 ($39) |
| grep | 50 ($33) | 49 ($35) |
| search | 50 ($31) | |
| check_snippet | 47 ($35) | 47 ($34) |
| grep + check_snippet | 53 ($31) | 52 ($31) |
| + spawn | 52 ($34) | |
| + add_fact | 52 ($35) | |
| + spawn + add_fact | 54 ($43) | |

Replicate runs land within three solves of each other but disagree on 6 to 11
problems, which is the noise floor a design difference has to clear. Library search
clears it: grep gains about 7.5 problems over base and reaches at $0.50 what base
reaches at $1, and semantic search matches it. Scratch compilation helps in some
settings. Subagents and the fact bank leave the solve count unchanged and mostly add
spend on unsolved problems. The papers have the analysis.

## Data

`paper/data/` holds the per-attempt tables every figure is built from: `attempts.csv`
(solved, cost, spend), `behaviour.csv` (tool calls, tokens, turns, workers,
compactions), `cells.csv` and `problems.csv`. Columns are documented in
`paper/data/README.md`. Transcripts and the accepted proofs are not released, to avoid
contaminating FATE-X.

## Layout

| path | what |
|---|---|
| `runner/` | the harness: `run.js` runs a design over a problem list, `lean-server.js` is the persistent Lean REPL pool, `grade.js` the independent grader, `sanitize.js` strips comments and docstrings from benchmark files |
| `extensions/` | the pi extensions: one per tool above, plus the always-on ones (`lean-check`, `file-sandbox`, `cmp-edit`, `supervisor`, `max-tokens`, `compaction-guard`) |
| `lean-env/` | Lake project pinning Lean and Mathlib `v4.27.0` |
| `vendor/repl.patch` | our patch to `leanprover-community/repl` (bounded snapshot retention); the server requires it |
| `scripts/` | analysis pipeline (session mining to `paper/data/`), probe tests, audit tools |
| `problems-fatex/` | the problem lists; the sanitised problem files are generated, not committed |
| `pi-agent/` | the pi agent directory the runs use (retry settings) |
| `archive/` | code of arms that were cut before the grid |
| `docs/HARNESS.md` | how an attempt runs, the Lean server, grading, budget, results layout |
| `docs/ANALYSIS.md` | scoring convention and the data pipeline |

## Running a cell

Prerequisites: Node 22, pi 0.80.6 (`npm i -g @earendil-works/pi-coding-agent@0.80.6`),
[elan](https://github.com/leanprover/elan), and a DeepSeek API key in `.env` as
`DEEPSEEK_API_KEY=...`.

1. Build the Lean environment: `cd lean-env && lake exe cache get && lake build`.
2. Build the REPL: clone `leanprover-community/repl` at its `v4.27.0` toolchain bump
   (commit `0e9e6e2`) into `vendor/repl`, run `git apply ../repl.patch`, then `lake build`.
3. Get the problems: clone FATE with submodules into `benchmarks/FATE`, then
   `node runner/sanitize.js --src-dir benchmarks/FATE/FATE-X/FATEX --out-dir problems-fatex --prefix fatex_`.
4. Start the Lean server: `node runner/lean-server.js`. `CMP_REPL_WORKERS` sets the
   number of REPL workers; each holds Mathlib in memory. `scripts/lean-server-watchdog.sh`
   keeps one alive.
5. Run a design:

   ```bash
   node runner/run.js --combo lean-grep,lean-snippet --problems problems-fatex/safe90.txt \
     --problems-dir problems-fatex --run-id snippet-r3
   ```

6. Watch with `node runner/status.js snippet-r3`. Results land in `results/snippet-r3/`:
   one directory per problem with the pi session file and the final `problem.lean`, plus
   `results.jsonl` and `summary.json` for the run.

`npm test` runs the probe suite for the harness pieces (renderer, sandbox, edit tool,
grep, supervisor, compaction guard). Some probes need the Lean server up.
