# pub-faker-2206 provenance (not given to arms)

- issue: joke2k/faker#2206 (es_ES/es_AR/es_MX text() falls back to latin lorem)
- fix_pr: joke2k/faker#2211 (https://github.com/joke2k/faker/pull/2211)
- merge_sha: 6d11923b5a673b994230044d9bab9385b659b144
- repo.ref (red) = merge^1: 399672d438c63af370ff3b38756b63d9a466caf9
- source files touched (medium: >=2): faker/providers/lorem/es_ES/__init__.py,
  es_AR/__init__.py, es_MX/__init__.py (3 new files)
- hidden files: tests/providers/test_lorem.py, trimmed (see below)
- Trim: upstream's file imports the three new provider modules at module level
  (`from faker.providers.lorem.es_ES import ...`), a file-level collection error
  at ref that hides per-test signal. The hidden file keeps only the three new
  classes (TestEsEs, TestEsAr, TestEsMx) verbatim except: the imports are replaced
  by a lazy `_provider(locale)` helper (importlib), the per-class `word_list`
  attribute became a property, and `EsEsLoremProvider` became `_provider("es_ES")`.
  Everything else (upstream's unrelated reformatting of older tests, other
  locales' classes) is dropped. The tests' content and assertions are unchanged.
- RED verified: worktree at repo.ref, overlaid the trimmed file, `pip install -e .`,
  hidden.run (no -k): `25 failed`, rc=1 (incl. the author-added test), 24 of them `ModuleNotFoundError`.
- GREEN verified: worktree at merge_sha, same overlay: `25 passed`, rc=0.
- Deletion mutant: at merge_sha, es_AR and es_MX providers replaced by an en_US
  subclass. `4 failed, 21 passed` (re-run with the 25-test file), rc=1 (the word-membership checks). Reverted;
  GREEN re-confirmed (`24 passed`).
- D30 no-op baseline (run 2026-09-30 through run.sh): `STUB_MODE=noop
  LOKI_EVAL_CLAUDE_BIN=<abs path>/eval/loki10/fixtures/stub-arm.sh bash eval/loki10/run.sh
  --arm raw-claude --task pub-faker-2206` gave status=ok, hidden_pass=false,
  completed=false, exit_code=0, pr_opened=false.
- Verified on this host's Python 3.14; setup needs no special host state.

- S41-20 pre-check (2026-09-30), `git diff --stat 399672d438c6 6d11923b5a67` verbatim (source files are the .py files under src/ or the package dir; changelog, docs and tests are not counted):
     faker/providers/lorem/es_AR/__init__.py |    7 +
     faker/providers/lorem/es_ES/__init__.py | 1016 +++++++++++++++++++++++++++++++
     faker/providers/lorem/es_MX/__init__.py |    9 +
     tests/providers/test_lorem.py           |  240 +++++++-
     4 files changed, 1268 insertions(+), 4 deletions(-)
- Criterion 1 (D30): each source file restricted with `git apply --include=<file>` onto repo.ref plus the hidden files; no single file makes hidden.run pass. Wrong-fix probe (found a hole, fixed): es_ES aliased to the Latin `la` provider (es_AR/es_MX subclassing es_ES) passed all 24 upstream-derived tests because they only check words against the provider's own word_list, so a Latin-text fix graded as complete. Author-added test `test_spanish_word_lists_are_not_latin` (appended to the hidden file, NOT upstream; requires <5% overlap of each es_* word list with the Latin list; real lists overlap 3/999 words) now rejects it: `1 failed, 24 passed`. hidden.run still runs the whole file (no -k): RED at repo.ref `25 failed`, GREEN at merge_sha `25 passed` (RED.txt/GREEN.txt regenerated; earlier text in this file saying 24 is superseded). Per-file: each of the 3 files alone -> 16 failed + 8 passed/errors. Reproducer: `Faker('es_ES').text()` at repo.ref returns Latin ('Dolor unde corrupti maiores...').
- refdiff: eval/loki10/refdiff/pub-faker-2206.diff is the measure-size.py source-only filter of that diff; `python3 eval/loki10/measure-size.py` exits 0 and classifies the task medium.
- No-op baseline re-run 2026-09-30 after the hidden file changed (STUB_MODE=noop, absolute LOKI_EVAL_CLAUDE_BIN, run.sh --arm raw-claude --task pub-faker-2206): status=ok, hidden_pass=false, completed=false, exit_code=0, pr_opened=false.
