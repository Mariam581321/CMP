# How arms are compared

The readout rules, fixed before the remaining cells run. `PLAN.md` sets the arms and the
metric; this file says how two cells become a claim. Written 2026-08-10, after block A
and before loogle / snippet / block C / library / triage — see **Status** at the end for
which parts are confirmatory and which are exploratory, because that line matters more
than any test in here.

## 1. There is no single fair cost number

Two questions, two estimands. Reporting one and calling it "cost" is how the comparison
goes wrong.

- **Spend** — what does it cost to run this arm under our policy? Mean cost over ALL
  problems, cap included. The $1 cap is part of the policy and applies to every arm, so
  this needs no correction. It is the budget line item.
- **Efficiency** — given the arm gets there, how cheaply? Paired cost-to-first-proof on
  problems both arms solve.

Headline stays `(solve rate, cost)` as a pair, per PLAN. Never collapse it to one number
without saying which of the two you collapsed.

**Mean cost among an arm's own solves is banned.** It selects on the outcome. A better arm
is rewarded with the expensive problems, which then inflate its average:

| | mean first-proof cost among its own solves |
|---|---|
| base (43 solves) | $0.250 |
| grep (50 solves) | $0.238 |

Nearly identical, and misleading. grep's 9 extra wins cost **$0.461** each against **$0.189**
for the 41 both solve — and paired on those 41, grep is cheaper on 27. Conditioning on
solve status hides the effect.

## 2. The curve is the primary object

For each arm, `f(B)` = problems solved with cost-to-first-proof ≤ B, for B from 0 to the
cap. Every other number here is a summary of it. Report it as a figure, per arm, with the
paired-bootstrap band.

**Simulated cutoffs** (block A, n=90; solves = first-proof ≤ cap, spend = Σ min(end cost, cap)):

| cap | base | grep | semantic | spread |
|---|---|---|---|---|
| $0.10 | 13 / $8.37 | 23 / $7.88 | 24 / $7.76 | **11** |
| $0.25 | 30 / $17.87 | 34 / $16.50 | 39 / $16.25 | 9 |
| $0.50 | 34 / $29.58 | 42 / $26.94 | 43 / $27.29 | 9 |
| $0.75 | 41 / $37.58 | 47 / $34.96 | 46 / $36.38 | 6 |
| $1.00 | 43 / $43.74 | 50 / $41.11 | 49 / $43.99 | 7 |

The arms are **furthest apart at $0.10 and converge as budget grows**. A pass@1 rate at
$1.00 reads the experiment at the point where it has least to say: with a strong model and
a generous cap, everything solvable eventually gets solved, so the headline measures the
benchmark ceiling more than the arm. Say this in the paper — it is a finding about
evaluation practice, not a footnote about ours.

Two consequences:

- **Always run at the most generous cap affordable.** A run at $1.00 can be censored down
  to any smaller cap exactly and for free; nothing can be extended upward. The cap you run
  at is a data-collection choice; the operating point is an analysis choice.
- **The simulation rests on one assumption**: that an attempt killed at cap `c` after
  reaching a verified proof at `< c` still grades solved. The high-water scan supports it —
  213 attempts kept editing after a green check and all 213 got back to green; the 8 that
  reached a proof and graded unsolved are all harness-era artefacts. State the assumption
  and cite the scan.

## 3. Summaries, and what each is for

**AUC** — area under `f(B)` from 0 to the cap. The identity is worth quoting because it
makes the metric transparent:

> **AUC = solves − (first-proof cost of those solves)**

"Solves, charged for what they cost," at an implicit exchange rate of **one solve per $1**,
set by the cap. Defensible because the cap was pre-registered, but state the rate — a
reviewer will ask, and any other rate is a different metric. Censoring-native, no
conditioning, uses every problem. Block A: base 32.3, grep 38.1, semantic 38.9.

**$/solve** — reader-facing headline. base $1.02, grep $0.82, semantic $0.90 at the $1 cap.
Ratio of two random quantities, so it needs a paired-bootstrap CI and moves with the cap
(see the table above: the ordering is stable but the numbers are not).

**Paired cost-to-first-proof** — the efficiency claim. Sign test or Wilcoxon on problems
both arms solve. Block A: semantic vs base 29/41 (p = 0.012), grep vs base 27/41
(p = 0.060), grep vs semantic 21/46 (p = 0.659) — against McNemar's 0.109 / 0.109 / 1.000
on the same cells. The binary readout is the least sensitive view of the same data.

**Use first-proof cost for efficiency, end cost for spend.** 8% of all spend happens after
the problem is already solved; that is agent fidgeting, not arm signal, and it belongs in
the spend number but not the efficiency one.

## 4. Censoring is unequal and must be reported

At-cap counts: base 23, grep 23, **semantic 29**. Semantic's spend is the most understated
of the three, so a naive spend comparison flatters it most. Report at-cap counts beside
every spend figure, and run one sensitivity line — what the ordering does if capped
attempts would have cost 2× — rather than pretending the cap is neutral.

Attempts ended by `max_nudges` are **failures, not censoring**: 0 of 50 attempts that ever
reached three consecutive refusals went on to solve. They cost less than the cap, so they
pull spend down without buying solves; that is a real property of the arm, not an artefact.

## 5. The noise floor gates every claim

grep r1 vs r2, same arm, same freeze, same list: **3 flips on the first 38 problems**,
projecting to **~9 on the 90** (flips concentrate in the near-cap class; 11 of those are
done and 23 remain). For scale, block A's discordant counts were grep-vs-semantic **7**,
grep-vs-base **10**.

**No single-cell comparison in this grid can resolve anything smaller than ~10 problems.**
Rules that follow:

- Effects below the floor are reported as bounds, not nulls: *"differ by less than N
  problems and less than X¢ per proof"*. A null you can bound is a result; a null you
  cannot is an underpowered run, and replicates are the entire difference.
- k = 3 on the carried-forward baseline, k = 2 per arm. Pooling k replicates cuts the sd of
  a paired difference by √k — it turns block A's z ≈ 1.9 into z ≈ 3.3. With n pinned at 90,
  replication is the only lever left for power.
- Replicates also give **per-problem solve probability** instead of a bit, which is what
  makes the curve band honest.
- Don't subset to a "hot" list to save money: the 23 always-solved-cheap problems cost grep
  $1.70 in total. Cost lives in the failures, which are the ones you need.

## 6. Library and triage are policies, not arms

Every arm is a policy for turning dollars into solves. Plot them all on the **(spend, solves)
plane**. The baseline arm's budget curve *is the frontier of all uniform-cap policies*, and
it is already computed — so the question for any non-uniform policy is simply whether it
lands above that frontier. This dissolves the "how do I average cost for these" problem:
you never average, you compare at matched spend.

**Library** — "spend $10 upfront, then run." Its curve is the ordinary curve shifted right
by the amortized phase cost, $10/90 = $0.11/problem, so AUC penalises the phase
automatically with no special-casing. Report campaign total *and* per-problem amortized
with n stated: the amortization is an assumption, not a fact, and it moves if a triage
stage later shrinks the attempted set.

**Triage** — spend the judge fee on all 90, the full cap only on the "yes" set.

- two-stage spend = 90 × judge cost + Σ attempt cost over "yes"
- two-stage solves = solves among "yes", over all 90 as denominator

The comparator is **not** the uncapped reference cell — that comparison is rigged, since
triage spends less by construction. It is **the same arm at matched dollars**: find the cap
`c` where `Σ min(cost, c)` equals the two-stage spend, read solves off the curve at `c`.
Above the frontier, the claim is sharp — *selective allocation beats uniform budget
allocation at matched spend*. Below it, the judge fee doesn't pay for itself. Either way it
costs nothing to compute.

Two constraints: use the same arm's curve as the comparator (triage on grep → grep's
curve), and the matched-dollar rule is fixed here, before any verdict exists.

## 7. Extending past the cap: don't

Resuming at-cap attempts to de-censor the tail is technically feasible — pi has
`--continue`/`--session`/`--fork`, session files survive intact, `work/problem.lean` and the
Mathlib symlink are still there, and the server memo makes re-checks free. It is still the
wrong measurement: supervisor state is in-process and lost, so a resumed attempt restarts
with a fresh 3-nudge budget (nudges end ~20% of attempts), the error ledger resets, budget
accounting has to be carried forward by hand, and a resume today may cross a silent model
boundary. What comes back is a new arm, not a longer cell.

If the uncapped tail is worth knowing, it is worth its own pre-registered cell at a higher
cap — priced as such. Otherwise report the censoring honestly (§4) and stay inside the cap.

## 8. Checklist per comparison

1. Curve for each arm, paired-bootstrap band, cutoffs at $0.10 / $0.25 / $0.50 / $0.75 / $1.00.
2. AUC + exchange rate stated; $/solve with CI; spend with at-cap counts.
3. Paired cost-to-first-proof on commonly-solved problems (sign test / Wilcoxon).
4. Binary McNemar at the $1 cap — kept because it was pre-registered, reported beside the
   noise floor, never alone.
5. Effect vs noise floor; if below, state the bound rather than "no difference".
6. For library/triage: the (spend, solves) plane against the matched-dollar comparator.

## Status: what is confirmatory and what is not

The curve readout was anticipated — the `PLAN.md` next-steps item *"write the fair-comparison
rationale (which post-hoc readout: solve-vs-token curves, matched dollars, cost-per-solve)
**before** full-grid numbers exist"* is what this file discharges. But it is being written
after block A's numbers were seen, so:

- **Exploratory** — every block A curve, AUC and paired-cost figure quoted above. Label them
  so in the writeup. They are still worth reporting: the effect replicates across two
  independent arms (grep and semantic vs base), which is more than a single post-hoc slice.
- **Confirmatory** — the same analyses applied to loogle, snippet, block C, library and
  triage, none of which have run. That is the honest split, and it is the reason this file
  is dated and committed before those cells launch rather than after.

The pre-registered binary McNemar stays in the report either way. It is not the most
sensitive view of the data, and the gap between it and the curve is itself worth a
paragraph.
