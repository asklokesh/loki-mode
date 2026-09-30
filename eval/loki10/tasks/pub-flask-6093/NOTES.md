# pub-flask-6093 provenance (not given to arms)

- issue: pallets/flask#6093
- fix_pr: pallets/flask#6096 (https://github.com/pallets/flask/pull/6096)
- merge_sha: 05e9c6bd630ecf4ec0ec884b1fc7901663737bc7
- repo.ref (red) = merge^1: 514fc6b3e8402e4c646d5284e97a4f0ab50a7c4b
- files touched (git diff --stat 514fc6b3 05e9c6bd): 4, of which 2 source
  (src/flask/app.py, src/flask/testing.py) and 2 tests. CHANGES.rst is not
  touched. Source-only diff committed as eval/loki10/refdiff/pub-flask-6093.diff.
- hidden files (verbatim upstream at merge_sha): tests/test_testing.py,
  tests/test_basic.py. Both taken whole (not trimmed): scanned for the
  local-ci.sh emoji gate ([\x{1F300}-\x{1FAFF}\x{2600}-\x{27BF}]) and for
  U+2013/U+2014, 0 hits in either file.
- issue author supplied the exact reproduction for both new/changed tests
  (test_session_transaction_ipv6, and one new parametrize row added to
  test_run_from_config); the fix PR's test diff matches the issue verbatim.
- hidden.run is narrowed with -k "session_transaction or test_run_from_config":
  "session_transaction" also selects the existing test_session_transactions,
  which a plausible wrong fix (`.rpartition(":")` plus `.strip("[]")` in both
  app.py and testing.py) breaks (KeyError: 'foo'), so that fix is rejected.
  test_run_from_config is the existing parametrized test whose new row
  discriminates (run whole, per the D30 policy).
- RED at ref (514fc6b3, hidden files copied in from merge_sha, exact
  hidden.run command): 2 failed, 11 passed, 146 deselected, rc=1.
  - tests/test_testing.py::test_session_transaction_ipv6 -- AssertionError
    (session cookie host truncated at its first colon by
    `ctx.request.host.partition(":")[0]`).
  - tests/test_basic.py::test_run_from_config[None-None-[::1]:8080-::1-8080]
    -- ValueError: invalid literal for int() with base 10: ':1]:8080' (same
    root cause in Flask.run via `server_name.partition(":")`).
- GREEN at merge_sha (05e9c6bd, exact hidden.run command): 13 passed,
  146 deselected, rc=0.
- wrong-fix check (ref, rpartition + strip("[]") in app.py and testing.py):
  1 failed (test_session_transactions, KeyError: 'foo'), 12 passed.
- deletion mutant (earlier run, -k with the narrower filter): reverting the
  source-only diff at merge_sha made both target tests fail again.
- public API only: Flask.run(), Flask.test_client().session_transaction().
  No private symbols.
- RED/GREEN both re-verified through the exact hidden.run command above (not
  hand-simulated), private venvs at ref and at merge_sha, blobless clones
  under a run-owned temp dir (not committed).
