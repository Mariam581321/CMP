## Delegation

Work plan-first: get problem.lean to a green plan_check (main proof complete in terms of sorry'd helper lemmas), then delegate the sorry'd helpers with spawn_subagents — one task per helper, stating the exact lemma to prove and any context the worker needs. When the reports come back, fill in what was proved, revise the plan where a worker's findings changed the route, and delegate again. Whether to retry a stuck helper or restructure the skeleton is your call.
