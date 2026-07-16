# CMP — harness-extension ablations for Lean theorem proving

Which agent-harness features actually matter for proving competition math in Lean 4?
We fix one harness ([pi](https://github.com/earendil-works/pi)), implement candidate
features as independently-toggleable pi extensions, and measure solve rate + cost for
combinations of them on PutnamBench. See `PLAN.md` (research plan) and `SKELETON.md`
(implementation plan).

## Setup

- Node 22 (`~/.local/node/bin`), pi CLI (`npm i -g @earendil-works/pi-coding-agent`),
  elan/lake (`~/.elan/bin`).
- `.env` with `DEEPSEEK_API_KEY=...` (gitignored).
- `benchmarks/PutnamBench` cloned (gitignored); `lean-env/` built from it:
  copy `lean-toolchain` + `lake-manifest.json`, minimal lakefile requiring mathlib
  `v4.27.0`, then `lake exe cache get`.
- `node runner/sanitize.js --pick 10 --seed 42` → `problems/` + `problems/dev.txt`.
  Sanitization strips `--` comments (answers) AND `/-- -/` docstrings (informal NL
  statement) — by default the agent sees only the formal Lean. For an NL arm:
  `node runner/sanitize.js --keep-nl --out-dir problems-nl`, then run with
  `--problems-dir problems-nl`.

## Running an experiment

```bash
node runner/run.js --problems problems/dev.txt                      # baseline
node runner/run.js --combo lean-search --problems problems/dev.txt  # + semantic search
```

Flags: `--combo a,b` `--problems <file>` `--timeout <s>` (600) `--concurrency <n>` (4)
`--model <id>` (deepseek/deepseek-v4-flash) `--thinking <level>` (off) `--run-id <s>`.

Each problem runs in an isolated scratch dir containing only the sanitized statement
(PutnamBench files have the answers in comments — the agent must never see the repo).
The agent gets `read,edit,write` + the `lean_check` tool, plus whatever the combo adds.

## Grading (independent of the agent)

`runner/grade.js`, run after the agent exits:
1. statement preserved — every code line of the original must survive (docstrings exempt);
2. compiles under Lean 4.27 + Mathlib (`lake env lean` in `lean-env/`);
3. `#print axioms` for every benchmark declaration must be within
   `{propext, Classical.choice, Quot.sound}` — catches `sorry` (sorryAx), new axioms,
   and `native_decide` in one mechanism.

## Results

`results/<run-id>/` (gitignored): `results.jsonl` + `summary.json`, and per problem:
`events.jsonl` (full pi event stream), a replayable pi session file, `work/problem.lean`
(final state), `attempt.json`, `stderr.log`. Stats are computed after the fact from these.

## Adding an extension arm

1. Write `extensions/<name>.ts` (default-export `function (pi: ExtensionAPI)`, register
   tools/events — see pi's `docs/extensions.md`).
2. Add its tool names to `EXT_TOOLS` in `runner/run.js` (pi's `--tools` allowlist also
   filters extension tools, so they must be listed).
3. Run with `--combo <name>`.

## Gotchas learned the hard way

- pi `--tools` filters custom/extension tools too, not just built-ins.
- `lake env lean` on a sorry'd file exits 0 (warning only) — grade via `#print axioms`.
- Compile ≈ 12 s warm / 55 s cold per check (mathlib olean loading dominates).
