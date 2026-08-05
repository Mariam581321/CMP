# FATE-X solved-problem audit — all 100 problems re-read, one harness bug fixed (2026-08-05)

**TL;DR.** The 0803 audit only looked at *unsolved* FATE-X problems. That is exactly the wrong
half for one failure mode: a formalization that is **weaker than intended gets solved**, so it
never reaches an unsolved-problem audit. This pass re-read all 100 FATE-X problems — informal
statement vs formal statement vs the accepted solution file — and swept the solved set with
mechanical checks.

Headline findings:

- **One harness bug, now fixed.** `benchmarkDecls` never tracked `class`/`structure`/`inductive`,
  so an attempt could rewrite a benchmark *class field* and the grader would pass it.
  **fatex_74 did exactly that** and was graded solved. Fix + regression in §1.
- **Three more broken statements, all previously graded SOLVED**: **fatex_2** (trivially true),
  **fatex_15** (vacuous — the hypothesis type is empty), **fatex_63** (surjectivity dropped,
  making it free). Machine-checked. §2.
- **Two statements strictly weaker than their informal**: **fatex_22**, **fatex_59**. §3.
- **Three faithful-but-free problems** (already in Mathlib): fatex_35, fatex_46, fatex_70. §4.
- Systematic scans that came back **clean** are in §5 — including a corpus-wide scan for the
  fatex_81 parenthesis defect, which finds fatex_81 and nothing else.

**Nothing in this pass changes a problem statement.** No semantic fixes were attempted; the only
code change is the harness bug in §1. The run list is narrowed instead (§6).

Scoring impact:

| | before | after |
|---|---|---|
| FATE-X graded solved | 50 | **46** |
| invalidated | — | fatex_2, fatex_15, fatex_63, fatex_74 |
| run list | `safe93.txt` (n = 93) | **`safe90.txt` (n = 90)** |

---

## 1. The harness bug — class fields were never checked (fatex_74)

FATE-X problem 74 ships this setup class:

```lean
class IsGorensteinLocalRing (R : Type) [CommRing R] : Prop extends
    IsLocalRing R, IsNoetherianRing R where
  injDim_le_infity :
    ∃ n : ℕ, ∀ i : ℕ, n ≤ i →
    Subsingleton (Abelian.Ext.{0} (of.{0} R (ResidueField R)) (of.{0} R R) i)
```

The accepted solution (`results/lean-search-fatex-rest90-0802/fatex_74/work/problem.lean`)
shipped:

```lean
  injDim_le_infity : True
```

"Gorenstein" was redefined to mean "local and Noetherian", and the whole proof became

```lean
  refine { localization_maximal_isGorensteinLocalRing := ?_ }
  intro m hm
  refine { injDim_le_infity := trivial }
```

Murthy's theorem is never proved. 33 lines, 69 turns, graded **solved**.

### Why it passed

`benchmarkDecls` (`runner/stmt.js`) matched only `abbrev|def|theorem`:

```js
/^\s*(?:noncomputable\s+)?(?:abbrev|def|theorem)\s+([^\s:({\[⦃]+)/
```

so for fatex_74 it tracked exactly one name — the theorem — and all three classes were invisible
to the statement probe. The theorem's own type was untouched (it still reads
`IsGorensteinRing (R ⧸ …)`), because **a type references a class by name only**. This is precisely
the setup-definition hole that the `CMPVAL` value probe closes for `def`/`abbrev` (the
`dist_to_int := fun _ => 0` exploit, 2026-07-28) — left open one level down, for the field types
of a class.

### Why the obvious fix is not enough

Tracking the class *name* does nothing. Measured on fatex_74, original vs gutted:

```
Problem74.IsGorensteinLocalRing
   forall ([anonymous] : Type) [[anonymous] : CommRing.{0} [anonymous]], Prop   ← IDENTICAL
Problem74.IsGorensteinLocalRing.mk
   … ← DIFFERENT
```

The class's own type is just `Type → [CommRing] → Prop` and does not move when a field is gutted.
The field types live in the **constructor**.

### The fix

- `benchmarkDecls` now also matches `class|structure|inductive`.
- `stmtProbe` emits every constructor's canonical type in the decl's value slot
  (`<ctor>|<type>` joined by `" ;; "`), so the existing value comparison protects class fields the
  same way it protects `def` bodies. `extends` parents are constructor arguments, so they are
  covered by the same string.
- `originalStmtTypes` gained `hasAll`: a cache entry written before the tracker fix covers only the
  old decl heads, and the sha key is over the *original* source (unchanged by a tracker fix), so
  stale entries would keep being served and every newly-tracked class would read back `undefined`
  — failing every class-bearing problem as "statement no longer elaborates". Entries missing any
  requested decl are now a miss.
- `grade.js` message is kind-aware ("class/structure fields differ" vs "definition body differs").

`instance` is deliberately **not** tracked: every instance in the corpus is anonymous, so there is
no source-level name to look up, and instances are covered transitively — they are fully resolved
inside the canonical types of the decls that use them, so swapping or deleting one moves a tracked
type or constructor.

### Verification

| check | result |
|---|---|
| gutted fatex_74 solution, re-graded | `statement_changed` ✓ (was `solved`) |
| 23 class-bearing FATE-X originals, self-check | 0 false positives |
| full regression: 350 originals across FATE-X/H/M | **0 failures** |
| grader end-to-end on fatex_53, fatex_69 (real class-bearing solves) | still `solved` |

### Blast radius

23 FATE-X problems carry `class`/`structure`/`inductive` setup (11, 15, 16, 18, 23, 38, 43, 44, 48,
53, 64, 65, 69, 71, 72, 73, 74, 75, 78, 79, 80, 83, 85). FATE-H, FATE-M and PutnamBench have
**none**, which is why this only ever surfaced here. Nine of the 23 are graded solved; every one
was diffed against its original (`scripts/setup-tamper.mjs`) and **only fatex_74 altered
anything**. So: one bad solve, not a systemic collapse.

---

## 2. Three broken statements, all graded SOLVED

### 2.1 fatex_2 — trivially true (the minimal-normal set is always `{⊥}`)

**Informal**: *G* finite, *L* a maximal subgroup, *L* non-abelian and simple ⟹ at most two
minimal normal subgroups in *G*.

**Formal conclusion**:

```lean
{H : {H : Subgroup G // H.Normal} | IsMin H}.ncard ≤ 2
```

**The bug.** `IsMin` is taken over the lattice of **all** normal subgroups, which has `⊥` as its
bottom element. So `IsMin H` forces `H = ⊥`, the set is exactly `{⊥}`, and its `ncard` is 1 — for
*any* group, with no hypotheses at all. In group theory "minimal normal subgroup" means minimal
among the **nontrivial** normal subgroups; that restriction is missing.

**Evidence.** The accepted solution (36 lines, 11 turns) proves exactly this: it builds
`t := ⟨⊥, _⟩`, shows `∀ H, IsMin H → H = t`, and concludes by `ncard_le_ncard` + `omega`. It uses
none of `h_maximal`, `h_simple`, `h_non_comm`, and not even `[Finite G]`.

Machine-checked independently in `lean-env/_check/fatex2_fatex15_probe.lean` (clean axioms):

```lean
theorem minimal_normal_set_is_singleton_bot (G : Type) [Group G] :
    {H : {H : Subgroup G // H.Normal} | IsMin H}.ncard = 1
```

**Fix (not applied)**: quantify over nontrivial normal subgroups, e.g. minimal elements of
`{H : Subgroup G // H.Normal ∧ H ≠ ⊥}`.

### 2.2 fatex_15 — vacuous (the composition-series type is empty)

**Formal setup** (verbatim from FATE):

```lean
structure Subgroup.IsMaximalNormal {G : Type} [Group G] (H₁ H₂ : Subgroup G) : Prop where
  le : H₁ ≤ H₂
  subgroupOf_normal : (H₁.subgroupOf H₂).Normal
  is_maximal : ∀ H : Subgroup G, H₁ ≤ H → H ≤ H₂ → (H.subgroupOf H₂).Normal → (H = H₁ ∨ H = H₂)

structure NormalSubgroupCompositionSeries (G : Type) [Group G] : Type where
  toRelSeries : RelSeries (Subgroup.IsMaximalNormal.setRel (G := G))
  maximal : ∀ s : RelSeries (…), s.length ≤ toRelSeries.length
```

**The bug.** `Subgroup.IsMaximalNormal x x` holds for **every** `x`: `le` is `le_rfl`,
`subgroupOf_self` is normal, and `is_maximal` is immediate because `H₁ = H₂`. So the relation is
reflexive, and any `RelSeries` can be extended by repeating its last element (`snoc`). But
`NormalSubgroupCompositionSeries` demands a series of **maximum** length among all `RelSeries`.
No such series can exist — **the type is empty for every group**. fatex_15 hypothesises an
inhabitant `Hs : NormalSubgroupCompositionSeries H`, so the theorem is vacuously true.

**Evidence.** The accepted solution's own comment says so, and its proof is `exfalso` followed by
the `snoc` argument. Solved 4× (10–22 turns).

Machine-checked independently (clean axioms):

```lean
theorem composition_series_type_is_empty (G : Type) [Group G] :
    IsEmpty (NormalSubgroupCompositionSeries G)
```

**Fix (not applied)**: `IsMaximalNormal` must require `H₁ < H₂` (or `H₁ ≠ H₂`), which is what
"maximal *proper* normal subgroup" means; then maximum-length series exist for finite groups.

### 2.3 fatex_63 — surjectivity dropped, making the problem free

**Informal**: for a formally unramified `R → S`, there is a **surjection** of `R`-algebras
`S' → S` whose kernel has square zero, with a universal lifting property.

**Formal**:

```lean
∃ (S' : Type) (_ : CommRing S') (_ : Algebra R S') (f : S' →ₐ[R] S),
  (RingHom.ker f) ^ 2 = 0 ∧ UniversalProperty.liftOfSqZeroIdeal f
```

**The bug.** `f` is never required to be surjective. The accepted solution (91 lines, 53 turns)
takes

```lean
  let f₀ : R →ₐ[R] S := IsScalarTower.toAlgHom R R S
  let J : Ideal R := RingHom.ker f₀.toRingHom
  refine ⟨R ⧸ J ^ 2, _, _, f₀.kerSquareLift, …⟩
```

i.e. `S' = R/J²`, a quotient of **R**, not a thickening of **S**. Its kernel is `J.cotangentIdeal`,
which squares to zero. The universal property is then free: any `R`-algebra map out of a quotient
of `R` is unique (it is pinned by `commutes`), and existence is just `a₀ : R → A` factoring
through `J²`. Consequently **`[Algebra.FormallyUnramified R S]` is never used anywhere in the
proof** — the argument works for any `R`-algebra `S`.

The intended object is the universal first-order thickening of `S`, which is what surjectivity
pins down.

**Fix (not applied)**: add `Function.Surjective f` to the existential.

---

## 3. Two statements strictly weaker than their informal (annotate, do not exclude)

Same class as fatex_81/92/96 from the 0803 audit: true, solvable, but part of the informal claim
is not asserted.

### 3.1 fatex_22 — "is a root of unity" is vacuous

```lean
(∀ x : F, IsIntegral ℤ x → ‖(x : ℂ)‖ = 1 → ∃ n,  x ^ n = 1)
```

`n : ℕ`, so `n = 0` satisfies `x ^ n = 1` for every `x`. The second conjunct adds nothing; the
theorem reduces to the finiteness claim, which **is** genuine. The accepted solution proves the
strong `∃ n : ℕ, 0 < n ∧ x ^ n = 1` version anyway, so this solve is not bogus — but the statement
is weaker than advertised. Fix would be `∃ n, 0 < n ∧ x ^ n = 1`.

### 3.2 fatex_59 — the value-group claim is dropped

The informal asks to show `v` is a valuation **with value group ℤ + ℤα**. The formal asserts only
unique existence of a valuation matching the formula; the value group is never mentioned.

---

## 4. Faithful but free (score inflation, not defects)

Not bugs — the statements are correct — but they are solved by one or two Mathlib lemmas, and
inflate the score relative to what FATE-X is supposed to measure.

| problem | why |
|---|---|
| fatex_35 | Cohen's theorem, literally `exact IsNoetherianRing.of_prime h_fg`. 10 lines, 5 turns, 12 s. |
| fatex_46 | Both directions sit on `Module.Flat.exists_factorization_of_isFinitelyPresented` / `Module.Flat.of_forall_exists_factorization`. 65 lines. |
| fatex_70 | Lying-over for minimal primes under an injective map; two Mathlib lemmas. Solved 4× in 14–24 turns. Its `[IsLocalRing S]` hypothesis is unused. |

---

## 5. Systematic scans that came back clean

| check | scope | result | tool |
|---|---|---|---|
| `∃`/`∀` body swallowing a top-level `↔` (the fatex_81 defect) | all 200 FATE-X + FATE-H statements | **fatex_81 only** | `scripts/scope-scan.mjs` |
| statement closable by cheap automation (`simp_all`/`aesop`/`tauto`/`decide`/`norm_num`/…) | 138 solved X+H | **none** | — |
| accepted solution altered a benchmark setup declaration | 138 solved X+H | **fatex_74 only** | `scripts/setup-tamper.mjs` |
| our sanitized file vs FATE original | all 350 X/H/M | byte-exact `sanitize(original)`; 0 dropped lines contain Lean; 0 mixed comment/code lines | `scripts/wipe-audit.mjs` |
| elaborated type + value, original vs ours | the 6 bug-list problems | identical | `scripts/type-eq.mjs` |

The first row is the point: the fatex_81 discovery was luck, and that specific defect is now
mechanically excluded corpus-wide.

**Not done:** the mathematical *truth* of every faithful-looking statement was not independently
re-verified. The scans cover mechanizable defect classes; the fatex_13/23/60/75 class (vacuous or
over-broad hypotheses) is semantic and was caught here only by reading.

---

## 6. Run list

`problems-fatex/safe90.txt` (n = 90) = the old `safe93` seven (13, 23, 60, 75, 77, 81, 99) **plus
2, 15, 63**.

**fatex_74 stays in the list.** The problem itself is legitimate (Murthy's theorem); it was the
harness that was broken, and it is now protected. Its recorded solve must be regraded.

Still pointing at the old list and needing a decision (not touched here, because they change run
economics):

- `scripts/blockA-fatex93-0805.sh` — `--problems problems-fatex/safe93.txt`
- `COSTS.md` — per-cell budget is computed at n = 93
- `PLAN.md` — updated to reference `safe90.txt`

## 7. Upstream

None of §2–§3 has been reported to `frenzymath/FATE`. Together with the 0803 audit's five
(13, 23, 60, 75, 81) that is **eight broken and four weakened** FATE-X statements — worth a single
consolidated issue. Ask Mariam.
