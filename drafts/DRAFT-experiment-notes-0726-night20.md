# DRAFT — experiment notes, 2026-07-26 (night20: lean-search on FATE-H, 20 problems)

Run `lean-search-fateh20-0726`: lean-search combo (base + `search_mathlib`), DeepSeek
V4 Flash, thinking off, **$1.00 @std budget cap per problem** (binding limit), 21600 s
wall-clock backstop, concurrency 10, sha `10ebfc7`, launched 13:56 CEST → finished
21:39 CEST, entirely off-peak (cost_std = cost_usd). Problem set: `night20-0726.txt`,
20 FATE-H problems **disjoint from the 0725 baseline pilot's 10**. First run with the
supervisor extension (in-process nudges, release after 3 consecutive no-progress
rounds) and the first FATE-H run at $1 @std.

## Headline: 12/20 solved, $9.73 — vs 3/10 for the 0725 baseline pilot

| problem | topic (short) | result | wall | cost | turns/checks | nudges |
|---|---|---|---|---|---|---|
| fateh_53 | ℝ ≃ₐ[ℚ] ℝ is trivial | ✓ | 22 s | $0.001 | 7/2 | 0 |
| fateh_74 | flat over valuation ring ⇒ no zero smul-divisors | ✓ | 74 s | $0.003 | 21/4 | 0 |
| fateh_17 | (Xᵖ−1)/(X−1) irreducible | ✓ | 172 s | $0.007 | 45/11 | 0 |
| fateh_96 | ideal inf via span decomposition | ✓ | 403 s | $0.010 | 38/7 | 0 |
| fateh_19 | every finite G embeds in some Aₙ | ✓ | 1382 s | $0.062 | 205/71 | 5 |
| fateh_26 | coatom subgroup: center or commutator | ✓ | 1824 s | $0.105 | 225/63 | 7 |
| fateh_20 | \|G\|=p³ ⇒ Z(G)=[G,G] | ✓ | 1837 s | $0.108 | 242/62 | 12 |
| fateh_8 | cyclic Sylow-2 ⇒ index-2 subgroup | ✓ | 2583 s | $0.157 | 377/122 | 13 |
| fateh_77 | maximal ideal at prime, bijective case | ✓ | 4736 s | $0.176 | 408/147 | 8 |
| fateh_89 | prime height under comap | ✓ | 14330 s | $0.580 | 797/352 | 16 |
| fateh_88 | no (xᵐ−1)(xⁿ−1)=… in Noetherian ring | ✓ | 18117 s | $0.831 | 904/515 | 26 |
| fateh_2 | no simple group of order 56 | ✓ | 16293 s | $0.848 | 901/356 | 33 |
| fateh_98 | regular sequence generating P^r | ✗ uses_sorry (gave up) | 8149 s | $0.442 | 443/62 | 73 |
| fateh_78 | nilradical = contraction under integral ext | ✗ uses_sorry (gave up) | 14508 s | $0.443 | 510/168 | 39 |
| fateh_55 | K(√a) via x²=a, adjoin = ⊤ | ✗ compile_error (gave up) | 20776 s | $0.957 | 1370/707 | 73 |
| fateh_33 | deg-n poly, Gal ≅ Sₙ card n! | ✗ budget | 20488 s | $1.000 | 1036/268 | 4 |
| fateh_32 | Gal(ℚ(⁴√2,i)/ℚ) ≅ D₄ | ✗ budget | 21617 s | $1.000 | 1017/289 | 69 |
| fateh_46 | [ℚ(α):ℚ] ∣ 8 from α+α⁻¹ condition | ✗ budget | 20001 s | $1.001 | 1104/270 | 17 |
| fateh_94 | Krull dim of S/ann(M) | ✗ budget | 22109 s | $1.001 | 1044/296 | 28 |
| fateh_81 | R(3), R(4) not UFDs | ✗ budget | 22502 s | $1.001 | 890/254 | 11 |

Caveats on the 3/10 → 12/20 comparison: disjoint problem sets, different budgets
($1 @std vs 2 h wall), supervisor vs old respawn loop, small n. But the direction
matches the 0725 timeout autopsy exactly — it diagnosed the baseline failures as
retrieval-starved (blind name-guessing, "needs Mathlib search, not budget"), and the
retrieval arm roughly doubled the rate. `search_mathlib` was called 1,303 times
(65/problem); every solve ≥ 5 nudges also leaned on it heavily.

Grading hygiene: all 12 solves close over `propext / Classical.choice / Quot.sound`
only; zero suspicious keywords, zero `native_decide` reaches (0725 had two), zero
sorries in solved files.

## The numbers

- **Totals:** 11,584 turns, 4,026 lean_checks, 434 supervisor nudges, 58.9 agent-hours
  packed into 7 h 43 m real time. Tokens: 5.1 M in / 6.2 M out / **2.60 B cache-read**.
- **Solve economics:** the 12 solves cost **$2.89 (30%)**; the 8 failures burned
  **$6.85 (70%)**. Cost per solve $0.81 all-in. Heavy tail as always: 9 solves cost
  ≤ $0.18 (together $0.66); the three grinders (fateh_89/88/2) cost $2.26.
- **Budget-cap counterfactual:** a $0.25 cap ⇒ 9 solves for ~$2.5 total; $0.60 ⇒ 10;
  $0.85 ⇒ 12. The last dollar-tier bought 3 solves — consistent with 0725's
  "spend and hope correlate" and the $1 @std choice.
- **Median solve:** ~30 min wall. Solves averaged 143 checks; failures 290.
- **Failure margins:** 4 of 8 failures ended with a *compiling* file 1–2 sorries short
  (fateh_32: 2, fateh_94/98/78: 1). The compile_error failures died at 3–9 errors
  (fateh_33/46: 3 with 0 sorries — plumbing, not math). Nobody was hopeless-far at
  death; FATE-H at $1 is a near-miss regime, not a wall.

## Biggest issue: the 17:13 lean-server outage → $2.09 retry storm (21% of run spend)

The lean server died ~17:13 CEST (10 "socket hang up" results, then a steady stream of
`ECONNREFUSED`; the original server's log wasn't preserved, so cause of death is
unrecorded — it predated the watchdog). Manual recovery respawned it 17:23:51; Mathlib
import took 84 s; healthy ~17:25.

In that ~12-minute hole, **978 of the run's 4,026 lean_checks (24%) returned
"lean_check unavailable — transient, try again"**. The tool result *invites an
immediate retry*, checks fail in milliseconds instead of blocking, and each retry turn
re-reads the attempt's full cached context. Ten agents turned into a token pump:
**1,233 turns and $2.09 burned inside the window** — a >10× burn-rate spike vs the
run average. Per-attempt damage: fateh_89 spent $0.293 there (51% of its total),
fateh_88 $0.276 (33%), fateh_33 $0.338, fateh_89 and fateh_88 still solved, but the
five budget_exceeded attempts each lost $0.08–0.34 of their $1.00 to the storm — for
the near-miss failures that's plausibly the margin.

Fixes this suggests, in order of value:
1. **Server-side: make lean_check block, not bounce.** When the server is down or the
   REPL is restarting, hold the HTTP request (or sleep-and-retry inside the extension)
   for up to ~60 s before returning failure. An agent waiting costs nothing; an agent
   retrying costs cache-read on the whole transcript.
2. The watchdog now exists (`scripts/lean-server-watchdog.sh`, polling /health every
   10 s, running since 17:53) — it caps a future outage at ~10 s + import time instead
   of 11 min of dead air. Keep it as a standing prerequisite for launches.
3. Runner could pause nudging while /health is down (supervisor already does a real
   server check per agent_end; a down server currently yields "no check result
   available" nudges, which keep the loop hot).

## Second issue: the REPL churned all evening

After recovery, the replacement server logged **22 "restarting REPL: watchdog
timeout" events between 17:25 and 19:53** — one every 3–10 minutes, each costing a
4–90 s Mathlib re-import plus whatever checks were in flight. This is 0725
operational finding #1 (heavy FATE-H checks wedge the serialized REPL) but now in
chorus: by evening the survivors were exactly the six $1-class grinders, whose checks
are the heavy ones. The per-check agent-facing timeout + fair scheduling from
`718449e` kept it liveable (solves continued through the churn), but ~24 restarts/run
is a lot of re-import tax. Worth pulling the restart correlation (which attempt's
check tripped each watchdog kill) before the next FATE-H night; if it's again 1–2
attempts causing all of it, a per-attempt heavy-check quarantine would pay.

## The give-ups: supervisor release policy fired 3 times

Three attempts ended `completed`-but-unsolved via the 3-consecutive-no-progress
release — a new outcome class this harness version introduced (the 0725 baseline
never stopped trying). Their last words are diagnostic:

- **fateh_78** ($0.443, 56% budget unspent): *"I give up. The theorem is false. The
  `sorry` cannot be filled."* It talked itself into disbelieving a (presumably true)
  benchmark statement. Wrong-belief termination — more nudging wouldn't help, but a
  nudge variant that challenges "the theorem is false" claims (e.g. "it is a
  benchmark theorem; find the missing hypothesis you dropped") might.
- **fateh_98** ($0.442): *"The theory of regular local rings is not available in
  Mathlib."* A retrieval-confidence failure — it made 127 search_mathlib calls and
  concluded absence. Whether the API truly is absent in our 4.27 pin is checkable;
  if it exists under a name search missed, that's a direct indictment of the search
  arm's recall and worth a case study.
- **fateh_55** ($0.957, 73 nudges, 707 checks — both run maxima): *"I've tried
  everything I know for over 8 hours. … Please stop asking me to fix it."* Budget
  was spent anyway; the release just saved the last $0.04.

Two of three released with >half the budget unspent, which looks premature next to
0725's spend-hope correlation — but both were belief-failures, not effort-failures.
The policy behaved as designed; the leverage is in what the nudge says, not in
nudging longer.

## Regression risk it re-confirmed: no best-state checkpoint

The error trajectories show long plateaus where `problem.lean` compiled clean except
for sorries (fateh_55: 203 consecutive such checks; fateh_88: 171; fateh_2: 144;
fateh_89: 134) while the model ground on the remaining subgoal. fateh_55 then
**destroyed its own compiling state**: from compiles-with-2-sorries it ended at 9
compile errors — exactly the 0725 fateh_72/fateh_56 pattern ("kept destroying its
best state"). fateh_81 likewise ended (4 errors + 2 sorries) worse than its best.
Best-state checkpointing was flagged 0725 as an all-arms harness question; this run
turns two would-be near-misses into worse-than-near-misses and makes the case again.

## Ops notebook

- **Laptop sleep stretched the wall-clock backstop.** ~29 min of cumulative WSL2 VM
  suspend accrued between launch and evening (ps monotonic-derived start 14:25:54 vs
  run.json realtime 13:56:33). Node timers run on the monotonic clock, which freezes
  during suspend, so the 6 h SIGKILL backstop fired up to ~29 min late in wall terms —
  which is why status.js showed attempts "running" past 6 h elapsed (fateh_81 hit
  22,502 s). Harmless *this* run because the budget cap is event-driven and did the
  binding (all five over-6 h attempts ended `budget_exceeded`, none `timeout`), but on
  a no-budget run the backstop drifts by exactly the sleep time. Known-gotcha family:
  laptop sleep corrupts runs.
- **Provider flakiness was constant but survivable:** 522 provider errors (every one
  "Connection error."), 561 auto-retries, only 3 exhausted retry chains, ~22 min total
  backoff wait. fateh_46 alone ate 101 connection errors. No attempt aborted for
  provider reasons (`provider_aborted: 0`).
- **Budget enforcement was precise:** the five cap kills landed at $1.000–$1.001 —
  overshoot ≤ 1 message as designed (`7304e3c`).
- **Supervisor v1 works.** 434 in-process nudges, no respawn loop, single event
  stream per attempt. Nudge-then-solve is real: fateh_2 solved after 33 nudges,
  fateh_88 after 26, fateh_89 after 16 — the pre-supervisor harness would likely have
  ended those sessions long before the solve.
- fateh_33 and fateh_46 each made 1 `grep` call, fateh_55 one `test` call, fateh_88
  four `bash` calls — hallucinated/out-of-toolset names that the supervisor correctly
  does not count as progress. Cosmetic, but a reminder the toolset prompt doesn't
  fully pin the model's tool vocabulary.

## What this sets up

- lean-search on FATE-H looks like a real arm effect in the direction the 0725
  autopsy predicted; the committed E0–E2 grid comparison is what turns this into a
  claim (this run is one cell's pilot, not the measurement).
- Before the next night run: keep the watchdog up, consider blocking lean_check
  during server-down, and decide whether best-state checkpointing enters the harness
  before the grid (it's all-arms, so it's a harness delta that would invalidate
  comparisons if introduced mid-grid).
- The five budget_exceeded near-misses (compiling-with-1-2-sorries or ≤3 errors) are
  the natural candidates for a $2-budget probe of the marginal-solve curve — but
  that's a design decision for the grid, not tonight.
