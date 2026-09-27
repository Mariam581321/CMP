# Harness effects in agentic theorem proving

A harness for testing which tools help a fixed Lean agent prove theorems, and how
much its results vary from run to run.

Components common to theorem-proving harnesses (retrieval, scratch compilation,
subagents and memory) are represented as tools available to a fixed baseline agent:
the [pi](https://github.com/earendil-works/pi) coding agent with DeepSeek V4 Flash and
a `lean_check` tool that compiles the solution. A *design* is a set of these tools.
Designs are evaluated on 90 formalised abstract-algebra problems from
[FATE-X](https://github.com/frenzymath/FATE), excluding ten whose formal statements
did not pass our audit, with a $1 cap per problem. Runs are compared problem by
problem, not only by solve rate: the problems solved in only one of two runs (their
*discordance*) measure run-to-run variability and support exact paired tests between
designs.

- `data/`: the per-attempt result tables the papers are built from, numbers only.
  Transcripts and accepted proofs are withheld to avoid contaminating FATE-X.
- `docs/HARNESS.md`: how an attempt runs, the Lean server, grading, budget.
- `docs/ANALYSIS.md`: how attempts are scored and how `data/` is produced.

The papers themselves are not in this repository.

## Tools

The agent always has pi's `read`, `edit` and `write` plus `lean_check`, which compiles
the solution file. Everything else is an optional pi extension in `extensions/`. Each
extension adds one tool the agent can call; the extension name is what you pass to
`--combo`, the tool name is what the agent sees.

| extension (`--combo` name) | tool added | what it does |
|---|---|---|
| `lean-search` | `search_mathlib` | semantic search through LeanSearch |
| `lean-grep` | `grep_mathlib` | searches the Mathlib source for matching declarations; the agent may then open the files |
| `lean-snippet` | `check_snippet` | compiles a proof fragment against Mathlib, separately from the solution file |
| `lean-spawn` | `spawn_subagents` | delegates to worker agents |
| `lean-facts` | `add_fact` | stores proved lemmas in a fact bank shared with the workers |

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
| `archive/` | code of arms that were cut before the experiment, kept for reference; moved out of `runner/` and `extensions/`, so its relative imports no longer resolve and it does not run as is |

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

## License

MIT, see `LICENSE`. `vendor/repl.patch` is a diff against
[`leanprover-community/repl`](https://github.com/leanprover-community/repl), which is
Apache-2.0; the patched REPL you build in step 2 keeps that license.
