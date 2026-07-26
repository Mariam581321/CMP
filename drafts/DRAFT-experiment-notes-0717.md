# DRAFT — experiment notes, 2026-07-17 (dev10 failure analysis + mid10 4-arm comparison)

Working notes from reading `events.jsonl` for every attempt. To be reviewed/merged into
PLAN.md experiment log + NOTES.md later. All runs: DeepSeek V4 Flash, thinking off,
1200 s/problem timeout.

---

## Part 1 — dev10-baseline-0717 failure autopsy (2/10, $0.27, sha `b02c8be`)

**Caveat up front: both dev10 runs predate the truncation fix (`438b46c`).** The dominant
failure shapes below are partly artifacts of that; the mid10 runs (sha `077a317`) confirm
the fix changes the shape (rumination → busy iteration) without changing solve ability on
hard problems.

### Failure mode 1 — rumination/truncation death spiral (all 3 `uses_sorry`: 1973_b3, 1993_a4, 1997_a5)

Identical trajectory in all three:
1. Reads problem.lean (its only tool call), then tries to solve the math **in chat** —
   20–27k chars of derivation, zero tool calls, until the 8192 output-token cap
   (`stopReason=length`, mid-sentence). Every single long message in these attempts
   ended at exactly 8192.
2. Nudge ("You are not done… sorry at line N") → restarts the derivation from scratch,
   meanders differently, truncates again. 4 sessions × truncated essay, zero writes.
3. Harness gives up after `MAX_NUDGES=3` consecutive no-tool-call nudges → file is the
   untouched sorry skeleton → `uses_sorry`. ~33k output tokens (4×8192) for nothing.

Content-level: the model never converges on the known solution — tries an approach,
second-guesses, switches ("Let me try yet another completely different approach").
1973_b3 even said "Let me search for information about this Putnam problem" (no search
tool in baseline). These are problems where it doesn't know the math; unbounded
chat-space derivation is its coping strategy.

### Failure mode 2 — truncated writes silently corrupt the file (1962_b1, 1975_a2)

When a `write` call itself hits the 8192 cap, the tool-call `content` argument is cut
mid-line and **the harness executes the partial write anyway**. Verified: 1962_b1 has a
write inside a stop=length message ending mid-comment → `unexpected token ':='` at the
cut point; 1975_a2 has two → `unexpected token '|*'` at lines 95/279. The agent then
spends turns patching damage it caused itself. → Harness fix idea: detect
stopReason=length on a message containing a tool call and reject/annotate the write.

### Failure mode 3 — doom loops with no learning (timeouts)

- **2012_a3**: 36 lean_checks cycling between exactly two states for ~25 min:
  `No goals to be solved` and the statement guard `missing/modified line: open Matrix
  Function` — tripped **12+ times** (every full-file rewrite dropped the `open` line,
  restored it when told, dropped it again next rewrite). Zero adaptation.
- **1998_a6**: hallucinated-lemma treadmill (`MeasureTheory.volume_triangle`,
  `norm_sq_eq_sum_sq`, `PiLp.norm_sq_eq_sum` — none exist); also re-ran lean_check on an
  unchanged file 4–5× in a row.
- **1975_a2**: after recovering from truncated writes, stuck throwing `linarith` at
  nonlinear goals (products of roots / discriminants) where `nlinarith` or a real
  argument was needed.

### Failure mode 4 — write-without-check batching (1983_b2)

37 writes vs 10 lean_checks; at one point **31 consecutive full-file rewrites without a
single compile check**, iterating blind on the formalization (Finset.pi type mismatches,
DecidablePred failures on its digit-sum def). Ended with stop=stop, file still broken.

### What the 2 successes look like

1975_a1 (14 writes/14 lean_checks) and 1998_b1 (18 edits/9 checks, 0 nudges): tight
write→check→small-edit loop, ~1:1 write:check ratio, short text between calls.
Failures cost 3–7× the tokens of successes.

### dev10-lean-plan-0717 comparison (2/10, $0.47 — 1.8× cost, same solves)

- Rumination trio (1973_b3/1993_a4/1997_a5) **byte-identical failure** (5 turns, 1 read,
  32,847 out tokens each): the arm only adds a tool + prompt addendum, and these attempts
  never emit tool calls, so the arm can't reach them.
- On the solvable problems planning genuinely helped: 1998_b1 solved in 88 s / 8.7k out
  tokens vs 298 s / 24k baseline.
- On hard problems it just kept the agent busy longer: baseline's two compile_errors
  (1962_b1, 1983_b2) became full-1200s timeouts.
- plan_check moved the thrash earlier rather than removing it: 2012_a3 — 12/13
  plan_checks failed "plan does not compile"; 1983_b2 — 13 fails, one PASS, then broke
  the plan again; 1998_a6 ignored plan_check entirely (101 writes / 93 lean_checks).

### Post-fix confirmation (mini3 @ `438b46c`, mid10 @ `077a317`)

stop=length still frequent (up to 11–12 truncated messages/attempt on hard problems),
but the truncation-aware nudge converts rumination into tool use: 1997_a5 went 1 → 20
tool calls dev10→mid10; 1962_b1 flipped to **solved** in mid10. Fail mode shifts
uses_sorry → timeout. The fix removed the pathological *shape*, not the capability gap.

---

## Part 2 — mid10 4-arm comparison (all sha `077a317`, same 10 problems, 1 run/arm)

Runs: `mid10-baseline-0717`, `mid10-plan-0717`, `mid10-search-0717`,
`mid10-plan-search-0717`.

| | baseline | plan | search | plan+search |
|---|---|---|---|---|
| **Solved** | **4/10** | 2/10 | **4/10** | 3/10 |
| Cost | $0.39 | $0.47 | $0.36 | $0.40 |
| Fail modes | 1 compile, 5 timeout | 1 compile, 7 timeout | 5 timeout, 1 sorry | 6 timeout, 1 sorry |

Legend: ✅ solved · ⏱ timeout · 💥 compile_error · 😴 uses_sorry (rumination).
"Trunc" = assistant messages cut at the 8192 output cap.

### Solved-by-someone problems

**putnam_1962_b1** — solved by everyone *except* plan

| Arm | Result | Wall | Turns | Out tok | Trunc | Nudges | Notes |
|---|---|---|---|---|---|---|---|
| baseline | ✅ | 931s | 113 | 105k | 2 | 1 | ground it out; one 12×-repeated error loop |
| plan | ⏱ | 1254s | 159 | 105k | 0 | 0 | 91 edits, 24 lean_checks, never converged; 1 failed plan_check |
| search | ✅ | **427s** | 44 | **50k** | 0 | 0 | search_mathlib hit exactly the right lemmas (`descFactorial_eq_prod_range`, `sum_choose_succ_nsmul`); clean solve |
| plan+search | ✅ | 328s | 53 | 34k | 0 | 0 | 6 failed plan_checks but search carried it; cheapest solve |

**putnam_1964_b2** — solved by all 4

| Arm | Result | Wall | Turns | Out tok | Nudges | Notes |
|---|---|---|---|---|---|---|
| baseline | ✅ | **186s** | 23 | **19.6k** | 0 | tight loop; cheapest |
| plan | ✅ | 222s | 30 | 26.9k | 0 | 2 failed plan_checks, mild overhead |
| search | ✅ | 279s | 39 | 31k | 0 | 11 searches, mild overhead |
| plan+search | ✅ | 424s | 69 | 41.8k | 0 | overheads stack: 2.3× wall, 2.1× tokens vs baseline |

**putnam_1982_a5** — baseline & search solve it; both plan arms lose it

| Arm | Result | Wall | Turns | Out tok | Trunc | Nudges | Notes |
|---|---|---|---|---|---|---|---|
| baseline | ✅ | 554s | 29 | 47k | 2 | 2 | solved despite 2 truncated essays |
| plan | ⏱ | 1242s | 40 | 112k | 4 | 3 | 20 full-file writes, **zero plan_check calls**; stuck on `unsolved goals` |
| search | ✅ | 1193s | 43 | 96k | 5 | 3 | solved with 7 s to spare |
| plan+search | ⏱ | 1237s | 70 | 91k | 3 | 2 | 5×-repeated `No goals to be solved` loop at the end |

**putnam_2005_b1** — solved by all 4 (easy)

| Arm | Result | Wall | Turns | Out tok | Notes |
|---|---|---|---|---|---|
| baseline | ✅ | **67s** | 14 | 7.3k | clean, fastest |
| plan | ✅ | 230s | 28 | 20.5k | 2 failed plan_checks + guard trip = 3.4× wall for nothing |
| search | ✅ | 163s | 16 | 18.9k | fine |
| plan+search | ✅ | 113s | 20 | **13.3k** | smooth |

### Never-solved problems (24/24 attempts failed)

**putnam_1965_b6** — all ⏱

| Arm | Wall | Turns | Out tok | Trunc | Notes |
|---|---|---|---|---|---|
| baseline | 1234s | 48 | 157k | 6 | 28 writes vs 15 checks |
| plan | 1224s | 34 | 164k | **11** | worst truncation; 22 writes, only 1 lean_check |
| search | 1226s | 74 | 122k | 8 | most iterative (19 checks/17 edits); math never lands |
| plan+search | 1228s | 52 | 141k | 6 | only plan_check **PASS** on an unsolved problem — couldn't fill the sorry'd helper |

**putnam_1979_a5** — all ⏱

| Arm | Wall | Turns | Out tok | Trunc | Notes |
|---|---|---|---|---|---|
| baseline | 1226s | 95 | 125k | 7 | 52 writes/36 checks; **17×-repeated** identical `rewrite failed` |
| plan | 1209s | 30 | 155k | 10 | 8 nudges; truncated essays + blind writes, 2 lean_checks total |
| search | 1232s | 68 | 125k | 3 | 19 searches; 10×-repeated error loop |
| plan+search | 1245s | 50 | 148k | 2 | 23 searches but only 4 lean_checks — searched instead of checking |

**putnam_1993_a4** — 💥/💥/⏱/⏱

| Arm | Result | Wall | Turns | Out tok | Trunc | Notes |
|---|---|---|---|---|---|---|
| baseline | 💥 | 493s | 11 | 55k | 5 | rumination; died at nudge limit with broken file |
| plan | 💥 | 1173s | 36 | 162k | **12** | 23 writes, **zero** lean_checks or plan_checks — wrote blind 20 min |
| search | ⏱ | 1236s | 66 | 110k | 3 | real iteration (14 searches/10 checks); combinatorial argument never materializes |
| plan+search | ⏱ | 1213s | 65 | 119k | 4 | 22 searches; same story |

**putnam_1997_a5** — all ⏱ (also failed in dev10; model doesn't know this proof)

| Arm | Wall | Turns | Out tok | Trunc | Notes |
|---|---|---|---|---|---|
| baseline | 1213s | 24 | 134k | **11** | 19 writes, **zero lean_checks** |
| plan | 1236s | 38 | 136k | 5 | 25 writes, 6 checks, 1 guard trip |
| search | 1274s | 73 | 110k | **0** | only zero-truncation attempt on a hard problem: 36 checks, real iteration; 11×-repeated error loop |
| plan+search | 1215s | 36 | 144k | 7 | 20 writes, zero lean_checks, 6 nudges |

**putnam_1998_b4** — all ⏱

| Arm | Wall | Turns | Out tok | Trunc | Guard trips | Notes |
|---|---|---|---|---|---|---|
| baseline | 1202s | 48 | 134k | 11 | 2 | 10 nudges (most in run) |
| plan | 1244s | 60 | 161k | 6 | **10** | kept mangling the statement; 1 plan_check pass then broke it |
| search | 1257s | 57 | 140k | 6 | 3 | 13 searches, steady thrash |
| plan+search | 1254s | 74 | 178k | 7 | 3 | most expensive attempt of the experiment ($0.084) |

**putnam_2006_a3** — ⏱/⏱/😴/😴 — rumination spiral survives the truncation fix

| Arm | Result | Wall | Turns | Out tok | Notes |
|---|---|---|---|---|---|
| baseline | ⏱ | 1240s | 35 | 152k | 26 writes, only 5 checks |
| plan | ⏱ | 1202s | 38 | 124k | 9 nudges, 4 failed plan_checks |
| search | 😴 | 373s | 7 | 42k | 1 read + 1 write, then truncated essays to nudge limit |
| plan+search | 😴 | 320s | 6 | 41k | 1 read, then **five** straight truncated essays — ignored the explicit "CUT OFF, write to the file NOW" nudge all 4 times |

### Takeaways

1. **Search is the only arm that pays for itself.** Same solves as baseline (4) at lower
   cost; on 1962_b1 it's the difference between grinding (931 s, error loops) and a
   clean 427 s solve — lemma lookups returned exactly the right Mathlib names. Also
   produced the only zero-truncation hard-problem attempt (1997_a5): searching seems to
   partially substitute for chat-space derivation.
2. **Plan is currently net-negative.** 2/10, highest cost, lost two problems baseline
   solves (1962_b1, 1982_a5). Consistent signature: plan_check mostly fails ("plan must
   compile" is a bar the model can't clear on hard formalizations), the agent often
   abandons plan_check entirely (soft-gate adherence collapse, again), and on 1993_a4
   wrote 23 files with no check of any kind. On easy problems pure overhead (2005_b1:
   3.4× wall). The lone plan_check PASS on an unsolved problem (1965_b6) repeats the
   dev10 finding: a compiling plan doesn't help when the sorry'd helper holds all the
   difficulty.
3. **Plan+search ≈ search minus plan's tax.** Where search carries, it's fine (1962_b1:
   6 failed plan_checks, still cheapest solve); it dropped 1982_a5 that search kept.
4. **The 6 unsolved problems fail in every arm** — bottleneck is the mathematics, not the
   scaffolding; ~$0.05/problem/attempt to rediscover that. Truncation still rampant
   exactly there (up to 12 capped messages/attempt).
5. **Behavior is bimodal and stochastic; 1–2 solve differences are weak evidence.**
   2006_a3: same model+problem — baseline/plan iterate 20 min, search/plan+search die in
   6 turns of pure rumination, ignoring the truncation nudge 4×. n=1 per cell ⇒ even
   plan's 2 vs 4 could be partly variance.

### Ideas / possible next steps (not started)

- Cheap discrimination: repeat runs on the 4 solvable problems only (1962_b1, 1964_b2,
  1982_a5, 2005_b1) rather than re-running all 10 — the 6 hard ones fail universally.
- Harness fixes worth considering:
  - reject/annotate tool calls whose arguments were truncated by the output cap
    (currently partial writes execute and corrupt the file);
  - detect repeated-identical lean_check results with no intervening edit;
  - escalate the statement-guard nudge after 2–3 trips of the same missing line;
  - rumination hard-stop: if N consecutive stop=length messages with no tool call,
    inject a much more coercive nudge or forcibly seed the file.
- The math gap, not Lean mechanics, is the ceiling → raises priority of arms that help
  find/recall the argument (NL sketch? external hints?) over workflow restructuring.
- `--max-tokens` knob (65eab7e) exists now: worth testing whether a higher cap simply
  dissolves the truncation spiral (at what cost), before building more nudge machinery.
