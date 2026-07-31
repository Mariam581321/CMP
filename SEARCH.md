# The two retrieval arms, exactly

Block A compares two ways of finding a Mathlib lemma. They have the same interface shape
(one string in, ranked declarations out, fixed result count, no knobs) and differ only in
the retrieval mechanism. This file is the citable definition of each; design rationale is
in `PLAN.md`, implementation in `runner/grep.js` + `runner/snippet.js` and the `extensions/`
wrappers.

Result depth is fixed per arm and deliberately not a tool parameter: with the knob exposed
the agent set it on 91% of calls, so the arm measured a mix of depths rather than one.

Behavioural figures quoted below come from runs on the **pre-0731 `deepseek-v4-flash`
preview weights** (see the model boundary in `PLAN.md`). They are the evidence that
motivated each design choice, not claims about the current model.

---

## `search_mathlib` — semantic retrieval

**Mechanism.** One POST to the public LeanSearch API (`https://leansearch.net/search`),
`{query: [<text>], num_results: 6}`. Natural-language queries matched by meaning. No
fallbacks, no retries; a 30 s abort.

**Returns.** Up to 6 lines, `• <name> : <signature> — <informal name>`. Zero hits →
`"No results."` (a result, not an error). HTTP failure or timeout → tool failure.

**Properties that matter for the write-up.**
- The index is **external and live**: it is not built from our checkout, it tracks its own
  Mathlib version (the API exposes no revision field), and it can change between runs.
  Semantic-arm results are therefore **not reproducible** from the repo.
- Version skew is real but small, and now measured. Of the 36,882 results returned across
  the 0727 runs (11,698 distinct names), checked for existence in the environment the REPL
  compiles: **23 distinct names (0.2%), 65 occurrences (0.2%), do not exist here.** Most are
  notation constants (`termGal(_/_)`, `term_≡_[ZMOD_]`), not lemmas; the genuinely absent
  lemmas number about five (e.g. `Submodule.FG.of_le`,
  `UniqueFactorizationMonoid.card_factors_of_irreducible`). Left uncorrected on purpose: a
  filter would make the arm a curated LeanSearch rather than LeanSearch, and at 0.2% the
  cure costs more validity than the disease.
- It answers *"what is there about this idea"*. It cannot confirm a specific name.

---

## `grep_mathlib` — symbolic retrieval, literal-first relaxation ladder

Not an off-the-shelf tool. The protocol below is ours; in the write-up it is a
**literal-first relaxation ladder over the pinned Mathlib source, with declaration-scoped
matching and elaborator-faithful name resolution**.

**Corpus.** The pinned local Mathlib checkout — *the same source the REPL compiles against*
(7,516 `.lean` files, ~209k declarations). A hit therefore provably exists in the agent's
environment. Fully offline and reproducible from the repo.

**Protocol.** One string in. No mode parameter: in the first version the agent chose the
mode and got it wrong on 39% of calls (0730b), so mode is now a property of the tool. The
readings are tried in order of how literally they take the query; **the first one that
yields any hit wins and the rest are skipped**. Every result reports which one answered
(`mode`), so any effect can be attributed to a rung after the fact.

| # | reading | mechanism | fires when |
|---|---|---|---|
| 0 | **qualified name** | resolve the name Lean would assemble; exact matches only | pattern is a dotted identifier |
| 1 | literal | `grep -F` | always |
| 2 | literal, case-insensitive | `grep -F -i` | 1 empty |
| 3 | regex | `grep -E` | 2 empty, pattern has metacharacters and compiles |
| 4 | regex, case-insensitive | `grep -E -i` | 3 empty |
| 5 | across line breaks | anchor grep + whole-declaration match | 4 empty, ≥2 literal fragments |

**Rung 0 — name resolution.** A declaration's real name is assembled by the elaborator:
`namespace IntermediateField` + `protected theorem inv_mem` = `IntermediateField.inv_mem`,
a string that appears **nowhere** in Mathlib. So the tool reconstructs it: grep declaration
heads for the final segment, walk each candidate file's `namespace`/`end` stack (sections
occupy the stack for `end`-matching but contribute no name; `_root_.` escapes it), prepend,
and keep only declarations whose assembled name **equals the query exactly**. Near-misses
sharing a final segment are never returned — `Fin.val_lt_val` yields nothing rather than
offering the unrelated `Units.val_lt_val`. This rung runs *first*, so a name query is
answered with the declaration rather than with other lemmas that happen to mention it.

**Rung 5 — cross-line matching.** grep is line-based and Mathlib signatures wrap, so
`card_GL.*Fin.*ZMod` cannot match any single line even as a correct regex. This rung greps
the longest literal fragment of the pattern (then the second longest), expands each
candidate to its full declaration, flattens the whitespace, and tests the whole pattern
against that. Declarations only.

**Result shape.** Up to 10 hits, each `• <path>:<line>` plus the declaration expanded from
the matched line up to its `:=` (≤10 lines / 600 chars). Declarations whose own text
matches rank above *usage sites* — matches inside a proof body — which are annotated
`↳ matches inside its proof, line N`. Zero hits → a "no matches" message (a result, not an
error). Bad patterns and a missing checkout → tool failure.

**Bounds.** 400 raw grep lines per pass (4,000 for the anchor passes, which filter
afterwards), 15 s per grep, ~1.5 s worst case for a full ladder descent.

**What it cannot do.** Names that are never written in source: 13,872 `@[to_additive]`
declarations and 2,329 `alias`es. Those resolve only in the compiled environment
(`#check`), which is `check_snippet`'s territory in Block B.

---

## What the agent is told

Only the capability and the return shape — never the technique, and never the rung order,
mirroring `search_mathlib` so the two arms differ in retrieval mode and nothing else. The
agent learns which reading answered from the per-result `note:` line, i.e. as feedback
after the call rather than as instruction before it. The tool descriptions in
`extensions/lean-grep.ts` and `extensions/lean-search.ts` are the full model-visible
surface: with a custom `--system-prompt`, pi's own tool guidelines are not sent.
