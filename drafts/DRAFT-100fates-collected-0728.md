# DRAFT — "the 100 fates" collected, 2026-07-28

Everything about the full-FATE-H (100 problems) thinking-on pass, treated as **one
experiment over 100 problems**. All reruns have landed and the regrade audit is done, so
the numbers here are final for this pass. What it is *not* is a grid cell: the harness
still changed after it (see "Status" at the end).

## The experiment

100 problems (`problems-fateh/`), `lean-search` combo, DeepSeek V4 Flash, thinking high,
$1.00 @std budget cap per problem, harness sha `e1af6f7`, pi 0.80.6. Every attempt in the
canonical set ran under that identical configuration.

For operational reasons the 100 attempts were *launched* as several jobs (a 20-problem
job, an 81-problem job a few hours later, and two single-problem reruns on 0728). That is
launch bookkeeping, not experimental structure — the analysis below never splits on it.

| launch | date | n | note |
|---|---|---|---|
| `lean-search-think-fateh20-0727` | 0727 | 19 | killed for the next launch; fateh_32 left unfinished (no attempt record) |
| `lean-search-think-fateh81-0727` | 0727→0728 | 81 | the remaining 80 + fateh_32; done 08:06Z 0728 |
| `lean-search-think-fateh21-rerun-0728` | 0728 | 1 | replaces a sleep-corrupted 14 h timeout |
| `lean-search-think-fateh63-rerun-0728` | 0728 | 1 | replaces a record hit by the unicode decl-name grader bug (fixed `e5d8e8f`) |

Canonical record per problem: the 81-run for fateh_32, the reruns for fateh_21 and
fateh_63, the original attempt for everything else. 19 + 79 + 2 = **100 distinct
problems, no double counting.**

**Regrade audit (0728, `runner/regrade.js` at `00af155`).** All 202 attempts across the
four launches were force-recompiled under the current grader — the one carrying the
value check, the connection retry, and the typed timeout label. Result: **zero solve
flips.** All 66 solves stay solved, all fails stay failed. Exactly two labels changed,
both on already-failed attempts: fateh_41 and fateh_63 `grader_error → compile_error`.
The new setup-def value check fired on nothing — fateh_81 (the only FATE-H problem with a
setup def) is an honest `uses_sorry` — so the hole it closes was real but never exploited.
The regrade is read-only: `attempt.json` still shows fateh_41 as `grader_error`; the
honest label is `compile_error`.

## Headline

**66/100 solved** — **66/99** excluding fateh_78, which is false as formalized
(machine-checked; `DRAFT-fateh78-broken-statement-0727.md`). Cost of the canonical 100
attempts: **$43.20 @std**. Every solve is sorry-free, axiom-clean (`propext`,
`Classical.choice`, `Quot.sound` only) and carries no suspicious keywords.

### The 34 failures

| grade | n | what it means |
|---|---|---|
| `compile_error` | 18 | final file doesn't compile |
| `uses_sorry` | 14 | structure written, holes left open |
| `statement_changed` | 2 | fateh_28, fateh_78 — the graded declaration is gone/renamed (scratch-clobber) |

Counts are post-regrade (fateh_41 moves from `grader_error` to `compile_error`); **no
failure in the set is a grader malfunction.**

Cross-cut by *how the attempt ended* rather than how it graded:

| end | n | spend | median turns |
|---|---|---|---|
| `completed` (agent stopped on its own) | 17 | $10.54 | 619 |
| `budget_exceeded` / `timeout` | 17 | $16.98 | 930 |

Half the failures give up voluntarily at a median $0.64 — well short of the cap. Raising
the cap cannot recover those; only a different arm can.

## Cost over the 100

- Solves **$15.68 (36%)**, failures **$27.52 (64%)**. The per-run cost is essentially
  (#unsolved × $1) plus small change.
- Solve cost is cheap with a heavy tail: median **$0.10**, mean $0.24; **32 solves under
  $0.10**, 12 at $0.50 or more, 2 landing exactly at the budget kill (fateh_4, and
  fateh_21's rerun at 837 turns).
- Failure cost is bimodal by construction: median $0.985 for the capped ones, $0.64 for
  the voluntary stops.

**What a tighter cap would have bought** (solves whose cost-at-completion fits under it):

| cap @std | solves | full-run cost |
|---|---|---|
| $0.10 | 32 | ~$6 |
| $0.25 | 45 | ~$13 |
| $0.50 | 54 | ~$24 |
| $0.75 | 58 | ~$33 |
| $1.00 (actual) | 66 | $43.20 |

Diminishing but not flat — the last $10 of budget still bought 8 problems, so $1.00 is
not obviously over-generous for this tier.

### Actual billed USD (peak windows)

Computed 0728 ~09:30 UTC from per-message timestamps in `events.jsonl` against the peak
windows; the runner's `cost_usd` does **not** apply the 2× multiplier, so `results.jsonl`
understates billing for anything in-window.

| piece | std | billed |
|---|---|---|
| 20-problem launch (19 attempts) | $5.48 | $5.48 (entirely off-peak) |
| fateh_32 killed partial (in no results file) | $0.70 | $0.70 |
| 81-problem launch | $37.02 | **$44.20** (ran through both peak windows) |
| fateh_21 rerun | $1.00 | $1.86 |
| fateh_63 rerun | $1.00 | $1.78 |
| **total thinking-on spend** | **$45.20** | **$54.02** |

The $45.20 spent exceeds the $43.20 of canonical attempts by the superseded fateh_21 /
fateh_63 originals ($1.30) and the killed fateh_32 partial ($0.70). Whole campaign
including the 0725 baseline pilot ($2.08) and the 0726 no-thinking run ($9.73):
≈ **$65.8 billed, ≈$57.0 @std**.

No lean-server outage occurred during any thinking-on attempt (launch logs: zero
unavailable/ECONNREFUSED; watchdog: two routine REPL restarts). The $2.09 outage retry
storm belongs to the 0726 no-thinking run.

## Effort and volume over the 100

45,037 turns · 13,293 `lean_check` · 9,814 edit · 8,026 write · 6,390 `search_mathlib` ·
4,345 read · 2,329 nudges · 1,071 provider errors (touching 81 of the 100 attempts).
Tokens: 23.4 M in / 32.0 M out / 11.06 B cache-read.

Per-attempt medians, solved vs failed:

| | solved | failed |
|---|---|---|
| turns | 248 | 813 |
| `lean_check` calls | 74 | 196 |
| `search_mathlib` calls | 33 | 105 |

Every one of the 100 attempts called `search_mathlib` at least once, and failures search
~3× as much as solves — retrieval demand tracks difficulty, it doesn't substitute for it.
(This is the dataset the grep-vs-semantic question in block A comes from; the search-call
autopsy lives with that analysis, not here.)

Wall-clock is **not** a usable effort measure for this pass: the 81-problem launch was
deliberately paused and resumed around the 03–06 peak window, so per-attempt `wall_s`
(median 65 min for solves, max 14.3 h) includes hours of intentional idling. Cost is the
honest measure.

## Against the earlier arms (paired, same problems)

- **vs the 0725 baseline pilot** (no search, no thinking, 2 h wall cap, 10 problems):
  3/10 → **9/10**. Six of that pilot's seven wall-clock timeouts became solves
  (fateh_15, 22, 56, 57, 70, 72); only fateh_36 stayed unsolved (`uses_sorry`).
- **vs the 0726 no-thinking run** (`lean-search`, $1 cap, 20 problems): 12/20 → **13/20**,
  three flips (fateh_33 ✗→✓, fateh_46 ✗→✓, fateh_8 ✓→✗).

Both comparisons are **confounded** — thinking, harness sha (`10ebfc7`→`e1af6f7`),
supervisor changes and the 0726 outage storm all move at once. They are direction
checks, not effect sizes, and neither is a run-to-run variance estimate.

## Denominator notes

- **fateh_78** — false as formalized, unsolved in every run; report as 66/99 or annotate.
- **fateh_28** — `statement_changed` at $0.28 after 371 turns: the agent clobbered the
  graded declaration with scratch work. Confirmed unchanged by the regrade; counted as an
  honest fail, and a direct motivation for the `check_snippet` arm.
- **fateh_41** — the grading compile exceeds 120 s. Under the one-budget metric a proof
  too expensive to compile inside the shared budget is a fail, so the verdict stands; the
  regrade fixed the label.
- **fateh_32** — no attempt survives from the first launch (killed mid-problem, $0.70
  discarded); its canonical record is the 81-run's, `budget_exceeded` / `uses_sorry`.
- **fateh_4, fateh_21** — graded solved with end `budget_exceeded`: they closed the proof
  in the same turn the cap killed them. Correct under the end/grade split, just unusual.

## Where the rest of the thinking lives

- `DRAFT-experiment-notes-0725-fate.md` — FATE-M saturated (10/10), FATE-H cliff (3/10),
  timeout autopsy, spend-correlates-with-hope → the $1 @std cap.
- `DRAFT-experiment-notes-0726-night20.md` — the no-thinking 20: budget-cap
  counterfactuals, the lean-server outage / $2.09 retry storm, give-up policy, best-state
  checkpointing, laptop-sleep drift.
- `DRAFT-fateh78-broken-statement-0727.md` — the machine-checked refutation, the audit
  that fateh_78 is the *only* broken statement among the doubly-unsolved, the Mathlib gap
  list and the harness pathology catalog. Upstream issue **not filed — ask first**.
- Per-attempt artifacts: `results/lean-search-think-fateh*/<problem>/`.

## Status

This pass is a **cost-calibration run, not a grid cell**. It predates the pre-grid freeze
(the `lean_check` prompt clarification landed in `4f4a247`, grader hardening in
`00af155`), so block A starts fresh runs under the frozen harness. What it does buy:

- a solid cost model — **~$43 @std per 100-problem cell** at this cap, ~$0.43/problem,
  dominated by (#unsolved × cap);
- the failure mix the block A/B/C arms are aimed at (18 compile errors, 14 sorry-holes,
  2 scratch-clobbers, 17 voluntary give-ups);
- FATE-H placed as a mid-range tier at 66% — enough headroom to move, not near a floor.

Still open: the run-to-run variance number. It is no longer a separate experiment — block
A's winning search config is run twice, and that flip count is the noise floor every
later McNemar readout is measured against.
