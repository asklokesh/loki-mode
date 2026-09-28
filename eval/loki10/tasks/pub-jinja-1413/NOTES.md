# pub-jinja-1413 provenance (not given to arms)

- issue: pallets/jinja#1413
- fix_pr: pallets/jinja#1664 (https://github.com/pallets/jinja/pull/1664)
- merge_sha: fbc3a696c729d177340cc089531de7e2e5b6f065
- repo.ref (red) = merge^1: 1d55cddbb28e433779511f28f13a2d8c4ec45826
- source files touched (medium: >=2): src/jinja2/compiler.py, src/jinja2/parser.py
- hidden files (verbatim upstream at merge_sha): tests/test_core_tags.py
- EV-11b fix (2026-09-28): hidden.run was previously narrowed with -k to
  just test_namespace_set_tuple; that narrowing was reverted because a
  deletion mutant at merge_sha (replacing the `for nsref in
  node.find_all(nodes.NSRef): ...` loop body in
  src/jinja2/compiler.py:visit_Assign, which the fix relocated the
  isinstance(Namespace)/TemplateRuntimeError guard into, with a bare `pass`)
  made the narrowed run exit 0 (the -k filter deselected the two tests that
  would have caught the deletion: test_set_invalid,
  test_namespace_redefined). hidden.run now runs -k "TestSet" (the whole
  class); full-class GREEN at merge_sha is "14 passed" (GREEN.txt), RED at
  ref is "1 failed, 13 passed" (only test_namespace_set_tuple fails, same
  failure as before -- RED.txt), and the same deletion mutant at merge_sha
  now fails (2 failed, 12 passed) instead of exiting 0. Re-verified against
  a fresh clone under the scratchpad (not committed): the hidden test file
  is byte-identical to `git show fbc3a696:tests/test_core_tags.py`.
