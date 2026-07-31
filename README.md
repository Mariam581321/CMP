# CMP — harness-extension ablations for Lean theorem proving

Which agent-harness features actually matter for proving competition math in Lean 4? We
fix one harness ([pi](https://github.com/earendil-works/pi)), implement candidate
features as independently-toggleable pi extensions, and measure solve rate + cost for
combinations of them. The experiment grid runs on **FATE-H** (100 graduate-level algebra
problems); PutnamBench built the harness and stays a secondary anchor.

- **[`PLAN.md`](PLAN.md)** — the research plan: the factorial framework (three questions
  every harness answers), the papers and experiments as vectors in it, protocol, open
  questions, and todos.
- **[`SKELETON.md`](SKELETON.md)** — the implementation: how one attempt runs end-to-end,
  independent grading, the persistent lean server, logging, and tool-level arm designs.
- **[`NOTES.md`](NOTES.md)** — the full collection of research ideas
- **[`papers/INDEX.md`](papers/INDEX.md)** — annotated reference papers + candidate
  benchmarks with open-source verification notes (PDFs gitignored; the index is the
  record).

## Setup

- Node 22 (`~/.local/node/bin`), pi CLI (`npm i -g @earendil-works/pi-coding-agent`),
  elan/lake (`~/.elan/bin`).
- `.env` with `DEEPSEEK_API_KEY=...` (gitignored).
- `benchmarks/PutnamBench` cloned (gitignored); `lean-env/` built from it (copy
  `lean-toolchain` + `lake-manifest.json`, minimal lakefile requiring mathlib `v4.27.0`,
  `lake exe cache get`).
- `node runner/sanitize.js --pick 10 --seed 42` → `problems/` + `problems/dev.txt`.
  Strips `--` comments (answers) and `/-- -/` docstrings (NL statement); for an NL arm,
  `--keep-nl --out-dir problems-nl` then run with `--problems-dir problems-nl`.

## Running

```bash
node runner/run.js --problems problems/dev.txt                      # baseline
node runner/run.js --combo lean-search --problems problems/dev.txt  # + semantic search
```

Flags: `--combo a,b` `--problems <file>` `--budget-std <usd>` ($1.00 cost_std cap per
problem) `--timeout <s>` (172800, wall-clock backstop) `--concurrency <n>` (12)
`--model <id>` (deepseek/deepseek-v4-flash) `--thinking <level>` (high)
`--check-cpu <s>` (120, CPU-seconds per check — the one compile budget) `--run-id <s>`.
Unknown flags are hard errors. Output is uncapped by default (model-max `max_tokens`
sent explicitly); `--max-tokens` sets a tight cap only for capped experiment cells.

The agent gets `read,edit,write` + `lean_check`, plus whatever the combo adds, in an
isolated scratch dir (the agent must never see the benchmark repo — answers leak in
comments). Grading is independent of the agent (`runner/grade.js`). The proof-rule
line is *kernel-checked or it doesn't count*: `decide`/`norm_num`/`omega` are
kernel-verified computation and fine; `native_decide` (trusts the native compiler via
`ofReduceBool`) and new axioms are banned — enforced by `#print axioms` at grading,
pre-rejected lexically by agent-facing checks. See SKELETON.md.

## Gotchas learned the hard way

- pi `--tools` filters custom/extension tools too, not just built-ins.
- `lake env lean` on a sorry'd file exits 0 (warning only) — grade via `#print axioms`.
- Compile ≈ 12 s warm / 55 s cold per check (mathlib olean loading dominates) → use the
  persistent REPL.
