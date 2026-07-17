# Plan: Which harness features actually matter for Lean theorem proving?

## Motivation

Papers in this space tend to propose a whole architecture as a package — a specific model,
loop structure, subagent scheme, search graph, etc. — evaluated end-to-end. That makes it
hard to tell which component actually carries the performance. We want a controlled,
factorial answer instead.

## Core idea

1. Fix a base agent harness ([pi](https://github.com/earendil-works/pi), cloned in `pi/`) —
   chosen because it's open source and has a clean extension system (custom tools, event
   interception, programmatic SDK).
2. Pick a small set of k harness **extensions** (e.g. forced planning phase before proving, semantic search, memory component).
3. Run some of the **2^k combinations** of extensions on a Lean benchmark and measure solve rate
   (proof compiles, no `sorry`), plus cost/tokens/turns. Not the full grid: baseline + each
   extension alone + the combinations that sound like they should work well together.
4. Report which extensions (and which interactions between them) actually move the needle.

## Implementation details

- **Harness:** pi agent, extended via its extension API; driven headlessly via its SDK/RPC.
- **Model:** DeepSeek V4 Flash — cheap enough to afford full-benchmark runs across all
  extension combinations.
- **Benchmark:** open-ended. PutnamBench (cloned at `benchmarks/PutnamBench`) is the
  starting point for the first experiments — cheap, well-known, directly comparable to
  Goedel-Architect's numbers — not a commitment. Candidates for later phases are
  collected in `papers/INDEX.md` § Benchmarks (FATE, Formal Conjectures, …); which
  benchmark(s) carry the headline results is an open decision.
- **Success metric:** proof accepted by the Lean compiler (sorry-free), per problem.
- **No budget parity:** we don't equalize budgets across combos — we report *(solve rate,
  cost)* per combination and let the tradeoff be part of the result. Only a hard cap
  (max turns / tokens / wall-clock per problem) so runs terminate.
- **Eval protocol:** each combination runs the full dataset **once** (pass@1; whether
  pass@n is worth it is an open question). During
  development we iterate on a fixed subset — the *same* subset for every combo, so dev
  comparisons stay fair.
- **Answer hygiene:** PutnamBench files leak answers — `_solution` abbrevs have the actual
  answer in a comment directly below the `sorry` (e.g. `lean4/src/putnam_1962_a2.lean`),
  and `informal/putnam.json` contains `informal_solution`. The runner must serve the agent
  a *sanitized* problem file (comments/solutions stripped) in an isolated workspace with no
  path to the benchmark repo.

## Ideas for the extensions ("arms")

The three reference systems (AxProver-Base, Goedel-Architect, Danus — see
`papers/INDEX.md`) are monolithic architectures and can't be compared as-is. But they
decompose into orthogonal primitives, and *those* fit our factorial design. Key
implementation insight: a pi extension's `execute()` is arbitrary code, so an arm can
encapsulate control flow (e.g. spawn a worker pi), not just add a tool — every arm
stays a `--combo` flag on the one harness.

0. **Iterate against the verifier** — the baseline loop (pi + `lean_check`)
   - Baseline tools stay read/edit/write + `lean_check`; hard cap = wall-clock timeout.
   - pi's auto-compaction is ON by default (on context overflow it summarizes older
     messages, keeping ~20k recent tokens) — so the baseline silently contains a memory
     policy. Constant across arms, so it doesn't confound; a future `memory` arm would
     vary it.

1. **Explicit plan artifact** (inspired by Goedel-Architect's blueprint):
   the agent must first produce a compiling skeleton of `sorry`'d helper lemmas above the
   theorem, then fill the bodies; on repeated failure, revise the skeleton, not the local
   proof. Give the agent a `plan_check` tool. Alternatively, for a softer version, only
   prompt the agent to start with planning but don't reinforce it — *observe* planning
   rather than fight the model. Isolates "does a checkable plan artifact help?".

2. **Semantic search** — running as `lean-search`; the first arm actually implemented.
   A `search_mathlib(query)` tool backed by the LeanSearch API: natural language in,
   Mathlib lemmas out. The public endpoint now serves LeanSearch v2's *standard mode*,
   so we already query v2 — see `papers/INDEX.md` (the response's informal
   descriptions/kind fields aren't surfaced to the agent yet). Other semantic indexes
   are worth trying as variants.

3. **Re-plan** (inspired by LeanSearch v2's reasoning mode — see `papers/INDEX.md`) —
   an add-on to `plan` (1). The idea is to search Mathlib to get a sense of whether the
   plan needs revising. Concretely, we insert a loop into the planning phase: after a
   green `plan_check` of the proof sketch, a `vet_skeleton` step retrieves top-k Mathlib
   candidates per `sorry`'d helper lemma (LeanSearch called internally) and a
   *blank-context* vetting call labels each lemma's library support with a structured
   verdict (keep / flag / reroute, plus suggested premises). The main agent is instructed
   to consider revising the skeleton on flags before spending proof budget on bodies.
   I suspect this will help the agent find proofs that are naturally easier to formalize
   in Lean — in some sense we *look* for a proof, viewing Mathlib as puzzle pieces,
   instead of *building* one.

   **TODO — scaffold vs discretion (test after arms 2+3 exist):** `replan` is a
   *scaffolded* version of a behavior that `plan`+`lean-search` (1+2) merely *permits* —
   an agent with a search tool could vet each sorry'd helper against Mathlib itself
   before spending budget on bodies, but nothing makes it, and its judgment happens
   in-context, already committed to its own plan (replan's vetting is blank-context by
   design). The informative combos:
   - **1+2 (plan+search)** — discretion: retrieval available, agent decides if it ever
     informs the plan;
   - **1+3 (plan+replan)** — scaffold only: forced per-helper retrieval + blank-context
     verdicts after each green `plan_check`, no agent-facing search tool;
   - **1+2+3** — both, in case the two help through different channels (replan vets the
     decomposition; search helps fill bodies).
   Readout: 1+2 vs 1+3 is the cheapest pair answering "does forcing the vet loop beat
   leaving it to the agent"; 1+2+3 vs 1+2 isolates what the forced loop adds *on top of*
   tool access (tie ⇒ replan's machinery is redundant with discretion; win ⇒ the
   scaffold/blank-context independence itself carries weight). This mirrors the
   soft-vs-hard-gate choice already made for `plan` (stay soft, observe adherence) —
   same dimension, different arm.

4. **Verified fact store** (inspired by Danus's fact-graph, minus workers):
   `submit_fact(lemma)` checks the lemma in isolation via the lean server and appends it
   to a bank only if green; `list_facts()` reads the bank back. Monotone, verified shared
   state — and in Lean the verifier is free (`lean_check` plays the role of Danus's
   stateless verifier — theirs is an agent reasoning in NL to confirm a statement,
   engineered for zero false positives; the compiler gives us that for free).
   The final `problem.lean` must still be self-contained (grading unchanged).
   I expect this to matter more once combined with workers, or once the bank persists
   between runs for pass@n — still worth measuring alone first.

More ideas:

**Context-minimized sub-provers** — sketch: a `prove_lemma(statement, given_facts)` tool
spawning a *constrained* worker pi (fixed prompt, `lean_check` only, hard budget, returns
a proof or a structured diagnosis). I want to experiment with subagents, but the design
space is too wide to pin down now (constrained vs free workers, context inheritance,
budget accounting across subprocesses). For example, a subagent could itself be a pi
worker running a specified combination of the extensions defined above.

**Who owns the loop** — a *separate dimension*, not a combo: agent-owned (pi decides
every step; all arms above) vs scripted pipeline (a deterministic driver calls the
model in fixed roles). Tested later as a paired arm — same prompts, tools, model,
budget as an agentic arm, only the controller differs. One bespoke driver, built only
after the combo arms exist. This is NOTES.md's "blackbox vs micromanaging" question.

Paper → arm mapping: AxProverBase ≈ 0+2 (+ memory/context management); Goedel-Architect ≈
0+1+workers with a scripted loop; Danus ≈ 0+4+workers with an LLM planner; LeanSearch
v2's reasoning mode ≈ 1+3 built as a retrieval system rather than a prover. The papers
become corners of our grid instead of incomparable systems.

Comparison hygiene — **open task: what is the fair comparison between arms?** We keep
the no-budget-parity protocol (report solve rate *and* cost), but the honest post-hoc
readout is deliberately undecided and needs real thought before the full grid.
Candidates so far: solve-rate-vs-token-budget curves (Goedel-Architect Fig. 3 style,
computable from `events.jsonl` with no protocol change), matched wall-clock, matched
dollars, cost-per-solve. Each answers a different question and each can flatter a
different arm (e.g. worker arms look better under wall-clock, minimal arms under tokens) —
so the task is to argue which question we're actually asking, pick the readout(s), and
write the rationale down *before* seeing full-grid numbers. Non-negotiable regardless
of readout: arm prompts differ only in the manipulated instruction, and worker-style
arms report subprocess tokens into the parent's accounting.

## Remaining extension candidates (beyond the decomposition above)
- **Symbolic search** — Loogle / `exact?` / `apply?` / `rw?`: type-directed lookup, a
  contrast arm to semantic search.
- **Interactive goal state** — persistent REPL tool showing goal state after each
  tactic, vs batch compile-and-report-errors.
- **Counterexample checking** — `plausible`/`slim_check` to falsify a candidate lemma
  before spending budget proving it (pairs naturally with `plan`/`facts`: vet skeleton
  lemmas early).
- **Context management** — a memory component; try something different from pi's
  built-in auto-compaction.

## Open questions

### Benchmark & model
- Which benchmark(s) beyond PutnamBench for the full grid / headline numbers — see
  `papers/INDEX.md` § Benchmarks. Known practicalities: Formal Conjectures' frozen
  subsets pin Lean 4.27 (matches our `lean-env` as-is); FATE HEAD pins 4.28 (needs an
  env bump or an older FATE tag).
- Dev subset: how many problems (~20–50?), sampled how (stratified by year/topic)?
- Cost estimate for the full grid: combos × #problems × avg tokens at DeepSeek
  pricing — before committing to k.
- Sanity-check that DeepSeek V4 Flash isn't so weak (or so strong) on the benchmark that
  the extension effects get floor/ceiling-compressed. Maybe a second model for robustness.
- Single run per combo means noise; with a few hundred problems the binomial error is tolerable
  (~±2–4% at plausible solve rates), but worth stating in the writeup.

### Implementation questions
- Runner language: pi's SDK is TypeScript. Either write the runner in TS directly, or drive
  pi via RPC/JSON mode from Python. (TS runner is probably less friction.)
- Lean environment: toolchain + mathlib version pinned to what the benchmark expects; how
  the agent checks proofs (batch `lake` compile vs a persistent Lean REPL for speed).
- Isolation: each problem attempt in a fresh workspace/session; parallelism across problems.

## Moving pieces to build

1. `extensions/` — one pi extension per feature, independently toggleable.
2. Lean workspace setup — pinned toolchain + mathlib (match `benchmarks/PutnamBench/lean4`),
   **sanitized** problem files (solutions/comments stripped), a fast proof-checking entry
   point exposed to the agent as a tool.
3. Runner script — takes (extension combo, problem set, model, budget), runs the agent per
   problem via pi's SDK, records transcript + outcome + cost into a results store (sqlite or
   jsonl).
4. Analysis — solve rates per combo, per-extension main effects and interactions, cost
   breakdown.

## Next steps

- [x] Pick the fixed dev subset (10 problems, seed 42 → `problems/dev.txt`).
- [x] Write the sanitizer (now also strips NL docstrings by default; `problems-nl/` for
      the NL arm).
- [x] pi headless + DeepSeek + `lean_check` end-to-end; persistent lean server; grader.
- [x] `lean-search` arm (semantic search, arm 2) — the first arm implemented.
- [ ] Confirm the extension set
- [x] Implement `plan` (arm 1) — `plan_check` = compiles + statement preserved + sorries
      only in helper lemmas; restatement similarity logged, plans snapshotted (see
      SKELETON.md addendum for the fake-plan caveat)
- [ ] Implement `facts`
- [ ] Implement `replan`
- [ ] Scaffold-vs-discretion combos: 1+2 vs 1+3 (vs 1+2+3) — see the TODO under arm 3
- [ ] Baseline + arms on the dev subset; then cost estimate (combos × #problems × avg tokens)
      → pick k for the full grid.
