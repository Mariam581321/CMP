# DRAFT — "the 100 fates" collected, 2026-07-28

One place for everything on the full-FATE-H (100 problems) data. **Collection, not
analysis** — two reruns are still in flight; the analysis pass comes after they land.

## What "the 100 fates" is

Full `problems-fateh/` corpus (100 problems), lean-search combo, DeepSeek V4 Flash,
$1.00 @std budget cap per problem. The thinking-high coverage of all 100 is a
**composite of two runs** launched a few hours apart on 0727:

- `lean-search-think-fateh20-0727` — the night20 problem set re-run with thinking high
  (19 of 20 finished; see below).
- `lean-search-think-fateh81-0727` — the other 80 problems + fateh_32 again.

Union = exactly 100 distinct problems, overlap = {fateh_32} (counted from the 81-run,
where it ran to completion).

## Run map

| run | date | config | n | solved | cost (std=usd) | status |
|---|---|---|---|---|---|---|
| `baseline-fateh10-202607252058` | 0725 | baseline, no think, 2 h wall cap, sha 079de6d | 10 | 3 | $2.08 | done; pre-$1-cap pilot, disjoint 10 |
| `lean-search-fateh20-0726` | 0726 | lean-search, no think, $1 @std, sha 10ebfc7 | 20 | 12 | $9.73 | done ("night20"); includes $2.09 outage retry storm |
| `lean-search-think-fateh20-0727` | 0727 | lean-search, think high, $1 @std, conc 20, sha e1af6f7 | 20 | 13/19 | $5.48 | **killed early**: fateh_32 unfinished (last event 13:40Z), run stopped for the 81 launch (14:25Z) → no summary.json |
| `lean-search-think-fateh81-0727` | 0727→0728 | same, conc 30, sha e1af6f7 | 81 | 52 | $37.02 | done 08:06Z 0728 |
| `lean-search-think-fateh21-rerun-0728` | 0728 | same, conc 1, `--peak-ok` | 1 | **1** | $1.00 | done 10:28Z: **solved at the budget kill** (837 turns; first attempt was the sleep-corrupted 14 h timeout) |
| `lean-search-think-fateh63-rerun-0728` | 0728 | same | 1 | 0 | $1.00 | done 10:46Z: budget_exceeded, compile_error — an honest fail (first attempt's `grader_error` was the unicode decl-name grader bug, fixed e5d8e8f) |

All 0726/0727 runs launched off-peak (cost_std = cost_usd). The 0728 reruns launched
in the peak window (`--peak-ok`, peak_pricing_at_launch: true) — compare them by
tokens / cost_std, not cost_usd.

## Composite headline (thinking high, all 100)

**FINAL: 66/100** (= 66/99 scored, fateh_78 excluded) — 13 (think-20) + 52 (81-run)
+ fateh_21's rerun solve; fateh_63 failed its rerun too. Canonical run cost $42.50
@std ($5.48 + $37.02); $44.50 @std including the two $1.00 reruns.

Known asterisks on the denominator:
- **fateh_78 is false as formalized** (machine-checked, see
  `DRAFT-fateh78-broken-statement-0727.md`) — unsolved in every run, should be
  excluded/annotated → effective denominator 99.
- **fateh_41**: `grader_error` detail = "REPL timed out after 120s" — under the
  one-budget metric that *is* a fail (a solve must compile inside 120 s), so the
  verdict stands; only the label is untidy.
- **Unicode-grader audit (0728):** fateh_63 (`eval₂_…`) is the *only* FATE-H problem
  whose decl name the pre-e5d8e8f regex truncated (all 100 checked) — so the grader
  fix invalidates nothing else in ref #1, and no regrade is needed.
- **fateh_28**: graded `statement_changed` — same scratch-clobber failure mode as
  fateh_78 run 2; worth a regrade look, may be an honest unsolved.
- **fateh_32** has no completed thinking-run replicate of its own night20 slot; its
  composite result comes from the 81-run ($1.00 budget_exceeded, uses_sorry, unsolved
  in both configs).
- **fateh_4** graded solved at the budget kill (end `budget_exceeded`, grade solved) —
  fine under the end/grade split, just unusual.

### 81-run numbers (previously undocumented — no 0727 experiment draft exists)

- 52/81 solved. Fail reasons: 12 budget_exceeded, 6 compile_error, 6 uses_sorry,
  3 timeout (fateh_100, 41, 21), 1 grader_error (63), 1 statement_changed (28).
- Cost split: solves $13.18 (36%), failures $23.84 (64%). 25 solves cost < $0.10;
  11 solves cost ≥ $0.50.
- Volume: 37,830 turns, 10,415 lean_checks, 5,671 search_mathlib, 1,957 nudges.
  Tokens 19.4 M in / 27.8 M out / 9.47 B cache-read.
- Crossover worth noting for the analysis pass: of the 0725 baseline pilot's 7
  wall-clock timeouts, this arm solved 6 (fateh_15, 22, 56, 57, 70, 72); only
  fateh_36 stayed unsolved (uses_sorry).

### think-20 run per-problem (19 finished, previously undocumented)

| problem | result | cost | | problem | result | cost |
|---|---|---|---|---|---|---|
| fateh_53 | ✓ | $0.001 | | fateh_33 | ✓ | $0.352 |
| fateh_74 | ✓ | $0.004 | | fateh_78 | ✗ completed | $0.180 |
| fateh_96 | ✓ | $0.012 | | fateh_94 | ✗ compile_error | $0.565 |
| fateh_17 | ✓ | $0.019 | | fateh_81 | ✗ uses_sorry | $0.595 |
| fateh_77 | ✓ | $0.077 | | fateh_55 | ✗ compile_error | $0.638 |
| fateh_26 | ✓ | $0.092 | | fateh_98 | ✗ budget | $1.001 |
| fateh_19 | ✓ | $0.099 | | fateh_8 | ✗ budget | $1.000 |
| fateh_46 | ✓ | $0.103 | | fateh_32 | — killed mid-run | — |
| fateh_89 | ✓ | $0.125 | | | | |
| fateh_20 | ✓ | $0.142 | | | | |
| fateh_88 | ✓ | $0.167 | | | | |
| fateh_2 | ✓ | $0.352 | | | | |

Head-to-head vs the no-thinking 0726 run on the same set (19 shared completions):
3 flips — fateh_33 and fateh_46 flipped to solved, fateh_8 flipped to failed
(budget). 12/20 → 13/19. **Confounded** (thinking + sha 10ebfc7→e1af6f7 + supervisor
changes + the 0726 outage storm), so this is *not* a variance estimate — see below.

## Cost per full 100-problem run (approximate)

| config | per-problem | full run of 100 |
|---|---|---|
| think high, lean-search, $1 @std (actual composite) | $0.425 | **~$42.5** |
| no think, lean-search (0726 run, incl. outage storm) | $0.487 | ~$49 |
| no think, outage-corrected ($9.73 − $2.09) | $0.382 | ~$38 |

So: **~$40–45 @std per full pass** with thinking high, call it ~$45 with rerun slop.
Peak window (01–04 & 06–10 UTC = 03–06 & 08–12 CEST) doubles the USD; cost_std is
the comparable number.

### Actual billed USD for thinking-on (computed 0728 ~09:30 UTC, from per-message
### timestamps in events.jsonl vs the peak windows; runner's cost_usd does NOT apply
### the 2× multiplier, so results.jsonl understates billing for anything in-window)

| piece | std | billed | note |
|---|---|---|---|
| think-20 run (19 results) | $5.48 | $5.48 | entirely off-peak (10:45–14:25 UTC) |
| fateh_32 killed partial | $0.70 | $0.70 | off-peak; not in any results.jsonl |
| 81-run | $37.02 | **$44.20** | ran overnight through both peak windows; $7.18 of std-priced tokens billed 2× |
| rerun fateh_21 (final) | $1.00 | $1.86 | 07:13–10:28 UTC, mostly inside the 06–10 peak |
| rerun fateh_63 (final) | $1.00 | $1.78 | 08:10–10:46 UTC, mostly inside the 06–10 peak |
| **total thinking-on (final)** | **$45.20** | **$54.02** | peak surcharge $8.82 + $0.70 killed attempt |

No lean-server outage occurred during any thinking-on run (launch logs: zero
unavailable/ECONNREFUSED; watchdog log: two routine REPL restarts) — the $2.09
outage retry storm belongs to the 0726 no-thinking run. Whole-campaign actual
billed, final (pilot $2.08 + night20 $9.73 + thinking-on $54.02) ≈ **$65.8**
(≈ $57.0 @std).
Structure behind the average: solves are cheap-heavy-tailed (¼–⅓ of spend), failures
pin the cap (⅔ of spend goes to $1.00 burns) — the per-run cost is mostly
(#unsolved × $1) + small change.

## Where the existing thinking lives (pointers, content not duplicated)

- `DRAFT-experiment-notes-0725-fate.md` — FATE-M saturated (10/10); FATE-H cliff
  (3/10); timeout autopsy; spend-correlates-with-hope → $1 @std cap rationale;
  REPL-starvation and sandbox-escape findings.
- `DRAFT-experiment-notes-0726-night20.md` — 12/20 headline; budget-cap
  counterfactuals ($0.25 ⇒ 9, $0.60 ⇒ 10, $0.85 ⇒ 12 solves); the 17:13 lean-server
  outage / $2.09 retry storm; REPL churn; give-up policy firing; best-state
  checkpoint case; laptop-sleep backstop drift.
- `DRAFT-fateh78-broken-statement-0727.md` — fateh_78 false as formalized
  (machine-checked refutation + corrected proof in `lean-env/_check/`); audit
  verdict that it's the *only* broken statement among the doubly-unsolved; Mathlib
  gap list (going-up chains, grade theory, graded quotients, Kummer glue); harness
  pathology catalog. Upstream issue **not filed — ask first**.
- `DRAFT-PR-fateh78-frenzymath-0728.md` — the draft upstream report itself.
- 81-run and think-20 numbers: this file (above) + `results/*/results.jsonl`.

## Open items for the analysis pass (not started)

1. ~~Land fateh_21 + fateh_63 reruns~~ done 0728 → **composite frozen at 66/100**.
2. Eyeball fateh_28 (statement_changed — possible scratch-clobber misgrade).
   fateh_41 resolved: grader 120 s timeout = fail by the metric, verdict stands.
3. Decide fateh_78 handling in reported scores (exclude vs annotate).
4. Same-config variance rerun (see below) before reading arm deltas off single runs.
5. Thinking on/off comparison on the 20-set is confounded — if it matters, it needs
   a clean paired design.
6. missing summary.json for `lean-search-think-fateh20-0727` (run killed) — decide
   whether to synthesize one or leave the jsonl as source of truth.

## Planned: exact-repeat run for run-to-run variance (Mariam, 0728)

Idea: rerun the identical 100-problem thinking-high config once more and count
per-problem flips vs the composite. Purpose: measure the pass@1 noise floor. If two
identical runs flip ~±10 problems, single-run arm differences of that size are
meaningless; if flips are few, single-run pass@1 cells in the E0–E2 grid are
defensible. Report **both** net Δ and flip count (net cancels; flips are the real
noise measure). Cost ≈ one full run, ~$42 @std. Not launched — needs a go.
