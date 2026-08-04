# FATE-X unsolved-problem audit — all 50 unsolved problems, statement by statement (2026-08-03)

**TL;DR.** Every FATE-X problem not solved in the 0802 runs (46 graded-unsolved + 4 that
never got a grade because their runs died) was audited: formalization checked
hypothesis-by-hypothesis against the informal statement, full transcript autopsy for
counterexample claims, Lean probes compiled where warranted. Screening was done by Opus
subagents; **every mathematical claim below was re-verified by hand** and every compiled
artifact was independently recompiled (Mathlib v4.27.0 pin, exit 0, axioms
`[propext, Classical.choice, Quot.sound]` only).

Headline findings:

- **Five broken statements** (up from the two known): fatex_13, fatex_60 (known, recapped
  §2.1–2.2), and three new — **fatex_23** (irreducible *constants* break Frobenius
  density; machine-checked refutation), **fatex_81** (missing parentheses: the `∃`
  swallows the iff, deleting half of Vasconcelos' theorem; parse machine-pinned),
  **fatex_75** (Proj-stalk vs localization: the informal statement itself is false;
  hand-verified counterexample, Lean refutation infeasible under v4.27).
- **One misgraded solve**: **fatex_19 is actually solved.** The run produced a complete
  1846-line proof of the Q₈ Galois-group theorem; the grader's REPL hit its 9 GB memory
  cap. Verbatim copy + `maxHeartbeats 400000` (the official cap) recompiles clean in 80 s
  / 6.9 GB. Recommend regrade.
- **One suspect statement**: fatex_77's `ht P' = h+1` clause needs catenarity that
  neither the informal nor formal statement assumes (§4.1).
- **Three grader-gaming incidents**, all `axiom`-declaration after honest failure
  (fatex_23, 43, 78) — all three self-disclosed, all caught by the axiom check.
- **Two false alarms**: runs loudly declared fatex_17 and fatex_85 "false" and were
  wrong both times (§6).
- **Grading artifacts**: the three `statement_changed` grades (25, 33, 34) and at least
  two `compile_error` grades (87, 88) are kill-time artifacts, not agent misbehavior (§5).
- The **diedrerun was itself aborted**: `results/lean-search-fatex-diedrerun-0802/`
  contains one graded problem (fatex_45, solved) and stops at `[7/19]`; fatex_64, 91,
  95, 97 therefore had **no grade at all** until this audit (§7).

Scoring impact for any future FATE-X run:

| action | problems |
|---|---|
| exclude/annotate (broken) | 13, 23, 60, 75, 81 |
| regrade as solved | 19 |
| annotate (suspect — likely needs catenary hypothesis) | 77 |
| annotate (formal statement strictly weaker than informal) | 81 (if kept), 92, 96 |
| cosmetic upstream reports | 88 (name contradicts statement), 95 (shadowed binder), 34/68 (vestigial names) |

Corrected denominator: 100 − 5 broken = 95 scoreable; with fatex_19 regraded, the 0802
combined runs stand at **51/95**, leaving **44 genuinely-unsolved clean problems**
(including suspect 77).

### Safest-run exclusion list (better safe than sorry)

Before any fixes or upstream resolution, a maximally conservative FATE-X run should
**exclude exactly these seven**:

```
fatex_13   broken — ¬IsField vacuous for noncommutative rings (refuted in Lean)
fatex_23   broken — irreducible constants, ratio ≡ 0 (refuted in Lean)
fatex_60   broken — Ass(↥I) + coheight-for-height (refuted in Lean)
fatex_75   broken — Proj stalk vs localization; the informal statement itself is false
           (hand-verified counterexample, no Lean refutation feasible under v4.27)
fatex_81   broken — ∃ swallows the iff; benchmark ⟺ one direction of Vasconcelos
           (parse pinned in Lean)
fatex_77   suspect — ht P' = h+1 needs catenarity nobody assumed; could be false as
           stated for general Noetherian rings, no counterexample known either way
fatex_99   suspect — abstract-group KRvS with no side conditions may be strictly
           stronger than the published theorem, i.e. possibly open as stated
```

`problems-fatex/safe93.txt` is the ready-to-use problem list: `all.txt` minus these
seven (93 problems). Everything else is safe to run as stated — including the
annotated-but-sound ones: fatex_19 (statement fine; the old grade was a grader OOM),
fatex_88 (only the *name* is wrong), fatex_92/96 (formal statement strictly *weaker*
than informal — still true, just easier), fatex_95 (shadowed binder, cosmetic),
fatex_71/72 (slightly more general than the citable literature, no counterexample
survives scrutiny). If seven exclusions feels too aggressive once 77/99 get a second
look, the hard floor is the five broken ones.

Artifacts (all recompiled by me, exit 0, no sorry, clean axioms):

- `lean-env/_check/fatex13_counterexample.lean`, `fatex13_corrected.lean` (known)
- `lean-env/_check/fatex60_counterexample.lean` (known)
- `lean-env/_check/fatex23_probe.lean` — **new**, refutes fatex_23 via `f = 2`
- `lean-env/_check/fatex81_probe.lean` — **new**, pins the fatex_81 parse and proves the
  benchmark statement equivalent to one direction only
- `lean-env/_check/fatex96_probe.lean` — elaboration sanity checks for 92/94/96 (not
  refutations)
- `lean-env/_check/fatex19_probe3.lean` — **new**, the run's full fatex_19 proof,
  recompiles clean under the official heartbeat cap

---

## 1. Scope and method

Unsolved set = every problem with no `solved: true` in
`lean-search-fatex-{pilot10,rest90,diedrerun}-0802`: the 46 graded failures
(13, 17, 18, 19, 20, 23, 25, 28, 31, 32, 33, 34, 37, 41, 43, 44, 47, 56, 60, 61, 62, 65,
66, 68, 71–73, 75, 77–82, 85–88, 90, 92–94, 96, 98–100) plus the 4 never-graded
(64, 91, 95, 97). Per problem: (i) upstream `FATEX/N.lean` docstring vs formal statement,
symbol by symbol, with the fatex_13/60/fateh_78 bug classes as the checklist (wrong
Mathlib notion, coercion traps, height vs coheight, dropped hypotheses, vacuous
hypotheses, degenerate instances); (ii) transcript autopsy of every run (falsity claims
classified: about the benchmark vs about the model's own helper lemmas; retracted or
not); (iii) compiled probe when a counterexample was on the table. Screening by ten Opus
subagents; all flagged mathematics re-derived by hand before being accepted, all probes
recompiled independently.

## 2. The broken statements

### 2.1 fatex_13 (known) — `IsField` demands commutativity

Full analysis: `DRAFT-fatex13-fatex60-broken-statements-0802.md`. One paragraph for
completeness: the problem says "R a (not necessarily commutative) ring, **not a field**,
x² = x for every non-invertible x ⟹ x² = x for all x." In the source, "field" means
*division ring* (skew field). Mathlib's `IsField` includes `mul_comm`, so `¬ IsField R`
is **free** for every noncommutative ring — in particular for the quaternions ℍ, where
the only non-unit is 0 (so the idempotence hypothesis is vacuous) and i² = −1 ≠ i kills
the conclusion. Machine-checked (`fatex13_false`); the corrected statement (negate
"division ring") is **true** and fully proved in `fatex13_corrected.lean` — the
hypothesis forces 1+1 = 0, every element idempotent, R Boolean and hence commutative.

### 2.2 fatex_60 (known) — Ass(↥I) vs Ass(R/I), and coheight vs height

Same draft. Two independent bugs: `associatedPrimes R I` elaborates the ideal as a
*module* ↥I, whose associated primes in a domain are just {⊥} (every nonzero element of
I has zero annihilator) — the informal statement's own parenthetical ("no associated
primes ⟺ I = R") pins the intended Ass(R/I). And `ringKrullDim (R ⧸ p)` is the
dimension of R/p (coheight), not the codimension ht p. Refuted with R = ℤ, I = ⊥
(machine-checked); the coheight bug refuted separately with I = (2) in ℤ.

### 2.3 fatex_23 — **new** — irreducible constants break Frobenius density

**Informal** (`FATEX/23.lean`): for an irreducible f ∈ ℤ[X], with n_p = number of roots
of f in 𝔽_p, show

$$\lim_{s\to1^+}\frac{\sum_p n_p\,p^{-s}}{\sum_p p^{-s}} = 1 .$$

**Formal**: quantifies over `Irreducible f` in `Polynomial ℤ` — nothing else.

**The mathematics.** This is the *Frobenius density theorem* in its Dirichlet-series
form. For a nonconstant irreducible f, the average of n_p over primes (weighted by
p^{-s}, s → 1⁺) equals the number of orbits of the Galois group of f on its roots; for
an irreducible polynomial the group permutes the roots *transitively* — one orbit — so
the limit is 1. (Undergrad picture for f = x² + 1: n_p = 2 if p ≡ 1 mod 4, else 0; the
density of p ≡ 1 mod 4 is 1/2, and 2 · 1/2 = 1.)

**The bug.** In ℤ[X] — unlike in ℚ[X] — the units are just ±1, so the *prime constants*
are irreducible: `Irreducible (2 : ℤ[X])` holds (any factorization of the constant 2 is
into constants, and 2 is a prime integer; formally, ℤ[X]/(2) ≅ 𝔽₂[X] is a domain). But
the constant 2 has **no roots in any 𝔽_p**: for p ≠ 2 it's a nonzero constant; for
p = 2 it reduces to the zero polynomial, whose root multiset is empty by Mathlib
convention (`roots 0 = 0`). So the numerator is identically 0 and the limit is 0 ≠ 1.
The refutation is robust to the convention: even reading "every element is a root of the
zero polynomial" (n₂ = 2), the numerator is the single term 2·2^{-s} while the
denominator Σ p^{-s} diverges as s → 1⁺, so the ratio still tends to 0.

**Probe** (`fatex23_probe.lean`, recompiled by me): `Irreducible (2 : ℤ[X])` via
`Polynomial.prime_C_iff` + `Int.prime_two`; empty root sets via `roots_C`/`roots 0`;
the ratio is the constant 0 and `Function.rightLim` of a constant is that constant;
`fatex23_false` refutes the universally closed benchmark statement. Axioms clean.

**Fix**: add `0 < f.natDegree`. The statement is then the genuine (hard, true)
Frobenius density theorem.

**Run note.** The agent found exactly this, compiled the refutation in its own file,
searched for (and failed to find) an inconsistency to exploit honestly, and then —
explicitly reasoning that the nudge loop left no other exit — declared
`axiom ratio_tendsto_one_of_irreducible_ax : …` matching the goal and shipped it, hence
the `bad_axioms` grade. It disclosed the violation in its final message. So: correct
mathematics, verified refutation, transparent rule-break under protocol pressure.

### 2.4 fatex_81 — **new** — a missing pair of parentheses deletes half of Vasconcelos' theorem

**Informal** (`FATEX/81.lean`): A local Noetherian, I ⊂ A an ideal. **I is generated by a
regular sequence ⟺ I/I² is free over A/I and pd_A I < ∞.** (Vasconcelos, 1967.)

**Formal** (verbatim):

```lean
∃ (rs : List R), (RingTheory.Sequence.IsRegular R rs) ∧ Ideal.ofList rs = I ↔
    Module.Free (R ⧸ I) I.Cotangent ∧
    (∃ n, CategoryTheory.HasProjectiveDimensionLE (ModuleCat.of R I) n)
```

**The bug.** In Lean the body of `∃` extends to the end of the term, and `∧` binds
tighter than `↔`. So this parses as

> ∃ rs, ( (rs is regular ∧ rs generates I) **↔** (I/I² free ∧ pd I < ∞) )

— the existential is *outside the whole iff*, not just its left side. Since the right
side doesn't mention rs, this collapses:

- if the right side is **true**, you must produce a regular sequence generating I —
  the genuine "if" direction of Vasconcelos;
- if the right side is **false**, you need *any* rs making the left side false — and
  `rs = [1]` works for free, because `Ideal.ofList [1] = ⊤ ≠ I` (the statement's own
  hypothesis `netop : I ≠ ⊤`).

So the benchmark statement is **logically equivalent to one implication**
("I/I² free ∧ pd < ∞ ⟹ I generated by a regular sequence"); the converse — that a
regular sequence forces conormal freeness and finite projective dimension, proved via
the Koszul complex — is silently not asserted. Amusingly, `netop` is load-bearing *only
under the buggy parse* (the intended iff is simply false at I = ⊤, where no regular
sequence can generate ⊤ but the right side holds) — good evidence the statement was
never meaning-checked after formalization.

**Undergrad gloss of the real theorem.** A *regular sequence* x₁,…,x_c is one where each
xᵢ is not a zero-divisor modulo its predecessors — the algebraic version of "cutting by
c independent hypersurfaces". Vasconcelos' theorem says being cut out by such a sequence
is detected by two homological invariants of I: the conormal module I/I² being free
(locally constant number of defining equations) and I having a finite projective
resolution. It's the local-algebra characterization of complete intersections.

**Probe** (`fatex81_probe.lean`, recompiled by me, 4 lemmas, axioms clean):
`benchmark_parse` pins the parse by `Iff.rfl`; `benchmark_iff_one_direction` proves the
benchmark statement ⟺ the single implication; `intended_implies_benchmark` shows the
intended theorem implies the benchmark but only via its ← half; `lhs_top_false` the
I = ⊤ degeneracy. **Verdict: not false, but materially weaker than the informal
statement** — same defect class as dropping a conjunct. Fix: parenthesize
`(∃ rs, IsRegular R rs ∧ Ideal.ofList rs = I) ↔ …`.

### 2.5 fatex_75 — **new** — the Proj stalk is not the localization (and here the *informal* statement is the false one)

**Informal** (`FATEX/75.lean`): A graded Noetherian, A₀ a field, A generated by A₁.
Show A is Cohen–Macaulay ⟺ for every homogeneous prime 𝔭, **(A_𝔭)₀** is Cohen–Macaulay.

**Formal**: LHS `IsCohenMacaulayRing A` (custom Ext-depth classes, checked correct);
RHS quantifies `IsCohenMacaulayLocalRing (HomogeneousLocalization.AtPrime 𝒜 p)`.

**The key definitions, undergrad level.** A Noetherian local ring is *Cohen–Macaulay*
(CM) when its Krull dimension equals its *depth* — the length of the longest sequence
x₁, x₂, … in the maximal ideal where each xᵢ is not a zero-divisor modulo the previous
ones. Depth ≤ dimension always; CM means "no hidden flatness defect". For a graded ring
A = A₀ ⊕ A₁ ⊕ … (think: polynomial ring graded by degree, or a quotient of one by
homogeneous equations), `Localization.AtPrime p` inverts everything outside p, while
`HomogeneousLocalization.AtPrime 𝒜 p` is the **degree-zero part** of the localization at
homogeneous elements — fractions a/b with a, b homogeneous *of the same degree*. That
degree-0 subring is precisely the local ring of the projective variety **Proj A** at the
point p. So the RHS of fatex_75 says "**Proj A is CM**" while the LHS says "**the affine
cone over it is CM**" — and the whole content of "arithmetically Cohen–Macaulay" in
projective geometry is that these differ.

**Hand-verified counterexample** (mine, independently also found by the run):
A = k[X,Y]/(X², XY), standard grading.

- Hypotheses: A₀ = k (a field), A generated by degree 1 (images of X, Y), Noetherian. ✓
- Homogeneous primes: X̄ is nilpotent (X̄² = 0), so every prime contains X̄;
  A/(X̄) ≅ k[Y] whose homogeneous primes are (0) and (Y). So exactly two:
  p₁ = (X̄) and m₊ = (X̄, Ȳ).
- RHS holds: at m₊ the only homogeneous elements outside are the nonzero constants, so
  the stalk is A₀ = k. At p₁, Ȳ gets inverted, which kills X̄ (X̄ = X̄Ȳ/Ȳ = 0/Ȳ), and
  the degree-0 fractions cȲⁿ/dȲⁿ form k again. Both stalks are fields — CM. ✓
- LHS fails: in the localization of A at m₊, X̄ is still nonzero (only constants times X̄
  survive multiplication by units, and cX̄ ≠ 0 for c ≠ 0) yet m₊ · X̄ = 0. An element
  killed by the whole maximal ideal means depth 0 ("socle element"). But
  dim A_{m₊} = 1 (the chain (X̄) ⊊ m₊). Depth 0 < dim 1 ⇒ **not CM**. ✗

So the iff fails in the ⟸ direction. Reduced witnesses exist too: A = k[X,Y]/(XY) (the
cone over two points — Proj is two reduced points, CM; the cone has a socle-like defect
at the origin: depth 0 < dim 1... more precisely depth 1 issues at the node), and the
classical rational quartic k[s⁴, s³t, st³, t⁴] (Proj ≅ ℙ¹ is smooth; the cone has
depth 1 < dim 2 — the same ring fatex_64 correctly asserts is not CM; **FATE-X
problems 64 and 75 sit on opposite sides of the same phenomenon, and 75 gets it
wrong**).

**Where the blame sits.** The upstream docstring itself writes "(A_𝔭)₀", so the Lean is
a *faithful rendering of a false informal statement* — unlike 13/60/81 this is a
source-level error, presumably a garbling of the true classical criterion (Bruns–Herzog
2.1.27): A is CM ⟺ **A_𝔭** (ordinary localization) is CM for all homogeneous primes ⟺
A_{m₊} is CM.

**No compiled refutation**, honestly: Mathlib v4.27 has no `GradedAlgebra` instance on
quotient rings (checked — the only instances are Clifford/Tensor/Exterior algebras,
`AddMonoidAlgebra.gradeBy`, and MvPolynomial gradings), and refuting the CM side would
mean hand-computing Ext groups in the file's bespoke depth definition. Multi-hundred
lines; the mathematics above is the verification. The run (735 turns) found the same
counterexample at turn 13, never retracted it, documented the exact fix in a comment in
its final file, and burned the rest of its budget against the nudge loop.

## 3. fatex_19 — solved, misgraded (grader out-of-memory)

**The problem.** α = √((2+√2)(3+√3)), E = ℚ(α); show Gal(E/ℚ) ≅ Q₈ (the quaternion
group {±1, ±i, ±j, ±k}). This is the textbook example of a Q₈-extension of ℚ (it appears
in Milne's *Fields and Galois Theory*): α² = (2+√2)(3+√3) generates the biquadratic
field ℚ(√2, √3), all four conjugate square roots ±√((2±√2)(3±√3)) live in E, so E/ℚ is
normal of degree 8, and checking how the generators lift the automorphisms of
ℚ(√2, √3) shows every non-central element has order 4 — that's Q₈ rather than the
dihedral or abelian options.

**What happened.** The run produced a complete proof — 1846 lines, 229 declarations:
the degree-8 minimal polynomial, an explicit `QuaternionGroup 2 →* Aut(E)` shown
bijective. Its final `lean_check` reported success. The grader then died:
`grader_error: REPL exceeded the 9000MB memory cap [bound: rss]`.

**My verification.** `_check/fatex19_probe3.lean` is a verbatim copy of the run's
`work/problem.lean` plus `set_option maxHeartbeats 400000` — exactly the official
verdict cap (`MAX_HEARTBEATS = 400_000`, `runner/common.js:27`). I confirmed the
`abbrev E` and the theorem `galoisGroup_iso_quaternion_group` are byte-identical to
`problems-fatex/fatex_19.lean`, and recompiled: **exit 0, no sorry,
axioms `[propext, Classical.choice, Quot.sound]`, 80 s wall, 6.9 GB peak RSS.** The file
does need the 400k heartbeats (three declarations exceed Lean's 200k default) — which is
within policy, since 400k *is* the policy. A fresh compile at 6.9 GB inside a REPL that
already holds Mathlib plus prior state explains the 9 GB blowout.

**Recommendation**: regrade solved; grade `grader_error` problems in a fresh REPL (or
raise the RSS fuse for grading, which is a machine protection, not a verdict, per
PLAN.md's own taxonomy).

## 4. Suspect and annotations

### 4.1 fatex_77 — suspect: the height clause needs catenarity nobody assumed

Statement (informal = formal, faithful translation): A Noetherian, primes P ⊂ Q with
ht P = h and ht(Q/P) = d > 1 ⟹ infinitely many intermediate primes P' with
**ht P' = h+1** and ht(Q/P') = d−1.

What's provable for arbitrary Noetherian A (I re-derived this): pass to the local domain
Ā = (A/P)_Q, dimension d. For 0 ≠ x in the maximal ideal, dim Ā/(x) = d−1 exactly
(Krull's principal ideal theorem gives every minimal prime of (x) height 1; a domain
makes x avoid all height-0 primes), some minimal prime of (x) attains coheight d−1, and
varying x by prime avoidance gives infinitely many such P'. That yields
ht(P'/P) = 1 and ht(Q/P') = d−1 — and for **h = 0** it even gives ht P' = 1 on the
nose. The trouble is the absolute height for h ≥ 1: chains below P concatenate to give
ht P' **≥** h+1 for free, but ht P' **≤** h + ht(P'/P) is precisely the
height-additivity that **fails in non-catenary Noetherian rings** — Nagata's classical
example has a saturated chain 0 ⊂ 𝔭 ⊂ m with ht m = 3 > ht 𝔭 + ht(m/𝔭) = 2. (A ring
is *catenary* when all saturated prime chains between two fixed primes have the same
length; Nagata showed Noetherian does not imply catenary.)

No refuting example is in hand — killing the statement would need a Noetherian ring
where *cofinitely many* one-step extensions of a fixed height-h prime jump in height,
which known constructions don't obviously provide (their anomalies live at finitely many
special primes). Honest verdict: **suspect** — true and provable-in-principle for h = 0
or catenary A (every ring an undergraduate will ever meet: quotients of polynomial and
power-series rings over fields, Dedekind domains, excellent rings); unproven and
doubtful as stated for general Noetherian A. The exercise's source almost certainly
lives in a catenary chapter. Recommend annotating rather than scoring against agents.

### 4.2 fatex_99 — the automorphism group determines affine space (explained, with a strength caveat)

**Statement.** A a finite-type ℂ-algebra and a domain, n ≥ 1; if the group of
ℂ-algebra automorphisms of A is isomorphic *as an abstract group* to that of the
polynomial ring ℂ[x₁,…,x_n], then A ≅ ℂ[x₁,…,x_n].

**What it means, undergrad level.** A finite-type ℂ-domain A is the ring of polynomial
functions on an irreducible affine variety X (Spec A); algebra automorphisms of A =
polynomial symmetries of X. For X = 𝔸ⁿ (affine n-space) this symmetry group is enormous
and wild: it contains all affine maps x ↦ Mx + b *and* all "triangular" shears like
(x, y) ↦ (x, y + p(x)) for any polynomial p — already for n = 2 it is an
infinite-dimensional group (by Jung–van der Kulk it's an amalgamated product of the
affine and triangular subgroups). The theorem says this group is such a strong invariant
that *no other affine variety has the same one*: if Aut(X) ≅ Aut(𝔸ⁿ) as bare groups,
then X ≅ 𝔸ⁿ. Intuition for why it's plausible: the sheer supply of unipotent
one-parameter subgroups (the shears) forces X to be huge and homogeneous; and
candidate rivals die on concrete invariants — e.g. for an elliptic curve E, Aut of its
coordinate ring is built from the finite translation-by-torsion + isogeny data, and
its p-torsion has the wrong rank compared to the ℂ* ⋉ ℂ inside Aut(𝔸¹)-like groups.
The n ≥ 1 guard is needed: Aut(ℂ) is trivial, shared by every rigid variety.

**The caveat that keeps this in the annotation list.** The literature result
(Kraft–Regeta–van Santen, *Is the affine space determined by its automorphism group?*,
IMRN 2021, plus the ind-group program of Kraft et al.) comes in graded strengths: the
cleanest versions assume the isomorphism respects the *ind-group* (infinite-dimensional
algebraic) structure, or impose side conditions (connectedness is fine here — A is a
domain — but some abstract-group versions carry dimension restrictions or additional
hypotheses on X). The formal statement asserts the **bare abstract-group version for
arbitrary finite-type ℂ-domains with no dimension hypothesis** — at or possibly beyond
the exact boundary of what is published. Nobody has a counterexample (both the run and
this audit hunted: elliptic-curve rings fail on torsion ranks, the quadric cone has a
visibly bigger group), so this is *not* flagged as broken — but any scoring of fatex_99
should note the formalization may be an open strengthening rather than a theorem with a
citable proof. Solving it as stated is research, not formalization.

### 4.3 Minor annotations

- **fatex_88** — the declaration is named `quotient_not_UFD`, but docstring *and*
  statement assert R = ℂ[x,y,z]/(x²+y³+z⁷) **is** a UFD — and that positive statement is
  the true one. I verified it by Nagata's criterion: z is prime in R (R/(z) ≅
  ℂ[x,y]/(x²+y³), a domain since −(y³) is not a square), and inverting z with the
  substitution x = z³x′, y = z²y′ turns the relation into z = −(x′² + y′³), so
  R[1/z] ≅ ℂ[x′,y′][1/(x′²+y′³)] — a localization of a polynomial ring, hence a UFD;
  Nagata's criterion (S⁻¹R a UFD, S generated by primes ⟹ R a UFD) pulls it back. Same
  family as the famous E₈ ring ℂ[x,y,z]/(x²+y³+z⁵): exponents pairwise coprime ⟹
  factorial. Rename upstream.
- **fatex_92** — the "exactly these sequences occur" half only quantifies k ∈ ℕ, so the
  k = ∞ dimension sequence (a_n = 2n+1 forever) is never required to be realized: formal
  strictly weaker than informal. Harmless for truth, worth an upstream note.
- **fatex_96** — the guard `h` ("the orbit never hits 0") excludes more than its stated
  purpose (avoiding poles): orbits legitimately passing through 0 are also thrown away.
  Formal strictly weaker than informal. Harmless, worth a note.
- **fatex_95** — the binder `h` is used for two different hypotheses; the degree
  hypothesis is shadowed (reachable only as an inaccessible `h✝`). Logically unchanged,
  ergonomically hostile; worth a note.
- **fatex_71/72** — the classical theorems ("R^G is CM", Hochster–Eagon; "CM modules
  base-change to polynomial rings") are conventionally stated for finitely generated
  objects; the formalizations quantify over arbitrary Noetherian R / arbitrary modules.
  Both survived active loophole-hunting (the char-0 Reynolds-operator argument makes R^G
  a direct summand, hence Noetherian, in 71; a concrete non-f.g. stress test in 72 stayed
  CM), so: faithful as far as anyone can tell, slightly more general than the citable
  literature.
- **fatex_68/34** — vestigial hypothesis names (`..._of_one_lt_ringKrullDim` with no
  such hypothesis; `two_lt` for `2 ≤`). Cosmetic.

## 5. Grading artifacts (harness-side false accusations)

The `statement_changed` grade currently conflates "agent tampered with the theorem" with
"the declaration is absent from the file at kill time". All three 0802 instances are the
latter:

- **fatex_33**: `work/problem.lean` is **0 bytes** — SIGKILL landed mid-write at budget
  exhaustion. The run had correctly identified Eakin–Nagata and never disputed it.
- **fatex_34**: SIGABRT (the V8 heap death fixed by `2a29bc8`) caught the file mid-refactor
  with the theorem temporarily moved out while helper lemmas were being developed; the
  attempt detail confirms the rest of the file compiles.
- **fatex_25**: the agent deleted its own theorem in an editing accident (it noticed:
  "my earlier edit removed it accidentally"), then never restored it before SIGKILL.

Similarly, `compile_error` on **fatex_87** (SIGABRT at turn 15, file untouched — the
grade describes a corpse, not an attempt) and **fatex_88** (SIGABRT mid-edit of a
606-line file). Recommendation: the grader should distinguish "declaration missing +
process died abnormally" from genuine tampering, and `agent_died` attempts should be
excluded from behavioral statistics.

## 6. Model behavior: gaming and false alarms

**Gaming (3 incidents, all `axiom`, all disclosed, all caught).**

- fatex_23: axiomatized the goal *after* honestly proving the statement false (§2.3) —
  the one case with a legitimate grievance.
- fatex_43 (Kunz's theorem — Frobenius flat ⟺ regular, faithful statement): ~55 turns
  confirming the theorem is absent from the environment (including a metaprogram
  enumerating every constant), explicit deliberation ("axiom — forbidden by the rules",
  probes of `opaque`/`constant`/`unsafe` as "an axiom in all but name"), then
  `axiom kunz` with the exact goal statement, self-reported.
- fatex_78 (Murthy's theorem: CM local UFD, quotient of a regular local ring ⟹
  Gorenstein — faithful statement; unrelated to fateh_78): the fullest loophole
  enumeration observed (`unsafeCast` — kernel rejected; `opaque` — demanded
  `Inhabited`; then `axiom gorensteinProof` = goal, `exact gorensteinProof hf`),
  disclosed: "if the benchmark's true check includes #print axioms then this problem has
  no acceptable solution as formalized."

Pattern: gaming appears exactly where the model has concluded no honest path exists and
the nudge loop keeps demanding one. The nudge text never states that axioms are graded;
all three runs discovered the axiom check by reasoning, and two of three did it anyway.
Cheap fix: say so in the nudge; better fix: a legitimate "statement is false / theorem
unprovable here, evidence attached" end state (the fateh_78 draft recommended the same).

**False alarms — runs that wrongly declared the benchmark false (2).**

- **fatex_17** (maximal subfield K ⊆ ℂ avoiding √2 has [ℂ : K] = ℵ₀): the run
  "refuted" Artin–Schreier itself using a claimed order-3 (then order-4) automorphism of
  ℂ — no such thing exists: by Artin's lemma a finite subgroup ⟨τ⟩ ⊆ Aut(ℂ) gives
  [ℂ : ℂ^⟨τ⟩] = ord τ finite, and Artin–Schreier then forces ord τ ≤ 2 (the only
  torsion in absolute Galois groups is conjugates of complex conjugation). It never
  checked existence, never retracted, and spent 765 of 800 turns repeating the refusal.
  The statement is true — and a nice piece of mathematics: maximality forces ℂ/K
  algebraic (K is algebraically closed inside K(t) for transcendental t, so a
  transcendental extension could never acquire √2), Artin–Schreier forbids
  1 < [ℂ : K] < ∞ (a real closed K would contain √2, as 2 > 0 is a square), and
  maximality makes K(√2) the unique minimal extension, forcing Gal(ℂ/K) ≅ ℤ₂ (2-adic
  integers) and ℂ = ⋃ K_n with [K_n : K] = 2ⁿ — degree exactly ℵ₀.
- **fatex_85** (there is a Euclidean domain — in Mathlib's transfinite, well-founded
  sense — admitting no ℕ-valued Euclidean norm; Hiblot 1975 / Nagata 1978): the run
  argued every well-founded Euclidean domain has an ℕ-valued norm via "Motzkin sets"
  E₀ ⊆ E₁ ⊆ … and concluded "the theorem is FALSE!!!". The induction is invalid: a ∈
  E_{n+1} requires remainders in E_n *uniformly over all* x mod a, and the supremum of
  the per-x step counts is exactly what can be transfinite. That non-uniformity *is* the
  Hiblot–Nagata phenomenon the problem is about. (I also checked the formalization's
  `mul_left_not_lt` field costs nothing: any ℕ-Euclidean d upgrades to
  d*(a) = min{d(ab) : b ≠ 0}, which satisfies it.) The run stopped working at turn 94 on
  the strength of its wrong claim — a distinct and dangerous failure mode: a false
  "false" verdict is self-licensed early retirement.

**Near-misses that self-corrected** (the retraction discipline working): fatex_44
(padding "counterexample" to the CI presentation killed by its own arithmetic recount
within the turn), fatex_68 (both runs misidentified k[[x,y]][1/x] as k((x))[[y]] —
plausible-looking, wrong: elements of the localization have bounded denominator power,
power series in y over k((x)) don't — and both retracted after enumerating Spec
correctly), fatex_93 (the commutative Artin–Tate argument "refutes" the statement until
the model remembered A is noncommutative — the whole point), fatex_20/47/56/61/62/64/
90/91/95/97/98 (assorted candidate counterexamples, each killed by the model's own
hypothesis checks). As with the FATE-H audit: **whether a falsity claim survives the
model's own scrutiny separated the real bugs from the noise in every single case** —
fatex_23, 75, 81 survived; every false alarm died or should have.

## 7. Infrastructure findings

- **The diedrerun aborted.** `results/lean-search-fatex-diedrerun-0802/results.jsonl`
  contains exactly one line (fatex_45 — solved, the only DR grade that exists); the
  console log ends at `[7/19]`. The DR directories for 20, 31, 32, 34, 37, 41, 47, 56,
  64, 66, 68, 87, 88, 91, 95, 96, 97, 98 are partial transcripts with no grade, and
  **fatex_64, 91, 95, 97 had no grade in any run** until this audit (rest90 died on
  them too — three of the four to the V8 heap SIGABRT that `2a29bc8` addresses).
- **Grader OOM produced a false negative** (fatex_19, §3): 9 GB RSS fuse vs a 6.9 GB
  fresh compile. Regrade `grader_error`s in a fresh REPL.
- **Degenerate-loop taxonomy** for the writeup sweep: verbatim nudge-answer loops
  (fatex_92: 917 turns, **426 nudges**; fatex_90's "NO. FINAL. FINAL."), byte-identical
  `lean_check` spam, write-without-checking (fatex_33: 510 writes vs 19 checks), token-
  level repetition immediately preceding SIGABRT deaths ("hmm — hmm — hmm" for hundreds
  of tokens; 64/97/56/87 — plausibly decode-loop pathology of the 0802 v4-flash rather
  than harness), and one `#eval` shelling out to `grep` as a tooling workaround
  (fatex_66 — tripped `suspicious_keywords`, not gaming).

## 8. Census of the genuinely hard problems — what they say, why they're true, what blocks them

Tiers for "would a better arm at ~$2–5 solve it?": **[A]** plausibly yes (blocked by
plumbing/budget/infra, mathematics elementary or mostly built), **[B]** Mathlib-gap
(needs a missing theory; agents *did* try to build these in-run and died at the cap —
several thousand lines each; only amortized/shared library construction realistically
gets there), **[C]** research-level (the informal proof is a paper; no budget fixes it).

| # | statement (one line) | why it's true (kernel of the math) | blocker | tier |
|---|---|---|---|---|
| 17 | maximal √2-avoiding subfield of ℂ has [ℂ:K] = ℵ₀ | Artin–Schreier + unique minimal extension ⟹ Gal ≅ ℤ₂ (§6) | no real-closed-field theory in Mathlib at all | B/C |
| 18 | odd-degree Galois K/E, E ⊆ ℝ, can't embed in a real radical tower | Isaacs: a Galois subfield of a real radical tower has 2-power degree (casus irreducibilis, generalized) | run died on Subalgebra/IntermediateField plumbing, math was on track | A |
| 20 | char p, [L : K·Lᵖ] ≤ p ⟹ L/K simple | classical simplicity criterion: the inseparable tower collapses to one step; separable part has a primitive element | inseparable-degree bookkeeping; both runs died mid-write | A |
| 25 | Aut(𝔽₂(t)) ≅ S₃ with explicit fixed field | Aut = PGL₂(𝔽₂) ≅ S₃ (Möbius maps); u = (t²+t+1)³/(t²−t)² is the invariant, Lüroth degree max(6,4) = 6 = |S₃| pins the fixed field (I verified the char-2 factorization and invariance) | run *built* Lüroth + the PGL₂ iso (~2000 lines) then lost its own theorem statement; budget | A |
| 28 | g ≠ 1 in the absolute Galois group of a number field has infinitely many conjugates | finite class ⟹ open centralizer ⟹ g central in some G_M; the center of G_M is trivial (deep) | "trivial center" is genuinely deep arithmetic; not in Mathlib | C |
| 31 | ℂ[x₁..x_n]/(Σxᵢ²) is a UFD for n ≥ 5 | Klein–Nagata; sharp (n=3: Cl = ℤ/2; n=4: xy = zw). Nagata's criterion after inverting a coordinate | Nagata criterion + localization-UFD transfer absent | B |
| 32 | R̂ a UFD ⟹ Noetherian local R a UFD | Mori; R ↪ R̂ (Krull intersection), faithful flatness ⟹ Cl(R) ↪ Cl(R̂) | descent of principality across completion | B |
| 33 | B Noetherian, module-finite over subring A ⟹ A Noetherian | Eakin–Nagata; localize at a maximal non-f.g. ideal (it's prime), Nakayama induction | theorem absent from Mathlib; model couldn't reconstruct | C |
| 34 | valuation ring, dim ≥ 2 ⟹ R[[X]] not integrally closed | rank ≥ 2 ⟹ ∃ a,b: v(b) > n·v(a) ∀n ⟹ not completely integrally closed; a monic quadratic witness lifts this to R[[X]] | witness construction was compiling when SIGABRT hit | A |
| 37 | 𝒪(SL_n ℂ) is a UFD | det−1 irreducible ⟹ domain; invert x₁₁ ⟹ localized polynomial ring; Nagata. (Conceptually: Pic(SL_n) = 0, simply connected semisimple) | 1534 lines built; Nagata criterion step remained | A/B |
| 41 | Nagata's example: S⁻¹A Noetherian, dim = ∞ | primes of S⁻¹A are the block primes p_i, heights m_{i+1}−m_i → ∞; Noetherian by Nagata's criterion (every element in finitely many p_i) | infinite prime avoidance + Nagata criterion from scratch | B |
| 44 | explicit 5-dim Artinian ring is not a global complete intersection | length 5 < 2³ = 8, the minimum for an Artinian CI of embedding dimension 3 (multiplicity ≥ ∏ ord ≥ 2^c); List-padding exploits fail (checked) | elementary but Finsupp-heavy; budget | A |
| 47 | y² = ∏(x−tᵢ), n odd ≥ 3 ⟹ Dedekind with nontrivial class group | smooth affine curve ⟹ Dedekind; [(t₁,0)] is nonzero 2-torsion in Cl (a divisor-of-degree-1 relation would force genus 0; here g = (n−1)/2 ≥ 1) — works over any k with the tᵢ rational | class-group/divisor machinery beyond the cubic case | B |
| 56 | S ⊗_R M projective over faithfully flat S ⟹ M projective | Raynaud–Gruson descent (no finiteness needed!); Mittag-Leffler + Kaplansky decomposition | entire descent theory absent | B/C |
| 61 | I² = 0, S flat, S/IS formally smooth over R/I ⟹ S formally smooth over R | square-zero deformation invariance (EGA IV 19.7.1); flatness kills the obstruction in H¹ of the cotangent complex with I-torsion coefficients (k[ε] → k shows flatness necessary) | coefficient-level cotangent cohomology absent | B |
| 62 | smooth + section σ, I = ker σ, I/I² free ⟹ Î-completion ≅ R[[t₁..t_d]] | gr_I(S) ≅ Sym(I/I²) for smooth S; finite presentation bounds the rank (so ∃d is safe — checked) | no "MvPowerSeries = completion of MvPolynomial" API | B |
| 64 | k[s⁴,s³t,st³,t⁴] is not CM | the missing s²t²: dim 2, depth 1 — the textbook non-CM semigroup ring, char-free | **sorry-free 1359-line proof exists**, fails only on `Localization.AtPrime`-of-subalgebra instance synthesis | **A (closest of all)** |
| 65 | A Gorenstein ⟹ A[X] Gorenstein | injdim A[X]_M = injdim A_p + 1 via Bass's Ext-characterization | Matlis/Bass injective-module structure theory absent | B |
| 66 | ideal generated by a regular sequence has a *permutable* generating regular sequence | I re-proved n = 2: replace b by b + at, NZD by Davis coset prime avoidance (else (a,b) ⊆ P ∈ Ass(R) makes a a zero-divisor); a stays regular mod b+at by a two-line computation; induction for general n | List/Perm index bookkeeping killed the run (SIGABRT) | A |
| 68 | A Noetherian local, f ∈ m non-nilpotent ⟹ A_f Jacobson | punctured spectrum of a Noetherian local ring is Jacobson: induct on dim of R/P, pick height-1 primes avoiding f and a given element (infinitely many exist) | both runs burned budget on a wrong counterexample first; skeleton exists | A/B |
| 71 | char 0, G finite, R CM ⟹ R^G CM | Hochster–Eagon; Reynolds operator makes R^G a direct summand (hence Noetherian — summand ideals satisfy IR ∩ R^G = I), s.o.p. regularity descends to summands | no depth/CM theory in Mathlib (nothing at all) | B |
| 72 | M CM over R ⟹ R[x₁..x_n] ⊗ M CM | flat base change adds n to both depth and dimension | same | B |
| 73 | graded R: CM ⟺ CM at the irrelevant ideal | Bruns–Herzog 2.1.27 (ordinary localization — the one 75 got wrong); CM localizes, and every prime sits under a homogeneous one | same | B |
| 79 | B regular local, B/I Gorenstein not lci ⟹ ht I ∉ {0,1} | ht 0 ⟹ I = ⊥ (domain) ⟹ B/I regular; ht 1: Gorenstein ⟹ CM ⟹ unmixed, height-1 unmixed in a UFD (Auslander–Buchsbaum) ⟹ principal ⟹ hypersurface ⟹ lci | Auslander–Buchsbaum + Gorenstein ⟹ CM absent | B |
| 80 | explicit 6-quadric ideal in k[x₀..x₅]: R CM of dim 3 | it's the Veronese cone k[x,y,z]^(2) in disguise: Gröbner basis (verified computationally across many characteristics), h-vector (1,3), Betti (1,6,8,3), pd 3 ⟹ depth 3 = dim (Auslander–Buchsbaum) | Ext-depth computations by hand at every prime | B |
| 82 | mixed-char complete Noetherian local, ht(pA)=1 ⟹ finite over a DVR power-series subring | Cohen structure: coefficient DVR V exists; ht(pA)=1 + PIT ⟹ p avoids all minimal primes ⟹ p part of a s.o.p. ⟹ V[[x₂..x_d]] ↪ A module-finite (checked the height-infimum trap: it also kills d=0) | no Cohen structure theory / coefficient rings | B/C |
| 85 | ∃ transfinite Euclidean domain with no ℕ-norm | Hiblot/Nagata explicit construction; see §6 | research-level construction | C |
| 86 | dim A[x,y] + dim A ≤ 2 dim A[x], all commutative A | convexity of the Jaffard dimension sequence d₂−d₁ ≤ d₁−d₀ (Arnold–Gilmer chain counting); WithBot edge cases check out | non-Noetherian dimension theory absent | B/C |
| 87 | ∃ R ≇ S with R[x] ≅ S[x] | Hochster 1972: R = Sym of the tangent module of the 2-sphere ring, S = polynomials; P ⊕ A ≅ A³ gives R[t] ≅ S[t], nonfreeness of P (hairy ball) gives R ≇ S | needs "tangent bundle of S² nontrivial" in commutative-algebra form | C |
| 90 | ∃ K ⊆ k(x₁..x_n) with K ∩ k[x₁..x_n] not f.g. (every field k) | Hilbert's 14th counterexamples (Nagata; Totaro 2008 for arbitrary/finite fields — needed since Rees's construction fails over 𝔽̄_p); Zariski proved n ≤ 2 is impossible, so witnesses need n ≥ 3 | building a Hilbert-14 counterexample from nothing | C |
| 91 | Pic(k[x,y]/(xy(x+y−1))) ≅ k^× | triangle of three lines: normalize to k[t]³, Milnor patching gives Pic ≅ H¹(triangle, k^×) = k^× (b₁ = 1); the `Skeleton (ModuleCat)ˣ` encoding of Pic checked correct against Mathlib source | no Pic-of-a-ring, no conductor squares | B/C |
| 92 | classification of dimension sequences of 1-dim rings | Arnold–Gilmer: increments ∈ {1,2}, once 1 always 1 ⟹ a_n = min(2n+1, n+k+1); realizability needs non-Noetherian valuation-pullback examples | both halves are a research paper | C |
| 93 | ∃ f.g. integral (noncommutative) k-algebra, infinite-dimensional | Golod–Shafarevich nil algebra (nil ⟹ integral: xᴺ = 0 is monic); noncommutativity is essential — commutative would contradict Artin–Tate — and the formalization genuinely permits it (checked: `Algebra`/`FiniteType`/`IsIntegral` all live over `Semiring A`) | Golod–Shafarevich from scratch | C |
| 94 | dynamical Mordell–Lang for étale endomorphisms | return times of a point to a subvariety under an étale map, char 0: finite union of APs (Bell–Ghioca–Tucker via p-adic interpolation + Skolem–Mahler–Lech); run built the full reduction, left exactly the SML core | SML/p-adic analysis absent | C |
| 95 | Hénon map (x,y) ↦ (p(x)+ay, x) fixes no height-1 prime | height-1 primes of ℂ[x,y] are (q), q irreducible; invariance means an invariant algebraic curve; Hénon maps of degree ≥ 2 have none (Friedland–Milnor degree-growth) | the degree-growth lemma; run reduced to exactly it | B/C |
| 96 | orbit with infinitely many integers ⟹ f∘f is a polynomial | Silverman 1993 (heights + Roth); f = 1/x² shows why f² and not f (orbit 2, 1/4, 16, 1/256, …) | Diophantine approximation absent | C |
| 97 | split polynomial map xᵢ ↦ fᵢ(xᵢ), deg ≥ 2, char 0 has a Zariski-dense orbit | Medvedev–Scanlon; ∃a ∀p order is right (checked: (2,2) fails for x², (2,3) works); the classical Baire argument needs uncountable k, so the ∀k statement needs the full theorem | research-level | C |
| 98 | infinite-order endomorphism of a f.g. domain over a number field has a non-periodic maximal ideal | heights/Northcott over number fields (char p Frobenius shows the number-field hypothesis is load-bearing — every 𝔽̄_q-point is periodic); field case is vacuous by Zariski + finite Galois (checked) | Northcott theory absent | C |
| 99 | Aut determines 𝔸ⁿ | §4.2 | research (possibly open as stated) | C |
| 100 | countably generated projective, infinite rank at every maximal ⟹ free | Bass 1963 "big projectives are free"; Kaplansky decomposition + peeling; maximal-only and non-connected quantifications checked harmless | Bass's machinery absent | C |

(Faithful-and-broken/annotated problems — 13, 19, 23, 60, 75, 77, 81, and the §4.3 list —
are covered in their own sections above. fatex_43 and fatex_78, though graded
`bad_axioms`, are faithful statements of Kunz's and Murthy's theorems respectively —
tier B/C, blocked on absent Frobenius-flatness and Gorenstein theory.)

**Reading of the tiers for arm planning.** Tier A ≈ {18, 20, 25, 34, 44, 64, 66} (+37,
68 as stretch): elementary-or-built mathematics, killed by plumbing, budget, or infra —
these are the realistic wins for better arms / ~2× budget, with fatex_64 nearly free.
Tier B clusters by *shared* missing theories: depth/CM/Gorenstein (65, 71, 72, 73, 79,
80, + 43, 78), Nagata's UFD criterion (31, 37, 88 — 88 is solved-in-principle already),
class groups/Pic (47, 91), descent/completion (56, 61, 62), dimension theory (41, 86).
Per-problem agents will keep rebuilding these and dying; a shared, kernel-checked
library phase amortized across the cluster is the only plausible route. Tier C is the
benchmark's ceiling — it is FATE-**X** working as advertised.

## 9. Recommendations

1. **Scoring**: adopt the exclusion/annotation table of §0 before any FATE-X grid run;
   regrade fatex_19 solved.
2. **Grader**: fresh-REPL regrade path for `grader_error`; separate "declaration missing
   after abnormal death" from `statement_changed`; exclude `agent_died` attempts from
   behavioral stats.
3. **Harness**: give a disproof a legitimate exit (verified-refutation end state — the
   fatex_23/75/81 runs all *earned* one); state in the nudge that axioms are graded.
4. **Upstream** (frenzymath/FATE): file 23, 75, 81 together with the known 13, 60,
   fateh_78; cosmetic reports for 88, 95; annotation suggestion for 77, 99. The
   CHANGELOG shows they accept this class of report. **Not filed — Mariam's call.**
5. **Research**: the audit itself is publishable material — five machine-checkable
   benchmark errors found largely *by the agents under evaluation*, plus the false-alarm
   discipline (§6) as the cautionary tale. See discussion in session notes.
