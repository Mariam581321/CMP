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

- **Benchmark: FATE-H** — 100 graduate-level algebra problems, eval-only (dev iteration
  happens on FATE-M + Putnam mid-problems, never on FATE-H). fateh_78 is annotated out
  of scoring: the formalization is false as stated (machine-checked refutation —
  `drafts/DRAFT-fateh78-broken-statement-0727.md`).
- **Model: DeepSeek V4 Flash, thinking on, always.** Thinking is a model knob, not a
  harness answer, so it is fixed config rather than an arm; the on/off pilot on a shared
  20-problem set showed thinking-on solves the same or slightly more while being cheaper
  and faster. All results are conditional on a reasoning model — the deployment norm —
  and explicit scaffolding competing with internal reasoning is part of what's measured.
- **Progressive baseline (hill-climb).** The experiments run in sequential blocks;
  each block's winner becomes the base configuration for the next. Search is decided
  first — every realistic system ships retrieval, and later arms should stack on the
  better version of it. Comparisons are clean *within* a block; cross-block
  attributions are conditional on the chosen path, and are reported that way.
- **Metric:** proof accepted sorry-free by the Lean compiler within the shared 120 s
  check budget — one budget for agent, supervisor, and grader, so a solve is always
  observable inside the agent's own loop; the grader's verdict is a fresh compile.
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

- **base** — no search. The floor and effect-size ruler.
- **semantic** (`lean-search`) — natural-language semantic search over Mathlib.
- **grep** — exact/substring/regex search over Mathlib declaration names and
  signatures. The autopsies say agents often need *confirmation of a name they can
  nearly guess*, not discovery: one attempt produced 398 unknown-identifier errors
  across 193 hallucinated lemma names; another made 127 semantic searches and wrongly
  concluded an API was absent. Semantic vs grep separates discovery-retrieval from
  confirmation-retrieval.

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

- **spawn** — a `spawn_subagent` tool; workers report back as summaries. Do
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

**Final (if time allows) — FATE-X with the best-performing combination.** The hardest
tier (PhD-level). Pilot on 10 problems first and drop the idea near 0 solves; a full
run only if there's signal. The headroom number nobody publishes.

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
- **FATE-M as grid tier** — saturated by the baseline (10/10); smoke-test tier only.
  **Putnam** stays a secondary anchor; **Formal Conjectures** is the reserve scale-up
  if effects land too small for n≈100 to resolve.

## Runs so far

Dev phase (Putnam subsets: dev10/mid10/mini3/p100) established the harness, the
budget-cap regime, and that arm comparisons need mid-difficulty problems. FATE pilots
placed the tiers (FATE-M saturated, FATE-H mid-range). The first full FATE-H pass with
thinking on scored **66/100** (66/99 scored) — a **cost-calibration run**, not a grid
cell: the harness still changes before the freeze (lean_check prompt clarification,
possible grader fixes), so all block-A runs start fresh after it. Details and autopsies:
`drafts/DRAFT-experiment-notes-*.md`, `drafts/DRAFT-100fates-collected-0728.md`;
per-run artifacts under `results/`.

## Next steps

- [x] Remaining grader fixes; **FROZEN 2026-07-29 at `2f89a7c`, re-cut 2026-07-30 at
      `d66e12e`** — the grid freeze is `d66e12e`: harness_git_sha of every grid run
      must be that commit or a descendant. Edit here if anything has to change
      mid-grid and re-freeze. The calibration run predates both freezes, which is why
      it isn't a grid cell.
      Why re-cut: the first block-A cell launched at `2f89a7c` (lean-grep, 50 FATE-H)
      was destroyed by a DeepSeek uplink outage, and that harness could only flag a
      provider error when an attempt made zero tool calls — so an outage landing
      mid-proof was graded on whatever it left on disk and printed as a clean 21/46.
      `d66e12e` makes infrastructure noise separable from results (error counts per
      attempt, a trust cutoff that marks an attempt rerun-not-result, a kill on a dead
      link) — no arm semantics changed, so the block design is untouched. The 0729
      grep attempt is discarded, not a cell: `results/_archive/provider-error-0729/`.
- [x] Implement `grep_mathlib` + FATE-M smoke (2/2, tool-path probes green).
- [ ] **Block A runs**: base, semantic, grep → repeat the winner (noise floor).
- [x] Implement `check_snippet` (smoked via scripted probes incl. timeout/memo paths;
      FATE-M arm smoke still cheap to add before the Block B run).
- [ ] **Block B run**: snippet on the winning search → substitution analysis
      (per-problem search-call counts vs block A); contingent no-search+snippet run
      if search usage collapses.
- [ ] Write the fair-comparison rationale (which post-hoc readout: solve-vs-token
      curves, matched dollars, cost-per-solve) *before* full-grid numbers exist.
- [ ] Sandbox rework for workers; `spawn_subagent` with child-usage roll-up (workers
      get `check_snippet` + search, not `lean_check`); `facts` bank; plan integration.
- [ ] **Block C runs**: spawn, spawn+facts, spawn+plan; contingent spawn+plan+facts;
      delegation analysis → harness-owned pipeline fallback if the model won't
      delegate.
- [ ] FATE-X: compile check under our toolchain pin → 10-problem pilot → full run with
      the overall winner.
- [ ] Post-hoc sweep of event logs for emergent behaviours (scratch strategies,
      degenerate loops, give-up patterns, best-state destruction) — feeds the writeup,
      no re-running.
