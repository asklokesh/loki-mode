# pub-isort-2646 provenance (not given to arms)

- issue: PyCQA/isort#2646
- fix_pr: PyCQA/isort#2647 (https://github.com/PyCQA/isort/pull/2647)
- merge_sha: 2934927a192037417b378c2179c272751fcf3f4a
- repo.ref (red) = merge^1: 03f1ce055c4f4c76fc77244d25136e6a02a08310
- source files touched (medium: >=2): isort/core.py, isort/literal.py
- `git diff --stat ref merge`: isort/core.py (+1 -1), isort/literal.py (+11 -3), tests/unit/test_isort.py (+26), tests/unit/test_literal.py (+25); the two test files are the hidden files
- hidden files (verbatim upstream at merge_sha): tests/unit/test_isort.py, tests/unit/test_literal.py
- prompt: the issue text with the pointer to the internal source line dropped and the "Notes" / AI-assisted footer removed.
- hidden.run deselects test_settings_path_skip_issue_909 and test_skip_paths_issue_938: both fail with FileNotFoundError at ref and at merge on this host (environmental, unrelated to the fix). Nothing else is narrowed, so the whole rest of both files runs: RED at ref = 7 failed, 261 passed, 1 skipped, 2 deselected (rc=1); GREEN at merge = 268 passed, 1 skipped, 2 deselected (rc=0).
- issue reproducer at ref: `isort.code('__all__ = ["b", "a"]  # noqa: F401\n\nx = 1\n', sort_reexports=True)` drops the comment; the `= ` in a comment raises ValueError. Fails at ref.
- (a) single-file check: core.py only = 7 failed (comment still dropped, rc=1); literal.py only = 1 failed (`=` in a comment still raises through the `__all__` path in core.py, rc=1). Neither alone passes.
- (c) plausible wrong fix rejected: fixing only literal.py (the comment preservation, where the symptom shows) leaves the core.py `split("=")` and test_reexport_keeps_trailing_comment_with_equals stays red.
- (e) deletion mutant at merge (drop the trailing-text preservation line in literal.py): 17 failed, rc=1. No-op baseline through run.sh (STUB_MODE=noop, absolute LOKI_EVAL_CLAUDE_BIN): status=ok, completed=False.
- Hidden tests call isort.code and isort.literal.assignment, both public API.
- Verified on Python 3.14.6.
