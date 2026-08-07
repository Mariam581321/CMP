# The three retrieval arms, exactly

Block A compares three ways of finding a Mathlib lemma — by **meaning** (semantic), by
**spelling** (grep over source), and by **structure** (Loogle over the compiled
environment). They have the same interface shape (one string in, ranked declarations out,
fixed result count, no knobs) and differ only in the retrieval mechanism. This file is the
citable definition of each; design rationale is in `PLAN.md`, implementation in
`runner/grep.js` + `runner/snippet.js` and the `extensions/` wrappers.

Result depth is fixed per arm and deliberately not a tool parameter: with the knob exposed
the agent set it on 91% of calls, so the arm measured a mix of depths rather than one.
Each arm runs at its own mechanism's natural depth — 6 for the semantic API, 25 for grep —
because a ranked semantic list degrades gracefully at the tail and a text search does not.

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

**Result shape.** Up to 25 hits (10 until 2026-08-07 — see Ordering below for the
measurement that moved it), each `• <fully-qualified name>` plus the declaration
expanded from the matched line up to its `:=` (≤24 lines / 1,600 chars). The heading is the
name Lean assembles, not the name the source writes — `DihedralGroup.r_zero` for a source
line reading `theorem r_zero` — carrying the source's own `«»` quoting so it can be written
into a proof as it stands; every emitted name in an 80-name sample resolved under `#check`.
A `private` declaration is named and flagged as unusable outside its own file. A hit with
no nameable declaration — import lines, docstring prose, wrapped binders, proof-body lines,
anonymous `instance`s, and the 1,253 `alias ⟨fwd, rev⟩` forms; 15% of hits over a 120-query
replay of the 0730b logs — is headed `(no enclosing declaration …)` above the matched line.
**File locations follow read access** (2026-08-04). The original removal of paths was
decided from the logs: the source text under a hit carries the name as *written*, so a
path was the only namespace signal and had to be decoded, and returning it induced reads
that the environment could never serve — of grep-arm reads with an identifiable Mathlib
path, 546 used a path the tool had just printed against 8 guessed, and none had ever
returned content. Both legs are honored separately now. The name-first heading is
permanent. The path's fate depends on whether it is actionable: **the grep arm ships
with the Mathlib source readable** — a work-dir symlink `Mathlib/` onto the pinned
checkout (one canonical tree, not a copy; write/edit through it blocked by the sandbox;
the same shape exposes `library.lean` in block-D cells) — and with read active, each
result appends its location as a secondary `— Mathlib/...lean:N` line the ordinary read
tool opens directly, converting the measured 546-read demand into a capability. Read
access rides WITH grep — one symbolic-retrieval modality, grep to locate, read to
browse — and never with base, which stays the no-retrieval floor; in configs without
read, rendering is path-free exactly as before and locations live only in the tool's
log details. Consequence stated rather than discovered later: block A's grep arm is
thereby a "repo access" arm — symbolic search plus source browsing — versus the
semantic API; the comparison is retrieval *modality*, no longer retrieval mechanism
alone.
**Ordering (2026-08-07).** Results used to be emitted in `grep -rnI` order, which is
alphabetical by path and says nothing about relevance — so with a cap on the list, the
tool answered a query with whatever happened to live earliest in the tree. Measured over
grep-fatex87-0805: **4,088 of 9,428 calls truncated (43%)**, and re-running those queries
with the cap lifted showed a median of **38 matching declarations** (p25 18, p75 83, p90
≥ 200). On nearly half of all retrievals the arm was returning an alphabetical prefix of
roughly a quarter of what matched, and an exact-name hit in `Mathlib/RingTheory/…` could
be crowded out by `Mathlib/Algebra/…` lemmas that merely mention the token — `Ideal`
itself was not in its own result list.

The ordering is now, in tiers, ties keeping traversal order:

| tier | the hit's assembled name | example for query `inv_mem` |
|---|---|---|
| 0 | IS the query | — |
| 1 | ends with the query | `IntermediateField.inv_mem` |
| 2 | contains the query | `Foo.inv_mem_of_bar` |
| 3 | does not — the query matched only the signature | a lemma *about* `inv_mem` |

then *usage sites* — matches inside a proof body, annotated `↳ matches inside its proof,
line N` — which rank after every declaration, as before. Each tier uses the SAME matcher
as the rung that produced the hits (literal / literal-ci / regex / regex-ci), so the
ranking cannot disagree with the search; a cross-line query spans a wrapped signature and
never matches a bare name, so all its hits sit in tier 3 and keep traversal order. This is
deliberately not a relevance *score*: the only claim it makes is that a declaration the
query NAMES comes before one that merely mentions it. Pinned by
`scripts/probe-grep.mjs`. Zero hits → a "no matches" message (a result, not an error).
Bad patterns and a missing checkout → tool failure.

**Bounds (all raised 2026-08-07).** 20,000 raw grep lines per pass, 30 s per grep, ~0.8 s
worst case for a full ladder descent on the broadest patterns in Mathlib. There are now
exactly TWO cuts and both are visible in the output: grep stops at the raw-line cap, and
the display stops at the arm's result count. The middle one — candidate collection stopped
at `maxResults × 3` = 30 declarations — is gone, because it meant the tool never LOOKED at
a 31st candidate, so ranking them would have been ranking the alphabet. The raw-line cap
sat at 400 on the assumption that grep is expensive; measured, an uncapped grep over the
whole checkout costs ~0.1 s even for `Ideal` (11,916 matching lines), so it was buying
nothing and losing the back half of the library. Declaration expansion is 24 lines /
1,600 chars (was 10 / 600), sized so a wrapped Mathlib signature is not cut in half —
which is the only thing the expansion exists for.

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
