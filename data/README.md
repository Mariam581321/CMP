# data/ — the per-attempt tables behind every figure in the papers

Produced by `scripts/build-paper-data.py` from the session-mined `mined/attempts.jsonl`
(the glue of reruns and resumes into 90-problem cells is verified independently by
`scripts/verify-glue.py`). Transcripts, session files and proofs are not released.

## Conventions

* **No-nudge harness.** An attempt is *solved* iff a verified sorry-free `lean_check`
  (a green) occurred before the agent's first *give-up*: the first supervisor nudge that
  followed a turn the agent ended itself (`stopReason == "stop"`) with the statement
  intact. Nudges after an output-token cutoff or a transport error, and nudges that only
  ask for a modified statement to be restored, are the harness doing its job: the
  attempt continues through them. `cost` is the cumulative `cost_std` at that green,
  workers included. Greens and spend after the give-up do not count.
* **Costs** are `cost_std`, DeepSeek list price in USD, per problem. The cap was $1.00.
* **N = 90**, the `problems-fatex/safe90.txt` list.
* **Arms** are design names; `rep` distinguishes byte-identical replicate runs.
  Four arms are replicated (base, grep, snippetonly, snippet); the rest are single runs.

## attempts.csv  — one row per (arm, rep, problem); the analysis table

| column | meaning |
|---|---|
| arm | base, grep, semantic, snippetonly, snippet, spawn, spawnfacts, snippetfacts |
| rep | 1 or 2 |
| problem | fatex_N |
| solved | 1 iff a green exists before the first give-up |
| cost | first-solve cost (USD) if solved, empty otherwise. A solve at cap c is `solved==1 and cost<=c` |
| spend | spend under the no-nudge harness: cost at the first give-up if there was one, else the whole attempt (main + workers). Spend at cap c is `min(spend, c)` |

Budget curve: `S(c) = #{cost <= c}`. Total-spend plane at cap c: `sum(min(spend, c))`.
If you want "harness stops at the first solve" spend instead, use `min(cost, spend)` for
solved rows — post-solve spend is ~8% of the total.

## behaviour.csv  — same keys; what the agent did, under the no-nudge harness

Every count is censored at the first give-up, like `cost` and `spend`: it is what the
attempt did *before* the agent first gave up, and the whole attempt when it never did.
Columns with a `_full` suffix are the full-harness (nudges allowed) view instead.

| column | meaning |
|---|---|
| proof_lines, proof_decls | non-blank lines and `theorem`/`lemma` declarations in the first green file (solved rows only) |
| checks_pre_nudge | `lean_check` calls before the first give-up |
| end | how the attempt ended, full harness: completed / budget_exceeded |
| nudges | supervisor nudges received over the whole attempt, of every kind (a full-harness quantity by nature) |
| gave_up | 1 iff the attempt is unsolved and ended, under the no-nudge harness, by the agent giving up (see Conventions); unsolved rows with `gave_up == 0` ran to the cap |
| ever_green_full, cost_full_first_green | full-harness outcome and first-green cost — the "as-recorded" estimand for the appendix reconciliation |
| spend_full | whole-attempt spend, main + workers |
| turns | main-agent turns before the first give-up; `turns_full` the whole attempt |
| tokens_in_full, tokens_out_full, tokens_cache_read_full | whole attempt, workers included (tokens are not tracked at the give-up; use `spend` for the censored quantity) |
| lean_check, check_snippet, grep_mathlib, search_mathlib, read, write, edit, spawn_calls, add_fact | tool-call counts, main agent only, before the first give-up |
| add_fact_workers | `add_fact` calls made by the attempt's workers before the first give-up (spawn arms) |
| workers, worker_spend | subagents started before the first give-up, and their spend up to it |
| compactions | context compactions of the main session before the first give-up; `compactions_full` the whole attempt |

## cells.csv — one row per run: tools, block, replicated flag, n, solves, total no-nudge spend
## problems.csv — the 90 ids with their theorem name and how many of the 12 runs solve each

Tool vocabulary: `search` = semantic Mathlib search (external API); `grep` = text search
over the local Mathlib (+ `read`); `check_snippet` = compile a scratch snippet;
`spawn` = spawn subagents; `add_fact` = append a compiled lemma to the facts bank.
`lean_check` (compile the solution file) is available in every arm.
