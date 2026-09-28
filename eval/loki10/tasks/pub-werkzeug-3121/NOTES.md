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
  werkzeug.routing as r, werkzeug.exceptions.NotFound) reduced to only what
  that function needs. No assertion, input, or expected value inside the
  test was changed. This is the same "trim to exercised tests" pattern
  already used by pub-humanize-174 (NOTES.md there), and follows the
  INDEX.md D30 rework note identifying this exact candidate group as
  revivable this way.
- r2 fix (2026-09-28): the "byte-for-byte" claim above did not hold as
  first committed -- the trimmed body was missing the upstream function's
  last two lines (`assert adapter.match("/no/merging")[0] == "no_merging"`
  and `pytest.raises(NotFound, lambda: adapter.match("/no//merging"))`, the
  merge_slashes=False regression guards) and the `NotFound` import they
  need. Restored both lines and the import verbatim from upstream at
  merge_sha; an AST source-segment diff of the committed function against
  `git show c328342ef9f7a6476b9e41565ad0a70ff10cfde6:tests/test_routing.py`
  now reports no difference.
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
- deletion mutant (r2, at merge_sha): both `re.sub("/{2,}", ...)` call sites
  (matcher.py, rules.py) gated behind `if False and ...` so merge-slashes is
  a no-op -- hidden.run still fails (1 failed), mutant caught. Reverted
  after the check; GREEN re-confirmed (1 passed).
