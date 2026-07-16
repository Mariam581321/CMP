# Plan: Which harness features actually matter for Lean theorem proving?

Summer research project (Cambridge / G-Research), supervised. Topic: AI for formalizing
math in Lean, focused on **agent harness architecture** rather than models or prompting
tricks in isolation.

## Motivation

Papers in this space tend to propose a whole architecture as a package — a specific model,
loop structure, subagent scheme, search graph, etc. — evaluated end-to-end. That makes it
hard to tell which component actually carries the performance. We want a controlled,
factorial answer instead.

## Core idea

1. Fix a base agent harness ([pi](https://github.com/earendil-works/pi), cloned in `pi/`) —
   chosen because it's open source and has a clean extension system (custom tools, event
   interception, programmatic SDK).
2. Pick a small set of k harness **extensions** (e.g. subagents, semantic search, forced
   planning).
3. Run **all 2^k combinations** of extensions on a Lean benchmark and measure solve rate
   (proof compiles, no `sorry`), plus cost/tokens/turns.
4. Report which extensions (and which interactions between them) actually move the needle.

## Decided

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
- **Eval protocol:** each combination runs the full dataset **once** (no pass@n). During
  development we iterate on a fixed subset — the *same* subset for every combo, so dev
  comparisons stay fair.
- **Answer hygiene:** PutnamBench files leak answers — `_solution` abbrevs have the actual
  answer in a comment directly below the `sorry` (e.g. `lean4/src/putnam_1962_a2.lean`),
  and `informal/putnam.json` contains `informal_solution`. The runner must serve the agent
  a *sanitized* problem file (comments/solutions stripped) in an isolated workspace with no
  path to the benchmark repo.

## Architecture decomposition

The three reference systems (AxProver-Base, Goedel-Architect, Danus — see
`papers/INDEX.md`) are monolithic architectures and can't be compared as-is. But they
decompose into orthogonal primitives, and *those* fit our factorial design. Key
implementation insight: a pi extension's `execute()` is arbitrary code, so an arm can
encapsulate control flow (e.g. spawn a worker pi), not just add a tool — every arm
stays a `--combo` flag on the one harness.

1. **Iterate against the verifier** — the baseline loop (pi + `lean_check`), and the
   dominant factor in both prover papers. Decisions about the baseline:
   - Baseline tools stay read/edit/write + `lean_check`; hard cap = wall-clock timeout;
     nudge policy identical across arms.
   - pi's auto-compaction is ON by default (on context overflow it summarizes older
     messages, keeping ~20k recent tokens) — so the baseline silently contains a memory
     policy. Constant across arms, so it doesn't confound; a future `memory` arm would
     vary it (AxProver's second-biggest factor).
   - Iteration itself is silently assumed → add a cheap **one-shot control arm**
     (produce the proof in one response, one check) so primitive 1's value is measured,
     not assumed.
2. **Explicit plan artifact** → **`plan` arm** (Goedel-Architect's blueprint, minus
   parallelism): prompt variant + a `plan_check` tool. Agent must first produce a
   compiling skeleton of `sorry`'d helper lemmas above the theorem, then fill bodies;
   on repeated failure, revise the skeleton, not the local proof. Soft gate (tool +
   instructions, not hard enforcement) so we can *observe* planning rather than fight
   the model. Isolates "does a checkable plan artifact help?" — neither paper isolates it.
3. **Context-minimized sub-provers (workers)** — the shared ingredient of
   Goedel-Architect (per-lemma prover, sees only declared parents) and Danus (one claim
   at a time). Sketch: a `prove_lemma(statement, given_facts)` tool spawning a
   *constrained* worker pi (fixed prompt, lean_check only, hard budget, returns proof or
   a structured diagnosis — can't-close vs believe-false-because, Goedel's
   forfeit/negation channel). **Deferred**: design space too wide to pin down now
   (constrained vs free workers, context inheritance, budget accounting across
   subprocesses). Keep the description, think later.
4. **Verified fact store** → **`facts` arm** (Danus's fact-graph, minus workers):
   `submit_fact(lemma)` checks the lemma in isolation via the lean server and appends it
   to a bank only if green; `list_facts()` reads the bank back. Monotone, verified shared
   state — and in Lean the verifier is free (`lean_check` *is* Danus's stateless
   verifier, engineered for zero false positives at no cost to us). Final `problem.lean`
   must still be self-contained (grading unchanged). Expected to matter more once
   combined with workers; worth measuring alone first.
5. **Who owns the loop** — a *separate dimension*, not a combo: agent-owned (pi decides
   every step; all arms above) vs scripted pipeline (a deterministic driver calls the
   model in fixed roles, Goedel-style). Tested later as a paired arm — same prompts,
   tools, model, budget as an agentic arm, only the controller differs. One bespoke
   driver, built only after the combo arms exist. This is NOTES.md's "blackbox vs
   micromanaging" question made operational.

Paper → primitive mapping: AxProverBase ≈ 1 (+ context management); Goedel-Architect ≈
1+2+3 with a scripted loop; Danus ≈ 1+3+4 with an LLM planner. The papers become corners
of our grid instead of incomparable systems.

Comparison hygiene — **open task: what is the fair comparison between arms?** We keep
the no-budget-parity protocol (report solve rate *and* cost), but the honest post-hoc
readout is deliberately undecided and needs real thought before the full grid.
Candidates so far: solve-rate-vs-token-budget curves (Goedel-Architect Fig. 3 style,
computable from `events.jsonl` with no protocol change), matched wall-clock, matched
dollars, cost-per-solve. Each answers a different question and each can flatter a
different arm (e.g. worker arms look better under wall-clock, one-shot under tokens) —
so the task is to argue which question we're actually asking, pick the readout(s), and
write the rationale down *before* seeing full-grid numbers. Non-negotiable regardless
of readout: arm prompts differ only in the manipulated instruction, and worker-style
arms report subprocess tokens into the parent's accounting.

## Open questions

### Remaining extension candidates (beyond the decomposition above)
- **Semantic search** — running as `lean-search` (LeanSearch API); other semantic
  indexes worth trying as variants.
- **Symbolic search** — Loogle / `exact?` / `apply?` / `rw?`: type-directed lookup, a
  contrast arm to semantic search.
- **Interactive goal state** — persistent REPL tool showing goal state after each
  tactic, vs batch compile-and-report-errors.
- **Counterexample checking** — `plausible`/`slim_check` to falsify a candidate lemma
  before spending budget proving it (pairs naturally with `plan`/`facts`: vet skeleton
  lemmas early).
- Lower priority: scratchpad/notes (the `memory` arm), self-critic pass,
  error-message enrichment, mathlib docs lookup.

### Benchmark & model
- Which benchmark(s) beyond PutnamBench for the full grid / headline numbers — see
  `papers/INDEX.md` § Benchmarks. Known practicalities: Formal Conjectures' frozen
  subsets pin Lean 4.27 (matches our `lean-env` as-is); FATE HEAD pins 4.28 (needs an
  env bump or an older FATE tag).
- Dev subset: how many problems (~20–50?), sampled how (stratified by year/topic)?
- Cost estimate for the full grid: 2^k combos × 673 problems × avg tokens at DeepSeek
  pricing — before committing to k.
- Sanity-check that DeepSeek V4 Flash isn't so weak (or so strong) on the benchmark that
  the extension effects get floor/ceiling-compressed. Maybe a second model for robustness.
- Single run per combo means noise; with 673 problems the binomial error is tolerable
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
- [ ] Confirm the extension set with supervisors (proposal: `plan`, `facts`,
      `lean-search`, one-shot control; workers + who-owns-the-loop later).
- [ ] Implement `plan` and `facts` extensions + the one-shot control arm.
- [ ] Baseline + arms on the dev subset; then cost estimate (combos × 672 × avg tokens)
      → pick k for the full grid.
