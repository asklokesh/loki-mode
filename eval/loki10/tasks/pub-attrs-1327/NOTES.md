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
- D30 no-op baseline (run 2026-09-30 through run.sh): `STUB_MODE=noop LOKI_EVAL_CLAUDE_BIN=<abs path>/eval/loki10/fixtures/stub-arm.sh bash eval/loki10/run.sh --arm raw-claude --task pub-attrs-1327` gave status=ok, hidden_pass=false, completed=false, exit_code=0, pr_opened=false. The stub path must be absolute: a relative path gives exit_code 127 (stub not found), which is not a valid baseline.
- Requires no special host setup; verified on this host's Python 3.14.6.

- S41-20 pre-check (2026-09-30), `git diff --stat 53e632c5218b 6fda0a4e086b` verbatim (source files are the .py files under src/ or the package dir; changelog, docs and tests are not counted):
     changelog.d/1328.change.md |  1 +
     src/attr/_make.py          | 32 ++++++++++++++++++++------------
     src/attr/setters.py        | 11 ++++++++---
     tests/test_converters.py   | 33 +++++++++++++++++++++++++++++++++
     tests/test_setattr.py      | 36 +++++++++++++++++++++++++++++++++++-
     5 files changed, 97 insertions(+), 16 deletions(-)
- Criterion 1 (D30): each source file restricted with `git apply --include=<file>` onto repo.ref plus the hidden files; no single file makes hidden.run pass. Wrong-fix probes: Converter.__call__ fix (_make.py) alone -> 2 failed, 5 passed (test_pipe and test_setattr_converter_piped still fail); the setters.py changes alone -> 7 failed. -k covers all 4 tests the PR added or changed (test_pickle x4, test_works_as_adapter, test_pipe, test_setattr_converter_piped), no widening needed. Reproducer: the issue's MWE at repo.ref raises `AttributeError: 'attr._make.Converter' object has no attribute '__call__'` from setters.py convert().
- refdiff: eval/loki10/refdiff/pub-attrs-1327.diff is the measure-size.py source-only filter of that diff; `python3 eval/loki10/measure-size.py` exits 0 and classifies the task medium.
