# pub-packaging-1162 provenance (not given to arms)

- issue: pypa/packaging#1162
- fix_pr: pypa/packaging#1163 (https://github.com/pypa/packaging/pull/1163)
- merge_sha: b82413d6a1e5037b65aabc44154a97f0b2d63766
- repo.ref (red) = merge^1: 9ac29c01860f5732de260326f272da2346c50003
- source files touched (medium: >=2): src/packaging/_structures.py (new file, the
  backward-compat shim), src/packaging/version.py (__getstate__/__setstate__)
  (CHANGELOG.rst excluded, not source)
- hidden files: tests/test_version.py, trimmed (see below)
- pytest pinned to `<9` in setup: on this host, pytest 9.1.1 turns a pre-existing,
  unrelated `PytestRemovedIn10Warning` (a `parametrize` call elsewhere in this file
  using a `itertools.chain` argvalues, `TestVersion::test_comparison_true`) into a
  collection error because this repo's pyproject.toml sets
  `[tool.pytest.ini_options] filterwarnings = ["error"]`. That failure is
  unrelated to this fix and reproduces at both repo.ref and merge_sha alike, so
  it is an environment/pytest-version issue, not a task defect. Pinning
  `pytest<9` (verified with 8.4.2) collects and runs the file cleanly at both
  commits.
- Trimmed hidden test: dropped the upstream `test_structures_shim_repr` test and
  its module-level `from packaging._structures import Infinity, NegativeInfinity`
  import (both added by this same fix PR). That import fails to resolve at
  repo.ref (the pre-fix commit, where `packaging._structures` does not exist
  yet -- it is the very module this PR restores), which is a file-level
  collection error for the whole test file, not a discriminating test failure
  (same class of problem flagged for arrow#1201/#1138 and the werkzeug
  candidates in this file's own dropped-candidates note). `test_structures_shim_repr`
  only covers `__repr__` formatting of the two shim classes, which is incidental
  to the issue (correct unpickling), so dropping it (precedented by the
  pub-humanize-174 trim pattern) removes the collection blocker without
  removing any test that discriminates the actual bug. The 7 remaining new
  test functions (`test_pickle_roundtrip` x8 params, `test_pickle_old_format_loads`,
  `test_pickle_old_format_re_pickled_is_clean`, `test_pickle_26_0_slots_format_loads`,
  `test_pickle_26_2_tuple_getstate_loads`, `test_pickle_setstate_rejects_invalid_state`)
  are verbatim upstream and cover the actual pickling/unpickling contract.
- hidden.run narrowed with -k "test_pickle" (substring match on all 7 kept
  functions; nothing else in the file starts with test_pickle).
- RED verified: checked out repo.ref, overlaid the trimmed merge_sha version of
  tests/test_version.py, reinstalled (pip install -e .), ran hidden.run:
  `5 failed, 8 passed, 51500 deselected in 1.59s`, rc=1. The 8 passes are the
  plain `test_pickle_roundtrip` parametrizations (round-tripping a pickle
  created and loaded by the same process works even without the fix; they are
  kept because they still exercise Version's pickle path and do not weaken the
  signal). The 5 failures are the backward-compat and error-handling tests:
  `ModuleNotFoundError: No module named 'packaging._structures'` (old/26.0
  format loads) and `AttributeError: 'Version' object has no attribute
  '__setstate__'` (the invalid-state test), matching the issue exactly.
- GREEN verified: checked out merge_sha, applied the same trim to its own copy
  of tests/test_version.py, reinstalled, ran hidden.run:
  `13 passed, 51500 deselected in 1.35s`, rc=0.
- Deletion mutant: at merge_sha, replaced the body of `Version.__setstate__` in
  src/packaging/version.py with a bare `pass` (deletes all restore logic added
  by the fix, keeping only `__getstate__`). Re-ran hidden.run:
  `13 failed, 51500 deselected in 1.50s`, rc=1 (every kept test now fails,
  mostly `AttributeError` since the recomputed fields are never set). Mutant
  reverted (`git checkout -- src/packaging/version.py`); GREEN re-confirmed
  (`13 passed, 51500 deselected in 1.35s`, rc=0).
- D30 no-op baseline: not run through run.sh directly in this pass; RED/GREEN/
  mutant above were verified by hand at each commit with the exact hidden.run
  command, matching the other medium tasks' initial verification.
