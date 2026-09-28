# pub-werkzeug-3121 provenance (not given to arms)

- issue: pallets/werkzeug#3121
- fix_pr: pallets/werkzeug#3136 (https://github.com/pallets/werkzeug/pull/3136)
- merge_sha: c328342ef9f7a6476b9e41565ad0a70ff10cfde6
- repo.ref (red) = merge^1: b913d68db5898c8f3def3c09a653aaf95abe38e5
- source files touched (medium: >=2): src/werkzeug/routing/matcher.py,
  src/werkzeug/routing/rules.py (CHANGES.rst also touched, not a source file)
- hidden files: tests/test_routing.py -- EDITED UPSTREAM TEST. The real
  upstream tests/test_routing.py is ~2900 lines and contains unrelated test
  cases with literal emoji test data (snake U+1F40D, snowman U+2603) that
  trip scripts/local-ci.sh's repo-wide emoji gate
  ([\x{1F300}-\x{1FAFF}\x{2600}-\x{27BF}]). Rather than escape those unrelated
  characters, the hidden file is trimmed to just the single discriminating
  test, test_merge_slashes_match, copied verbatim (byte-for-byte body) from
  the upstream file at merge_sha with its imports (pytest,
  werkzeug.routing as r) reduced to only what that function needs. No
  assertion, input, or expected value inside the test was changed. This is
  the same "trim to exercised tests" pattern already used by
  pub-humanize-174 (NOTES.md there), and follows the INDEX.md D30 rework note
  identifying this exact candidate group as revivable this way.
- the added assertion in the fix PR (the only diff to this test function):
  `with pytest.raises(r.RequestRedirect): adapter.match("//yes///tail////")`
  -- 3+ leading/repeated slashes were not being merged into one at ref
  because Rule.compile's merge-slash regex used a non-greedy `{2,}?`
  quantifier instead of greedy `{2,}`, so `match()` returned 404 NotFound
  instead of redirecting.
- hidden.run is narrowed with -k "test_merge_slashes_match" (the only test
  in the trimmed file).
- setup installs ephemeral-port-reserve in addition to pytest: werkzeug's
  tests/conftest.py imports it unconditionally at collection time even
  though this specific test does not use it (confirmed: pytest fails at
  conftest import, not at the test, without it).
- public API only: werkzeug.routing.Map/Rule/MapAdapter.match(). No private
  symbols.
- RED/GREEN both re-verified through the exact hidden.run command above (not
  hand-simulated), private venvs at ref and at merge_sha, python3.14 /
  werkzeug repo checkouts under /tmp/wz (scratch clone, not committed).
