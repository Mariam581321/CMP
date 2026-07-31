# The three retrieval arms, exactly

Block A compares three ways of finding a Mathlib lemma — by **meaning** (semantic), by
**spelling** (grep over source), and by **structure** (Loogle over the compiled
environment). They have the same interface shape (one string in, ranked declarations out,
fixed result count, no knobs) and differ only in the retrieval mechanism. This file is the
citable definition of each; design rationale is in `PLAN.md`, implementation in
`runner/grep.js` + `runner/snippet.js` and the `extensions/` wrappers.

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
heads for the final segment, walk each candidate file's `namespace`/`end` stack, prepend,
and keep only declarations whose assembled name **equals the query exactly**. The walk
follows Lean's own scoping rules: sections and `mutual` blocks occupy the stack for
`end`-matching but contribute no name, a dotted `namespace A.B` opens one scope per
component (and may be closed as `end A.B` or as `end B` then `end A`), a bare `end` closes
only what Lean lets it close, `_root_.` escapes every namespace, and prose inside `/- -/`
comments is not scope structure. Identifiers are read as Lean writes them, subscripts and
all (`HomologicalComplex₂.d₁`, `Mathlib.Tactic.Erw?`, `«Prop»`): a name truncated to its
ASCII prefix can collide with a real but unrelated declaration, which is the one thing this
rung must never return. Checked against the compiled environment (2026-07-31): all 217,968
declaration heads in the checkout assemble to a name that exists in it. Near-misses
sharing a final segment are never returned — `Fin.val_lt_val` yields nothing rather than
offering the unrelated `Units.val_lt_val`. This rung runs *first*, so a name query is
answered with the declaration rather than with other lemmas that happen to mention it.

**Rung 5 — cross-line matching.** grep is line-based and Mathlib signatures wrap, so
`card_GL.*Fin.*ZMod` cannot match any single line even as a correct regex. This rung greps
the longest literal fragment of the pattern (then the second longest), expands each
candidate to its full declaration, flattens the whitespace, and tests the whole pattern
against that. Declarations only.

**Result shape.** Up to 10 hits, each `• <fully-qualified name>` plus the declaration
expanded from the matched line up to its `:=` (≤10 lines / 600 chars). The heading is the
name Lean assembles, not the name the source writes — `DihedralGroup.r_zero` for a source
line reading `theorem r_zero` — carrying the source's own `«»` quoting so it can be written
into a proof as it stands; every emitted name in an 80-name sample resolved under `#check`.
A `private` declaration is named and flagged as unusable outside its own file. A hit with
no nameable declaration — import lines, docstring prose, wrapped binders, proof-body lines,
anonymous `instance`s, and the 1,253 `alias ⟨fwd, rev⟩` forms; 15% of hits over a 120-query
replay of the 0730b logs — is headed `(no enclosing declaration …)` above the matched line.
**File locations are not returned to the agent**; they are kept in the tool's log details.
That is a deliberate reversal of the earlier shape, decided from the logs: the source text
under a hit carries the name as *written*, so a path was the only namespace signal and had
to be decoded, and returning it induced reads that this environment can never serve — of
grep-arm reads with an identifiable Mathlib path, 546 used a path the tool had just printed
against 8 guessed, and none in the project's history has ever returned content. It also
makes the two arms' output shapes match: both now return names and signatures.
Declarations whose own text
matches rank above *usage sites* — matches inside a proof body — which are annotated
`↳ matches inside its proof, line N`. Zero hits → a "no matches" message (a result, not an
error). Bad patterns and a missing checkout → tool failure.

**Bounds.** 400 raw grep lines per pass (4,000 for the anchor passes, which filter
afterwards), 15 s per grep, ~1.5 s worst case for a full ladder descent.

**What it cannot do.** Names that are never written in source: 13,872 `@[to_additive]`
declarations and 2,329 `alias`es. Those resolve only in the compiled environment
(`#check`), which is `check_snippet`'s territory in Block B.

---

## `loogle_mathlib` — structure-based retrieval, filtered to the pinned environment

**Mechanism.** One GET to the public Loogle API (`https://loogle.lean-lang.org/json?q=`),
30 s abort, no retries. Loogle searches the **compiled environment**, not source text:
queries are name substrings (`"mul_pow"`), constants (`Real.sin`), term patterns with
wildcards (`(_ * _) ^ _`, named `?a` for repetition), or conclusion-only patterns
(`⊢ tsum _ = _ * tsum _`), combinable with commas. Because it searches elaborated
declarations it sees the generated names the grep arm structurally cannot (`@[to_additive]`
and `alias` declarations — the gap noted under grep's "what it cannot do").

**Returns.** Up to 10 hits (grep's depth, for grep's reason: Loogle orders by module
import order, not relevance), each `• <name><binders> : <type>` plus the first docstring
line when one exists — bare bullets, mirroring `search_mathlib`. Loogle's own header line
("Found N declarations…") is deliberately **not** passed through: its count is
pre-filter, and a count larger than the visible results induces narrowing calls hunting
for hits that do not exist in this environment. The only count shown is the filtered one
(`note: showing 10 of N`, `+` when Loogle itself truncated at its 200-hit cap). Zero
hits → `"No results."` (a result). An **unknown identifier** in the query is also a
result, not a failure — `No results: unknown identifier 'X'.` plus Loogle's
suggestions — because a bare-name probe is the confirmation question and "no such
constant" is its answer, exactly as grep's zero-hit is (decided from the first smoke:
32 of 56 rejections were this shape). A query Loogle cannot parse or elaborate
("Function expected…") → tool failure carrying Loogle's message and at most 8 of its
suggestions (the analogue of grep's bad-regex failure). Module names — a path signal —
never reach the model (the
24ed9ae reversal applies); they are logged in `details`, as are dropped names and
Loogle's raw counts.

**The environment filter — the one deliberate asymmetry with `search_mathlib`.** Hits
whose name does not exist in our compiled environment are dropped before the agent sees
them (a set lookup against `problems/env-names.txt`, every non-internal constant of the
resident environment; regenerate with `scripts/dump-env-names.mjs`). Measured 2026-07-31
over 2,559 sampled hit names: **9.5% do not exist in our pin** — the public instance
tracks current Mathlib, ~800 commits past us — versus LeanSearch's measured 0.2%. The
no-filter rule was priced at 0.2%, where the cure costs more validity than the disease;
at 9.5% the disease is the arm: a tool whose confirmations are wrong one time in ten is
not a version of Loogle, it is a hallucination amplifier. The filter only ever removes
false-presents; the reverse direction (our names unknown to public Loogle) sampled at
1/30, the one miss a compiler-internal equation lemma. Dropped names are logged per call
(`details.droppedNames`), so Loogle-as-deployed is reconstructible from the run logs. A
locally-built Loogle against our pin would have zero skew in both directions and is the
pre-registered upgrade if this arm wins block A.

**Properties that matter for the write-up.**
- The index is **external and live** (same caveat as semantic): ranking and coverage can
  drift between runs, so results are not reproducible from the repo — but unlike
  semantic, every hit the agent sees provably exists in its environment.
- Per-call `heartbeats` (Loogle's own work counter) is logged: pattern queries cost
  thousands of heartbeats, name queries single digits — retrieval cost is analyzable
  post hoc.
- It answers *"what has this shape"* — the case where the agent knows neither the name
  nor the informal phrasing, only the goal structure. Discovery vs confirmation vs
  shape-matching is the three-way contrast block A now measures.

---

## What the agent is told

Only the capability and the return shape — never the technique, never the rung order,
never the environment filter — so the three arms differ in retrieval mode and nothing
else. The one exception is syntax: `loogle_mathlib`'s description teaches Loogle's query
grammar (wildcards, `⊢`, commas), because without it the arm would measure syntax
guessing rather than structure search; it still says nothing about when or why to reach
for the tool. The agent learns which reading answered from feedback after the call (the
grep `note:` line; Loogle's error messages on rejected queries), not instruction before
it. The tool
descriptions in `extensions/lean-grep.ts`, `extensions/lean-search.ts` and
`extensions/lean-loogle.ts` are the full model-visible surface: with a custom
`--system-prompt`, pi's own tool guidelines are not sent. Zero-hit messages are equally
bare in all three arms ("No results." / "No matches (case-insensitive included).") —
no arm gets retry coaching the others lack.
