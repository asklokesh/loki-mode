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
  hidden.run (no -k): `24 failed in 0.59s`, rc=1, all `ModuleNotFoundError`.
- GREEN verified: worktree at merge_sha, same overlay: `24 passed in 2.08s`, rc=0.
- Deletion mutant: at merge_sha, es_AR and es_MX providers replaced by an en_US
  subclass. `4 failed, 20 passed`, rc=1 (the word-membership checks). Reverted;
  GREEN re-confirmed (`24 passed`).
- D30 no-op baseline (run 2026-09-30 through run.sh): `STUB_MODE=noop
  LOKI_EVAL_CLAUDE_BIN=<abs path>/eval/loki10/fixtures/stub-arm.sh bash eval/loki10/run.sh
  --arm raw-claude --task pub-faker-2206` gave status=ok, hidden_pass=false,
  completed=false, exit_code=0, pr_opened=false.
- Verified on this host's Python 3.14; setup needs no special host state.
