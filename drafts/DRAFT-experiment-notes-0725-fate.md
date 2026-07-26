# DRAFT — experiment notes, 2026-07-25 (first FATE runs: FATE-M + FATE-H baseline pilots)

First runs off PutnamBench. Both runs: baseline combo, DeepSeek V4 Flash, thinking off,
7200 s/problem timeout, concurrency 6, sha `079de6d`, launched off-peak
(cost_std = cost_usd for both). Problems: seeded pick (seed 42) from each tier,
first 10 of 12 candidates; all 24 candidate originals compiled unmodified under our
Mathlib 4.27 env despite FATE pinning Lean 4.28.

Prep that made this work (committed alongside these notes):
- `runner/sanitize.js` gained `--src-dir` (other corpora of the same shape) and
  `--prefix` (FATE files are bare numbers; `fatem_`/`fateh_` keeps names unique in the
  shared `problems/stmt-types.json`). Putnam behavior unchanged.
- Sanitized corpora in `problems-fatem/` (150) and `problems-fateh/` (100); picks in
  `pick12.txt`/`dev10.txt` in each dir. Docstrings stripped as with Putnam (formal-only
  default arm).
- stmt-type cache entries built for the 24 picks. Note: `fateh_81` carries an extra
  `def R` above its theorem — `benchmarkDecls` picks up both and the grader protects
  both; the type-level check ports to FATE with zero changes.

## Part 1 — baseline-fatem10-202607252005: FATE-M is saturated (10/10, $0.46)

| problem | result | wall | cost | turns/checks |
|---|---|---|---|---|
| fatem_143 | ✓ | 24 s | $0.001 | 9/3 |
| fatem_100, 112, 108, 115, 48 | ✓ | 38–59 s | ~$0.002 | 4–23 turns |
| fatem_113 | ✓ | 229 s | $0.012 | 66/30 |
| fatem_36 | ✓ | 254 s | $0.012 | 75/32 |
| fatem_133 | ✓ | 1199 s | $0.062 | 159/73 |
| fatem_53 | ✓ | 2915 s | $0.365 | 649/355 |

Textbook abstract algebra ≈ free for the baseline: six problems fell in under a minute
for ~$0.002 each. The cost distribution is extremely heavy-tailed — fatem_53 alone is
79% of run cost (649 turns of grind, but it converged). **Implication: FATE-M cannot
discriminate between arms** (ceiling too low); at most useful as a cheap smoke test of
a new arm's plumbing. Don't pool with FATE-H (paper says the same).

## Part 2 — baseline-fateh10-202607252058: the cliff (3/10, $2.08)

| problem | result | wall | cost | turns/checks |
|---|---|---|---|---|
| fateh_86 | ✓ | 487 s | $0.027 | 85/38 |
| fateh_79 | ✓ | 1183 s | $0.088 | 161/59 |
| fateh_7 | ✓ | 3207 s | $0.036 | 139/67 |
| fateh_22 | ⏱ timeout ⚠ native_decide | 7281 s | $0.079 | 347/158 |
| fateh_36 | ⏱ timeout ⚠ native_decide | 7445 s | $0.078 | 328/161 |
| fateh_56, 57 | ⏱ timeout | 7444 s | ~$0.095 | ~270/~120 |
| fateh_15 | ⏱ timeout | 7445 s | $0.278 | 378/77 |
| fateh_70 | ⏱ timeout | 7207 s | $0.333 | 400/164 |
| fateh_72 | ⏱ timeout | 7215 s | $0.975 | 871/271 |

All 7 failures are wall-clock timeouts at the 2 h cap — no uses_sorry giveups, no
statement tampering, no compile-error finishes. The baseline never stops trying on
final-exam-level algebra; it just doesn't converge. fateh_72 burned $0.97 (47% of run
cost, 871 turns) without landing. FATE-H at 3/10 leaves plenty of headroom in both
directions — **this looks like the right tier for arm comparisons** (vs Putnam p100
and vs FATE-M's ceiling).

Two attempts (fateh_22, fateh_36) tripped the advisory `native_decide` keyword
tripwire — agents reach for kernel-bypass tactics when stuck on heavy algebra. Neither
solved, so no human adjudication needed this time, but expect this on FATE tiers.

## Operational findings (new, FATE-H-specific)

1. **One pathological attempt can starve the whole run.** fateh_22 alone caused every
   one of the first 13+ REPL watchdog restarts (53 "REPL timed out" errors in its
   events; zero in anyone else's): it looped on tactic variants individually too heavy
   to finish, each occupying the serialized REPL until the ~5 min watchdog kill,
   stalling all other agents' checks. Restart recovery is fast (5–8 s, warm olean
   cache) but the queue pain is real. FATE-H checks are just heavier than Putnam's —
   if this recurs, consider a shorter per-check timeout for agent-facing checks
   (grader keeps 480 s).
2. **There is no clean way to kill a single attempt mid-run.** SIGTERM to an attempt's
   pi process looks identical to "model ended its turn early" — run.js's nudge loop
   resumed the session (by design, `run.js` nudge loop) and fateh_22 ran on to its 2 h
   cap anyway. If per-attempt abort is ever needed for real, it needs a first-class
   mechanism (e.g. a tombstone file the nudge loop checks), not process murder.
3. FATE-H originals compile fine on 4.27 (12/12), so the one-version toolchain gap is
   a non-issue for FATE-M/H. (FATE-X untested — it ships extra definitions and may
   lean harder on 4.28.)
4. **fateh_36 reproduced the putnam_1965_b6 path-escape pattern** (hallucinated
   absolute path with the `/work` segment dropped → wrote `<attempt>/test/test.lean`
   outside its cwd), 40 min before `extensions/file-sandbox.ts` existed — the whole
   run predates the sandbox (added 22:17 that evening; run.js reads its extension
   list once at launch, 20:58). Unlike 1965_b6 it was a one-off 345-byte scratch
   probe, never read back; the proof stayed in `work/problem.lean` (which parameter-
   less `lean_check` always compiles), so the verdict is unaffected. Two more escapes
   found on a full path audit: fateh_86 wrote a proof draft to
   `results/basis-finite-tensor/fateh_86/work/problem.lean` — run-id segment replaced
   by a *semantic description of its own problem* (write tool mkdir-p'd the phantom
   run dir; solved via the real file anyway) — and fateh_56 dropped a probe at
   `/tmp/test.lean`. Notably, zero reads of repo files (PLAN/README/runner) across
   all 20 attempts — escapes are hallucinated paths, never repo exploration; the
   scratch-file habit is endogenous. Pattern now confirmed on 4 attempts across
   3 runs → sandbox justified; future FATE re-runs carry it as a harness delta vs
   these two baselines.

## Timeout autopsy (added 0726, from full events.jsonl reads)

Per problem: what the budget went on, and whether there was real progress. Ordered by
spend. "Hopeful" = the mathematics was right and the attempt was converging; "hopeless" =
more compute extends the same loop.

- **fateh_72 (Noetherian local↔global) — $0.97 · hopeful.** Correct textbook proof plan by
  message 2, ~24 KB of sorry-free Lean, twice down to a *single* plumbing error before a
  write-truncation loop (31 "file is truncated again" messages) kept destroying its best
  state; ~100 of 271 checks were `#check` probes using problem.lean as a scratchpad.
- **fateh_70 (ℤ[2i] not integrally closed) — $0.33 · hopeless as run, math complete.**
  Right witness (i = α/2) in its first message, ~290-line proof with all the substance;
  but 117/164 checks were "you modified the statement" rejections from `#check` probing in
  problem.lean, then a 45-min plateau at 12–17 errors. Final file: a 4-line scratch
  snippet, worse than the stub.
- **fateh_15 (ℤ[√−5] not a PID) — $0.28 · hopeful, nearly done.** Standard norm argument
  executed end to end: errors 9→2, final file 248 lines with 0 sorries, and both surviving
  errors are the same one-token slip (`zsmul_eq_mul` vs `smul_eq_mul`) duplicated in
  mirrored branches. Waste: 16 checks on the untouched stub, 58 failed edits on ambiguous
  match strings.
- **fateh_56 (Φ₂ₙ(x)=Φₙ(−x), n odd) — $0.10 · hopeful but unlucky.** Right reduction
  (ℚ→ℂ, μ↦−μ on primitive roots, sign dies as φ(n) even), the two hard `IsPrimitiveRoot`
  helper lemmas fully proven, two one-liner gaps left — then it deleted its own 8.9 KB
  peak file and died on a stub. Slow spender (~$0.05/h): 25 min lost learning lean_check
  only compiles problem.lean; lemma search = one name-guess per 60 s compile.
- **fateh_57 (nontrivial purely inseparable ext) — $0.09 · hopeless as configured.**
  398 unknown-identifier errors across 193 distinct hallucinated lemma names; ~90 of 110
  compiles were probe files that clobbered the proof. Reached `perfectClosure` (correct)
  in its last 15 calls and was ~4 lines from done at kill
  (`perfectField_of_perfectClosure_eq_bot` closes it) — but blind name-guessing gives no
  convergence signal; needs Mathlib search, not budget.
- **fateh_22 (Aut(D₄) ≅ D₄) — $0.08 · hopeless as configured.** Correct explicit
  generators early (α: r↦r, s↦rs; β: r↦r³, s↦s) but never found `DihedralGroup.sr` —
  134/175 writes went to a `test.lean` the checker never compiles — and its fallback,
  `native_decide` over 8⁸ maps on a partly-noncomputable type, only ever hit 240 s REPL
  timeouts (the run-starving loop of operational finding 1). Last act: testing `1+1=2`.
- **fateh_36 (#intermediate fields = 10) — $0.08 · hopeless.** Had the full D₄ /
  10-subgroups argument (listed all 10 fields) within minutes but never found the Galois
  correspondence API (`IsGalois.intermediateFieldEquivSubgroup`); corrupted the graded
  file 87× with `#check` probes, read stale output as phantom successes, ended retrying
  `native_decide` (banned, and impossible on a noncomputable type).

**Read-through for the budget cap.** Spend and hope correlate *positively*: the three
biggest spenders ($0.28–0.97) all had the correct mathematics essentially written and sat
1–2 plumbing errors from a clean compile, while the three cheapest timeouts were
API-discovery failures no budget fixes. A $0.10–0.15 cap would have killed fateh_72 and
fateh_15 mid-convergence; $1 @std lets a fast-spending fateh_72-class attempt run ~2 h.
Median sustained spend across all ≥20-min attempts is ~$0.12/h (~9 h to $1), so the
wall-clock backstop is set to 12 h — only the slowest quartile (≲$0.04/h, check-wait-
dominated guessing loops, the least hopeful group) ever hits it. The
dominant waste is not tokens but harness friction — `#check` probes clobbering the graded
file, side-files the checker silently ignores, ~8 kB-truncated error output, no Mathlib
name search, no checkpoint of the best state. The first two are affordances the
non-baseline arms already manipulate; truncation and best-state checkpointing are
all-arms harness questions.

## Open questions for the grid

- FATE-H pass@1 = 3/10 on a 10-problem seed-42 pilot is compatible with a wide range;
  a full FATE-H run (#problems = 100) is ~$21 at this rate — affordable, worth doing
  before committing to it as the primary comparison tier.
- The 7 timeouts are exactly where arms (plan, lean-search, replan, facts) claim to
  help: long horizons, retrieval-starved, no decomposition. Autopsy now done — see
  "Timeout autopsy" above; 3–4 of 7 were mathematically on track, killed by harness
  friction rather than capability.
- fatem_53-style heavy tails on both tiers say resource caps, not turn caps, are doing
  the budget work. Superseded 0726: caps move from wall-clock to per-problem cost_std
  budget ($1 @std default, 12 h wall-clock as backstop) — spend-hope correlation in the
  autopsy supports capping on spend, not time.
