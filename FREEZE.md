# Harness freeze log

**Current grid freeze: `f4e3395`** (2026-08-02). The `harness_git_sha` of every grid run
must be that commit or a descendant.

**Every re-cut below predates the first grid cell.** The grid has not started; no run has
been invalidated by a harness change. A freeze that moves before any cell runs costs
nothing but a new SHA — this log exists so that a freeze moving *during* the grid would be
visible, and so that "frozen" is a checkable claim rather than a pointer to `HEAD`.

Re-cutting is what happens when the instrument is still being built. What must not happen
silently is re-cutting once measurement starts: an attempt run under a different harness is
not the same sample, which is why the freeze moves rather than being edited in place.

The plan itself is `PLAN.md`; mechanism is `SKELETON.md`; the retrieval arms are defined in
`SEARCH.md`. Entries here summarise and point there rather than restating.

---

## `2f89a7c` — 2026-07-29, the original freeze

Grader fixes complete. The FATE-H cost-calibration run (66/100) predates this and is not a
grid cell: the harness still changed after it.

## `d66e12e` — 2026-07-30, first re-cut: provider-error accounting

The first block-A cell launched at `2f89a7c` (lean-grep, 50 FATE-H) was destroyed by a
DeepSeek uplink outage, and that harness could only flag a provider error when an attempt
made *zero* tool calls — so an outage landing mid-proof was graded on whatever it left on
disk and printed as a clean 21/46. `d66e12e` measured the damage: error counts per attempt,
a trust cutoff marking an attempt rerun-not-result, a kill on a dead link.

## `900c364` — 2026-07-30, second re-cut: retry at the right level

`d66e12e` was the wrong level. pi retries at two levels, and the lower one — inside the
openai SDK, below the message layer — emits nothing into the session or the model's context
but defaulted to zero retries on the DeepSeek path. `900c364` turns it on
(`pi-agent/settings.json`: 500 retries, backoff clamped to 8 s ≈ an hour of re-probing),
making an outage a slow run rather than a damaged one, and deleting `d66e12e`'s accounting
as dead weight. Measured across 0726–0730: 2–5% of requests failed on a stable night, 7–8%
on a bad one; those are now absorbed, leaving `stderr.log` (`OPENAI_LOG=info`) as the only
record.

No arm semantics changed at either re-cut. Grid runs must not mix the two: an attempt that
never sees a nudge it would have seen at `d66e12e` is not the same sample.

Discarded, not cells: the 0729 grep attempt (`results/_archive/provider-error-0729/`) and
the 0730 grep attempt, which died with its runner at 30/50.

## `b1dfcb6` — 2026-07-31, third re-cut: three tool-layer defects

All found by autopsying the 0730b grep cell.

1. pi decides a tool call's `isError` from a *thrown* error only, so the six extension tools
   — which returned `{isError:true}` — logged their failures as successes (273 of 312 failed
   edits in 0730b). Telemetry only: the openai-completions path never sends the flag to the
   model.
2. `grep_mathlib` made the model pick literal-vs-regex, and it picked wrong on 38% of all
   calls — regex patterns sent with `regex=false`, matched literally, 99% empty. The
   parameter is gone; the tool now tries the readings in order itself.
3. A fully-qualified name is assembled by the elaborator and appears nowhere in the source,
   so `grep_mathlib` answered "no matches" about declarations that exist (21 of the 204
   dotted queries that came back empty in 0730b). It now rebuilds the name from
   `namespace`/`end` and answers exact matches only.

Also: the peak-hour launch guard is gone (billing checked 0731 is flat), and `billed_usd`
now comes from the account balance either side of a run.

**Only `grep_mathlib`'s model-visible surface moved.** `search_mathlib` gained per-result
telemetry (`distance`/`kind`/`module`) that is not serialized to the model; nudge policy,
budget, grader and arm design are untouched. Both retrieval arms are now defined exactly in
`SEARCH.md`.

## `60e8fa0` — 2026-07-31, fourth re-cut: rung-0 name resolution

Rung 0 was right in principle and wrong in practice. The walk that rebuilds a qualified name
tracked only *named* sections, so a bare `end` popped a scope it had never closed and took
the enclosing namespaces with it — plus five more defects of the same kind (untracked
`mutual` blocks and modifier forms of `section`, dotted namespaces that close one component
at a time, ASCII-only identifiers, scope words in comment prose, `class abbrev`). One
returned a WRONG declaration rather than none: `def d₁` inside `namespace
HomologicalComplex₂` assembled to `HomologicalComplex.d`, which exists and is unrelated —
the near-miss this rung promises never to return.

Settled by ground truth instead of inspection: assembled names are now checked against the
constants of the compiled environment, and all 217,968 declaration heads in the checkout
resolve to a name that exists there (2,227 more than before), with nothing that resolved
before failing now. Detail: `SEARCH.md`, rung 0.

The interface is unchanged — what moved is which declarations rung 0 finds — and no other
arm is affected.

## `bd3251b` — 2026-07-31, fifth re-cut: the check budget is CPU-seconds

A wall-clock bound measures the file's cost plus the machine's load against a hard
threshold, so borderline files flip: 52% of one run's "too expensive" verdicts compiled fine
when replayed idle, each one steering an agent off a proof with ordinary fixable errors.
Detail and the replay: `SKELETON.md`, "Why CPU-seconds and not wall clock".

**This changes the metric itself** — "compiles" now means "within 120 CPU-seconds" — so no
pre-`bd3251b` run is comparable to a grid cell.

## `24ed9ae` — 2026-07-31, sixth re-cut: grep returns qualified names

`grep_mathlib` returned a file location per hit, with the declaration as the *source* writes
it — so the heading was the one thing the agent could not use (`theorem r_zero`, callable
only as `DihedralGroup.r_zero`) and the namespace had to be decoded from the path. Hits are
now headed by the assembled name, quoted as the source quotes it; `private` is flagged;
locations move to the tool's log details, which the model never receives.

Two reasons, both from the logs:

1. The arm's job is confirmation-retrieval — verifying a name the model can nearly guess —
   and it was withholding the name.
2. Returning a path induced a retrieval this environment cannot serve. Across 595 attempts,
   27% tried to read Mathlib source (63% in the grep arm vs 11% semantic, 2% baseline); 546
   of those reads used a path the tool had just printed against 8 guessed; none of the 833
   ever returned content, the checkout having always sat outside the agent's working
   directory. A further 35 attempts said they could not read it without trying.

Retrieval is unchanged and checked so: over a 120-query replay of the 0730b logs, hits,
order, rung and truncation are identical to `bd3251b`; only the heading differs. Emitted
names were checked against the compiled environment (80/80 resolve under `#check`; `private`
ones correctly do not). Both search arms now return names and signatures, which block A
wanted and did not have. Definition: `SEARCH.md`, result shape.

**Only `grep_mathlib`'s model-visible surface moved**; no other arm, the grader, budget or
nudge policy is touched.

Not expected to move the score: wanting the source did **not** predict failure (grep arm,
59% solved among attempts that tried vs 55% among those that did not), so this is a
token-cost and arm-cleanliness fix. Smoke `ga-smoke-0731c` (10/10, $0.089, same config as
`0731`/`0731b`): attempts trying to read Mathlib fell to 1/10 from 5/10 in each prior smoke
(Fisher p = 0.049, n = 10 — suggestive, not settled), and the one remaining read guessed a
path grep never printed. The long grep prefix before the first compile is unchanged, as
expected: that is a signature-vs-behaviour gap, and `check_snippet` is what addresses it.

Whether agents still reach for source once `check_snippet` exists is the pre-registered
trigger for revisiting source access as a block-B follow-on, rather than spending a block-A
cell on it now.

## `7629f39` — 2026-07-31, seventh re-cut: third search arm + pre-freeze scan

Block A becomes a three-way comparison: **`lean-loogle`** (structure-retrieval — public
Loogle over the compiled environment, hits filtered to the pin; skew measured 9.5%
unfiltered vs LeanSearch's 0.2%, which is why the no-filter rule flips here — numbers
and rationale in `SEARCH.md`). New derived artifact `problems/env-names.txt`
(regenerate: `scripts/dump-env-names.mjs`); preflighted at launch for loogle combos.

A four-agent review sweep over runner/, extensions/ and scripts/ before cutting, fixes
landed in this commit:

1. **Grader anti-spoof** — axiom reports are now parsed only from messages whose line
   number lies past the solution, where the probe's `#print axioms` output lives. A
   `trace "'decl' depends on axioms: []"` in the solution previously spoofed the
   first-match parse into `solved` on a sorry'd proof (verified both ways: real solve
   still grades solved, spoof now `uses_sorry`).
2. **Edit tool** — the fuzzy path duplicated the newline a match consumed, silently
   inserting a blank line per boundary-matched edit. Ten-case battery green.
3. **Sanitizer** — `classifyLines` now tracks nested `/- -/` block comments; the
   "corpus has none" claim was false (putnam_2022_a4 shipped an NL hypothesis hint,
   now stripped — the only file affected; FATE corpora verified clean).
4. **Runner** — interrupt/kill now takes in-flight pi children down with it (orphaned
   spenders); non-runner deaths recorded `end: "agent_died"` instead of `"completed"`;
   NaN flag values refuse to launch; run-dir reuse guard covers pre-first-record
   crashes; log-stream errors no longer kill the run; balance sampling retries;
   UTF-8-safe event decoding; duplicate problem lists refuse to launch.
5. **Lean server** — repl process/stdin `error` handlers (spawn failure or a
   dying-repl EPIPE no longer kills the whole server). **Watchdog** — liveness is not
   readiness: a live-but-permanently-not-ready server is killed after 20 min.
6. **Grep surface** — zero-hit message stripped of retry coaching the other arms never
   had; the qualified-name note no longer asserts a namespace decomposition that is
   false for prefix-written heads.

Model-visible surfaces moved: `grep_mathlib` (two wording changes), the edit tool
(correct writes), and the new `loogle_mathlib`. Grading strictness moved only against
spoofing. No budget, nudge, or scheduling semantics changed.

Known and deferred (documented, not fixed — all outside the single-worker regime the
grid runs in): a `/recycle` admitted during multi-worker traffic can strand a worker;
a boot-time import fuse kill exits the whole server; a requeued check's final attempt
can outlast the client's 30 min socket under extreme memory pressure; the memo key
omits `check_cpu_ms` (fine while every run uses the default 120 s — do not vary it
against a warm server).

## `f4e3395` — 2026-08-02, ninth re-cut: the check verdict is deterministic (`maxHeartbeats`)

**This changes the metric itself** — "compiles" now means "every declaration elaborates
within `maxHeartbeats 400000`", decided by Lean, not by any measured quantity — so no
pre-`f4e3395` run is comparable to a grid cell. The incident that forced it: fateh_32
(0801) sat on the 120 CPU-second line and flipped verdicts across four measurements of
the same bytes, ending as a recorded `compile_error` on a proof the agent had watched
compile. A measured threshold has a noise band; CPU-seconds narrowed it vs wall clock
(fifth re-cut) but could not zero it. Heartbeats are a pure function of the file.

The cap is not a new number — it has been injected on every check since `eb36538`
(2026-07-12), so the elaboration side of every past verdict is unchanged; what is gone is
the aggregate-CPU conviction, which is one-directional (old fails can only become
passes). Submitted files cannot raise the cap (server-side clamp, all numeral forms). All
resource bounds (CPU 600 s / wall 900 s / rss / mem) are now machine fuses that end, at
worst, in `unavailable` — never memoized, never a verdict, `grader_error` on the grading
path. `--check-cpu`/`check_cpu_ms` are gone; run.json records `max_heartbeats` from the
live server and run.js refuses to launch on a mismatch. Detail: `SKELETON.md`, "The
verdict is deterministic"; verification battery summarized in the implementing commit
(`bf5eca8`).

Also in this re-cut, no metric weight: `benchmarkDecls` emits namespace-qualified names
(required for FATE-X's `namespace ProblemN` wrappers; byte-identical for every existing
corpus), and the server defaults are sized for the 64 GB Ryzen server (8 workers,
avail floor 4000 MB).

`lean-search-fateh100-0801` sits on the old side of this line. Its budget-borderline
attempts (recorded budget-fail in grade detail, final agent-side check passed in
events.jsonl) are to be bucketed and reported both ways; whether the run is re-run is a
methodology decision recorded here when made.

## `3084411` — 2026-07-31, eighth re-cut: loogle unknown-identifier is a result

The loogle smoke (10/10, 115 calls) showed 49% of calls rejected, 32 of 56 being
bare-name existence probes — the confirmation question, which grep answers with a
zero-hit *result* while loogle answered with a tool *failure*. Reclassified: unknown
identifier → `No results: …` + Loogle's suggestions; parse/ill-typed patterns stay
failures. Only `loogle_mathlib`'s surface moved. Smoked again after the change.

---

## Model boundary — 2026-07-31 (not a freeze move)

DeepSeek re-pointed the `deepseek-v4-flash` alias to the 0731 GA build (same architecture
and size as the preview, re-post-trained, tuned for agentic tool use). There are no dated
snapshots — `GET /models` serves only `deepseek-v4-flash` and `deepseek-v4-pro` — so the
preview weights are gone and nothing run before that date is reproducible.

Every grid run is on 0731; every run under `results/` predating it is a different model and
cannot be quoted beside a grid cell. This is not a harness change, so it does not move the
freeze, but it cuts the same way: pre-0731 runs are not samples of the same thing.
