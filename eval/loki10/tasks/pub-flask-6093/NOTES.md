# pub-flask-6093 provenance (not given to arms)

- issue: pallets/flask#6093
- fix_pr: pallets/flask#6096 (https://github.com/pallets/flask/pull/6096)
- merge_sha: 05e9c6bd630ecf4ec0ec884b1fc7901663737bc7
- repo.ref (red) = merge^1: 514fc6b3e8402e4c646d5284e97a4f0ab50a7c4b
- source files touched (medium: >=2): src/flask/app.py, src/flask/testing.py
  (CHANGES.rst also touched, not a source file)
- hidden files (verbatim upstream at merge_sha): tests/test_testing.py,
  tests/test_basic.py. Both taken whole (not trimmed): scanned for the
  local-ci.sh emoji gate ([\x{1F300}-\x{1FAFF}\x{2600}-\x{27BF}]) and for
  U+2013/U+2014, 0 hits in either file.
- issue author supplied the exact reproduction for both new/changed tests
  (test_session_transaction_ipv6, and one new parametrize row added to
  test_run_from_config); the fix PR's test diff matches the issue verbatim.
- hidden.run is narrowed with -k "test_session_transaction_ipv6 or
  test_run_from_config": the first is the new test function, the second is
  the existing parametrized test whose new row discriminates (its other
  rows already pass at ref and stay selected/passing, matching the D30
  policy of running the whole discriminating function, not deselecting
  individual parametrize rows).
- RED at ref (514fc6b3, hidden files copied in from merge_sha, exact
  hidden.run command): 2 failed, 7 passed, 150 deselected, rc=1.
  - tests/test_testing.py::test_session_transaction_ipv6 -- AssertionError
    (response body is not "42": the session cookie's host was parsed via
    `ctx.request.host.partition(":")[0]`, which truncates an IPv6 host at
    its first colon).
  - tests/test_basic.py::test_run_from_config[None-None-[::1]:8080-::1-8080]
    -- ValueError: invalid literal for int() with base 10: ':1]:8080' (same
    root cause in Flask.run: `server_name.partition(":")` truncates at the
    first colon inside the bracketed IPv6 literal).
- GREEN at merge_sha (05e9c6bd, exact hidden.run command): 9 passed,
  150 deselected, rc=0.
- deletion mutant (merge_sha, git apply -R of the source-only diff between
  ref and merge_sha restricted to src/flask/app.py and src/flask/testing.py,
  hidden test files left at their merge_sha content): both selected tests
  fail again identically to RED (2 failed, 7 passed, 150 deselected, rc=1).
  Mutant reverted (`git apply` the same diff forward); GREEN re-confirmed
  (9 passed, 150 deselected, rc=0); `git status --porcelain` empty after.
- public API only: Flask.run(), Flask.test_client().session_transaction().
  No private symbols.
- RED/GREEN both re-verified through the exact hidden.run command above (not
  hand-simulated), private venvs at ref and at merge_sha, blobless clones
  under a run-owned temp dir (not committed).
