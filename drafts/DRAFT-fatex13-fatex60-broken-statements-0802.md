# fatex_13 and fatex_60 are both false as formalized — analysis and verification (2026-08-02)

**TL;DR.** Both agent claims from `lean-search-fatex-rest90-0802` (deepseek-v4-flash,
thinking high) are **correct**: the two Lean statements are false, and both runs produced
machine-checked refutations in their own `problem.lean`. I re-verified both independently
in `lean-env/_check`, and proved the corrected fatex_13 from scratch (~90 lines, no
sorries). Two corrections to the summaries that reached us:

- **fatex_13 is *not* missing a commutativity hypothesis.** The informal statement says
  "(not necessarily commutative) ring" on purpose. The bug is that "R is not a **field**"
  means "not a **skew field** (division ring)" in the source, and was rendered with
  Mathlib's `IsField`, which *demands* commutativity — so for any noncommutative ring the
  hypothesis becomes free, and ℍ walks in. Adding `[CommRing R]` would produce a true but
  strictly weaker theorem, i.e. a different problem. The faithful fix is to negate
  "division ring". Under that fix **the theorem is true** — proved.
- **fatex_60 has two independent bugs, not one.** Besides `associatedPrimes R I`
  elaborating to `associatedPrimes R ↥I` (the ideal as a module), `ringKrullDim (R ⧸ p)`
  is the *co*height dim(R/p), not the codimension ht(p). The run's agent found both; the
  summary that reached us mentioned only the first.

Artifacts (all compile clean under our v4.27.0 Mathlib pin, exit 0, axioms
`[propext, Classical.choice, Quot.sound]` only):

- `lean-env/_check/fatex13_counterexample.lean` — ℍ refutes the statement.
- `lean-env/_check/fatex13_corrected.lean` — corrected statement, **fully proved**, plus
  the corollary that the conclusion forces commutativity.
- `lean-env/_check/fatex60_counterexample.lean` — ℤ with `I = ⊥` refutes the statement;
  the second (codimension) bug refuted separately; the RHS collapse demonstrated over
  ℚ[X,Y]; corrected statement stated and sanity-checked.

Upstream `frenzymath/FATE` fetched 2026-08-02: `origin/main` = `bb646ec` (v1.2.0,
2026-02-23), `FATE-X/FATEX/13.lean` and `60.lean` unchanged. The issue tracker was not
checked (no `gh` on this box). The CHANGELOG shows upstream does accept exactly this class
of report (X-11, X-77 "Added missing Noetherian condition", X-86).

---

## 1. fatex_13

Informal (`FATEX/13.lean` docstring, identical in `FATE-X.json`):

> Let $(R,+,\cdot)$ be a (not necessarily commutative) ring. If we know that $R$ is not a
> field and $x^2=x$ for any $x\in R,$ where $x$ is not invertible. Prove that $x^2=x$ for
> any $x.$

Formal:

```lean
theorem sq_eq_self_of_not_unit {R : Type} [Ring R] (h : ¬ IsField R)
    (h2 : ∀ x : R, ¬ IsUnit x → x^2 = x) (x : R) : x^2 = x
```

### Why it is false

Mathlib's `IsField` is a *commutative* notion:

```lean
structure IsField (R) [Semiring R] : Prop where
  exists_pair_ne : ∃ x y : R, x ≠ y
  mul_comm : ∀ x y : R, x * y = y * x        -- ← the whole problem
  mul_inv_cancel : ∀ {a : R}, a ≠ 0 → ∃ b, a * b = 1
```

So `¬ IsField R` is satisfied by *every* noncommutative ring, in particular by every
noncommutative division ring — where `h2` is vacuous, because 0 is the only non-unit.
Take R = ℍ (Hamilton quaternions over ℝ):

- `¬ IsField ℍ` — from `h.mul_comm i j`, since `i*j = k` and `j*i = -k`;
- `h2` holds: `¬ IsUnit x → x = 0 → x² = 0 = x` (`isUnit_iff_ne_zero` in a division ring);
- conclusion fails: `i² = -1 ≠ i`.

All three are machine-checked, and `fatex13_false` refutes the universal closure of the
benchmark statement.

### What the problem actually means, and why it is then true

"Field" here is the skew field / *corps* / Körper usage that goes with "not necessarily
commutative" — otherwise the hypothesis "R is not a field" would carry no information for
any noncommutative R, which is exactly the degeneracy that breaks the statement. Spelled
out: ¬(R nontrivial ∧ every nonzero element is a unit), i.e. R is trivial or has a nonzero
non-unit.

Under that hypothesis the theorem is true. Write N for the set of non-units, all
idempotent by `h2`, and fix a nonzero non-unit `a`:

1. `y ∈ N ⇒ -y ∈ N` (as `-y = (-1)·y` and `-1` is a unit), so `y² = -y`; with `y² = y`
   this gives **`y + y = 0` for every non-unit**.
2. `y ∈ N`, `u` a unit `⇒ uy ∈ N ⇒ (uy)² = uy ⇒ **y u y = y**` (cancel `u` on the left).
3. For `b ∈ N \ {0}`: `(1+b)² = 1 + 2b + b² = 1 + b`, so `1+b` is idempotent; an
   idempotent unit is 1, which would force `b = 0`; and `1+b = 0` would make `b = -1` a
   unit. So **`1+b` is again a nonzero non-unit**.
4. Feed `1+b` into (2): `(1+b)u(1+b) = 1+b`, expand, use `bub = b`, cancel `b`:
   **`u + ub + bu = 1`** for every unit `u` and every nonzero non-unit `b`. (★)
5. Apply (★) at `b` and at `1+b` (legal by (3)) and subtract: **`u + u = 0`** for every
   unit; at `u = 1`, **`1 + 1 = 0`**.
6. If `u ≠ 1` is a unit then `u+1` is a unit — otherwise it is idempotent, and
   `(u+1)² = u² + 2u + 1 = u² + 1`, forcing `u² = u` and `u = 1`. Now run (★) at the unit
   `u+1` and subtract (★) at `u`: everything cancels down to `1 = 0`, contradicting
   nontriviality.

So 1 is the only unit, every other element is a non-unit, and `x² = x` throughout — R is
Boolean, and therefore (a free bonus, also checked) commutative. The trivial-ring branch
is immediate. This is `fatex13_corrected`.

Note the shape of the result: the hypothesis "not a division ring" is doing real work
(ℍ shows it cannot be dropped), and the conclusion retroactively makes R commutative —
which is presumably why the source felt entitled to say "not necessarily commutative".

### Suggested upstream fix

```lean
theorem sq_eq_self_of_not_unit {R : Type} [Ring R]
    (h : ¬ (Nontrivial R ∧ ∀ x : R, x ≠ 0 → IsUnit x))
    (h2 : ∀ x : R, ¬ IsUnit x → x^2 = x) (x : R) : x^2 = x
```

(or `(a : R) (ha : a ≠ 0) (hau : ¬ IsUnit a)` if a positive hypothesis is preferred;
the trivial-ring case is then excluded and the proof is unchanged). The problem's own
tags — "Field Theory, Galois theory" — hint at how the skew-field reading got lost.

## 2. fatex_60

Informal:

> Let $R$ be a Noetherian domain, and suppose that for every maximal ideal $P$ of $R$ the
> ring $R_P$ is factorial. Let $I \subset R$ be an ideal. Prove that $I$ is an invertible
> module iff $I$ has pure codimension $1$. (We say that an ideal $I$ in a ring $R$ has pure
> codimension $1$ if every associated prime ideal of $I$ has codimension $1$. We include
> the case when $I$ has no associated primes at all---that is, when $I = R$.)

Formal:

```lean
theorem invertible_iff_codimension_one (R : Type) [CommRing R] [IsDomain R] [IsNoetherianRing R]
    (h_ufd : ∀ (p : Ideal R), (h : p.IsMaximal) → UniqueFactorizationMonoid (Localization.AtPrime p))
    (I : Ideal R) : I.Invertible ↔ ∀ (p : associatedPrimes R I), ringKrullDim (R ⧸ p.1) = 1
```

This is Eisenbud's exercise (*Commutative Algebra with a View Toward Algebraic Geometry*,
ch. 11, the "pure codimension 1" exercise); in Eisenbud, "associated primes **of an
ideal** I" means Ass(R/I) and "codimension" means height.

### Bug 1 — `associatedPrimes R I` is Ass(↥I), the ideal as a module

`associatedPrimes` takes a module, so `I : Ideal R` is coerced with `↥`:
`associatedPrimes R I = associatedPrimes R ↥I` (checked by `rfl`). The informal
statement's own parenthetical settles the intent: **Ass(R/I) = ∅ ⟺ I = R**, exactly the
case the author flags. For the module reading, Ass(↥I) = ∅ ⟺ I = 0 — the opposite end.

Consequences in a domain: for `I ≠ ⊥` every nonzero `x ∈ I` has `ann(x) = ⊥`, so
`Ass(↥I) = {⊥}` (the `⊥ ∈ Ass(↥(2))` witness is checked for ℤ), and the RHS collapses to
`ringKrullDim R = 1` — a statement that does not mention `I` at all. For `I = ⊥` the
module is zero and the RHS is vacuously **true**, while `Invertible ⊥` is **false** by
definition (`I ≠ ⊥`).

**Refutation** (`fatex60_false`): R = ℤ, I = ⊥. ℤ is a Noetherian domain, and `h_ufd`
holds because ℤ is a PID, hence Dedekind, so every localization at a maximal (hence
nonzero prime) ideal is a DVR, hence a PID, hence a UFD — all machine-checked. The run's
agent found the same witness with R = ℚ.

Not an edge case: over any 2-dimensional locally factorial Noetherian domain the RHS
collapses to `dim R = 1` and fails for *every* nonzero ideal. Checked for
`R = ℚ[X,Y]`, `I = (X)`: `I` is invertible, `⊥ ∈ Ass(↥I)`, and `dim (R ⧸ ⊥) = dim R = 2`
(`rhs_false_dim_two`). The only unchecked link there is `h_ufd` for ℚ[X,Y] — true
(localizations of a UFD are UFDs) but not available in Mathlib, so ℤ/⊥ remains the
complete refutation.

### Bug 2 — `ringKrullDim (R ⧸ p) = 1` is the wrong direction

Codimension of `p` is ht(p) = dim R_p. `ringKrullDim (R ⧸ p)` is dim(R/p), the dimension
of V(p) — the *co*height. These coincide only when dim R = 2 (in the catenary
equidimensional situation). Fixing only bug 1 therefore leaves a false statement:
R = ℤ, I = (2) is invertible, Ass(ℤ/(2)) = {(2)} of codimension 1, but
`ringKrullDim (ℤ ⧸ (2)) = dim 𝔽₂ = 0 ≠ 1` (`coheight_reading_still_false`).

### Corrected statement

```lean
∀ (I : Ideal R), I.Invertible ↔ ∀ p ∈ associatedPrimes R (R ⧸ I), p.height = 1
```

Stated as `Fatex60Corrected` (not proved — it is the genuine Eisenbud exercise). It is
true, and its edge cases line up: `I = R` gives Ass = ∅, RHS vacuously true, and `⊤` is
invertible; `I = ⊥` gives Ass = {⊥} of height 0, so RHS is false, matching
`¬ Invertible ⊥` (`corrected_rhs_false_at_bot`, machine-checked — the witness that kills
the benchmark statement no longer bites). Sketch of the mathematics: invertible ⟺ locally
principal (Noetherian + nonzero), and in a local UFD the principal ideals are exactly the
unmixed height-1 ideals — `(f)` with `f = ∏ πᵢ^{nᵢ}` has Ass = {(πᵢ)} all of height 1, and
conversely an ideal with all associated primes of height 1 is `∩ (πᵢ^{nᵢ}) = (∏ πᵢ^{nᵢ})`.
`ringKrullDim (Localization.AtPrime p) = 1` is an equivalent spelling of the RHS
(`IsLocalization.AtPrime.ringKrullDim_eq_height`).

## 3. Run notes

Both runs are the fateh_78 pattern again: correct diagnosis early, then trapped by the
nudge loop until budget.

| | fatex_13 | fatex_60 |
|---|---|---|
| model | deepseek-v4-flash, thinking high | same |
| wall / cost | 26 m / $0.085, 113 turns, 30 nudges | 30 m / $0.079, 82 turns, 6 nudges |
| grade | `uses_sorry` | `uses_sorry` |
| counterexample compiled in-file | yes (ℍ, plus a proof of the *commutative* variant) | yes (ℚ, `example : False` from the statement) |
| diagnosis | correct, but proposed `[CommRing R]` as the fix | correct on **both** bugs |

fatex_13's file even carries a proof of the commutative variant — the model reached for
`[CommRing R]` because that is the cheapest way to make Mathlib's `IsField` meaningful,
without going back to what "field" meant in the source. Worth noting for grading: a run
that refutes the statement *and* proves the intended variant is doing better work than
`uses_sorry` conveys.

Recommendation: exclude/annotate fatex_13 and fatex_60 in FATE-X scoring, and file both
upstream together with fateh_78 (still not filed — ask Mariam).
