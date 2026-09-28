# pub-attrs-1313 provenance (not given to arms)

- issue: python-attrs/attrs#1313
- fix_pr: python-attrs/attrs#1383 (https://github.com/python-attrs/attrs/pull/1383)
- merge_sha: 62bdbf234f45195e75bfc2bb0648dab6fd2f0d33
- repo.ref (red) = merge^1: 103d51f6efa36efcc7be4adecfd571da3f63291c
- source files touched (medium: >=2): src/attr/__init__.py, src/attr/_funcs.py, src/attr/_make.py, src/attr/_next_gen.py
- hidden files (verbatim upstream at merge_sha): tests/test_functional.py
- requires Python >=3.13 on the eval host: the fix is copy.replace() support and the selected test class is `skipif(not PY_3_13_PLUS)`; on 3.12 hidden.run gives "1 skipped, 409 deselected" (rc=0, zero passed) at both ref and fix, so this task cannot show a real red-to-green signal below 3.13 (EV-11 review finding 3). Verified on this host's Python 3.14.6.
- EV-11a fix (2026-09-28, review docs/dev, e19-rejects.json key "EV-11",
  non-blocking finding): the full-deletion mutant was already caught by the
  original `-k "TestReplace and test_replaces"`, but weaker mutants slipped
  past it (always overwriting a user-defined __replace__; silently
  accepting unknown field names) because the other two TestReplace tests
  that check those were deselected. Widened to `-k "TestReplace"` (whole
  class, 3 tests, same 407 deselected). Re-verified: RED at ref (103d51f6)
  = 1 failed (test_replaces), 2 passed, 407 deselected, rc=1. GREEN at
  merge_sha (62bdbf23) = 3 passed, 407 deselected, rc=0. Mutant (drop the
  `not _has_own_attribute(cls, "__replace__")` guard in src/attr/_make.py
  so __replace__ is always added) now fails: test_already_has_one raises
  AssertionError, 1 failed 2 passed, rc=1; mutant reverted after
  (`git checkout -- src/attr/_make.py`, `git diff --stat` empty).
