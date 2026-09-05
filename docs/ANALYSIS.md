# Analysis

## Scoring

The paper scores every attempt under the *no-nudge* convention. An attempt is solved if
a verified `lean_check` of the unchanged statement (a green) happened before the agent's
first give-up, where a give-up is a supervisor nudge that followed a turn the agent
ended by itself with the statement intact. Nudges after an output-token cutoff, a
transport error or a modified statement do not end the attempt. The cost of a solve is
the cumulative spend, workers included, at that first green; spend after the give-up is
not counted. `behaviour.csv` also carries the as-recorded outcome with nudges allowed,
for the reconciliation in the paper's appendix.

Two runs are compared through their discordance: the problems solved by exactly one of
them. Between replicate runs of the same design it measures the noise floor; between
designs it gives an exact paired (McNemar) test. Solve counts and spend are reported as
functions of the budget cap `c`: a solve at cap `c` is a solve with cost at most `c`,
and spend at cap `c` is `min(spend, c)`.

## Pipeline

1. `scripts/mine-sessions-0817.py` reads every session file under `results/` for the
   grid runs and writes `mined/attempts.jsonl`: the cost timeline, every check result,
   the first green, the nudges classified, worker usage and compactions. Everything is
   recomputed from the raw events; recorded verdicts are only cross-checked.
2. `scripts/verify-glue.py` re-derives from `results/` which run directory supplies each
   (design, replicate, problem) row, since some attempts were rerun after harness
   defects or provider outages and one replicate ran split across two machines, and
   checks it against the mined file.
3. `scripts/build-paper-data.py` reshapes `mined/attempts.jsonl` into the tables in
   `data/`: `attempts.csv`, `behaviour.csv`, `cells.csv`, `problems.csv`, plus an
   unreleased `provenance.csv`. Columns are documented in `data/README.md`.
4. The figure scripts, kept with the papers outside this repository, build every figure
   and table from those four tables alone.

`results/` and `mined/` contain verbatim agent transcripts and are not released;
`data/` is.

## Other scripts

- `mine-checkerrors-0828.py`, `mine-queries-0828.py`, `query-anatomy-0828.py`: mine
  compiler errors and search queries for the behavioural sections.
- `analyze-mined-0817.py`, `paper-stats.py`, `mcnemar-report.py`: statistics batteries
  over the same data.
- `highwater-scan.mjs`, `falsegreen-scan.mjs`, `render-replay.mjs`: audits of the grading
  and of what the agent was shown.
- `type-eq.mjs`, `scope-scan.mjs`, `wipe-audit.mjs`, `setup-tamper.mjs`: tools used for
  the benchmark audit.
- `probe-*.mjs`, `smoke-highwater.sh`: harness tests (`npm test`).
