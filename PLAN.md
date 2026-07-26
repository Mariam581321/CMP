# Plan: which harness features actually matter for Lean theorem proving?

## Motivation

Papers in this space propose a whole architecture as a package — a model, a loop, a
subagent scheme, a search graph — evaluated end-to-end. That makes it hard to tell which
component carries the performance. We want a controlled, factorial answer: fix one
harness ([pi](https://github.com/earendil-works/pi), cloned in `pi/`), express each
design choice as a toggleable extension, and measure what each one moves.

Implementation architecture (how an attempt runs, grading, tooling) lives in
`SKELETON.md`. Reference papers and benchmarks in `papers/INDEX.md`.

## The framework

We can view every harness architecture as a set of answers to three questions, asked at
each model call:

1. What context goes into the call?
2. How are the calls arranged?
3. What information exists outside the weights?

These are a **basis**: each harness design ("arm") is a vector of answers. To compare, we
change one answer at a time and isolate which choice moved the needle.

### 1. Context — what does this call see?

Every agent is a feedback loop; we care about decisions on that feedback.

- **Compactification:** when something is kept, is it raw (append everything) or
  compressed (a structured summary, e.g. a failure diagnosis instead of the failed
  attempt)?
- **Isolation:** does the call see the whole problem or only a piece? (This is what
  defines a subagent.)
- **Injection:** what is put in besides history — instructions, the plan, search results,
  another call's output? Influenced by question 3 (what *exists*); here we decide what
  gets injected.

Degenerate answer (our baseline): append everything until overflow, then auto-compact
(pi's default). Constant across every arm, so it doesn't confound comparisons.

### 2. Calls — how are they arranged?

- **Shape:** one thread with feedback, parallel samples, or a tree; where does compute
  branch?
- **Budget:** how are tokens/retries/time split across call types? Touches comparison
  fairness — some designs need more compute to pay off.
- **Owner:** who writes the call graph — a harness script (model can't opt out) or the
  model at runtime (tools it may ignore)? The model ignoring instructions can be good or
  bad, and it affects comparison: if we give a planning tool and it's never used, how do
  we measure the impact?

### 3. Outside information — what enters from beyond the weights?

- **Sources:** compiler errors, goal states, library search, a verified-facts collection,
  progress from a previous run (matters for pass@n, n>1), NL statements/proof hints,
  blank-context LLM judges/subagents.
- **Force:** does the answer gate control flow (a failed check changes what happens next)
  or only inform the next call?

### Papers → vectors in this basis

| System | 1 Context | 2 Calls | 3 Outside info |
|---|---|---|---|
| AxProver-Base | managed memory (explicit compaction policy) | one thread | compiler + search |
| Goedel-Architect | transcripts never survive; per-lemma calls see lemma + declared parents; blueprint is the only persistent object | harness-owned; parallel per lemma; per-call-type budgets; outer refine loop | compiler + retrieval (+ optional NL proof); failed lemmas return structured diagnoses that gate replanning |
| Danus | fact graph is the shared state; workers see graph slices | model-owned, dynamic; parallel workers | LLM verifier (imperfect) gates writes to the graph |
| MerLean-Prover | informal plan (nodes + status) is the only shared object; one node, one objective per call; checks see outputs, not reasoning | harness-owned sequential recursion; plan is the unit of revision; decompose only nodes that failed | compiler + kernel audit + three blank-context LLM judges (math / split? / faithful?); all gate; no search |

## Experiments

**Reference arm.** `base` (iterate vs compiler) stays the anchor cell, but experiments 1
and 2 compare against `ref = base + lean-search`. Rationale: every realistic system ships
retrieval, and on a search-less base an arm can "win" merely by compensating for its
absence (e.g. `facts` hoarding lemma names the model had no way to look up). Stated
deliberately: experiment 2 therefore measures memory *on top of* retrieval, not instead
of it. base vs ref is not a headline claim — retrieval's usefulness is already published
(LeanSearch v2: 20% vs 4% on FATE-H around a fixed prover) — but it falls out free from
cells that run anyway, and serves as **positive control and effect-size ruler**: search
is the arm most likely to move the benchmark, so if base vs ref shows nothing, the
instrument can't detect anything subtler and the grid readout isn't trustworthy.

Experiments I would like to run:

0. how does search *enter* the loop — same information source, different doors: a tool
   the model calls when it wants (0a) vs the harness mechanically injecting results with
   no model choice (0c). The prompted middle rung (0b) is deferred: under a budget the
   endpoint contrast is the clean one.
1. add to ref an instruction to plan + a `plan_check` tool. compare:
   - re-plan phase based on information retrieval before proving;
   - subagents proving specific components of the plan — enforced by the harness vs a
     `spawn_agent` tool + refine plan based on subagent feedback (deferred with workers).
2. external memory on ref: where is the model's intermediate work allowed to live? By default it
   lives in the transcript — the worst possible place: unverified, lost at truncation and
   compaction, and some problems are very inviting to just start algebra-bashing in chat.
   Offer locations with better guarantees and vary how hard the harness pushes the model
   into them:
   - an instruction to derive inside `problem.lean` (`have` steps closed by tactics);
   - a free-form draft file — durable, unverified;
   - an append-only bank of compiler-verified lemmas — durable, trusted, monotone;
   - crossed with a tight per-response output cap that makes chat a lossy place to work
     *(crossing dropped 0726 — cut from the committed grid)*.
   In basis terms the rungs decompose the idea: the artifacts are question-1 changes
   (what survives into future calls' context), the bank's gate adds question-3 force (a
   compiler verdict gates writes to state — the "verified-facts collection" source), and
   the cap is a question-2 budget knob repurposed as enforcement. Extends to multiagent
   later: the bank is the natural shared channel between workers.

### Experiments → vectors

Same basis, one row per variant. `= base` means unchanged from the base row. Combo names
in parentheses where a variant is already implemented/planned (tool designs in
`SKELETON.md`).

| Variant | 1 Context | 2 Calls | 3 Outside info |
|---|---|---|---|
| base — iterate vs compiler | append everything, auto-compact | one thread, model-owned | compiler |
| **0 — how does search enter** | | | |
| 0a tool (lean-search) = **ref** | = base | = base | + search, model calls it when it wants |
| 0b tool + prompted moments *(deferred)* | + instruction saying when to search | = base | + search, model still calls it |
| 0c mechanical injection | harness puts top-k candidates into context at set points (e.g. per open goal) | = base | + search, harness calls it; model never asks |
| **1 — plan machinery (on ref)** | | | |
| 1 plan tool (plan) | + plan protocol text | = ref | + plan_check verdict, soft |
| 1a re-plan before proving (replan) | vet call is blank-context: skeleton + retrieved candidates only | fixed vet phase after each green plan | + forced per-helper retrieval; verdicts inform, don't gate |
| 1b-h workers, harness-owned | worker sees one helper + parent statements, nothing else | harness spawns a worker per open helper, per-worker budget; failures feed a replan step | worker verdict/diagnosis gates replanning |
| 1b-t workers, model-owned | same worker contexts | model gets `spawn_agent`, decides when (maybe never) | worker summaries inform the main agent |
| **2 — external memory (on ref)** | | | |
| 2 in-file (derive) *(optional rider)* | steering instruction only: derivations become `have` steps in problem.lean, not chat prose | = ref | compiler verifies them via lean_check; nothing enforces the style |
| 2 draft file (notes) | + notes.md beside the transcript: free-form scratch that survives turns and compaction; ordinary read/write | = ref | nothing — writes ungated by design |
| 2 fact bank (facts) | + facts.lean: append-only bank of verified lemmas; readable as a file, writable only through the gate | = ref | compiler gates every write (add_fact: compiles + sorry-free + axiom-clean); direct write/edit hard-blocked |
| 2 × cap ({ref, facts} × {uncapped, 8k}) *(dropped 0726)* | = cell | + 8k/response output cap: the per-call budget squeezed so long chat derivations get cut off | = cell |
| 2a workers → summaries | worker results come back as summaries in the main thread | main agent + workers | compiler-checked facts travel via the main agent |
| 2b workers → shared bank | the bank is the shared state; everyone reads it, nobody reads transcripts | main agent + workers | compiler gates writes; the bank is the channel |

*Note (2a/2b): rethink the file sandbox before building workers — it pins each pi process
to its own startup dir, so a worker in its own scratch dir can't read a bank in the main
agent's work/. Either spawn workers with cwd = the shared work dir, or add an explicit
read allowlist to `extensions/file-sandbox.ts`.*

What each comparison isolates:

- **0a vs 0c** — same information source, two doors in: 0c removes the model's choice
  entirely and is the only question-1 change (injected context, not a tool). Does search
  help because the model asks well, or would it help more if it didn't have to ask?
  mini3 says the model *does* ask when stuck (search_mathlib pulled hardest on the hard
  problems), so the live question is whether harness timing beats model timing. 0b (the
  prompted middle rung) is deferred; **base vs 0a** is the free positive control, not a
  finding.
- **1b-h vs 1b-t** — identical worker machinery, only the owner of the call graph differs.
  The cleanest scaffold-vs-discretion pair (mid10 already showed discretion can collapse:
  plan_check ignored under pressure). A fully scripted pipeline — harness owns every
  phase — is the far end of this axis, kept as a later option.
- **ref+plan vs ref+replan** — scaffold vs discretion for retrieval-informed planning:
  with search ambient on ref, a plan agent *may* vet its skeleton against Mathlib but
  nothing makes it (and its judgment is in-context, already committed to its own plan);
  replan forces the vet, blank-context. Tie ⇒ the forced loop is redundant with tool
  access; win ⇒ the scaffold/blank-context independence itself carries weight. (The old
  three-way `plan`+`lean-search` vs `plan`+`replan` vs all-three collapses to this pair
  now that search is in ref.)
- **1a vs 1b** — revise the plan on *retrieval* evidence before proving vs on *worker
  failure* evidence during proving. Both feed the plan; the trigger differs.
- **ref vs derive** *(optional rider — prompt-only, cheap; not in the committed grid)* —
  the pure-instruction door: does merely asking for checkable
  derivations move anything, and does adherence survive difficulty? mini3 predicts
  collapse — soft protocols were abandoned exactly on the hard problems.
- **notes vs facts** (both on ref) — durability held constant, verification varied: is
  external memory
  useful because it *persists* (question 1) or because it's *trusted* (question 3)?
  notes is all persistence and no trust; facts is both, at the price of machinery.
- **{ref, facts} × {uncapped, 8k}** *(dropped 2026-07-26 — cut from the committed grid;
  kept here as design-space record)* — the enforcement interaction, and the only
  question-2 manipulation in this experiment. The cap alone punishes chat-bashing with
  no escape route (the dev-era truncation failures); the bank alone can be ignored.
  Claim under test: mechanical pressure pays only when there is a sanctioned place to
  push the work into — a positive interaction term. The cap is leaky (many short turns
  can still bash), so expect attenuation, not on/off. Capped cells carry a truthful
  one-line cap notice in the prompt; uncapped cells carry nothing.
- **2a vs 2b** — where verified knowledge lives: threaded through the coordinator's
  transcript vs kept in shared external state (Danus §4.4 claims only the second makes
  parallel work additive).

### The committed grid (final-result experiments)

Three headline experiments; every comparison is paired (same problems, exact McNemar).
Workers (1b) and 2a/2b stay deferred; `derive` and 0b are optional riders. The output-cap
enforcement crossing ({ref, facts} × {uncapped, 8k}) was cut on 2026-07-26 — not worth
two cells for a leaky manipulation.

- **E0 — retrieval's door: 0a (ref) vs 0c.** Model-directed vs harness-directed entry of
  the same information. base (run **twice**) anchors it: base-vs-base discordance is the
  noise floor, base vs ref the positive control / effect-size ruler.
- **E1 — plan machinery: ref vs ref+plan vs ref+replan.** Does a plan artifact pay at
  all, and does a forced blank-context vet beat discretionary tool access
  (scaffold vs discretion).
- **E2 — external memory: ref vs ref+notes vs ref+facts.** Persistence vs trust,
  on top of retrieval.

Distinct runs: base ×2, ref, 0c, plan, replan, notes, facts = **8 cells** ×
(#problems × avg cost/problem); see `COSTS.md` for the money/time estimate under the
budget-cap regime.

**Readout rule (fixed before seeing grid numbers).** Per comparison, exact McNemar on
discordant problems: significance at n≈100 needs wins ≈ 2×losses + 6 (6-0, 8-1, 10-2,
12-3 all cross p<.05). The duplicated base run calibrates how much discordance is pure
sampling churn; effects that don't clear the churn-adjusted bar are reported as
point estimates with the cost curves (the secondary endpoint — dev10 showed arms can
tie on solves while separating on cost and failure mix).

## Decided (protocol)

- **Benchmark:** FATE-H is the leading candidate for the grid (0725 pilots: FATE-M
  saturated at 10/10 → smoke-test tier only; FATE-H 3/10 = mid-range, and its timeout
  autopsy failure modes — retrieval starvation, long-horizon grind, scratch-state loss —
  are exactly the arms' claimed mechanisms; per-problem area tags in `FATE-H.json`
  enable exploratory per-area breakdowns, cells too small to test). Confirm with the
  full-tier baseline ×2 before committing. PutnamBench stays as secondary anchor:
  directly comparable to Goedel-Architect, topic breadth beyond algebra, and a pool big
  enough for disjoint dev/eval. Dev iteration happens on FATE-M + Putnam mid-problems;
  **FATE-H stays eval-only** (the tier is only #problems ≈ the grid size — any dev
  tuning on it contaminates the eval set). Formal Conjectures (solved+textbook) is the
  reserve scale-up if effects land small (+3–5pp) and n≈100 lacks power — needs a
  difficulty pilot and `answer(sorry)` grader support first. FATE-X: deprioritized,
  likely near-floor for this model.
- **Model:** DeepSeek V4 Flash — cheap enough for full-benchmark sweeps across combos.
- **Metric:** proof accepted by the Lean compiler (sorry-free), per problem.
- **No budget parity:** report *(solve rate, cost)* per combo, let the tradeoff be part
  of the result. Only a hard cap so runs terminate: per-problem cost_std budget
  ($1 @std default; peak-invariant), wall-clock only as a backstop for hangs and slow
  spenders (0725 fateh autopsy: spend correlates with being on track, time does not).
  Backstop = **6 h** (decided 2026-07-26; the 12 h-riders are the least hopeful failure
  class — the shorter backstop saves ~40% of grid wall-clock at no scientific cost).
- **Eval protocol:** each combo runs the dataset once (pass@1; pass@n open). Dev iterates
  on a fixed subset — the same subset for every combo, so dev comparisons stay fair.
- **Answer hygiene:** PutnamBench files leak answers (`_solution` comments,
  `informal/putnam.json`). The agent is served a *sanitized* file in an isolated
  workspace with no path to the benchmark repo.
- **Output cap:** DeepSeek's server-side 8k/response default is always overridden — every
  run sends an explicit model-max cap. A tight cap exists only as a manipulated factor
  (experiment 2's enforcement crossing), never as ambient config, and every cell's prompt
  states its true cap situation.

**Open task — what is the fair comparison between arms?** We keep no-budget-parity
(report solve rate *and* cost), but the honest post-hoc readout is undecided. Candidates:
solve-rate-vs-token-budget curves (Goedel-Architect Fig. 3 style, computable from
`events.jsonl` with no protocol change), matched wall-clock, matched dollars,
cost-per-solve. Each answers a different question and can flatter a different arm (worker
arms look better under wall-clock, minimal arms under tokens) — so the task is to argue
which question we're asking and write the rationale *before* seeing full-grid numbers.
Non-negotiable: arm prompts differ only in the manipulated instruction, and worker-style
arms report subprocess tokens into the parent's accounting.

Broader research questions that sit a level above this committed project — proof style,
creativity, autoformalization, Mathlib-search bottlenecks — live in `NOTES.md`.

## Experiment log

Dev-phase runs — all DeepSeek V4 Flash, thinking off, 20-min per-problem timeout unless
noted; per-run artifacts under `results/<run-id>/`, harness git SHA recorded per attempt.

- **`baseline-dev50`** — first baseline sweep over a ~50-problem dev list,
  2 h timeout. Interrupted by laptop sleep (an earlier attempt corrupted outright, in
  `results/_archive/`); 13 problems recorded, 5 solved. Motivated the smaller fixed
  subsets below.
- **`lean-plan-pilot1`** — 4-problem pilot of the plan arm: 2/4, $0.20. One
  failure was `statement_changed` (agent altered the theorem; caught by the grader) — the
  failure mode the `plan_check` statement-preservation check exists for.
- **`dev10-baseline-0717` / `dev10-lean-plan-0717`** — baseline vs plan on
  the 10-problem dev subset (`problems/dev.txt`). Both 2/10; plan cost ~1.8× ($0.47 vs
  $0.27). Failure mix shifted under plan: compile errors 2→0 but timeouts 3→5 — plan
  traded local iteration for slower, more structured attempts without (yet) converting
  more problems.
- **`mini3-{baseline,plan,search,plan-search}`** — first multi-arm
  comparison: baseline, plan, lean-search, plan+lean-search on 3 problems
  (`putnam_1998_b1`, `putnam_1983_b2`, `putnam_1973_b3`). **All four scored 1/3**
  (~$0.11–0.13 each): every arm solved `1998_b1` (86–243 s), every arm timed out on the
  other two. Tool-call logs confirm the arms genuinely differed (`plan_check` /
  `search_mathlib` calls present per combo), so the tie is real, not a wiring bug.
  - *Floor/ceiling:* one problem too easy, two too hard ⇒ zero discriminative power. Arm
    comparisons need mid-difficulty problems (ones baseline solves sometimes).
  - *Soft-plan adherence collapses under difficulty:* both plan arms called `plan_check`
    on the easy problem but **never** on either hard one — abandoning the protocol exactly
    where planning was meant to help. Direct evidence for the soft-vs-hard-gate tension in
    `plan` and the scaffold-vs-discretion comparison.
  - The search arm pulled `search_mathlib` hardest on the hard problems (9–10 calls) — the
    tool is at least demanded when the going gets tough.

See `drafts/DRAFT-experiment-notes-0717.md` for the full dev10/mid10 failure autopsy (FATE pilots: `drafts/DRAFT-experiment-notes-0725-fate.md`).

## Next steps

- [x] Fixed dev subset (10 problems, seed 42 → `problems/dev.txt`).
- [x] Sanitizer (strips NL docstrings by default; `problems-nl/` for the NL arm).
- [x] pi headless + DeepSeek + `lean_check` end-to-end; persistent lean server; grader.
- [x] `lean-search` — first arm implemented.
- [x] `plan` — `plan_check` = compiles + statement preserved + sorries only in helper
      lemmas; restatement similarity logged, plans snapshotted (SKELETON.md).
- [ ] Confirm the extension set.
- [x] Uncap output by default (model-max max_tokens sent explicitly on every run,
      baseline included; per-problem timeout now 1 h) and neutralize the baseline
      prompt — the tactic-first steering line is removed and reappears as `derive`'s
      addendum when that arm lands. Breaks comparability with the dev runs logged above.
- [ ] Implement `notes` (prompt-only arm); `derive` only as an optional rider if budget
      allows (out of the committed grid).
- [ ] Implement `facts` (gated `add_fact` + write-block — SKELETON § tool designs).
- [ ] Sweep event logs for emergent harness-interaction behaviours (post-hoc from
      `results/*/*/events.jsonl`, no re-running): tool misunderstandings, scratch
      strategies, degenerate loops, strategy pivots. Two catalogued so far:
      (a) scratch-file experimentation — baseline-p100/putnam_1967_a5 wrote
      `fix_segment.lean` expecting lean_check to compile it (it only ever checks
      problem.lean; grading-safe but burned confused turns) → candidate one-line
      prompt clarification at the next prompt revision, never mid-experiment;
      (b) check-spam loop — smoke-p100's 406 lean_check calls after a harness error
      said "try again" on a permanent fault (fixed, 079de6d): weak models comply
      literally with error-message advice, so error wording is harness design surface.
- [ ] Cost management — analyse from data once runs exist in the new regime (uncapped
      output × 1 h timeouts makes runaway attempts pricier): from time-to-solve and
      token distributions, decide whether attempts need a token/turn cap besides
      wall-clock, and where the timeout should really sit. Whatever cap we pick must be
      identical across arms — a short one systematically biases against structured arms
      (dev10: plan converted compile errors into timeouts).
      **Leading candidate (2026-07-25, Mariam): replace the wall-clock cap with a
      per-attempt budget cap denominated in cost_std** — every cell becomes an isocost
      comparison (what does each arm buy with $X?), immune to peak pricing, provider
      latency, and REPL queueing, and it equalizes arms that burn tokens at different
      wall rates (a parallel-subagent arm gets ~concurrency× the tokens under a time
      cap; a budget cap is symmetric). Keep a generous wall-clock backstop (3–4 h,
      infra-only — zero-token stalls consume no budget); enforcement = same live
      kill-switch pattern as the timeout, run.js already tracks cumulative usage.
      Set the number from p100's cost-at-solve distribution (late solves are the
      expensive ones — P99 + margin). Requirement for subagent arms: child usage must
      roll up into the parent attempt's ledger. Switch only at an experiment boundary
      (breaks comparability with p100 and earlier, like the uncap change did).
      p100 baseline evidence for the current regime: solves bimodal (8/11 < 20 min,
      3/11 in the last third, none between), timeouts work the full hour at median
      ~3.7k out-tok/min with median 0 nudges — the 1 h cap is binding, not slack.
- [ ] Implement `replan`.
- [ ] Full FATE-H baseline **×2** (all #problems): confirms the tier's solve rate, and
      base-vs-base discordance is the noise floor every McNemar readout needs. First
      spend of the new regime (cost_std cap + lean_check prompt clarification land at
      this boundary). ~2 × #problems × pilot rate.
- [ ] `lean_check` prompt clarification (only `problem.lean` is compiled) — all arms,
      at the same boundary; without it `notes`/`facts` win partly by fixing a
      documentation gap (fateh_22: 134/175 writes to an ignored side file).
- [ ] 0c (mechanical injection) — design the injection points (per open goal after
      each failed check?) + implement; the E0 counterpart to `lean-search`.
- [ ] Scaffold-vs-discretion: ref+plan vs ref+replan — see the committed-grid readouts.
- [ ] Arms on the dev subset (FATE-M + Putnam mid) for plumbing; then the committed
      grid (10 cells × #problems) on FATE-H.
- [x] simplify code (2026-07-26 refactor, one harness boundary — breaks comparability
      with all runs logged above, like the uncap change did):
      (a) the nudge loop moved in-process (`extensions/supervisor.ts`, one pi process
      + one session per attempt; runner keeps only hard kills; `STOP` file = clean
      per-attempt abort);
      (b) records split `end` (how the attempt ended) from `grade` (what the grader
      says about the final file) — verdicts are never overwritten again;
      (c) one shared `checkedCompile` client (`runner/stmt.js`) for lean_check +
      plan_check, so agent-facing checks can't drift from the grader;
      (d) plan_check's sorry placement now read from the environment probe (direct
      sorryAx reachability), line heuristics deleted;
      (e) `pi_version` recorded per run; strict CLI flags; peak-comparison machinery
      dropped (cost_std subsumes it — launch guard kept).
- [x] heuristics for server (same boundary): round-robin across clients, agent checks
      capped at 120 s REPL time (grader 480 s), watchdog timeouts typed
      (`check_timeout`) + memoized as deterministic per file + "simplify, don't
      retry" wording, `native_decide` pre-rejected client-side without compiling
      (banned anyway; each doomed attempt burned minutes of shared REPL).