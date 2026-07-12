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
- **Benchmark:** PutnamBench (cloned at `benchmarks/PutnamBench`). FATE also cloned for
  reference (`benchmarks/FATE`, from [frenzymath/FATE](https://github.com/frenzymath/FATE))
  — grad/PhD-level algebra, a possible later target.
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

## Open questions

### Which extensions? (the big one)
Candidates — need to pick ~3–4 and pin down designs:
- **Subagents** — liked, but the design space is wide: what does a subagent get spawned
  for (explore a proof branch? search mathlib? verify a lemma?), what context does it
  inherit, what does it return? One interesting implementation route:
  [pi-dynamic-workflows](https://github.com/michaelliv/pi-dynamic-workflows) (the agent
  authors its own multi-agent workflows). May want *multiple* subagent variants as
  separate arms (e.g. fixed-role spawner vs dynamic workflows).
- **Semantic search** — over mathlib (lemma retrieval). Embedding model / index choice,
  and how it compares to the grep-style search the base agent already has.
- **Symbolic search** — Loogle / `exact?` / `apply?` / `rw?`: type-directed lemma lookup.
  Cheap to expose as a tool, and a great contrast arm to *semantic* search.
- **Plan-first** — force an informal proof sketch before touching Lean. Cheapest to
  implement (system prompt or an enforced first tool call).
- **Proof decomposition** — a tool/protocol for stating intermediate lemmas as `sorry`
  stubs first, then filling each independently (draft-sketch-prove style; combines
  naturally with subagents: one subagent per stub).
- **Interactive goal state** — persistent Lean REPL tool showing the goal state after each
  tactic, vs. the baseline's batch compile-and-report-errors.
- **Counterexample checking** — expose `plausible`/`slim_check` so the agent can falsify a
  candidate lemma before wasting budget proving it.
- Lower priority: scratchpad/notes tool, self-critic pass before final submission,
  error-message enrichment, mathlib docs lookup, custom compaction for long attempts.

### What is the baseline?
- Which tools does the *bare* agent get? Minimum viable is probably: read/write files,
  a `lean_check` tool (compile + return errors), maybe bash. Everything else becomes an
  extension under test.
- What exactly the hard cap is (max turns? tokens? wall-clock?) and its value.

### Benchmark & model
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

- [ ] Decide the extension set with supervisors; sketch each extension's design in a page.
- [ ] Cost estimate: (combos × 673 problems × avg tokens) at DeepSeek pricing → pick k.
- [ ] Pick the fixed dev subset.
- [ ] Write the sanitizer for PutnamBench problem files.
- [ ] Get pi running headless with DeepSeek + a minimal `lean_check` tool on one problem
      end-to-end (the "hello world" of the whole setup).
