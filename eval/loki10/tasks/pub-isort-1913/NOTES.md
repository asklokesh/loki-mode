# pub-isort-1913 provenance (not given to arms)

- issue: PyCQA/isort#1913
- fix_pr: PyCQA/isort#2488 (https://github.com/PyCQA/isort/pull/2488)
- merge_sha: 59472c994c35dd6743c2261c895152f95f774ba7
- repo.ref (red) = merge^1: 23f100de865ac08ca1bd64ccc81f816aa0b21ba6
- source files touched (medium: >=2): isort/comments.py, isort/output.py, isort/parse.py
- `git diff --stat ref merge`: isort/comments.py (+9 -3), isort/output.py (+16 -14), isort/parse.py (+4 -4), tests/unit/test_ticketed_features.py (+19); the test file is the hidden file
- hidden files (verbatim upstream at merge_sha): tests/unit/test_ticketed_features.py
- hidden.run deselects test_isort_supports_shared_profiles_issue_970 and test_sort_configurable_sort_issue_1732: both fail at ref and at merge on this host (plugin / environment dependent, unrelated to the fix). Everything else in the file runs: RED at ref = 1 failed, 26 passed, 2 deselected (rc=1); GREEN at merge = 27 passed, 2 deselected (rc=0).
- issue reproducer at ref: `isort.code("import a  #\n")` returns `import a\n` (the bare comment is stripped). Fails at ref.
- (a) single-file check: comments.py only = 1 failed, output.py only = 1 failed, parse.py only = 21 failed (a regression: an empty-string comment is now treated as present on every import); none passes alone (rc=1 each).
- (c) plausible wrong fix rejected: the upstream test covers both the straight (`import a  #`) and the from-import (`from foo import bar  #`) paths plus idempotence, so a fix that only handles straight imports, or only the parse layer, stays red (partial fixes above).
- (e) deletion mutant at merge (parse.py `comment is not None` reverted to truthiness): 1 failed, rc=1. No-op baseline through run.sh (STUB_MODE=noop, absolute LOKI_EVAL_CLAUDE_BIN): status=ok, completed=False.
- Verified on Python 3.14.6.
