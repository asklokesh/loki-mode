# pub-werkzeug-3271 provenance (not given to arms)

- issue: pallets/werkzeug#3271
- fix_pr: pallets/werkzeug#3273 (https://github.com/pallets/werkzeug/pull/3273)
- merge_sha: f97c305673ba121a1dae6764c37e8be48907a1d1
- repo.ref (red) = merge^1: a33190bffb7f6dd4c7084c08257b4542689b8c66
- source files touched (medium: >=2): src/werkzeug/sansio/request.py,
  src/werkzeug/user_agent.py (CHANGES.rst also touched, not a source file)
- hidden files: tests/test_wrappers.py -- EDITED UPSTREAM TEST. The real
  upstream tests/test_wrappers.py contains an unrelated test case with a
  literal snowman emoji (U+2603) in test data that trips
  scripts/local-ci.sh's emoji gate ([\x{1F300}-\x{1FAFF}\x{2600}-\x{27BF}]).
  As with pub-werkzeug-3121, the hidden file is trimmed to just the single
  discriminating test, test_user_agent, copied verbatim from the upstream
  file at merge_sha with imports reduced to what that function needs
  (pytest, werkzeug.wrappers). No assertion, input, or expected value was
  changed. Same "trim to exercised tests" pattern as pub-humanize-174 and
  pub-werkzeug-3121.
- what the fix changes (test diff): the PR makes Request.user_agent equality
  compare and str() the raw header directly (`request.user_agent ==
  user_agent`), and moves `.to_header()`, `.string`, and `.browser` behind
  `pytest.deprecated_call()` (DeprecationWarning). werkzeug's pyproject.toml
  sets `filterwarnings = ["error", ...]`, so an uncaught DeprecationWarning
  fails the test outright; at ref, `UserAgent` is not comparable to a plain
  string (`request.user_agent == user_agent` is False -- an AssertionError,
  not a collection error), which is what the test discriminates on.
- hidden.run is narrowed with -k "test_user_agent" (the only test in the
  trimmed file).
- setup installs ephemeral-port-reserve in addition to pytest, same reason
  as pub-werkzeug-3121 (tests/conftest.py imports it unconditionally).
- public API only: werkzeug Request.user_agent. No private symbols.
- issue body confirmed pure ASCII (contains a URL with %22 escapes, no
  literal non-ASCII characters).
- RED/GREEN both re-verified through the exact hidden.run command above (not
  hand-simulated), private venvs at ref and at merge_sha, under /tmp/wz
  (scratch clone, not committed).
