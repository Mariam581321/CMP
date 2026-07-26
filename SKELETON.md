# Implementation

How one experiment runs end-to-end. The research design (arms, factorial framework,
protocol) is in `PLAN.md`.

Command: `node runner/run.js --combo lean-search --problems problems/dev.txt` → solve
rate + cost. pi supports DeepSeek natively (`deepseek/deepseek-v4-flash`, reads
`DEEPSEEK_API_KEY` from `.env`, gitignored) — no OpenAI-compat shim.

## How one attempt works

1. Runner makes a scratch dir with only the **sanitized** `problem.lean` + short
   instructions. No path to the benchmark repo.
2. Spawns pi headless in that dir:
   ```
   pi --mode json --session <transcript> --no-extensions --no-skills -nc \
      --model deepseek/deepseek-v4-flash --tools read,edit,write \
      -e extensions/lean-check.ts [-e extensions/lean-search.ts ...] \
      --append-system-prompt <prover instructions> \
      "Prove the theorem in problem.lean"
   ```
   Baseline = read/edit/write + `lean_check` only (no bash/grep). Combo = extra `-e`
   flags. `extensions/<name>.prompt.md` is appended to the system prompt when `<name>` is
   in the combo, so prompt deltas are versioned per arm.
3. Streams all JSON events to `events.jsonl`; kills the process when the per-problem
   cost_std budget is spent (wall-clock cap kept only as a backstop for attempts that
   hang or spend slowly).
4. **Grades independently** after the agent exits (never trust the agent's own
   lean_check).
5. Appends one record to the run's `results.jsonl`.

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
(`stmtProbe`) + `#print axioms` for each benchmark declaration. After the file
elaborates, the probe looks each declaration up in the environment and prints one info
line — kind (thm/defn/axiom/…), safety (safe/unsafe/partial), and the elaborated type
canonicalized (binder names erased, elaboration metadata stripped, universe params
renamed) and printed as a raw kernel expression with fully-resolved constant names.
Original-side answers come from the same probe run once per problem and cached in
`problems/stmt-types.json`, keyed by source hash (derived + gitignored like the problem
files; `node runner/grade.js --build-stmt-cache` rebuilds all, grade.js lazily fills
misses). The probe works on non-compiling files too: Lean's error recovery registers any
declaration whose *signature* elaborates (failed proofs become sorryAx), so statement
verdicts don't require a compiling proof.

**Verdict order** (first hit wins, so reason distributions stay comparable with v1):

1. `statement_changed` — declaration missing (renamed/deleted/statement doesn't
   elaborate), type differs, or kind differs (e.g. theorem redeclared as `axiom`/`def`).
2. `unsafe_decl` — declaration not `safe`: `unsafe` code may use kernel bypasses like
   `unsafeCast`. (`unsafe theorem` is illegal in Lean, so only the `_solution` def slot
   is exposed; `#print axioms` happens to flag today's `unsafeCast` pattern via
   `lcProof`, so this is deliberate redundancy, not the only line of defense.)
3. `compile_error` — any error-severity message. If the file is so broken the parser
   never reaches the probe (unterminated comment/bracket), it grades here with
   "statement unknown" in the detail — the one case where statement preservation is
   genuinely undeterminable.
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
re-verification of an unchanged file is ~free.

Speed context: a cold `lake env lean` deserializes all of Mathlib (~6 GB, 12–50 s) to
check a 20-line file; the REPL avoids the re-import (~1–5 s/check). Also cap
`maxHeartbeats` per check to bound runaway tactic searches (`decide`, etc.). With fast
checks the LLM becomes the bottleneck → agent concurrency 8–16.

*Not doing:* minimal per-problem imports (changes the benchmark — import hints are premise
hints), skipping independent grading, parallel arms while wall-time matters.

## Concurrency

`--concurrency N` worker pool over problems (default 6): each attempt = own scratch dir +
own pi subprocess; checks hit the shared warm REPL. LLM calls are I/O-bound and DeepSeek
is rate-limit-friendly; Lean compiles were the old bottleneck (now the REPL).

## Logging (stats computed after the fact, never during)

Per attempt under `results/<run-id>/<problem>/`: `events.jsonl` (full pi event stream),
pi session file (replayable transcript), `problem.lean` final state, `attempt.json`,
`stderr.log`, and `plans/` for the plan arm. Run-level `results.jsonl`, one record per
attempt:
```json
{"run_id": "...", "problem": "putnam_1962_a1", "combo": ["lean-search"],
 "model": "deepseek-v4-flash", "started_at": "...", "wall_s": 412, "turns": 14,
 "tokens": {"in": 84000, "out": 9100, "cache_read": 2400000}, "cost_usd": 0.021, "cost_std": 0.021,
 "tool_calls": {"lean_check": 6, "search_mathlib": 3},
 "solved": false, "fail_reason": "budget_exceeded|timeout|uses_sorry|compile_error|statement_changed|unsafe_decl|bad_axioms|provider_error",
 "suspicious_keywords": null, "harness_git_sha": "..."}
```
Everything raw is kept, so any stat (tool-use patterns, time-to-first-check, error types)
is computable later without re-running.

## Files

```
runner/run.js               spawn pi per problem, worker pool, logging
runner/sanitize.js          PutnamBench src/*.lean -> problems/*.lean (strip answers + docstrings)
runner/grade.js             independent grading over the lean server
runner/regrade.js           re-grade finished runs with the current grader (read-only)
runner/lean-server.js       persistent Lean REPL HTTP daemon
runner/plan.js              plan_check core logic
extensions/lean-check.ts    always-on agent-facing compile tool
extensions/lean-search.ts   semantic search (LeanSearch API)
extensions/lean-plan.ts     plan_check (+ lean-plan.prompt.md)
extensions/max-tokens.ts    injects the per-response max_tokens (always on; default = model max)
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
--timeout <s>        (43200) wall-clock backstop | --concurrency <n> (6)
--model <id>         deepseek/deepseek-v4-flash | --thinking <level> (off)
--max-tokens <n>     per-response output cap, always sent (default 384000 = model max;
                     set low, e.g. 8192, only for capped experiment cells)
--run-id <s>         default combo+timestamp
--peak-ok            allow launching during DeepSeek peak hours (see below)
```

DeepSeek peak-valley pricing (since mid-July 2026): 2x on all billing items during
01:00–04:00 and 06:00–10:00 UTC (03:00–06:00 and 08:00–12:00 Poland summer time —
launching after 12:00 noon local is always off-peak). run.js refuses to start a
deepseek run inside a peak window without `--peak-ok`. Runs that overlap a window get
`peak_pricing: true` in summary.json, and compare.js flags them: their cost_usd is not
comparable with off-peak runs — compare on `cost_std` (the `@std` column) instead.

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
they ran. `cost_usd` stays what was actually billed.

## Adding an extension arm

1. Write `extensions/<name>.ts` (default-export `function (pi: ExtensionAPI)`, register
   tools/events — see pi's `docs/extensions.md`).
2. Add its tool names to `EXT_TOOLS` in `runner/run.js` (pi's `--tools` allowlist filters
   extension tools too, so they must be listed).
3. Optional `extensions/<name>.prompt.md` — appended to the system prompt when the arm is
   in the combo.
4. Run with `--combo <name>`.

**Accounting note for worker-style arms:** any extension that spawns a pi subprocess must
surface that subprocess's tokens/cost into the parent attempt's record, and the
per-problem budget must be shared — otherwise parallel arms get free compute and the
comparison is broken.

## Tool-level arm designs

**`plan`** (`extensions/lean-plan.ts`, core in `runner/plan.js`) — implemented. Registers
`plan_check`, which validates that `problem.lean` is currently a *plan*: (1) compiles,
(2) statement preserved, (3) every `sorry` lies **outside** the benchmark declarations —
the main theorem's proof (and any `_solution` abbrev) is complete *in terms of* sorry'd
helper lemmas, so a green check means the compiler has verified the reduction "helpers ⟹
theorem". Prompt addendum: plan first, get plan_check green, fill helper bodies one at a
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

**`facts`** (`extensions/lean-facts.ts`): registers `add_fact(lemma_code)` — compiles
[current bank + new lemma] on the lean server and applies the full trust gate: no errors,
no `declaration uses sorry`, axioms within the allowed set (reuses the grade.js checks).
Green → append to `facts.lean`, never rewrite. Red → return the compiler output and write
nothing; since every lemma already in the bank compiled when it was admitted, any error
in [bank + new] is attributable to the submitted lemma (offset line numbers so they point
into the submitted snippet). Compiling against the bank prefix lets facts build on
earlier facts. Monotonicity is mechanical, not requested: a `tool_call` handler blocks
`write`/`edit` calls resolving to `facts.lean` (pi's documented path-protection pattern),
so the bank is readable with the ordinary `read` tool but writable only through the
compiler. Prompt addendum: the final `problem.lean` must stay self-contained — copy
needed facts (proofs included, along with any bank lemmas they depend on) above the
theorem; grading is unchanged.

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

## Search backend (`lean-search`)

`search_mathlib` POSTs to the public **[LeanSearch](https://leansearch.net)** API
(natural language → Mathlib lemmas; no indexing infra on our side). It's someone else's
public endpoint, so if it's flaky or rate-limits during a run, fall back to
[LeanExplore](https://arxiv.org/abs/2506.11085), which is self-hostable — removing the
external-uptime dependency.

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
