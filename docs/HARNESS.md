# The harness

How one attempt runs, what the agent sees, and how it is graded. The system prompt,
the tool descriptions and the nudge messages are reproduced verbatim in the paper's
appendix.

## One attempt

`runner/run.js` takes a design (`--combo`, a list of extensions) and a problem list and
runs one attempt per problem, `--concurrency` at a time. For each problem it:

1. Creates a scratch directory containing only `problem.lean`: the benchmark statement
   with every comment and docstring removed. The agent never sees the benchmark
   repository.
2. Starts one headless pi process in that directory with the always-on extensions, the
   design's extensions and the system prompt (in `run.js`; `extensions/<name>.prompt.md`
   is appended when `<name>` is in the design).
3. Tails pi's session file for token usage and kills the process when the budget is
   reached.
4. Grades the final `problem.lean` independently of anything the agent reported.

Fixed settings: `deepseek/deepseek-v4-flash`, thinking `high`, a `$1.00` cap
(`--budget-std`), and `max_tokens` sent on every request as the room left in the
context window, at most 384,000 and at least 131,072. When the room drops below the
floor the request is refused before inference and pi compacts the conversation.
Unknown flags are errors.

## Always-on extensions

| extension | role |
|---|---|
| `lean-check` | the `lean_check` tool: compile `problem.lean` through the Lean server and report the verdict, the errors, the goals at each `sorry`, whether the statement is intact and whether the axioms are clean. Also snapshots the file at every verified check (the high-water mark) |
| `file-sandbox` | confines `read`, `write` and `edit` to the attempt directory, plus a read-only Mathlib source tree in grep designs |
| `cmp-edit` | replaces pi's `edit` with one that does no Unicode normalisation (pi's rewrites Lean identifiers) and shows the closest region of the file on a failed match |
| `supervisor` | the end-of-turn policy: compile the file, end the attempt if verified, otherwise nudge (below) |
| `max-tokens` | sizes `max_tokens` per request as above |
| `compaction-guard` | if pi's own compaction request fails, drops errored messages and truncates over-long thinking blocks so that it can succeed |

## Termination and nudges

After every agent turn the supervisor compiles the current file. If it is verified, the
attempt ends. Otherwise the supervisor replies with the compiler output and an
instruction to continue. A turn the agent ended by itself, with the statement intact
and no verified proof, is a *give-up*. Up to three consecutive nudges without progress
are allowed, where progress is any tool call other than `read`; then the attempt ends.
Nudges after an output-token cutoff, a transport error or a modified statement are not
give-ups. The attempt also ends when the budget is exhausted (the runner kills the
process, overshooting by at most one message) or at the wall-clock backstop
(`--timeout`, 48 hours).

## The Lean server

`runner/lean-server.js` keeps a pool of Lean REPL processes (`vendor/repl` with our
retention patch) that import Mathlib once and serve checks over HTTP on port 8787
(`CMP_LEAN_PORT`). Every check by the agent, the supervisor and the grader goes through
it.

The verdict is deterministic: the server injects `maxHeartbeats 400000` per declaration
(a file may lower it, not raise it), so a timeout is an ordinary compile error that
reproduces on any machine. CPU time, wall clock and memory limits are fuses that
protect the machine. A check they kill is retried and, past the retry cap, reported as
unavailable, never as a verdict. Results are memoized by file hash. A file containing
`native_decide` is refused before compilation. Eight style linters are switched off;
deprecation warnings are kept.

Environment: `CMP_LEAN_ENV` (default `lean-env/`), `CMP_REPL_BIN`, `CMP_REPL_WORKERS`
(default 6, one per physical core; the pool costs about 6 GB once plus 1 to 3 GB per
worker) and
`CMP_REPL_MAX_RSS_MB`. `run.js` records the server's check fingerprint in `run.json`
and refuses to launch against a server whose checks differ from the checkout's.

## Grading

`runner/grade.js` recompiles the final `problem.lean` and applies four checks:

1. The file compiles.
2. The elaborated type of every benchmark declaration equals the original's, compared
   in the environment up to alpha-equivalence rather than as text, and the body of every
   setup definition is unchanged.
3. No declaration changed kind or became `unsafe` or `partial`.
4. `#print axioms` lists nothing beyond `propext`, `Classical.choice` and `Quot.sound`,
   which catches `sorry`, new axioms and `native_decide`.

`lean_check` applies the same predicate, so a file reported `COMPLETE` to the agent is a
file the grader accepts. `runner/regrade.js` re-grades finished runs with the current
grader and reports flips without touching recorded verdicts.

## Cost

Spend is computed from the token counts in the session file at a fixed price table,
DeepSeek's list prices for the model on 2026-07-22: $0.14 per million input tokens,
$0.0028 per million cache-hit input tokens, $0.28 per million output tokens, thinking
included (`costStd` in `runner/common.js`). Every dollar figure in the paper is this
`cost_std`, a function of the transcript alone, not the amount billed. Worker sessions
are tailed alongside the parent and counted in the same budget.

## Retrieval and scratch compilation

`search_mathlib` (`extensions/lean-search.ts`) sends the query to the public LeanSearch
API and returns its six nearest declarations with type signatures. Requests are paced
and retried inside the tool, so a rate limit costs wall-clock time and never reaches the
model. The result count is fixed on purpose: when it was a parameter the agent set it on
most calls, so the design would have measured a mix of depths.

`grep_mathlib` (`extensions/lean-grep.ts`, core in `runner/grep.js`) searches the
Mathlib source of the compiled version and tries readings of the pattern in order until
one matches: a fully qualified declaration name, literal text, literal text ignoring
case, a regular expression, the same ignoring case, and finally a match across the line
breaks of a wrapped signature. Each hit is expanded to the whole declaration and given
the name Lean assembles from the enclosing namespaces, which is often not the name
written in the source. Declarations whose name matches rank before those that merely
mention the pattern. At most 25 are returned, each with file and line, and the sandbox
exposes the Mathlib tree read-only so that `read` can open them.

`check_snippet` (`extensions/lean-snippet.ts`, core in `runner/snippet.js`) compiles a
standalone snippet through the same server and renders the result like `lean_check`,
without the statement and axiom facts a snippet does not have. In fact-bank designs the
snippet is compiled with the bank in scope.

## Workers and the fact bank

A worker (`runner/spawn.js`) is a fresh pi session with the same model and thinking
level, the worker prompt, `check_snippet`, the design's search tools and, in fact-bank
designs, `add_fact`. It has no file tools, no `lean_check` and no supervisor.
`spawn_subagents` blocks until every worker finishes and returns each worker's last
message. Workers cannot spawn workers.

The fact bank (`runner/facts.js`) is `facts.lean` in the attempt directory, writable
only through `add_fact`. A candidate is compiled together with the bank and admitted
only if it produces no error, no `sorry` and no axiom beyond the three allowed.
`check_snippet` sees the bank; `lean_check` and the grader do not, so a proof that uses
a bank fact must copy it into `problem.lean`.

## Results layout

`results/<run-id>/` holds `run.json` (the full configuration, git SHA, pi version,
server fingerprint), `results.jsonl` (one record per attempt: how it ended, the grade,
tokens, cost, tool-call counts, nudges, the high-water mark) and `summary.json`. Each
`results/<run-id>/<problem>/` holds the pi session file (the complete transcript, nudges
included, plus worker sessions), the final `problem.lean`, `attempt.json`, `stderr.log`
and the high-water snapshots. Nothing is computed during the run beyond what stopping
requires; everything else is derived afterwards (`docs/ANALYSIS.md`).

## Adding a tool

A design is a list of extensions and nothing else. To add one, write
`extensions/<name>.ts` registering the tool (its description is the whole prompt delta),
optionally `extensions/<name>.prompt.md` for a system-prompt addendum, and pass `<name>`
in `--combo`. Compilation goes through `postCheck` in `runner/common.js` so that the
tool gets the same verdict as everything else.
