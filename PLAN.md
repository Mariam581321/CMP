# Plan: which harness features actually matter for Lean theorem proving?

## Motivation

Papers in this space propose a whole architecture as a package — a model, a loop, a
subagent scheme, a search graph — evaluated end-to-end. That makes it hard to tell which
component carries the performance. We want a controlled, one-change-at-a-time answer:
fix one harness ([pi](https://github.com/earendil-works/pi), cloned in `pi/`), express
each design choice as a toggleable extension, and measure what each one moves.

Implementation (how an attempt runs, grading, tooling): `SKELETON.md`. Papers and
benchmarks: `papers/INDEX.md`. Money and time: `COSTS.md`. Run write-ups: `drafts/`.

## The framework

Every harness architecture is a set of answers to three questions, asked at each model
call:

1. **Context** — what does this call see? Raw history or compacted summaries; the whole
   problem or an isolated piece (that's what defines a subagent); what gets injected
   besides history.
2. **Calls** — how are they arranged? One feedback thread, parallel samples, a tree; how
   the budget splits across call types; and who owns the call graph — a harness script
   the model can't opt out of, or tools the model may ignore.
3. **Outside information** — what exists beyond the weights? Compiler errors, goal
   states, library search, verified-facts collections, judges; and whether a verdict
   gates control flow or only informs the next call.

These are a **basis**: each design ("arm") is a vector of answers; we change one answer
at a time and isolate what moved the needle.

### Papers → vectors in this basis

| System | 1 Context | 2 Calls | 3 Outside info |
|---|---|---|---|
| AxProver-Base | managed memory (explicit compaction policy) | one thread | compiler + search |
| Goedel-Architect | transcripts never survive; per-lemma calls see lemma + declared parents; blueprint is the only persistent object | harness-owned; parallel per lemma; per-call-type budgets; outer refine loop | compiler + retrieval (+ optional NL proof); failed lemmas return structured diagnoses that gate replanning |
| Danus | fact graph is the shared state; workers see graph slices | model-owned, dynamic; parallel workers | LLM verifier (imperfect) gates writes to the graph |
| MerLean-Prover | informal plan (nodes + status) is the only shared object; one node, one objective per call | harness-owned sequential recursion; plan is the unit of revision; decompose only failed nodes | compiler + kernel audit + three blank-context LLM judges; all gate; no search |

## Setup

- **Benchmark: FATE-X** — 100 PhD-level algebra problems, 92 scoreable: fatex_13, 23,
  60, 75, 81 are annotated out as broken statements (machine-checked or hand-verified —
  `drafts/DRAFT-fatex-unsolved-audit-0803.md`, which sets the scoring rules and regrades
  fatex_19 solved), and fatex_2, 15, 63 join them from the solved-side audit
  (`drafts/DRAFT-fatex-solved-audit-0805.md`: 2 is trivially true, 15 hypothesises an
  empty type, 63 drops a surjectivity requirement — all three were graded *solved*, which
  is why the 0803 unsolved-only pass could not see them).
  **The grid run list is `problems-fatex/safe87.txt` — n = 87**: the 92 minus
  fatex_77 and fatex_99, which the 0803 audit flags *suspect* rather than broken
  (§4.1: 77's `ht P' = h+1` needs catenarity nobody assumed; §4.2: 99's abstract-group
  KRvS may be strictly stronger than intended, and it is where both 0804 spawn pilots
  axiom-gamed), and minus fatex_35, 46, 70, which are faithful but close on one or two
  Mathlib lemmas — every arm gets them for free, so they cannot carry an arm effect
  (0805 audit §4; their recorded solves stand, they are simply not worth grid budget).
  Decided 2026-08-05, before the first grid cell: a suspect statement that
  later turns out broken would have to be struck from every cell after the fact, and the
  two of them cannot carry an arm effect worth that risk. So 87 is the paired unit for
  every within-block McNemar, the denominator of every grid solve rate, and the library
  and triage populations too; 92 survives only as the scoring rule and in pre-grid
  numbers (the 0802 51/95, which is 43/87 on this list). Eval-only; dev iteration happens on FATE-M + Putnam mid-problems.
  FATE-X replaced FATE-H as the grid benchmark on 2026-08-04: the ~08-02 silent model
  upgrade saturates FATE-H — an informal post-upgrade check solved everything it could
  actually attempt (the remainder died to infra, not difficulty) — so arm effects have
  nowhere to live there, the same fate as FATE-M before it. (fateh_78 stays annotated
  out of any FATE-H numbers: broken statement,
  `drafts/DRAFT-fateh78-broken-statement-0727.md`.) **Open decision:** if FATE-X pins
  the arms to the floor — too few discordant pairs for McNemar to resolve anything —
  the grid moves to a Putnam mid-difficulty subset, where differences between arms are
  plausibly more visible. Decide on the block A cells, not before.
- **Model: DeepSeek V4 Flash, thinking on, always.** Thinking is a model knob, not a
  harness answer, so it is fixed config rather than an arm; the on/off pilot on a shared
  20-problem set showed thinking-on solves the same or slightly more while being cheaper
  and faster. All results are conditional on a reasoning model — the deployment norm —
  and explicit scaffolding competing with internal reasoning is part of what's measured.
  Model boundaries (same API id, silently different model) cut run comparability without
  moving any freeze: 2026-07-31, and **~2026-08-02 — the upgrade that saturated FATE-H
  and forced this benchmark move**. Every pre-upgrade number, the FATE-H cost
  calibration included, describes the old model; grid cells start from scratch on the
  new one.
- **Progressive baseline (hill-climb).** The experiments run in sequential blocks;
  each block's winner becomes the base configuration for the next. Search is decided
  first — every realistic system ships retrieval, and later arms should stack on the
  better version of it. Comparisons are clean *within* a block; cross-block
  attributions are conditional on the chosen path, and are reported that way.
- **Metric:** proof accepted sorry-free by the Lean compiler, every declaration
  elaborating within the deterministic **`maxHeartbeats 400000`** cap — one definition of
  "compiles" for agent, supervisor, and grader, so a solve is always observable inside
  the agent's own loop; the grader's verdict is a fresh compile. Heartbeats, not a
  measured budget, since 2026-08-01: a wall-clock bound flipped 52% of one run's "too
  expensive" verdicts (0730b), CPU-seconds narrowed the noise band but fateh_32 (0801)
  still flipped twice in four measurements of the same bytes — heartbeats are a pure
  function of the file, so over-cap is a byte-reproducible compile error
  (`SKELETON.md`, "The verdict is deterministic"). Resource kills (CPU/wall/memory
  fuses) are machine events, not fails, and are recorded as `grader_error`.
- **Budget:** per-problem cost cap (cost_std, peak-invariant) as the binding limit;
  wall-clock is only a hang backstop. No budget parity across arms — we report
  *(solve rate, cost)* and let the tradeoff be part of the result. For worker arms,
  child usage rolls up into the parent's ledger and the cap is shared.
- **Readout (fixed before seeing numbers):** every comparison is paired on problems,
  exact McNemar on the discordant ones; the flip count between the two identical runs
  of the winning search is the noise floor any effect must clear — and the pass@1
  protocol's justification. Effects below the bar are reported as point estimates
  with cost curves. Arm prompts differ only in the manipulated instruction.

## The experiments

**Block A — search: what kind of retrieval matters?**

All arms are defined exactly — protocol, result shape, limits — in `SEARCH.md`; cite
that rather than the sketch here. `grep_mathlib` in particular is not an off-the-shelf
tool and needs its own definition in any write-up; `loogle_mathlib` is off-the-shelf
Loogle but environment-filtered, which needs stating too.

- **base** — no search. The floor and effect-size ruler.
- **semantic** (`lean-search`) — natural-language semantic search over Mathlib:
  retrieval by *meaning*.
- **grep** — exact/substring/regex search over Mathlib declaration names and
  signatures: retrieval by *spelling*. The autopsies say agents often need
  *confirmation of a name they can nearly guess*, not discovery: one attempt produced
  398 unknown-identifier errors across 193 hallucinated lemma names; another made 127
  semantic searches and wrongly concluded an API was absent. Since 2026-08-04 the arm
  also ships read access to the Mathlib source (work-dir symlink, results carry
  locations again — `SEARCH.md`): grep + read are one repo-access modality, and the
  546:8 tool-printed-vs-guessed blocked-read count showed the demand.
- **loogle** (`lean-loogle`, added 2026-07-31) — Loogle over the compiled environment:
  retrieval by *structure* (type-shape patterns, constants, name fragments), the mode
  for when the agent knows neither the name nor the phrasing, only the goal shape. Sees
  the `to_additive`/`alias` names grep structurally cannot. Public API, hits filtered
  to our pin (`SEARCH.md` has the skew numbers and the filter rationale).

Semantic vs grep vs loogle separates discovery-retrieval from confirmation-retrieval
from shape-retrieval.

⇒ Choose the better search as the default for everything after; **run the winner
twice** — the flip count between identical runs is the noise floor for every later
comparison and the justification for the pass@1 protocol.

**Block B — scratch verification.**

- **snippet** — winning search + a stateless `check_snippet(code)` tool: compile any
  snippet, no files involved. Replaces the old draft-file idea. Expected to matter:
  agents already write scratch files and try to compile them, which silently does
  nothing today — they clobber the graded file with probes, destroy best states, and
  sometimes get misgraded for it.

⇒ Analysis: does snippet *substitute* for search (compare per-problem search-call
counts against block A) or complement it? If search usage collapses with the score
held, a contingent no-search+snippet run tests whether guess-and-compile alone
suffices. Best arm so far carries forward.

**Block C — subagents.** All on the block-B winner. Workers see one subgoal + the
parent statements, get `check_snippet` (+ search) but **not** `lean_check` — only the
main agent touches the graded file; child usage rolls into the shared per-problem cap.

- **spawn** — a `spawn_subagents` tool (blocking batch: 1–N briefs, parallel workers,
  every report returned by the one call); workers report back as summaries. Do
  model-owned workers pay at all?
- **spawn+facts** — plus an append-only bank of compiling lemmas (`add_fact` gate:
  compiles, sorry-free, axiom-clean) as the shared channel. vs spawn isolates the
  channel — the Danus claim (they changed orchestration and shared memory at once).
- **spawn+plan** — plus `plan_check`: the agent is prompted to plan, delegate
  subgoals to workers, and reiterate the plan on their feedback.
- **spawn+plan+facts** — contingent: only if plan and facts each earn their keep.

⇒ Analysis: does the model actually delegate (the observed discretion-collapse risk:
soft protocols get abandoned exactly on hard problems)? If it won't, fall back to the
**harness-owned pipeline**: the main agent only plans (`plan_check`), the harness
spawns a worker per subgoal, workers report back, and the main agent stitches the
proof together or replans — the scaffold end of the ownership axis.

**Block D — library: cross-problem amortization.** On the overall winner, against the
winner's own grid cell as the paired baseline. Motivated by the 0803 audit's §8: the
genuinely-unsolved FATE-X problems cluster on ~6 shared missing theories
(depth/CM/Gorenstein ×8, Nagata's UFD criterion, Pic/class groups,
descent/completion, dimension theory); per-problem agents rebuilt them in-run and died
at the cap, several thousand lines each, and seven problems share *verbatim* bespoke
depth/CM definitions, so one canonical copy transfers by `rfl`.

- **library** — a shared formalization phase before the graded run: the spawn+facts
  machinery pointed at the whole problem set instead of one problem. A librarian agent
  sees all 87 run-list statements (digest in prompt + a `get_problem` tool), identifies the
  shared missing theory, and spawns workers per cluster; everything enters through the
  existing `add_fact` gate (compiles against the bank, sorry-free, whitelist axioms,
  no metaprogramming), under one harness-enforced **$10 @std** phase cap — the
  builder, like every agent, is budget-blind. The frozen library (content-hashed;
  `library_sha` in every record) is baked into the REPL resident env for the graded
  run, so library names are ambient exactly like Mathlib names and the grader shares
  the env — one definition of compiles, preserved. Attempts are the winner config plus
  one prompt paragraph (the library exists, is verified, grades like Mathlib, source in
  library.lean); discovery rides the existing channels — the full source read-only in
  the work dir, `grep_mathlib` covering it alongside Mathlib — never a prompt dump.
  Guards: memo keys include the env identity; after freeze, every statement
  recompiles against the library env and its `benchmarkDecls` term must match the
  no-library env (instance leakage prunes); the library never grows during the graded
  run (solve-order independence, or the pairing dies). Fallback shipping if env-baking
  fights the REPL: pre-seed the attempts' facts bank with the library (prefix
  compilation exists today) and accept the self-containment copying cost. First arm
  whose outside information includes artifacts built from *other problems in the
  benchmark* — cross-problem persistent state, the axis under Danus's fact graph, and
  how real formalization campaigns behave; the unit of evaluation becomes the
  campaign, reported as such with the phase cost amortized (~10¢/problem).

⇒ Analysis: paired exact McNemar, library vs the winner's cell, on the 87.
Pre-registered: the effect concentrates in the audit's tier-B clusters (tier A moves
are budget luck, tier C shouldn't move — the tier table is the prediction). Library
usage is measured mechanically (library names quoted in accepted proofs); "the
library proved a statement outright" is reported, not banned — the librarian prompt
steers toward shared theory, the gate is the only hard rule.

**Off the hill-climb — triage: a feasibility judge, evaluated counterfactually.**
Does not touch the attempt harness, so it burns no block and can run against any
completed cell.

- **triage** — a per-problem judge: an agentic loop with the attempt arm's information
  tools (same search + `check_snippet`, no `lean_check`, no files) that ends by
  calling `submit_verdict(yes|no, reason)` — can this system prove this statement?
  Hardcap $0.15/problem, budget-blind like everything else, prompt deliberately
  minimal (no "scrutinize your no" instruction — whether quick verdicts are calibrated
  IS the measurement; the scrutiny-prompted variant is the follow-up cell if the "no"s
  are trigger-happy). The arm is never "run": its verdicts reweight an existing cell —
  two-stage solve rate = solves among yes over ALL 87, two-stage cost = judge on all +
  attempts on yes — so the cell costs only the judge phase. Economic case from the
  0804 pilots: solves cost $0.34 total while fails cost $3.57. Readout: the
  verdict × outcome confusion matrix against the reference cell (FN = solves the gate
  deleted, TN = the savings), the same matrix against the 0803 audit tiers (an
  existing human-verified ground truth), and the "no" reasons as an automated
  missing-theory map — which is exactly the cluster input the library phase wants; the
  arms compose. Motivated by both calibration failure modes on record: false-"false"
  early retirements (fatex_17, 85) and the correct $0.09 unprovability settlement
  (fatex_99). Judge runs twice on the pilot list; the verdict flip count is this arm's
  noise floor. Known degenerate mode: all-yes — the arm only earns its cell on a tier
  where spontaneous "no" verdicts actually occur, which FATE-X demonstrably is.

There is no separate "final FATE-X run" any more: FATE-X *is* the grid, so the
headroom number nobody publishes falls out of the grid itself. Signal exists — the
2026-08-04 machinery pilots solved 6/10 on the pilot list.

## Archive — not testing, and why

- **Mechanical injection of search results (0c)** — the "how does search enter" question
  got cut: the tool door is how real systems deploy retrieval, base vs ref already
  provides the search signal we need as a control, and a whole run to compare entry
  mechanics isn't worth a cell in this grid.
- **Draft file (`notes`)** — replaced by `snippet`. What agents demonstrably want is to
  *compile* scratch work, not to persist it; a draft file without compilation would test
  persistence, which none of the failure autopsies implicate. Folding persistence back
  in would also confound the snippet comparison.
- **Prompt-only derivation steering (`derive`)** — soft protocols collapse exactly on
  hard problems (observed directly: plan arms abandoned `plan_check` on every hard
  problem in the mini3 pilot). A steering line with no mechanism isn't a testable arm.
- **Prompted search moments (0b)** — a middle rung between "tool available" and
  "harness-injected"; under a fixed budget the endpoints answer the question and the
  middle adds a cell without changing any conclusion.
- **Output-cap enforcement crossing ({ref, facts} × 8k cap)** — the cap is leaky (many
  short turns still let the model chat-bash), so the manipulation measures compliance
  friction more than the mechanism; not worth two cells.
- **One-shot control** — known result, nothing to learn.
- **plan / replan as single-agent arms** — a plan without a consumer is prose: the dev
  pilots showed ~1.8× cost with zero solve gain, protocol adherence collapsed exactly
  on hard problems, and a thinking model already plans internally. Planning returns in
  block C, where the plan has a structural consumer — workers proving its subgoals.
  The standalone blank-context vetting call dies with it.
- **facts as a single-agent arm** — the bank's motivating use is as a shared channel
  between workers; whether trusted external memory helps a *single* agent is a
  separate question we de-prioritized to save a cell. The bank survives inside
  block C as spawn+facts.
- **Thinking off as an arm** — model knob, not a harness answer; the pilot showed
  thinking-on is same-or-better and cheaper, so the off cells buy nothing.
- **FATE-M and FATE-H as grid tiers** — both saturated (FATE-M by the baseline, 10/10;
  FATE-H by the ~08-02 model upgrade); smoke-test tiers only. **Putnam** stays the
  secondary anchor and the contingent grid benchmark if FATE-X floors (see Setup);
  **Formal Conjectures** is the reserve scale-up if effects land too small for n = 87
  to resolve.

## Runs so far

Dev phase (Putnam subsets: dev10/mid10/mini3/p100) established the harness, the
budget-cap regime, and that arm comparisons need mid-difficulty problems. FATE pilots
placed the tiers (FATE-M saturated, FATE-H then mid-range). The first full FATE-H pass
with thinking on scored **66/100** (66/99 scored) — a **cost-calibration run** on the
pre-upgrade model, not a grid cell. The 0802 FATE-X runs (semantic search; 51/95 with
the audit's scoring) produced the unsolved-problem audit that now sets FATE-X scoring
and the tier map (`drafts/DRAFT-fatex-unsolved-audit-0803.md`). The 2026-08-04 block-C
machinery pilots ran the FATE-X pilot10 list end to end on the post-upgrade model —
snippet 6/10 ($3.91), spawn 6/10 ($2.06; delegation appeared exactly on the hard
problems, all 17 workers completed and reported), spawn+facts 6/10 ($2.29) — the same
six solved and four unsolved in all three, zero discordant pairs, so this pilot list
cannot separate these arms on the post-upgrade model. Two behaviors worth the cells
they'll get: the facts agent used the bank only on hard problems and on fatex_72
spontaneously built a 22-fact, 26 KB verified bank before dying at the cap — the
block-D premise (per-problem theory-building that evaporates) enacted by the agent
itself; and fatex_99 axiom-gamed in both spawn runs at ~$0.08 (pre-axiom-gate code;
the in-loop gate closes that exit). Machinery validation, not grid cells (pre-freeze;
the spawn reports still leaked per-worker cost, removed since).
The 2026-08-05/06 block-A pair — grep 46/87 and semantic 44/87 on safe87, with 11
attempts of base before it was stopped — ran clean end to end and is the corpus every
harness fix of 08-07 was measured from (13,058 checks, 9,428 greps, 10,411 edits, 712
nudges). It is **not** a grid pair: the 08-07 freeze re-cut moved both what compiles and
what the agent sees, so those three cells are re-run against `f613554`. What they already
answered, and what the re-run should reproduce or contradict, is that the two retrieval
arms land within two problems of each other on this list while disagreeing about which
problems: 40 solved by both, 6 by grep alone, 4 by semantic alone — 10 discordant pairs,
which is the shape a list can separate arms on, unlike the 0804 pilot's zero. Details and autopsies: `drafts/DRAFT-experiment-notes-*.md`,
`drafts/DRAFT-100fates-collected-0728.md`; per-run artifacts under `results/`.

## Next steps

- [x] Remaining grader fixes; **grid freeze: `c736c5f` (re-cut 2026-08-07; supersedes
      `b6d312e` of 08-05, itself superseding `638f697` and `3084411`)** — the
      `harness_git_sha` of every grid run must be that commit or a descendant, and the
      lean server must report its `check_sha` (`79102c77840650c7`).

      **This re-cut DOES invalidate grid cells, unlike every previous one.** The three
      block-A cells that ran on 08-05/08-06 — `grep-fatex87-0805` (46/87, `134ee0f`),
      `semantic-fatex87-0805` (44/87, `04b4489`) and the 11 attempts of
      `base-fatex87-0805` (`187778c`, killed) — all sit on the old side and have to be
      re-run. Two independent reasons, either of which alone would be enough: what
      "compiles" means changed (`synthInstance.maxHeartbeats` now gets the declaration's
      whole allowance instead of Lean's default 20 000 — instance synthesis was the most
      common timeout site in those very cells, 1,448 of 4,049), and what the agent SEES
      changed on every axis at once (the check header, style lints off at source, the
      16 KB digest, grep's depth and ordering, the failed-edit region, LeanSearch retries).
      They remain the measurement corpus this re-cut was designed from — every number in
      the commits above is theirs — but they are not cells.

      What the re-cut takes in, on top of `b6d312e`: the deterministic check channel
      (`runner/render.js`, one renderer for every check tool, style lints off at source,
      errors absorb the cap and the header never does), the solved high-water mark
      (`runner/highwater.js`), the CPU fuse at 3600 s and the derived fuse/client-wait
      chain, one typeclass budget, the single check verdict (`runner/verdict.js`, so the
      header and the grader cannot disagree), `CHECK_SHA` (`runner/check-env.js`, so a
      server from an older checkout cannot silently serve a run), grep at depth 25 with
      name-matches-first ordering, and the agent-facing channel fixes in `f613554` and
      `e4a9913`.
      From `b6d312e` it still carries the block-C machinery (`spawn_subagents` + the
      `add_fact` bank), the in-loop axiom gate, budget-blind spawn reports, the
      library-phase and triage plumbing, `grep_mathlib`'s Mathlib read access, the
      class/structure-field statement check, and the safe87 run list.

      Launching against this freeze requires a lean server started from it: `run.js`
      refuses on a `check_sha` mismatch and names the fields that moved. Restart the
      watchdog's server after pulling.
      Re-cutting before a grid cell runs means
      updating the SHA here; re-cutting mid-grid means re-freezing and saying so. What each
      re-cut invalidates is stated in the commit that makes it; the 2026-07-31 model
      boundary does not move the freeze but cuts run comparability the same way. The
      cost-calibration run predates every freeze, which is why it isn't a grid cell.
      Settled here so they are not relitigated: `max_nudges` stays 3 — re-examined
      2026-08-07 against the two block-A cells, where it is what ENDS ~20% of attempts
      (15 grep, 22 semantic, every one of them with budget left, median ~$0.25 of $1.00),
      and held anyway on the older and stronger evidence that across 12 runs and three
      benchmarks, 0 of 50 attempts that ever reached three consecutive refusals went on
      to solve; the per-problem budget stays $1.00 @std, with the tail it clips recorded
      rather than removed (solved attempts p50 $0.14, p90 $0.63, max $1.001; 24-30% of
      attempts hit the cap and they consume 52-61% of a cell's spend, so raising it is a
      cost decision that can be taken later without changing any other number); grep returns exact qualified-name matches only, never
      near-miss leads; loogle results ARE filtered against our environment while
      semantic's are not — the same question priced at different measured skews (9.5%
      vs 0.2%), decided the same way both times, cheapest-validity-first
      (`SEARCH.md` has both measurements); semantic results are not filtered (0.2%
      of the 11,698 distinct names LeanSearch returned in the 0727 runs do not exist
      in it — measured, and filtering would make the arm a curated LeanSearch rather
      than LeanSearch); Mathlib stays at PutnamBench's `v4.27.0` pin, 802 commits
      behind the `v4.28.0` that FATE itself targets — a documented divergence, not
      drift.
- [x] Implement `grep_mathlib` + FATE-M smoke (2/2, tool-path probes green).
- [x] Implement `loogle_mathlib` (public API + environment filter; skew measured, probe
      suite green) + FATE-M smoke.
- [x] Re-cut the grid freeze before block A (2026-08-05): the block-C machinery, the
      in-loop axiom gate, the budget-blind spawn reports and the library/triage plumbing
      all land after `3084411` — the new freeze SHA is pinned in the first Next-steps
      item above. (The ~08-02 model upgrade cuts comparability of every earlier run on
      top, without moving any freeze.) `COSTS.md` re-costed for the FATE-X grid at the
      post-upgrade pilot rates (~$0.21–0.39/problem/run).
- [ ] **Block A runs** (FATE-X, `problems-fatex/safe87.txt`, n = 87): base, semantic,
      grep, loogle → repeat the winner (noise floor). Launcher:
      `scripts/blockA-fatex87.sh <arm> [cut]` — one arm per invocation, sequential, so
      the account-wide `billed_usd` delta stays attributable to a single cell; it
      detaches into its own tmux session, so a cell never depends on the terminal or the
      Claude session that launched it. Launcher and `COSTS.md` retargeted to safe87
      (2026-08-05): the per-cell ceiling drops to 87 × $1 = $87 and the expected cell to
      ~$23.
      **Order as run: grep (launched 2026-08-05 16:23), then semantic, then base,
      then loogle.** Grep first because the autopsies most implicate it
      (confirmation-retrieval: 398 unknown-identifier errors across 193 hallucinated
      names in one attempt) and it was the newest code, so it was the cell most worth
      seeing early. Semantic second by decision on the day; it makes cell two the
      grep-vs-semantic contrast — the discovery-vs-confirmation question the block is
      actually about — rather than the effect-size ruler. **Consequence to hold onto:
      the Setup section's open decision (does FATE-X floor or saturate the arms?) is
      answered by base, so it now waits for cell three.** Grep's own solve rate is a
      one-sided hint at best: a high number could be the arm working or the tier being
      easy, and only base separates those.
- [x] Implement `check_snippet` (smoked via scripted probes incl. timeout/memo paths;
      FATE-M arm smoke still cheap to add before the Block B run).
- [ ] **Block B run**: snippet on the winning search → substitution analysis
      (per-problem search-call counts vs block A); contingent no-search+snippet run
      if search usage collapses.
- [ ] Write the fair-comparison rationale (which post-hoc readout: solve-vs-token
      curves, matched dollars, cost-per-solve) *before* full-grid numbers exist.
- [x] **How compiler output reaches the agent — landed as the default, 2026-08-07**
      (`runner/render.js`; SKELETON.md "What a check LOOKS like" is the design of
      record). Not run as an arm in the end: **every block-A cell reruns anyway** on
      this re-cut, so there is no split channel to protect and no cell to spend — the
      old channel simply stops existing. What shipped, against the options below:
      (a) and (d) together, plus (b) as a companion — header line stating the error
      count and every sorry's line number, then errors → sorries → warnings; the eight
      style linters off at source in `prepare()` (`linter.deprecated` and
      `linter.dupNamespace` deliberately kept); identical messages deduped to one plus
      their locator list; the heartbeat note once per check instead of once per message
      (3,991 copies, 1.72 MB across the two cells); cap raised 8 KB → 16 KB; the full
      uncapped output written to `.check/last.txt` every check with the header pointing
      at it; and, when the cap does bind, the ERROR section absorbs the cut, never the
      sorries. (c) was designed and rejected as too much machinery for the gain.
      Replaying the 13,058 recorded checks (`scripts/render-replay.mjs`): 1,495
      truncations → 0, 175 checks that lost every sorry goal → 0, 39.2 MB → 25.1 MB of
      agent-visible text. Invariants probed Lean-free in `scripts/probe-render.mjs`;
      `maxErrors` was tested and does NOT work in our path (it lives in the CLI's
      reportMessages, not the REPL's message harvest — `set_option maxErrors 1` on a
      3-error file returns all 3). Lean's `pp.deepTerms.threshold` DOES shrink big goals
      (840 → 120 bytes on a probe) and is left alone on purpose: unlike lint
      suppression it removes information the agent may need, so it is a knob for later,
      chosen from replayed real checks rather than guessed.
      The original entry, kept for the reasoning:
      Today the check result is one blob capped at 8000 chars
      (`render()` in `lean-server.js`, `renderWithoutProbe()` in `stmt.js`), assembled
      warnings-first and **sorries last, so the cap eats the sorries first**. Measured
      on the first two block-A cells: **675/5689 checks truncated in grep (12%),
      820/7369 in semantic (11%)**; one fatex_19 check spent its whole allowance on 78
      repetitions of the same `unnecessarySeqFocus` lint. It is *not* currently a
      correctness bug and should not be filed as one: the supervisor's done-gate reads
      the structured `check.sorries`, never the rendered text, and 0 of the 42
      `uses_sorry` attempts across both cells ended on a clean-looking truncated check.
      What it plausibly costs is turns — an agent re-reading a wall of lint it cannot
      see past. Options, cheapest first: (a) print sorries BEFORE the warning dump, so
      the one thing that decides "am I done" always survives the cap; (b) write the full
      output to a file in the work dir and show a digest plus a pointer, letting the
      agent choose what to page in; (c) parse and summarize — dedupe repeated lint
      classes, rank by severity, keep every error and elide the 78th copy of a style
      note; (d) **cheapest of all — stop emitting the style noise.** What fills the
      truncated checks is almost entirely default linters: `unusedSimpArgs` (6540
      occurrences), `unnecessarySimpa` (2921), `unusedVariables` (825),
      `unnecessarySeqFocus` (766). `prepare()` already injects `set_option
      maxHeartbeats` into every submitted file, so it can inject
      `set_option linter.unusedSimpArgs false` and friends the same way. None of them
      can change a verdict — they are style advice, not errors — so this is pure signal
      recovery. Note the cut itself is a blunt prefix slice
      (`pretty.slice(0, 8000)`), not a sample: the tail is simply gone, and sorries
      live in the tail. Why this is an **arm and not a harness fix**: it changes what every agent
      sees on every check, so landing it silently mid-grid would split a cell across two
      observation channels. It needs its own cell and a freeze re-cut, and it belongs
      after block A at the earliest.
- [x] **Solved high-water mark** — landed 2026-08-07 (`runner/highwater.js`;
      `SKELETON.md` has the record shape). `verifiedDone()` is now the single definition
      of the done-gate, read by both the supervisor's stop-nudging test and the
      watermark; `lean_check` snapshots the bytes at every green check (in the tool, not
      in the supervisor — the supervisor only sees `agent_end`, so a proof made and
      wrecked inside one turn would be invisible); the runner grades both snapshots into
      a separate `high_water` field, and `summary.json` reports `ever_solved` /
      `lost_proofs` beside `solved` without folding them in.
      **The corpus-wide scan says the expectation below was right.**
      `scripts/highwater-scan.mjs` reconstructs the mark for the 759 attempts recorded
      before this by replaying every write/edit and checking the result against the md5
      each check prints (53418/53419 exact). 472 attempts (62%) reached a verified
      proof; 213 of them kept editing afterwards; **all 213 got back to a green check —
      none shipped bytes it had not re-verified.** The 8 that reached a proof and graded
      unsolved are all harness-era artefacts, not self-destruction: 5 `bad_axioms` from
      before the axiom gate joined the agent-facing check (0804), 1 `compile_error` from
      the pre-0801 CPU budget (`fateh_32`), and `fatex_19` twice on the RSS fuse. What
      the scan does show is the by-product: **cost at first proof is 92% of cost at
      attempt end** — 8% of all spend happens after the problem is already solved.
      Original entry follows.
- [ ] **Solved high-water mark** (recording only — can land mid-grid). An attempt can
      reach a verified solve and then wreck it: the agent decides to simplify or
      refactor, and the budget SIGKILL catches the file mid-edit, so the FINAL file —
      the only thing graded today — misjudges what the attempt achieved. Record it
      instead of trusting the last write: when a `lean_check` passes the same gate the
      supervisor's done-test uses (compiles, zero sorries, statement intact, axioms
      clean — `extensions/supervisor.ts`), snapshot `problem.lean` beside the attempt
      and stamp the record with the check index, turn, and cost_std at that moment.
      **The headline metric does not move**: `solved` stays the verdict on the final
      file, and the snapshot verdict is a SEPARATE field, so the gap between "ever had
      a proof" and "ended with one" becomes measurable instead of invisible. Changing
      the metric itself mid-grid would invalidate the cells already run; recording a new
      field costs nothing and no agent can see it.
      Measured before building it, so the expectation is honest: across both block-A
      cells (174 attempts) **zero** agents destroyed a solve they had reached. The one
      candidate, `fatex_19` in grep, reached a verified proof at check 131/138 ($0.9309
      of $0.9636) and lost it to the RSS fuse, not to itself — and regraded `solved` on
      2026-08-06. So this is insurance against a failure mode that has not yet cost a
      solve, plus the by-product that matters for cost-vs-solve-rate: **cost at first
      proof**, which is not the same number as cost at attempt end (fatex_19 spent its
      last 3% silencing linters it did not need to silence).
- [x] Block C machinery (2026-08-04, `SKELETON.md` has the arm designs of record):
      `spawn_subagents` as a blocking batch of parallel child-pi workers with
      child-usage roll-up (runner tails worker sessions; budget binds the sum; workers
      get `check_snippet` + search, not `lean_check`); `add_fact` bank behind the
      compile gate (stricter-than-grading lexical rejects; bank in scope for
      `check_snippet`, never for `problem.lean`); `delegate.prompt.md` rider for
      spawn+plan. Sandbox rework dissolved: workers have no file tools at all, and
      their dirs sit outside the parent's sandbox root, so reports are the only
      channel. Smoked: 13 scripted gate probes green, one live worker round-trip
      (report + shared-bank write + accounting), one live parent batch (2 parallel
      workers, reports in-context, ledger current).
- [ ] **Block C runs**: spawn, spawn+facts, spawn+plan; contingent spawn+plan+facts;
      delegation analysis → harness-owned pipeline fallback if the model won't
      delegate.
- [x] Library-phase plumbing (2026-08-04, `SKELETON.md` has the designs of record):
      librarian launcher (`runner/library.js` — all statements inline, no fetch tools;
      workers via `runner/spawn.js` with harness-side per-worker caps), library freeze
      + `library_sha`, REPL env baking (`CMP_LIB_FILE`; sha in /health and in every
      memo key; `run.js --library` refuses mismatched envs both ways, `regrade.js`
      likewise), statement-drift recheck (`runner/drift-check.js` — verified 0-drift
      on a baked test server). Smoked end to end on FATE-M (2026-08-04): phase (librarian +
      worker, one legitimate compile rejection) → freeze → bake → drift-check clean →
      dry cell solved via a library lemma by name, `library_sha` in the record. The
      smoke also caught and fixed the benchmark-name collision (librarian pre-proved
      the targets under their exact names; drift-check refused the env; now rejected
      at the add_fact gate — statement names are reserved).
- [ ] **Block D run**: library phase ($10 cap) → library cell, paired vs the winner's
      cell; tier-concentration readout; report amortized.
- [x] Triage plumbing (2026-08-04): `submit_verdict` (terminates the session; a
      content-free resubmit reminder, max 3) + `runner/triage.js` (generous
      `--cap-std`, default 0.50 — calibrate after the pilot; no-verdict = excluded,
      engineered to be rare) + `runner/triage-join.js` (confusion matrix + two-stage
      readout; exclusions printed next to every headline). Piloted on FATE-M: quick
      verdicts (4–5 turns, ~$0.002), clean terminate, zero reminders, join verified
      against a real cell.
- [ ] Triage runs: judge twice on pilot10 (verdict flips = noise floor, cap
      calibration), then the 87 (~$10–15) against the winner's cell and the audit
      tiers.
- [ ] Post-hoc sweep of event logs for emergent behaviours (scratch strategies,
      degenerate loops, give-up patterns, best-state destruction) — feeds the writeup,
      no re-running.
