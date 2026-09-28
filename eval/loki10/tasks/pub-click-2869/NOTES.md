# pub-click-2869 provenance (not given to arms)

- issue: pallets/click#2869
- fix_pr: pallets/click#3781 (https://github.com/pallets/click/pull/3781)
- merge_sha: e1fd5946ab26aaf372009eaff1acf947140b40fb
- repo.ref (red) = merge^1: 2103e157683c5e4cadc8ee1838df526a54bde9a4
- source files touched (medium: >=2): src/click/_termui_impl.py, src/click/termui.py
- hidden files (verbatim upstream at merge_sha): tests/test_termui.py
- hidden.run was narrowed to "test_edit_pathlib and single": the PR's other new
  parametrization, test_edit_pathlib[iterable], already passes at ref (a list
  containing one PosixPath happens to work with subprocess.Popen's argv even
  before the fix), so it does not discriminate red from green; [single] does
  (TypeError: 'PosixPath' object is not iterable at ref, passes at fix).
- EV-11a fix (2026-09-28, review docs/dev, e19-rejects.json key "EV-11"): the
  "and single" narrowing let a deletion mutant grade completed. Mutating
  `if isinstance(filename, (str, os.PathLike)):` in src/click/termui.py to
  `if True:` (dropping the type check that wraps a single path into a
  1-tuple) still passed the narrowed run, because [single] never exercises
  the iterable branch that the mutant breaks. Widened hidden.run to
  `-k "test_edit_pathlib"` (both parametrizations; deselects 280, same as
  before). Re-verified by hand: RED at ref (2103e157) = 1 failed
  ([single]), 1 passed ([iterable]), 280 deselected, rc=1. GREEN at
  merge_sha (e1fd5946) = 2 passed, 280 deselected, rc=0. The same mutant
  applied at merge_sha now fails: [iterable] raises TypeError passing a
  list into subprocess.Popen's PathLike/str dispatch, rc=1; mutant reverted
  after (`git checkout -- src/click/termui.py`, `git diff --stat` empty).
- the PR also adds tests/typing/typing_edit.py, a pyright type-checker
  fixture pytest cannot collect as a test module; it is excluded from
  hidden.files and hidden.run (this is the candidate INDEX.md listed as
  revivable by filtering the probe to test_*.py).
- public API only: click.edit(filename=...). No private symbols.
- RED/GREEN both re-verified through the exact hidden.run command above
  (not hand-simulated), private venvs at ref and at merge_sha.
