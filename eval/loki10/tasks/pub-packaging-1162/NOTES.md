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
- D30 no-op baseline (run 2026-09-30 through run.sh): `STUB_MODE=noop LOKI_EVAL_CLAUDE_BIN=<abs path>/eval/loki10/fixtures/stub-arm.sh bash eval/loki10/run.sh --arm raw-claude --task pub-packaging-1162` gave status=ok, hidden_pass=false, completed=false, exit_code=0, pr_opened=false. The stub path must be absolute: a relative path gives exit_code 127 (stub not found), which is not a valid baseline.

- S41-20 pre-check (2026-09-30), `git diff --stat 9ac29c01860f b82413d6a1e5` verbatim (source files are the .py files under src/ or the package dir; changelog, docs and tests are not counted):
     CHANGELOG.rst                |   6 +-
     src/packaging/_structures.py |  33 ++++++++++
     src/packaging/version.py     |  67 ++++++++++++++++++++
     tests/test_version.py        | 148 +++++++++++++++++++++++++++++++++++++++++++
     4 files changed, 253 insertions(+), 1 deletion(-)
- Criterion 1 (D30): each source file restricted with `git apply --include=<file>` onto repo.ref plus the hidden files; no single file makes hidden.run pass. Wrong-fix probes: _structures.py shim alone -> 5 failed (no __setstate__/__getstate__); version.py alone -> 3 failed (old pickles still need packaging._structures). A __setstate__ that handles only the old dict format is caught by test_pickle_26_0_slots_format_loads / test_pickle_26_2_tuple_getstate_loads, all of which match -k test_pickle (6 of the PR's 7 new tests; test_structures_shim_repr is the excluded one, see above). Reproducer: at repo.ref packaging/_structures.py does not exist, so unpickling any pre-26.1 Version raises ModuleNotFoundError (RED run shows it).
- refdiff: eval/loki10/refdiff/pub-packaging-1162.diff is the measure-size.py source-only filter of that diff; `python3 eval/loki10/measure-size.py` exits 0 and classifies the task medium.

- r2 review fix (2026-09-30): review reproduced that `test_pickle_setstate_rejects_invalid_state` asserts `match="Cannot restore Version"`, an exact message the issue never states. Removed that test from the hidden file (hidden file now ends at the last `test_pickle_*` function; task.json has no hash fields). This supersedes the earlier bullets above: 6 new test functions remain (`test_pickle_roundtrip` x8 params, `test_pickle_old_format_loads`, `test_pickle_old_format_re_pickled_is_clean`, `test_pickle_26_0_slots_format_loads`, `test_pickle_26_2_tuple_getstate_loads`), 12 tests under -k test_pickle, not 13.
  Re-run through the exact hidden.run (.venv, pytest<9): RED at repo.ref `4 failed, 8 passed, 51500 deselected`, rc=1; GREEN at merge_sha `12 passed, 51500 deselected`, rc=0 (RED.txt/GREEN.txt regenerated). Each source file applied alone onto repo.ref (diff of that file between ref and merge, applied): `_structures.py` alone `4 failed, 8 passed` rc=1; `version.py` alone `3 failed, 9 passed` rc=1. Still a two-file task on the upstream split. The earlier deletion-mutant line (13 failed) was against the pre-trim file and was not re-run.
  Own one-file attempt (honest result, NOT rejected): version.py from the fix plus a `sys.modules["packaging._structures"]` stub module injected at the bottom of version.py, with no `_structures.py`, gives `12 passed` rc=0. So a hacky one-file route exists (inject the module at import instead of shipping the shim file); the two-file property holds for the upstream split of the fix, not for every correct solution. Flagged for the reviewer to decide.
