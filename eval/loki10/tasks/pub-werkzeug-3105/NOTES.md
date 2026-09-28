# pub-werkzeug-3105 provenance (not given to arms)

- issue: pallets/werkzeug#3105
- fix_pr: pallets/werkzeug#3109 (https://github.com/pallets/werkzeug/pull/3109)
- merge_sha: 620ae56fd8876a9c52f0d84560dbf0495fd441d4
- repo.ref (red) = merge^1: bf7529e62685e0b87350481703ddae5b6351072d
- source files touched (medium: >=2): src/werkzeug/routing/exceptions.py,
  src/werkzeug/routing/matcher.py, src/werkzeug/routing/rules.py
  (docs/routing.rst also touched, not a source file)
- hidden files: tests/test_routing.py -- EDITED UPSTREAM TEST, same
  emoji-trim reason as pub-werkzeug-3121 (real upstream test_routing.py has
  unrelated U+1F40D/U+2603 test data that trips the emoji gate). Trimmed to
  the PR's changed/new tests: test_no_duplicates (existing test, extended
  with two same-path different-method rules), test_duplicate_method_overlap,
  test_no_duplicate_head_options, test_duplicate_options_exact (all three
  new). Copied verbatim from the upstream file at merge_sha; imports reduced
  to pytest, werkzeug.routing as r, werkzeug.routing.exceptions.DuplicateRuleError.
- hand-screened at ref: of the 4 tests, only test_no_duplicates and
  test_no_duplicate_head_options fail at ref (both raise DuplicateRuleError
  when they should not, because at ref the duplicate-rule check does not
  consider HTTP methods at all); the other two (test_duplicate_method_overlap,
  test_duplicate_options_exact) already pass at ref by accident (two rules
  sharing the same path with fully disjoint or fully overlapping single
  methods already collide under the old check), so they do not discriminate
  RED from GREEN on their own. r2 fix (2026-09-28): hidden.run was
  previously narrowed with -k to just the two discriminating tests; that
  narrowing was reverted because a deletion mutant at merge_sha (replacing
  `raise DuplicateRuleError(existing, rule)` with `pass` in
  src/werkzeug/routing/matcher.py) made the narrowed run exit 0 (the -k
  filter deselected the two tests that would have caught the deletion).
  hidden.run now runs the whole file with no -k; full-file RED at ref is
  "2 failed, 2 passed" (the same two tests above still fail; the other two
  still pass by the accident described above), full-file GREEN at merge_sha
  is "4 passed", and the same deletion mutant at merge_sha now fails
  (2 failed, 2 passed) instead of exiting 0.
- RED failure mode: werkzeug.routing.exceptions.DuplicateRuleError raised
  where the test expects no exception (real assertion-shaped failure, not a
  collection error). The captured RED.txt error message contains a
  right-arrow character (U+2192, from werkzeug's own DuplicateRuleError repr,
  not from our test data); confirmed outside the emoji gate's ranges
  ([\x{1F300}-\x{1FAFF}\x{2600}-\x{27BF}]) and left as-is (unedited raw pytest
  output).
- setup installs ephemeral-port-reserve in addition to pytest, same reason
  as pub-werkzeug-3121 (tests/conftest.py imports it unconditionally).
- public API only: werkzeug.routing.Map/Rule. No private symbols.
- issue body confirmed pure ASCII.
- RED/GREEN both re-verified through the exact hidden.run command above (not
  hand-simulated), private venvs at ref and at merge_sha, under /tmp/wz
  (scratch clone, not committed).
- deletion mutant (r2, at merge_sha): `raise DuplicateRuleError(existing,
  rule)` in src/werkzeug/routing/matcher.py replaced with `pass`. With the
  no-`-k` hidden.run (all 4 tests) this now fails (2 failed, 2 passed) --
  mutant caught. Under the old, now-reverted `-k "test_no_duplicates or
  test_no_duplicate_head_options"` narrowing the same mutant exited 0 (the
  reviewer's reproduced blocking finding); dropping -k is the fix. Reverted
  after the check; GREEN re-confirmed (4 passed).
