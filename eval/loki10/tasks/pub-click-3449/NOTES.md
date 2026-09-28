# pub-click-3449 provenance (not given to arms)

- issue: pallets/click#3449
- fix_pr: pallets/click#3533 (https://github.com/pallets/click/pull/3533)
- merge_sha: 4df304c658666f34a5ca4335ab0da15832f02f9e
- repo.ref (red) = merge^1: cd9bdd96a9dcc8e4ecabd45b5c244dbc70034484
- source files touched (medium: >=2): src/click/_termui_impl.py,
  src/click/utils.py (CHANGES.rst also touched, not a source file)
- hidden file (verbatim upstream at merge_sha, taken whole, not trimmed):
  tests/test_termui.py. Scanned for the local-ci.sh emoji gate
  ([\x{1F300}-\x{1FAFF}\x{2600}-\x{27BF}]) and for U+2013/U+2014, 0 hits.
- regression: click 8.4.0 (pallets/click#3482, "echo_via_pager flushes after
  each write") started closing a *borrowed* stdout/pager stream via
  garbage collection of an internal TextIOWrapper, breaking
  CliRunner.invoke() whenever echo_via_pager runs with no external pager.
  The fix replaces the ad hoc `_SkipClose` wrapper with a `KeepOpenFile`
  wrapper and explicitly `detach()`s the binary buffer in `get_pager_file`'s
  `finally` block instead of letting GC close it.
- hidden.run is narrowed with -k
  "test_get_pager_file_missing_pager_keeps_borrowed_stream_open or
  test_echo_via_pager_tty_pager_missing": the two new test functions the fix
  PR added to tests/test_termui.py. The second is the issue's own
  reproducer (`echo_via_pager` + `CliRunner.invoke`, asserting no exception
  and the expected echoed output); the first is a lower-level regression
  test for the same GC-closes-borrowed-stream bug via `click.get_pager_file`
  directly, added by the same PR to cover the tty pipe/tempfile pager
  fallback paths the issue's traceback does not itself exercise (both
  fallbacks share the same `_nullpager`/`KeepOpenFile` code path the issue's
  bug lives in).
- RED at ref (cd9bdd96, hidden file copied in from merge_sha, exact
  hidden.run command): 2 failed, 238 deselected, rc=1. Both fail with
  `ValueError: I/O operation on closed file.` inside `sys.stdout.flush()`
  in src/click/testing.py's CliRunner.invoke -- the exact error and
  traceback line the issue reports.
- GREEN at merge_sha (4df304c6, exact hidden.run command): 2 passed,
  238 deselected, rc=0.
- deletion mutant (merge_sha, `git apply -R` of the source-only diff
  between ref and merge_sha restricted to src/click/_termui_impl.py and
  src/click/utils.py, hidden test file left at its merge_sha content): both
  selected tests fail again identically to RED (2 failed, 238 deselected,
  rc=1, same ValueError). Mutant reverted (`git apply` the same diff
  forward); GREEN re-confirmed (2 passed, 238 deselected, rc=0);
  `git status --porcelain` empty after.
- public API only: click.echo_via_pager(), click.get_pager_file(),
  click.testing.CliRunner.invoke(). The two new tests monkeypatch click's
  own internal helpers (`_default_text_stdout`, `isatty`, `os.environ`) to
  force the no-pager/tty branch deterministically -- this is test-harness
  setup, not an assertion on a private symbol; every assertion in both
  tests checks public behavior (stream state, echoed output, no exception).
- RED/GREEN both re-verified through the exact hidden.run command above (not
  hand-simulated), private venvs at ref and at merge_sha, blobless clones
  under a run-owned temp dir (not committed).
