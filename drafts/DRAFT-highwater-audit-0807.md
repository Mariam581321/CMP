# Solved high-water audit — 2026-08-07

Reconstructed from pi session files across 36 runs. Read-only: no recorded verdict was changed.

## Corpus

- 759 attempts, 53419 `lean_check` results.
- Check colours: 1754 green, 15147 sorry-carrying, 34845 failing, 1615 server errors.
- 58 ok-checks were truncated before their sorry list and had to be recompiled to be coloured (skipped: --no-verify).
- Replay fidelity: 53418/53419 checks reproduced the exact bytes the agent compiled (md5 from the check header).

## Did anyone hold a proof and not submit it?

472 of 759 attempts reached a green check. 213 of those kept editing afterwards, and 8 graded unsolved.

| run | problem | end | graded | first green | checks after | turns after | cost@proof | cost end | proof re-graded |
|---|---|---|---|---|---|---|---|---|---|
| grep-fatex87-0805 | fatex_19 | completed | grader_error | 131/138 | 7 | 18 | $0.93094 | $0.9636 | not run |
| lean-search-fateh100-0801 | fateh_32 | completed | compile_error | 70/73 | 3 | 15 | $0.4074 | $0.4173 | not run |
| lean-search-fatex-rest90-0802 | fatex_19 | completed | grader_error | 140/141 | 1 | 3 | $0.68921 | $0.6949 | not run |
| lean-search-fatex-rest90-0802 | fatex_23 | completed | bad_axioms | 21/21 | 0 | 2 | $0.05424 | $0.0562 | not run |
| lean-search-fatex-rest90-0802 | fatex_43 | completed | bad_axioms | 42/43 | 1 | 6 | $0.04462 | $0.0510 | not run |
| lean-search-fatex-rest90-0802 | fatex_78 | completed | bad_axioms | 20/20 | 0 | 2 | $0.07905 | $0.0814 | not run |
| spawnfacts-fatex10-0804 | fatex_99 | completed | bad_axioms | 3/3 | 0 | 1 | $0.03204 | $0.0327 | not run |
| spawn-fatex10-0804 | fatex_99 | completed | bad_axioms | 2/5 | 3 | 17 | $0.03367 | $0.0502 | not run |

## What agents do after their first proof

- 333/472 ran at least one more `lean_check` after the proof.
- 213/472 submitted different bytes than the proof they held.
- Of those, 209 still graded solved (a refactor that held) and 4 did not.
- Cost at first proof averages 91.2% of cost at attempt end — the rest is spent after the problem is already solved.

## Per-attempt data

`DRAFT-highwater-audit-0807.csv` (same directory).
