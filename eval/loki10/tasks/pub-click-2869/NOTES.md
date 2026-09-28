# pub-click-2869 provenance (not given to arms)

- issue: pallets/click#2869
- fix_pr: pallets/click#3781 (https://github.com/pallets/click/pull/3781)
- merge_sha: e1fd5946ab26aaf372009eaff1acf947140b40fb
- repo.ref (red) = merge^1: 2103e157683c5e4cadc8ee1838df526a54bde9a4
- source files touched (medium: >=2): src/click/_termui_impl.py, src/click/termui.py
- hidden files (verbatim upstream at merge_sha): tests/test_termui.py
- hidden.run is narrowed to "test_edit_pathlib and single": the PR's other new
  parametrization, test_edit_pathlib[iterable], already passes at ref (a list
  containing one PosixPath happens to work with subprocess.Popen's argv even
  before the fix), so it does not discriminate red from green; [single] does
  (TypeError: 'PosixPath' object is not iterable at ref, passes at fix).
- the PR also adds tests/typing/typing_edit.py, a pyright type-checker
  fixture pytest cannot collect as a test module; it is excluded from
  hidden.files and hidden.run (this is the candidate INDEX.md listed as
  revivable by filtering the probe to test_*.py).
- public API only: click.edit(filename=...). No private symbols.
- RED/GREEN both re-verified through the exact hidden.run command above
  (not hand-simulated), private venvs at ref and at merge_sha.
