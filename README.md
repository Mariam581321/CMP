# CMP

A harness for running a Lean 4 theorem-proving agent with different toolsets and
comparing them. We used it to test which tools help the [pi](https://github.com/earendil-works/pi)
coding agent, driven by DeepSeek V4 Flash, prove graduate-level algebra problems from
[FATE-X](https://github.com/frenzymath/FATE).

- `paper/`: the full paper (TMLR format).
- `paper-workshop/`: the 4-page MATH-AI @ NeurIPS 2026 version.
- `paper/data/`: the per-attempt result tables both papers are built from. Transcripts
  and proofs are not released, to keep FATE-X uncontaminated.
- `docs/HARNESS.md`: how an attempt runs, the Lean server, grading, budget.
- `docs/ANALYSIS.md`: how attempts are scored and how `paper/data/` is produced.

## Tools

The agent always has pi's `read`, `edit` and `write` plus `lean_check`, which compiles
the solution file. Everything else is an optional pi extension in `extensions/`. Each
extension adds one tool the agent can call; the extension name is what you pass to
`--combo`, the tool name is what the agent sees.

| extension (`--combo` name) | tool added | what it does |
|---|---|---|
| `lean-search` | `search_mathlib` | semantic search over Mathlib via the LeanSearch API |
| `lean-grep` | `grep_mathlib` | text search over the local Mathlib source, plus `read` on it |
| `lean-snippet` | `check_snippet` | compile a scratch snippet without touching the solution file |
| `lean-spawn` | `spawn_subagents` | run worker agents in parallel on subtasks |
| `lean-facts` | `add_fact` | add a verified lemma to a bank shared with the workers |

A design is a comma-separated list of extensions. The paper's eight designs are the
empty list, each of `lean-grep`, `lean-search` and `lean-snippet` alone,
`lean-grep,lean-snippet`, and that pair with `lean-spawn`, `lean-facts` or both.

## Layout

| path | what |
|---|---|
| `runner/` | `run.js` runs a design over a problem list; `lean-server.js` is the persistent Lean REPL pool; `grade.js` grades a finished attempt; `sanitize.js` strips comments and docstrings from benchmark files |
| `extensions/` | the tool extensions above and the always-on ones (`lean-check`, `file-sandbox`, `cmp-edit`, `supervisor`, `max-tokens`, `compaction-guard`) |
| `lean-env/` | Lake project pinning Lean and Mathlib `v4.27.0` |
| `vendor/repl.patch` | our patch to `leanprover-community/repl`; the server requires it |
| `scripts/` | analysis pipeline, probe tests (`npm test`), audit tools |
| `problems-fatex/` | problem lists (`safe90.txt` is the paper's set); problem files are generated, not committed |
| `pi-agent/` | pi agent directory used by runs (retry settings) |
| `archive/` | code of arms that were cut before the experiment |

## Running

Prerequisites: Node 22, pi 0.80.6 (`npm i -g @earendil-works/pi-coding-agent@0.80.6`),
[elan](https://github.com/leanprover/elan), and `DEEPSEEK_API_KEY=...` in `.env`.

1. `cd lean-env && lake exe cache get && lake build`
2. Clone `leanprover-community/repl` at commit `0e9e6e2` (the `v4.27.0` toolchain) into
   `vendor/repl`, `git apply ../repl.patch`, `lake build`.
3. Clone FATE with submodules into `benchmarks/FATE`, then
   `node runner/sanitize.js --src-dir benchmarks/FATE/FATE-X/FATEX --out-dir problems-fatex --prefix fatex_`
4. `node runner/lean-server.js` (`CMP_REPL_WORKERS` sets the pool size; each worker holds
   Mathlib in memory). `scripts/lean-server-watchdog.sh` keeps one alive.
5. Run a design:

   ```bash
   node runner/run.js --combo lean-grep,lean-snippet --problems problems-fatex/safe90.txt \
     --problems-dir problems-fatex --run-id snippet-r3
   ```

   `node runner/status.js snippet-r3` shows progress. Results go to `results/snippet-r3/`:
   one directory per problem with the pi session file and the final `problem.lean`, plus
   `results.jsonl` and `summary.json` for the run. Defaults are the paper's: $1 per
   problem, thinking `high`, 25 attempts in parallel.
