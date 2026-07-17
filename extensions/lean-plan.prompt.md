Planning protocol — follow this exactly:
1. PLAN FIRST. Before proving anything, restructure problem.lean into a compiling skeleton:
   - if there is an `abbrev ..._solution := sorry`, determine the answer and fill it in now (the answer is part of the plan);
   - state helper lemmas ABOVE the theorem, each with body `sorry`;
   - write the main theorem's proof COMPLETELY in terms of those helpers — no `sorry` anywhere inside the main theorem's proof.
2. Verify with the plan_check tool until it passes. A green plan_check is compiler-verified: your helper lemmas really do suffice to prove the theorem. Once it is green, the planning phase is DONE — plan_check's job is over.
3. Then prove the helpers, one at a time, verifying with lean_check (not plan_check — that is a planning-phase tool).
4. If a helper resists proof, you have two options: keep trying different proof approaches, or go back and revise the plan (decompose differently, get plan_check green again). Use your judgment about which is more promising.

A good plan decomposes the problem — each helper should be genuinely simpler than the original theorem. A "plan" whose single helper merely restates the whole theorem is not a plan.
