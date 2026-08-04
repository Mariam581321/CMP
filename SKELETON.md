# Implementation

How one experiment runs end-to-end. The research design (arms, factorial framework,
protocol) is in `PLAN.md`.

Command: `node runner/run.js --combo lean-search --problems problems/dev.txt` → solve
rate + cost. pi supports DeepSeek natively (`deepseek/deepseek-v4-flash`, reads
`DEEPSEEK_API_KEY` from `.env`, gitignored) — no OpenAI-compat shim.

## How one attempt works

1. Runner makes a scratch dir with only the **sanitized** `problem.lean` + short
   instructions. No path to the benchmark repo.
2. Spawns **one** pi process headless in that dir:
   ```
   pi --mode text --session-dir <dir> --no-extensions --no-skills -nc \
      --model deepseek/deepseek-v4-flash --tools read,edit,write,lean_check \
      -e extensions/lean-check.ts -e extensions/file-sandbox.ts \
      -e extensions/cmp-edit.ts -e extensions/supervisor.ts \
      [-e extensions/lean-search.ts ...] \
      --system-prompt <prover instructions> \
      "Prove the theorem in problem.lean"
   ```
   Baseline = read/edit/write + `lean_check` only (no bash/grep). Combo = extra `-e`
   flags. `extensions/<name>.prompt.md` is appended to the system prompt when `<name>` is
   in the combo, so prompt deltas are versioned per arm. Per-attempt config (original
   file, budget, caps) reaches extensions as one JSON env var (`CMP_CONFIG`).
3. The **supervisor extension** owns continuation, in-process: on each agent_end, if
   the proof doesn't actually check out (server check, memoized ≈ free), budget
   remains, and the agent shows progress (= non-read tool calls since the last nudge;
   reads alone are loopable noise), it queues a nudge as a follow-up message — the
   session keeps going inside the same pi process (same policy for every combo).
   Nudges are ordinary user messages in the session; dropping a `STOP` file in
   the attempt dir aborts one attempt cleanly.
4. The runner reads pi's **session file** as it is appended (`runner/session-tail.js`,
   1 s poll) and keeps only hard enforcement: SIGKILL when the per-problem cost_std
   budget is spent (checked per assistant message, overshoot ≤ 1 message) and the
   wall-clock backstop. The child writes nothing on stdout.
5. **Grades independently** after the agent exits (never trust the agent's own
   lean_check).
6. Appends one record to the run's `results.jsonl`.

## Grading (independent of the agent)

`runner/grade.js`, run after the agent exits, over the persistent lean server.

**Principle.** In Lean a theorem's statement *is* the type of its declaration (the proof
is the term). So "did the agent change the statement?" is not a question about source
text — it is: does `putnam_xxx` in the agent's file elaborate to the same type as in the
original? The grader asks Lean that question directly instead of diffing strings, which
makes it immune to reformatting, notation, binder renames (α-equivalence), and
`open`-shadowing in both directions: presentation changes can't fail it, semantic changes
can't sneak past it. (v1 was a line-survival check; `regrade.js` showed it false-rejected
a valid reformatted proof in a pilot, and it provably missed comment-wrap restatements.
Same design point as AXLE's `verify_proof`, which is closed source — hence reimplemented,
~60 lines of JS + ~30 of Lean.)

**Mechanism.** One REPL request per grade: the solution file + an appended Lean probe
(`stmtProbe`, in `runner/stmt.js`) + `#print axioms` for each benchmark declaration.
After the file elaborates, the probe looks each declaration up in the environment and
prints one info line — kind (thm/defn/axiom/…), safety (safe/unsafe/partial), whether
the declaration's own proof term reaches `sorry` directly (recursing only into its
compiler-generated auxiliaries, never into user-declared helpers — used by
`plan_check`, not by grading), and the elaborated type canonicalized (binder names
erased, elaboration metadata stripped, universe params renamed) and printed as a raw
kernel expression with fully-resolved constant names. For def/abbrev declarations the
probe also prints the canonicalized **value** (the body): a theorem's type references
file-local setup defs by *name* only, so type equality alone would let an agent gut a
setup def's body (verified exploitable: `dist_to_int := fun _ => 0` passed the type
check, 2026-07-28). Value equality is enforced exactly for decls whose *original*
value is sorry-free — setup defs must be preserved; the sorry'd slots (proofs, the
`_solution` abbrev) remain the agent's to fill.
Original-side answers come from the same probe run once per problem and cached in
`problems/stmt-types.json`, keyed by source hash (derived + gitignored like the problem
files; `node runner/grade.js --build-stmt-cache` rebuilds all, grade.js lazily fills
misses). The probe works on non-compiling files too: Lean's error recovery registers any
declaration whose *signature* elaborates (failed proofs become sorryAx), so statement
verdicts don't require a compiling proof.

**Verdict order** (first hit wins, so reason distributions stay comparable with v1):

1. `statement_changed` — declaration missing (renamed/deleted/statement doesn't
   elaborate), type differs, kind differs (e.g. theorem redeclared as `axiom`/`def`),
   or a sorry-free setup definition's body differs from the original.
2. `unsafe_decl` — declaration not `safe`: `unsafe` code may use kernel bypasses like
   `unsafeCast`. (`unsafe theorem` is illegal in Lean, so only the `_solution` def slot
   is exposed; `#print axioms` happens to flag today's `unsafeCast` pattern via
   `lcProof`, so this is deliberate redundancy, not the only line of defense.)
3. `compile_error` — any error-severity message, the deterministic heartbeat timeout
   included (an ordinary Lean error since 2026-08-01, byte-reproducible anywhere). If
   the file is so broken the parser never reaches the probe (unterminated
   comment/bracket), it grades here with "statement unknown" in the detail — the one
   case where statement preservation is genuinely undeterminable. A resource-fuse
   `unavailable` is a `grader_error` instead, never a fail (the grader additionally
   retries connection-level server failures for 5 min, since its verdict is permanent).
4. `uses_sorry` / `bad_axioms` — `#print axioms` per benchmark declaration must stay
   within `{propext, Classical.choice, Quot.sound}`; catches `sorry` (sorryAx), smuggled
   axioms (recorded in the env no matter how obfuscated their construction), and
   `native_decide` (ofReduceBool) in one mechanism. (`lake env lean` on a sorry'd file
   exits 0 — must grade via `#print axioms`, not by grepping.)

**Lexical tripwire (advisory, not a gate).** Metaprogramming / kernel-adjacent keywords
in the solution source (`macro`, `elab`, `run_cmd`, `open Lean`, `set_option debug`, …)
are logged as `suspicious_keywords` in the record and flagged ⚠ in run output — never
auto-failed, since a keyword can sit in prose or a string. Honest competition proofs need
zero metaprogramming, so expected hits ≈ 0 and each is a 30-second human read. This
covers the residual the environment-level checks cannot see: metaprograms that write
unchecked declarations into the env, kernel-check config tampering (AXLE's Appendix C.3
class). The attack payload can be obfuscated; its lexically visible launcher can't.

`runner/regrade.js results/<run-id> ...` re-grades finished runs with the current grader
and prints verdict flips (read-only — recorded results are what the run measured).

Kernel re-verification (lean4checker) is punted until we publish numbers.

## Lean without pain

One shared pre-built project `lean-env/`, built from `benchmarks/PutnamBench/lean4` (its
lakefile + toolchain), `lake exe cache get` once. Every check runs against a **persistent
Lean REPL** (`vendor/repl`, pinned v4.27.0) that imports Mathlib once into a resident
process, served by a small local HTTP daemon (`runner/lean-server.js`) shared by the
grader and every pi subprocess. Watchdog: per-cmd timeout, auto-restart on crash/hang.
Isolated checks are memoized server-side (hash the file → cached verdict), so
re-verification of an unchanged file is ~free; memo hits skip the queue entirely.

**Scheduling (one REPL, many agents).** Requests carry a `client` id (problem name;
the grader is just another client) and are served round-robin across clients, so an
attempt with many queued checks waits behind itself, not in front of everyone else
(one check-spamming attempt once starved a whole run). ONE definition of "compiles" for
agent checks, supervisor, and grader alike (2026-07-27: a solve must be observable inside
the agent's own loop) — honest proof steps check in seconds. The grader's final verdict
bypasses the memo (`force`) so it always comes from a real compile. Since 2026-08-04 the
observability principle covers the axiom gate too: `checkedCompile` builds the same probe
body as the grader (stmtProbe + `#print axioms` per benchmark decl, line-gated parse, raw
report lines stripped from display), so a proof that will grade `bad_axioms` is a FAILED
lean_check/plan_check and blocks the supervisor's "done" — before this, a smuggled
`axiom` + `exact` passed compile/statement/sorry checks, lean_check said green, and the
grader failed the finished attempt (spawn-fatex10-0804 fatex_99; three 0802 incidents) —
the agent-watches-green-gets-graded-red class on the one axis heartbeats didn't cover.
sorryAx is excluded from the in-loop report (sorries have their own channel, and error
recovery turns failed proofs into sorryAx — it would be noise on every broken file).

**The verdict is deterministic: `maxHeartbeats`, not a measured budget (2026-08-01).**
"Compiles" means every declaration elaborates within **400 000 heartbeats**
(`MAX_HEARTBEATS` in `runner/common.js` — the cap the server has injected on every check
since 2026-07-12, so past verdicts' elaboration side is unchanged). Heartbeats count
elaboration steps — a pure function of the file, identical on any machine, under any
load, at any REPL age — so over-cap is an ordinary, byte-reproducible compile error
("(deterministic) timeout"), the same for agent, supervisor, grader and any regrade. The
server clamps any `set_option maxHeartbeats` in a submitted file to the cap (all numeral
forms; lowering is allowed), and tags the error with a harness note saying raising it
cannot help. The history that led here: the bound was wall clock until 2026-07-31 (52% of
one run's "too expensive" verdicts compiled fine replayed idle), then 120 CPU-seconds,
which narrowed the noise band but could not zero it — fateh_32 (0801, ~49 KB proof on the
line) was measured four times on the same bytes and flipped twice, recording
`compile_error` on a proof the agent watched compile. Count, don't measure.

**No resource bound is ever a verdict.** CPU (600 s, `CMP_CPU_FUSE_MS`), wall (900 s),
RSS and MemAvailable are machine fuses. A fuse kill is **never reported to the client at
all**: the server requeues the check and answers only once Lean itself has answered.
Telling an agent "the machine faltered, try again" would teach it about our REPL and
spend a whole turn, the growing context re-billed as input, on something it cannot act on
— the same reasoning that already keeps connection retries inside the tools. The requeued
check always runs on a *different* REPL process (the kill marks its worker unready before
the retry can be dispatched: with one worker it waits out the reimport, with several it
goes to a sibling). Two non-`mem` kills, or the retry deadline (`mem` is never counted —
the `MIN_AVAIL` fuse selects its victim by worker size, so its casualty is whichever
check was in flight), end in `unavailable`: not a verdict, never memoized, nothing
recorded about the file — the machine could not run this check, and for the `cpu` fuse
the wording tells the agent the file must get dramatically cheaper. The grader records
`unavailable` as `grader_error`: visible and re-gradeable, never a silent fail. Each kill
is tagged with the fuse that fired (`bound: cpu | wall | rss | mem`) and every check
records its own `wall_ms`/`cpu_ms` (absent on memo hits, so replays are distinguishable
from measurements).

Heartbeats bound elaboration, not kernel reduction — a `decide`-heavy proof passes
elaboration under the cap and is then replayed by the kernel with no heartbeat cap. That
rare class cannot be bounded deterministically, so it is flagged, not verdicted: kernel
work heavy enough to matter trips the CPU fuse and lands in `unavailable`. (In practice
elaborator and kernel evaluate at comparable speed, so a cap-passing `decide` has kernel
cost of the same order — the fuse at 600 s sits far above the ~165 CPU-s worst case
measured for a single cap-exhausting declaration.)

Error wording is harness design surface (the 406-check spam incident): the tool asserts
the rule and the cache, both of which the harness enforces, and never predicts that Lean
will behave the same way twice.

**`native_decide` pre-reject (agent-facing only).** The ban line is *kernel-checked
or it doesn't count*: `decide`/`norm_num`/`omega` are kernel-verified computation and
legal; `native_decide` trusts the native compiler via the `ofReduceBool` axiom (a
demonstrated soundness hole and AXLE-class attack surface) and is banned. Since stuck
agents demonstrably burn minutes of shared REPL per doomed `native_decide` attempt,
`checkedCompile` rejects it lexically without compiling and says why. Client-side
only — the grader never pre-rejects anything (it must measure what's actually in the
file, old runs included); its env-level axiom check remains the sole gate, and no
other construct is pre-screened.

Speed context: a cold `lake env lean` deserializes all of Mathlib (~6 GB, 12–50 s) to
check a 20-line file; the REPL avoids the re-import (~1–5 s/check). With fast
checks the LLM becomes the bottleneck → agent concurrency 8–16.

*Not doing:* minimal per-problem imports (changes the benchmark — import hints are premise
hints), skipping independent grading, parallel arms while wall-time matters.

## Concurrency

`--concurrency N` worker pool over problems (default 25, sized for the 64 GB server —
the REPL pool absorbs check load and the deterministic verdict makes load a wall-clock
cost only, never a verdict risk):
each attempt = own scratch dir +
own pi subprocess; checks hit the shared warm REPL. LLM calls are I/O-bound and DeepSeek
is rate-limit-friendly; Lean compiles were the old bottleneck (now the REPL).

## Why the runner does not read stdout

Until 0802 the runner ran pi in `--mode json` and scraped its event stream. That mode
serialises every session event to stdout, and `message_update` fires **once per stream
delta carrying the whole accumulated message** — so an assistant message of T deltas
costs O(T²) bytes. Measured: 2.16 MB emitted for a 799-token message (900× its final
size), 2.55 GB for a 35k-token one. pi queues those writes in memory with no
backpressure (`core/output-guard.js` chains them and returns immediately), so a child
whose reader fell behind grew a multi-GB backlog and died on V8's heap cap. That is
what `agent_died` was: 11 attempts across 0727–0802 (4 in fatex-rest90), all with the
same last three events — `turn_end`, `turn_start`, `message_start`, then a GC abort
mid-message. It hit short sessions too (`fateh_42`: 13 turns), because the trigger is
one long *message*, not a long session: 79% of assistant content is `thinking`, and the
tail runs to 100k+ tokens per turn under `--thinking high`.

Raising the child heap only moves the cliff — backlog is ~quadratic in message length,
so 4 GB → 8 GB buys ~1.4× more message, and the largest message actually observed
(103,722 tokens) would need ~27 GB. The runner's own reader was never the fix either: it
sat at 75% of a core doing nothing but discarding a flood it had already decided to drop.

So the stream is gone. `--mode text` runs the identical print-mode path with a
subscriber that emits nothing per delta (verified: 0 bytes, flat RSS under the same
conditions that produced a 2.85 GB backlog), and the accounting reads pi's session file
instead — which is linear, already on disk, already the resume point, and reproduces
every recorded number byte-exactly (tokens and `cost_std` on all 47 finished 0802
attempts; `tool_calls` and `turns` shift by at most one on attempts the runner killed,
see `runner/session-tail.js`).

The file also exposes a liveness signal the pipe never did — a gap between entries is
time since the last *completed* message — and a `--stale-min` fuse was built on it and
then dropped the same day. Every single-operation hang is already bounded far below the
48 h backstop: `lean_check` by the server's 900 s wall / 600 s CPU fuses under a 30 min
client wait, loogle by a 30 s abort, a stalled provider stream by pi's 5 min HTTP idle
timeout, and a retry storm not at all — pi persists each failed assistant message
(`stopReason: "error"`) like any other, so retries keep the file moving. Meanwhile the
fuse was sized against the then-default `--max-tokens` of 384k (~58 min of generation),
so it sat barely above a legitimate long message and was likelier to kill a working
attempt than a stuck one. The one genuinely unbounded silence — the supervisor waiting
out a dead lean server — is bounded in the extension itself. Hangs ride the wall backstop
and stay around to be inspected.

Upstream this is two bugs — the snapshot-per-delta protocol (the delta is already in the
event as `assistantMessageEvent`, so it could be O(T)) and the unbounded write queue.
Both are still present in pi 0.83.0; `print-mode.js` and `output-guard.js` are
byte-identical to 0.80.6.

## Logging (stats computed after the fact, never during)

Per attempt under `results/<run-id>/<problem>/`: the pi **session file** (`session/*.jsonl`
— the replayable transcript and the log; one continuous session per attempt, nudges
included), `problem.lean` final state, `attempt.json`, `stderr.log`, and `plans/` for the
plan arm. Runs before 0802 also carry `events.jsonl`, pi's json event stream; see
"Why the runner does not read stdout" below for why that is gone. Run-level `results.jsonl`, one record per attempt. **How the attempt
ended (`end`) and what the grader says about the final file (`grade`) are separate
fields, both always recorded** — a timeout's grade verdict still says how close the
file was, and a verified proof counts regardless of how the attempt ended
(`solved` = `grade.solved`):
```json
{"run_id": "...", "problem": "putnam_1962_a1", "combo": ["lean-search"],
 "model": "deepseek-v4-flash", "started_at": "...", "wall_s": 412, "turns": 14,
 "tokens": {"in": 84000, "out": 9100, "cache_read": 2400000}, "cost_usd": 0.021, "cost_std": 0.021,
 "tool_calls": {"lean_check": 6, "search_mathlib": 3}, "nudges": 1,
 "end": "completed|timeout|budget_exceeded|agent_died",
 "grade": {"solved": false, "reason": "uses_sorry|compile_error|statement_changed|unsafe_decl|bad_axioms|no_file",
           "detail": "...", "axioms": null, "suspicious_keywords": null},
 "solved": false, "harness_git_sha": "...", "pi_version": "..."}
```
Everything raw is kept, so any stat (tool-use patterns, time-to-first-check, error types)
is computable later without re-running — e.g. "how many timeouts were one error from
compiling" is a jq query over `end` × `grade`, not a re-grading session.

## Files

```
runner/run.js               spawn pi per problem, worker pool, logging
runner/session-tail.js      follow pi's session file: the runner's accounting input
                            (budget, turns, tools, nudges) and the silence fuse's clock
runner/sanitize.js          PutnamBench src/*.lean -> problems/*.lean (strip answers + docstrings)
runner/stmt.js              statement-probe library + checkedCompile (the one agent-facing
                            compile+statement client, shared by lean_check and plan_check)
runner/grade.js             independent grading over the lean server
runner/regrade.js           re-grade finished runs with the current grader (read-only)
runner/lean-server.js       persistent Lean REPL HTTP daemon (round-robin across clients)
runner/plan.js              plan_check core logic
extensions/lean-check.ts    always-on agent-facing compile tool
extensions/lean-search.ts   semantic search (LeanSearch API)
extensions/lean-grep.ts     symbolic search (grep over the pinned local Mathlib checkout)
runner/grep.js              grep_mathlib core: grep + expand hits to whole declarations
extensions/lean-snippet.ts  scratch verification (PLAN.md block B): check_snippet
runner/snippet.js           check_snippet core: stateless snippet compile, snippet: labels
                            (+ facts-arm bank prefix, positions shifted back)
extensions/lean-spawn.ts    block C: spawn_subagents (blocking batch of parallel workers)
runner/spawn.js             worker core: child pi launch, session tail, report extraction
extensions/lean-facts.ts    block C: add_fact into the shared bank (+ lean-facts.prompt.md)
runner/facts.js             add_fact core: compile gate, on-disk lock, candidate re-labeling
extensions/delegate.ts      no-op carrier for delegate.prompt.md (spawn+plan steering)
extensions/lean-plan.ts     plan_check (+ lean-plan.prompt.md)
extensions/file-sandbox.ts  always-on: confine file tools to the attempt's work dir
extensions/cmp-edit.ts      always-on: shadows pi's edit tool (core in runner/edit.js) —
                            no-NFKC fuzzy matching (pi's corrupts Lean unicode: ℕ→N),
                            failed matches return the closest file region
extensions/supervisor.ts    always-on: in-process continuation policy (nudges, STOP file)
runner/edit.js              edit-tool core: trailing-ws-only fuzzy match + closest-region errors
extensions/max-tokens.ts    injects per-response max_tokens = remaining window room,
                            clamped to [131072, --max-tokens] (always on)
lean-env/                   shared Lean project (gitignored)
problems/                   sanitized statements + dev.txt + stmt-types.json (grader cache)
results/                    per-run dirs + results.jsonl (gitignored)
```

## Runner CLI

```
--combo a,b          extension names = filenames in extensions/ ("" = baseline)
--problems <file>    problem list | --problems-dir <dir> (problems/; problems-nl/ for the NL arm)
--budget-std <usd>   (1.00) per-problem spend cap in cost_std dollars (peak-invariant;
                     checked per assistant message, so overshoot ≤ 1 message; 0 disables)
--timeout <s>        (172800) wall-clock backstop | --concurrency <n> (25)
--model <id>         deepseek/deepseek-v4-flash | --thinking <level> (high)
--max-tokens <n>     per-response output CEILING, always sent (default 384000, the
                     model max; set low, e.g. 8192, only for capped experiment cells).
                     max_tokens is charged against the CONTEXT window at admission
                     (prompt + max_tokens <= 1048576), so extensions/max-tokens.ts
                     sends clamp(window - context - slack, 131072, ceiling) per
                     request rather than a flat reservation (flat 384000 capped
                     conversation at 664576 and 400'd past it; the largest output
                     ever observed is 122423, so the 131072 floor truncates nothing).
                     Once the window can't fit the floor the request 400s — free,
                     pre-inference — and pi compacts and retries: that cycle, not a
                     threshold, is what bounds conversation length (~917504/cycle).
--run-id <s>         default combo+timestamp

("compiles" is not a flag: the deterministic maxHeartbeats cap is MAX_HEARTBEATS in
runner/common.js, recorded in run.json as max_heartbeats from the live server's /health,
and the runner refuses to launch if the server's cap differs from the checkout's.)
```

Unknown flags are hard errors (`util.parseArgs` strict) — a typo'd flag must never
silently run a mispriced or misconfigured experiment.

DeepSeek peak-valley pricing — **announced but not in effect** (checked 2026-07-31).
The docs say the API "will soon adopt" 2x on all billing items during 01:00–04:00 and
06:00–10:00 UTC (03:00–06:00 and 08:00–12:00 Poland summer time), with the effective
date "subject to the official announcement". Verified against DeepSeek's own billing
rather than the docs: 07-26 billed $10.41 where the flat table predicts $9.73, and
07-27+07-28 billed $48.38 against $44.50 — both a few percent over flat pricing, where
2x on the peak-window share would have required ~$54–57. The windows above are
therefore currently free, so **the harness does not guard them** — there is no
`--peak-ok` flag and no launch-time refusal. The guard was removed once it turned out to
be blocking test runs against a price that isn't being charged, and it had never been
much of a guard anyway: it checked *launch* time only, so a long run started off-peak
walked into the next window regardless, which is what `lean-search-think-fateh81-0727`
did (17.7h, crossing both windows). If DeepSeek does activate it, `billed_usd` shows it
directly, and `run.json`'s `started_at` with each attempt's `wall_s` is enough to
reconstruct the overlap. None of it reaches the results either way: `cost_std` (the
`@std` column, the comparison metric) is peak-invariant by construction.

**Prompt caching is what makes agent runs affordable.** Every turn resends the whole
transcript, so over a T-turn attempt cumulative input grows ~quadratically in T (Σ_t
context_t) while genuinely new tokens are only linear. DeepSeek caches the conversation
prefix automatically; v4-flash bills input at $0.14/M on cache miss but $0.0028/M on
cache hit (50x cheaper; output $0.28/M — api-docs.deepseek.com/quick_start/pricing). So
the quadratic resent-prefix term carries the tiny cache-hit coefficient and only the
linear new-token term pays full price. Measured over all deepseek runs to date: ~98% of
input tokens were cache hits; uncached, the same traffic would have cost ~13x more
all-in. A model/provider without prompt caching is a non-starter for this harness.
(`tokens.in` counts cache-miss input only; cache-hit volume is `tokens.cache_read`.)

**`cost_std` — the headline comparison metric.** Per attempt and per run:
`0.14·in + 0.0028·cache_read + 0.28·out` per 1M tokens, i.e. the run re-priced at the
fixed off-peak v4-flash table (`STD_PRICES` in `runner/common.js` — the only thing to
update when DeepSeek reprices or the default model changes). Miss-only input ignores
the cache-read quarter of real spend; total-input treats a cached token as 50x its
economic weight; the weighted sum is peak-invariant, so runs are comparable whenever
they ran.

`cost_usd` is **not** what was actually billed — it is pi's own computation from a
baked-in price table (`packages/ai/src/providers/data/deepseek.json`, generated from
models.dev), and it only sees requests that returned a completed message. Reconciled
against DeepSeek's billing page it runs ~7% low: on 07-26 the token volume agrees to
0.5% (2.614B recorded vs 2.628B billed) but the money does not ($9.73 vs $10.41), and
the residual solves to a few million more cache-*miss* input tokens than the harness
recorded — the shape of a small number of failed requests that were billed but never
produced a message to account. Treat `cost_usd` and `cost_std` as lower bounds when
sizing a budget; they are exact for arm comparison (both arms are understated alike)
and approximate for money. The DeepSeek usage dashboard reports in **UTC** days —
confirmed by the 07-26 single-day query matching the UTC bucketing, not UTC+8.

**`billed_usd` — what DeepSeek actually charged.** run.js reads the account balance
(`GET /user/balance`) at launch and again after the last attempt, and writes
`balance_before`/`balance_after`/`billed_usd` into `summary.json` (`balance_before` also
lands in `run.json`, so a killed run still has its opening sample). The delta is
DeepSeek's own number, not a reconstruction — which is the only way to price a single
run, since the API returns no per-request cost and the dashboard aggregates by UTC day:
two runs sharing a day, or one run crossing midnight, cannot be separated after the
fact. This has to be sampled live; an unrecorded boundary is unrecoverable later.
Three conditions, recorded rather than corrected for: the balance is **account-wide**,
so overlapping runs on one key make every delta meaningless; a mid-run top-up reads as
a negative delta and is flagged in `billed_note` instead of reported as a cost; and the
balance carries two decimals, so resolution bottoms out at $0.01 — exact for a grid
cell, coarse for a smoke test. Any failure to reach the endpoint records `null` with a
`billed_note` and never interrupts the run. `cost_std` remains the comparison metric;
`billed_usd` answers "what did this cost", which `cost_std` deliberately does not.

## Adding an extension arm

1. Write `extensions/<name>.ts` (default-export `function (pi: ExtensionAPI)`, register
   tools/events — see pi's `docs/extensions.md`).
2. Declare any tools it registers in a `// @tools name1,name2` header line in the same
   file (pi's `--tools` allowlist filters extension tools too, so run.js must pass
   them; it reads the annotation — no central registry). Prompt-only arms omit it.
3. Optional `extensions/<name>.prompt.md` — appended to the system prompt when the arm is
   in the combo.
4. Run with `--combo <name>`.

**Accounting note for worker-style arms:** any extension that spawns a pi subprocess must
surface that subprocess's tokens/cost into the parent attempt's record, and the
per-problem budget must be shared — otherwise parallel arms get free compute and the
comparison is broken. (Implemented for `lean-spawn`: the runner tails every
`workers/*/session/` beside the parent's session, buckets parent and worker usage
separately, enforces the budget on the sum, and rolls both into the record — see the
spawn arm section below.)

## Tool-level arm designs

**`triage`** (`extensions/lean-verdict.ts`, `runner/triage.js`, join in
`runner/triage-join.js`) — implemented. One judge per problem: a worker-shaped agent
(`runWorker` with a judge view) holding the attempt arm's information tools plus
`submit_verdict(yes|no, reason)`, which records the verdict and ends the session
(pi `terminate`, plus a harness-side watcher that stops the process when verdict.json
appears — covers both pi behaviors). The judge's whole contract: here is the statement,
investigate however you see fit, submit when settled. No method steering, no budget
language; the generous cap (`--cap-std`, default 0.50) is enforcement, not information,
and a capped judge simply ends. If a turn ends with no verdict, a fixed content-free
reminder ("When your verdict is settled, submit it with submit_verdict.") fires, max 3 —
the supervisor pattern, protecting the spend without leaning on the decision.
No-verdict problems are EXCLUDED from the counterfactual (an infra artifact must never
become a filter decision — 2026-08-04) and `triage-join` prints them next to every
headline. The join is the whole evaluation: verdicts reweight an existing cell
(confusion matrix, two-stage solve rate and cost), so the arm costs only the judge
phase.

**`library` phase** (`runner/library.js`; block D) — implemented. One librarian agent
with `spawn_subagents` + `add_fact` + search + `check_snippet` + `read`; the bank IS
the library (`library.lean`), so the compile gate is the only writer, workers
contribute through the same tool, and a capped phase still ships a valid library (the
bank compiles at every prefix). All problem statements ride inline in the system
prompt — no fetch tools; which theory to build and how to split it across workers is
the librarian's call, and the phase cap ($5 default) plus per-worker caps
(`--worker-cap-std`, via the harness-side `maxCostStd` knob) are enforced by
tail-and-SIGKILL, never mentioned to any agent. Artifacts: `library.lean`,
`library.json` (sha256 — the `library_sha` of record), `index.md` (docstring +
signature per fact — the graded run's entire prompt delta).

**Library baking (the block-D graded run).** `CMP_LIB_FILE=<library.lean>` makes every
REPL worker elaborate the library on top of Mathlib at startup and serve all checks
against that env — library names are ambient exactly like Mathlib names, for agents
and grader alike (one definition of compiles), and nobody copies facts anywhere. The
library sha rides in `/health` and inside every memo key (the env identity is part of
the verdict's identity); a library that fails to elaborate is fatal at startup.
`run.js --library results/<phase-dir>/` verifies the running server's sha (refusing
launch on mismatch, both directions), appends index.md to the system prompt, and
stamps `library_sha` into run.json and every record; `regrade.js` refuses runs whose
recorded library does not match the server's. Before any library cell:
`runner/drift-check.js` recompiles every benchmark statement against the library env
and diffs canonical types/values against the bare-env stmt cache — zero drift is a
launch precondition (new instances changing how a statement elaborates would silently
change what is being proved).

**`plan`** (`extensions/lean-plan.ts`, core in `runner/plan.js`) — implemented. Registers
`plan_check`, which validates that `problem.lean` is currently a *plan*: (1) compiles,
(2) statement preserved, (3) no benchmark declaration's own proof term reaches `sorry`
directly (decided by the statement probe against the environment, not by source-line
heuristics) — the main theorem's proof (and any `_solution` abbrev) is complete *in
terms of* sorry'd helper lemmas, so a green check means the compiler has verified the
reduction "helpers ⟹ theorem". Prompt addendum: plan first, get plan_check green, fill helper bodies one at a
time; whether to retry a stuck helper or revise the skeleton is left to the model
(observe the choice, don't mandate it). After the first green, plan_check
appends a "planning phase is done, use lean_check" note (pilot showed the model using
plan_check as a general compile checker, since red plan_checks include compiler output).
Soft gate only: nothing ever refuses; planning stays observable in `tool_calls`.

*Fake-plan caveat:* the definition admits a degenerate plan — one helper restating the
whole theorem, main proof `:= helper ...`. Compiles and passes. Deliberately not gated
(observe planning, don't fight the model); instead every `plan_check` logs, per sorry'd
helper, the token-Jaccard similarity between the helper's sorry goal and the original
theorem's (`restatement_similarity`, ≈1.0 for a verbatim restatement, ≲0.2 for unrelated
— both ends verified against the REPL), and every checked plan is snapshotted to
`results/<run>/<problem>/plans/plan-NN-{green,red}.lean` for post-hoc judging without
re-running. Whether faking is prevalent is empirical; measure before adding an in-loop
judge.

**`replan`** (`extensions/lean-replan.ts`; only meaningful with `plan` — see PLAN.md
experiment 1): registers `vet_skeleton()` — reads `problem.lean`, extracts the sorry'd
helper statements, retrieves top-k candidates per lemma from LeanSearch internally (no
dependence on the `lean-search` combo), then issues one **blank-context** vetting call
(fixed prompt, no conversation history — the independence property; bare completion for
now, a worker pi only if the workers arm lands) and returns one structured verdict per
helper: `{support: strong|weak|none, verdict: keep|flag|reroute, reason:
missing_premise|different_route|type_mismatch|bespoke_ok, suggested_premises: [...]}`.
**The vetting call must see the full LeanSearch v2 metadata per candidate** — kind, type
signature, value, informal name and description (the endpoint returns all of it; don't
strip to name+signature the way the agent-facing `search_mathlib` does — the metadata is
what makes the relevance judgment possible). The prompt encodes
∅-is-a-flag-not-a-falsification: `support: none` with `verdict: keep, reason: bespoke_ok`
is legal. Prompt addendum: after a green `plan_check`, call `vet_skeleton`; on
flag/reroute, consider revising before filling bodies. Soft gate, same philosophy as
`plan`. Intuition: we *look* for a proof, viewing Mathlib as puzzle pieces, instead of
*building* one — plans drift toward what the library supports, which should also be
easier to formalize. Vetting-call tokens roll into the parent attempt's record.

**`facts`** (`extensions/lean-facts.ts`, core in `runner/facts.js`) — implemented.
Registers `add_fact(code)` — compiles [current bank + candidate] on the lean server
(usual heartbeat verdict) and applies the full trust gate: no errors, no sorry (both the
sorries list and the `declaration uses 'sorry'` warning), axioms within the grader's
whitelist (`ALLOWED_AXIOMS`, exported from grade.js, parsed with the same line-number
gate so nothing the candidate prints can spoof a verdict). Deliberately STRICTER than
grading on the lexical tripwire: metaprogramming/axiom/opaque/unsafe/private are
hard-rejected, not logged — grading has a human reading each ⚠, the bank's whole value
is that its contents are trusted blindly (by workers, and by every fact compiled on top).
Named declarations only (the name is what gets axiom-checked and referenced), balanced
namespace/section (an unbalanced candidate would silently re-scope everything appended
after it). Green → append to `facts.lean`, never rewrite; red → compiler output with
positions re-labeled into the candidate's own coordinates (any error in [bank + new] is
attributable to the candidate, since the bank compiled when admitted — bank-region
positions mean a conflict, e.g. a duplicate name, and say so). Admission is serialized
across processes by an on-disk lock (parent and workers share one bank), so the
bank-as-a-whole-compiles invariant survives concurrency. Monotonicity is mechanical,
not requested: a `tool_call` handler blocks `write`/`edit` calls resolving to
`facts.lean`, so the bank is readable with the ordinary `read` tool but writable only
through the compiler. **The bank is in scope for `check_snippet`** ([bank + snippet]
compiled, snippet positions shifted back, bank region stripped) — the channel is usable
everywhere EXCEPT `problem.lean`, which lean_check and grading compile standalone
exactly as before. Prompt addendum (`lean-facts.prompt.md`): copy needed facts (proofs
included, along with any bank lemmas they depend on, in bank order) above the theorem
before finishing; grading is unchanged.

**`spawn`** (`extensions/lean-spawn.ts`, core in `runner/spawn.js`) — implemented.
Registers `spawn_subagents(tasks[])`: a blocking batch — 1–N task briefs, one fresh
worker per brief, all in parallel, and the call returns every report. That shape is the
whole agent's-eye API: no ids, no polling, no collect step to forget; parallelism is the
batch. Each worker is a **child pi subprocess** in `workers/wN/` beside `work/` — the
same launch shape as the attempt itself (`--mode text`, no stdout, session file as the
record, max-tokens extension), NOT an in-process SDK session: it cannot take the parent
down with it, and the sandbox root at `work/` means the parent cannot browse worker
transcripts — reports are the only channel, which is the manipulation. Workers are
spawned undetached (parent pi's process group), so the runner's budget/backstop group
SIGKILL reaps them; a pid file per worker plus a runner-side sweep covers parents that
die on their own (`agent_died`). The worker's view is deliberately small and free: a
role prompt, the problem statement, the bank snapshot when facts is on, and the parent's
task text as the one user message; tools are `check_snippet` + the run's search arms
(+ `add_fact`) — no `lean_check`, no file tools, no spawn (depth 1 is structural: the
extension is never loaded into workers), and no supervisor — a worker that stops has
stopped, its final visible text is the report, and the parent decides what happens next.
**Budget-blind by design (2026-08-04):** the model is never given budget or spend
language — no dollar figures or turn counts in worker report headers (outcome word
only), no cost parameter in the tool schema, nothing about a budget existing in any
description. Spend telemetry lives in tool-result `details` and `worker.json`, which
the model never sees. The first spawn pilot leaked per-worker dollars into reports and
invited strategic early wrap-ups — the opposite of what the arm measures. A per-worker
`max_cost_std` survives in `runner/spawn.js` as a harness-side knob only (message
granularity, overshoot ≤ 1 message). Workers reuse the parent's REPL client id, so an
attempt's workers queue behind its own checks instead of multiplying its share of the
run. Accounting: the runner tails `workers/*/session/` alongside the parent session —
the budget binds the SUM, the record's `tokens`/`cost_usd`/`cost_std` are parent +
workers, and a `workers` array carries the per-worker breakdown (`worker.json` each);
`workers/ledger.json`, kept current by the extension, lets the supervisor's in-process
soft stop agree with the runner's hard cap. The attempt's STOP file aborts in-flight
workers mid-call (the supervisor can only see STOP at agent_end, which never comes while
the blocking call holds the loop). The spawn+plan steering line rides in
`delegate.prompt.md` on a no-op `delegate.ts` (the notes-pattern), so the spawn arm
itself stays tool-description-only.

**`notes`** — prompt-only arm, no tool code: the addendum names a free-form draft file
(`notes.md`) for informal scratch — ideas, failed approaches, case analyses. Never
compiled, never gated, rewritable at will; the absence of enforcement is the treatment.
Anything worth trusting graduates into the bank or into `problem.lean`. Needs a no-op
`extensions/notes.ts` so the combo resolves (the runner requires a `.ts` per combo name);
the `.prompt.md` carries the whole arm.

**`derive`** — prompt-only arm, same no-op-`.ts` pattern: the tactic-first steering line
(derive via `have` steps in `problem.lean`; routine algebra is one tactic away) moves
here from the baseline system prompt, so baseline stops carrying the experiment's
minimal treatment.

## Search backends (`lean-search`, `lean-grep`)

`search_mathlib` (semantic) POSTs to the public **[LeanSearch](https://leansearch.net)**
API (natural language → Mathlib lemmas; no indexing infra on our side). It's someone
else's public endpoint, so if it's flaky or rate-limits during a run, fall back to
[LeanExplore](https://arxiv.org/abs/2506.11085), which is self-hostable — removing the
external-uptime dependency.

`grep_mathlib` (symbolic, PLAN.md block A) greps the local Mathlib checkout at
`lean-env/.lake/packages/mathlib` — the exact source the REPL compiles against, so hits
can't be version-skewed (LeanSearch indexes a different Mathlib pin) and there's no
external dependency. It takes one pattern and no mode parameter: literal, regex,
cross-line and fully-qualified-name readings are tried in a fixed order and the first that
hits wins (**`SEARCH.md` is the exact protocol** — cite that, not this paragraph). Raw hits
are expanded to whole declarations (scan up to the column-0 head, down to `:=`, capped)
and deduped, so the agent sees full signatures, not clipped lines. Both arms carry their
entire prompt delta in the tool description — no `.prompt.md` — so the semantic-vs-grep
comparison manipulates only the tool.

## Scratch verification (`lean-snippet`)

`check_snippet(code)` (PLAN.md block B) compiles a standalone snippet against Mathlib
on the shared lean server — stateless, no files involved, no statement probe (a
snippet is not the graded file, so there is nothing to preserve). Same 120 s check
budget and the same round-robin client id as `lean_check`, so snippet checks queue
behind the attempt's own work; `native_decide` is pre-rejected for the same two
reasons (REPL burn, and a step "verified" with it can never count in `problem.lean`).
The server renders positions as `problem.lean:line:col`, so the core
(`runner/snippet.js`) rebuilds the pretty output with `snippet:` labels from the
structured messages — relabeling client-side rather than server-side because the
memo is keyed by code hash alone and would serve the first caller's label to
everyone. The whole prompt delta lives in the tool description (no `.prompt.md`);
block-C workers get this tool (+ search) instead of `lean_check`.

## Open implementation questions

- Lean environment: toolchain + mathlib pinned to what the benchmark expects; batch
  `lake` vs the persistent REPL (chose REPL).
- Isolation & parallelism: each attempt in a fresh workspace/session; parallelism across
  problems via the worker pool.
- Full-benchmark cost: combos × #problems × avg tokens at DeepSeek pricing — compute
  before committing to how many factors.

## Punted (deliberately)

Turn caps (cost_std budget + wall-clock backstop only), retries/resume, dashboards, lean4checker kernel
re-verification (add before publishing numbers), FATE, all not-yet-built arms.
