# pub-attrs-1327 provenance (not given to arms)

- issue: python-attrs/attrs#1327
- fix_pr: python-attrs/attrs#1328 (https://github.com/python-attrs/attrs/pull/1328)
- merge_sha: 6fda0a4e086b56d7058855e4c15112c8f58de74c
- repo.ref (red) = merge^1: 53e632c5218b729da6ac37a35b4b68379dc18999
- source files touched (medium: >=2): src/attr/_make.py, src/attr/setters.py (changelog.d/1328.change.md excluded, not source)
- hidden files (verbatim upstream at merge_sha): tests/test_converters.py, tests/test_setattr.py
- hidden.run narrowed with -k to the 4 test methods the fix PR added or changed: test_pickle
  (TestConverter, parametrized x4, gained an assertion that a Converter-wrapped
  callable is itself callable), test_works_as_adapter (new, TestConverter),
  test_pipe (TestSetAttr, changed to assert the chained converter receives
  instance/field), test_setattr_converter_piped (new, TestSetAttr, explicit
  regression test citing this issue).
- RED verified: checked out repo.ref, overlaid the merge_sha versions of both
  hidden test files (old test files at ref lack the new/changed assertions and
  pass trivially against old source, so they are not a valid RED signal by
  themselves), reinstalled (`pip install -e .`), ran hidden.run:
  `7 failed, 61 deselected in 0.12s`, rc=1. All 7 failures are
  `AttributeError: 'attr._make.Converter' object has no attribute '__call__'`,
  the exact crash in the issue.
- GREEN verified: checked out merge_sha as-is (own test files + fixed source),
  reinstalled, ran hidden.run: `7 passed, 61 deselected in 0.03s`, rc=0.
- Deletion mutant: at merge_sha, in src/attr/_make.py's `pipe_converter`,
  changed `val = c(val, inst, field) if isinstance(c, Converter) else c(val)`
  to `val = c(val)` (drops the Converter-adapter branch added by the fix).
  Re-ran hidden.run: `1 failed, 6 passed, 61 deselected in 0.04s`, rc=1
  (`test_pipe` raises `TypeError: Converter._takes_both() missing 2 required
  positional arguments: 'instance' and 'field'`). Mutant reverted
  (`git checkout -- src/attr/_make.py`); GREEN re-confirmed (`7 passed, 61
  deselected in 0.03s`, rc=0).
- D30 no-op baseline: not run through run.sh directly in this pass (network/
  worktree sandbox); the RED/GREEN/mutant runs above used the exact
  hidden.run command by hand at each commit, matching the methodology of the
  other medium tasks' initial verification.
- Requires no special host setup; verified on this host's Python 3.14.6.
