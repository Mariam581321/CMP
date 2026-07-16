# Papers

Local PDFs are gitignored — this index is the record. Each entry: link, local file, why it matters for CMP.

## A Minimal Agent for Automated Theorem Proving (AxProver)

- arXiv: https://arxiv.org/abs/2602.24273 · PDF: `axprover-minimal-agent-2602.24273.pdf`
- Code: https://github.com/Axiomatic-AI/ax-prover-base

Simple harness architecture; they focus on the memory and search tools/components.
The actual proving is still blackboxed — the harness doesn't tell the model to
recursively break down or sketch a plan. Their idea is to improve the memory or
search component individually. Search improves performance only slightly, so the
open question is whether the search tool is irrelevant or just not that good
(→ our lean-search arm probes exactly this, want to try different semantic searches as a tool here).

## Goedel-Architect: Streamlining Formal Theorem Proving with Blueprint Generation and Refinement

- arXiv: https://arxiv.org/abs/2606.06468 · PDF: `goedel-architect-2606.06468.pdf`

The blueprint idea: an initial DAG-sketch of lemmas/definitions with declared
dependencies, refined when lemmas fail — instead of recursive breaking down,
which tends to follow dead ends (trying to prove false sublemmas). Closer to how
people actually write Lean proofs. Also it actively exploits false sublemmas rather than dodging them: the prover proves the negation with a compiler-corroborated counterexample.

Checked: it has NOT been tested on graduate maths — evaluation is competition
benchmarks only (MiniF2F-test 99.2% pass@1, PutnamBench 75.6% pass@1, plus
IMO 2025, Putnam 2025, USAMO 2026; nothing FATE-like). So whether blueprints
survive graduate-level material is genuinely open. Note for us: their backbone
is DeepSeek-V4-Flash, and the reported costs are cheap enough to replicate and so their PutnamBench numbers will be
directly comparable to ours.

## Danus: Orchestrating Mathematical Reasoning Agents with Fact-Graph Memory

- arXiv: https://arxiv.org/abs/2607.06447 · PDF: `danus-fact-graph-2607.06447.pdf`
- Code: https://github.com/frenzymath/Danus

Not a prover — more a "research a difficult math problem and try to solve it"
system, evaluated on six research-level case studies (algebraic geometry,
singularity theory, combinatorics). Idea: parallel workers plus a main agent
that plans and redistributes tasks, and a fact-graph as the "objective truth"
(a stateless verifier gates claims before they enter the graph) — instead of a
blueprint that is refined. Open question for us: which part mattered,
the parallelism or the main-agent/worker subdivision? Should the main agent be given complete freedom to spawn a subagent or should it receive a description of a list of workers it has access to?

Caveats: the verifier is an LLM, not Lean — facts are informally verified (their §4.3
says its precision is the load-bearing assumption). In our Lean setting that verifier
is free and perfect. Also §4.4 partially answers the parallelism question: "simply
adding workers fails" when they share one blueprint; the fact graph is what makes
parallel work additive. Unablated: the main agent's contribution on its own.

## Cross-paper themes → CMP arms

- **Iteration against the verifier is the dominant factor** in both prover papers
  (AxProver's ablation says it outright; Goedel-Architect's initial blueprint solves
  only 29.8% and refinement lifts it to 75.6%). Everything else is a modifier on the
  loop → our baseline is primitive #1, plus a one-shot control arm so this isn't
  silently assumed.
- **Mapping to primitives** (PLAN.md): AxProverBase ≈ iterate + context management;
  Goedel-Architect ≈ iterate + plan artifact + per-lemma workers, scripted loop;
  Danus ≈ iterate + workers + verified fact store, LLM-owned loop. Our combos:
  `plan` (blueprint minus parallelism), `facts` (fact store minus workers), workers
  deferred, "who owns the loop" a separate dimension.
- **Complementary coverage**: AxProverBase tested on FATE/LeanCat (research-level) but
  has no plan/decomposition; Goedel-Architect has the plan machinery but competition
  benchmarks only. Nobody has both — relevant if we later target FATE.

# Benchmarks

Candidate problem sets beyond PutnamBench (which is the first-experiments target only —
the benchmark choice for the full grid is open, see PLAN.md). Each entry: link, local
PDF, and a verification note — checked whether these really are open-source formalized
problems we can use.

## FATE: A Formal Benchmark Series for Frontier Algebra of Multiple Difficulty Levels

- arXiv: https://arxiv.org/abs/2511.02872 · PDF: `fate-2511.02872.pdf`
- Data: https://github.com/frenzymath/FATE (MIT), cloned at `benchmarks/FATE` —
  FATE-M/H/X are git **submodules** (now initialized; a bare clone leaves them empty)
- Eval harness: https://github.com/frenzymath/FATE-Eval

**Verified usable:** real Lean files, one `sorry`'d theorem per file with an NL
docstring — same shape as PutnamBench, so our sanitizer/grader ports directly.
FATE-M 150 (textbook abstract algebra), FATE-H 100 (final-exam level), FATE-X 100
(PhD-qual and beyond; ships minimal extra definitions above the statement). Repo HEAD
pins Lean v4.28.0, one bump ahead of our 4.27 env. README warns against pooling the
three levels (different difficulty and formalization style).

## Formal Conjectures: An Open and Evolving Benchmark for Verified Discovery in Mathematics

- arXiv: https://arxiv.org/abs/2605.13171 · PDF: `formal-conjectures-2605.13171.pdf`
- Data: https://github.com/google-deepmind/formal-conjectures (Apache 2.0 / CC-BY)

**Verified usable (with a category caveat):** 2615 Lean 4 `sorry` statements, each
tagged `@[category]` (1029 research open, 836 research solved, 128 textbook, 467 test,
155 API) and AMS subject. Frozen subsets `FC100OpenSet1`/`FC100SolvedSet1` are pinned
at `bench-v1-lean4.27.0` — same Lean/mathlib as our `lean-env`, drops straight in.
Caveats for our ablations: the *open* set is a 0%-floor discovery benchmark (0% by
construction at release; even AlphaProof only reaches 45–50% on the *solved* set,
a DeepMind prover 66%) — arm effects would be invisible there, so **research-solved +
textbook** are the usable categories for us. Statements carry informal docstrings
(sanitizer strips them), and `answer(sorry)` problems need grader support for the
custom elaborator. Zero-contamination holds only for the open set; solved problems
have informal proofs in the literature.

## MathAtlas: A Benchmark for Autoformalization in the Wild

- arXiv: https://arxiv.org/abs/2605.14061 · PDF: `mathatlas-2605.14061.pdf`
- Data: https://huggingface.co/datasets/MathAtlas/MathAtlas (open split only) ·
  contact: Nilay Patel <nilay@ucsc.edu> (correspondence author)

**Not formalized problems:** MathAtlas is
~52k *informal* entities (theorems/definitions/exercises/proofs as text) extracted from
103 graduate textbooks, plus a ~178k-relation dependency graph. There are no gold Lean
statements to prove; the task is NL → Lean *statement autoformalization*, scored by
compile rate + LLM-judged semantic faithfulness (best baseline 9.8% correct on
statements; 2.6% on the deep-dependency MA-Hard subset). Only ~70% is public — the
Springer-sourced 30% is withheld, with regeneration code for those who have the books.
So: not a proving benchmark for the grid, but directly relevant to NOTES.md's
autoformalization questions (compiles-but-unfaithful is the dominant failure mode;
dependency depth predicts failure; grounding in Mathlib helps) and a natural target if
we later add an autoformalization arm.
