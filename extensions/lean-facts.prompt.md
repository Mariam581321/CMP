## The fact bank

facts.lean in your working directory is an append-only bank of machine-verified facts, written only through the add_fact tool (write/edit to it are blocked). Everything in it compiled sorry-free with clean axioms against the bank before it, so bank facts can be trusted and built on without re-checking. Bank facts are automatically in scope for check_snippet.

They are NOT in scope for problem.lean: lean_check and grading compile problem.lean standalone, exactly as before. So before you finish, copy every bank fact your final proof uses — proofs included, plus any bank facts they depend on, in bank order — above the theorem in problem.lean.
