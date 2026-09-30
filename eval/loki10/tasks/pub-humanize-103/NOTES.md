# pub-humanize-103 provenance (not given to arms)

- issue: python-humanize/humanize#103
- fix_pr: python-humanize/humanize#110 (https://github.com/python-humanize/humanize/pull/110)
- merge_sha: d7f5dc5d60a4eb8f43b1ff6ddb842030062e9910
- repo.ref (red) = merge^1: 19b43d3b8d80959d75097d8e145690be811465bd
- source files touched (medium: >=2): src/humanize/lists.py (new module,
  `natural_list()`), src/humanize/__init__.py (exports it); docs/mkdocs
  files excluded, not source
- hidden files (verbatim upstream at merge_sha): tests/test_lists.py (new file,
  wholly added by this PR; not present at repo.ref)
- hidden.run runs the whole file (no -k needed; every test in it is new and
  discriminating: `test_natural_list`, parametrized over 7 cases including a
  1-item list, a 2-item list, and mixed str/int items)
- setup needs `coverage` in addition to the template's usual `pytest freezegun`:
  this repo's pyproject.toml sets `filterwarnings = ["error", ...,
  "ignore:sys.monitoring isn't available...:coverage.exceptions.CoverageWarning"]`,
  and pytest's warning-filter loader fails at collection time
  (`PytestConfigWarning: Failed to import filter module 'coverage'`) if the
  `coverage` package isn't importable, at both repo.ref and merge_sha alike --
  an environment issue, not a task defect.
- RED verified: checked out repo.ref (no tests/test_lists.py there), placed the
  merge_sha's tests/test_lists.py, reinstalled (pip install -e .), ran
  hidden.run: `7 failed in 0.03s`, rc=1, all
  `AttributeError: module 'humanize' has no attribute 'natural_list'`.
- GREEN verified: removed the untracked test file, checked out merge_sha (own
  source + own test), reinstalled, ran hidden.run: `7 passed in 0.01s`, rc=0.
- Deletion mutant: at merge_sha, replaced natural_list's oxford-comma/"and"
  logic in src/humanize/lists.py with a bare
  `return ", ".join(str(item) for item in items)` (drops the "and" joiner and
  the 1-item/2-item special cases). Re-ran hidden.run: `5 failed, 2 passed in
  0.02s`, rc=1 (the single-item and empty-list cases still pass by accident,
  the multi-item "and"-joined cases fail). Mutant reverted
  (`git checkout -- src/humanize/lists.py`); GREEN re-confirmed (`7 passed in
  0.01s`, rc=0).
- D30 no-op baseline (run 2026-09-30 through run.sh): `STUB_MODE=noop LOKI_EVAL_CLAUDE_BIN=<abs path>/eval/loki10/fixtures/stub-arm.sh bash eval/loki10/run.sh --arm raw-claude --task pub-humanize-103` gave status=ok, hidden_pass=false, completed=false, exit_code=0, pr_opened=false. The stub path must be absolute: a relative path gives exit_code 127 (stub not found), which is not a valid baseline.
