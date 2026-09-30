# Medium-tier candidates (S41-20h mining pass)

Result: 2 shortlisted of 12 allowed (target was 8; the pass stopped at the time box). 4 candidates tried and rejected by a reproduced one-file fix. Nothing here is a task directory; no hidden/ files were built.

Method: PRs listed with `gh pr list --state merged --json files,closingIssuesReferences` over attrs, click, werkzeug (first 150 only), jinja, flask, itsdangerous, arrow, pendulum, isort, black, pyflakes, pycodestyle, packaging, platformdirs, tomli, tomlkit, boltons, astroid, jedi; filter: closes an issue, 2-4 non-test .py files, test .py files changed. Each tried candidate was cloned at merge^1 (blobless) into a run-owned temp dir, Python 3.12 venv via uv, upstream test files checked out from the merge sha. "Upstream half" below means checking out ONE of the two source files from the merge sha (a proxy for the best one-file fix); "own fix" means I wrote the change by hand.

## Shortlisted

### 1. platformdirs#539 -> PR #540 (relative XDG paths are ignored)
- Repo: platformdirs/platformdirs. Issue: #539. PR: #540.
- Merge sha: 555038573a2d3d6acdc7440a8eeaab33cb15acd8. Ref (merge^1): a209bf88a0c5937d784baa1cddd67f69f4b411d2.
- Behavior files: `src/platformdirs/_xdg.py` (XDGMixin, shared by Unix AND MacOS) and `src/platformdirs/unix.py` (`_get_user_dirs_folder` reads XDG_CONFIG_HOME raw).
- Upstream tests: `tests/test_api.py tests/test_macos.py tests/test_unix.py`.
- Command: `pytest tests/test_api.py tests/test_macos.py tests/test_unix.py -q -p no:cacheprovider` (needs pytest-mock and appdirs installed).
- RED at ref with upstream tests: rc=1, 73 failed, 736 passed.
- GREEN at merge: rc=0, 809 passed.
- One-file attempts:
  - Upstream `_xdg.py` only (unix.py left at ref): rc=1, 1 failed (`test_unix.py::test_user_dirs_ignores_relative_xdg_config_home`, which drives `Unix().user_documents_dir` through unix.py's user-dirs.dirs lookup), 808 passed.
  - Upstream `unix.py` only: rc=2, collection ImportError (`_xdg_dir` missing). Not a fair fix, so also tried:
  - Own `unix.py` only: made `_get_user_dirs_folder` ignore a relative XDG_CONFIG_HOME inline with `os.path.isabs`. rc=1, 72 failed (all `test_macos.py` relative-XDG tests plus the `_xdg`-driven `test_unix.py` tests), 737 passed. MacOS inherits XDGMixin and never imports unix.py, so no unix.py-only fix can pass the macOS tests.
- Residual risk: a `_xdg.py`-only change could in theory reach the one unix.py test by temporarily rewriting `os.environ` around `super()`. That is a hack I did not try; a reviewer should be told the unix.py test is the single discriminator for file two.
- Issue text vs tests: partly. Issue #539 names only XDG_STATE_HOME and says relative values should fall back to the platform default. Tests also assert the same for every other XDG_*_HOME variable, XDG_RUNTIME_DIR, site dir lists (relative entries filtered), and the user-dirs.dirs lookup. The XDG spec link in the issue states the general rule, but the task prompt should say "all XDG base-dir variables".

### 2. flask#5729 -> PR #5736 (template_filter/test/global usable without parentheses)
- Repo: pallets/flask. Issue: #5729. PR: #5736.
- Merge sha: ed1c9e953e2d67c0994e32e6c8d878291e36d4f7. Ref (merge^1): 85c5d93cbd049c4bd0679c36fd1ddcae8c37b642.
- Behavior files: `src/flask/sansio/app.py` (App.template_filter/test/global) and `src/flask/sansio/blueprints.py` (Blueprint.template_filter/test/global, an independent decorator implementation).
- Upstream tests: `tests/test_templating.py` (calls app decorators) and `tests/test_blueprints.py` (calls blueprint decorators).
- Command: `pytest tests/test_blueprints.py tests/test_templating.py -q -p no:cacheprovider` with `pytest==8.3.5` (newer pytest removes `monkeypatch.notset` used by tests/conftest.py), asgiref, python-dotenv.
- RED at ref: rc=1, 6 failed, 86 passed.
- GREEN at merge: rc=0, 92 passed.
- One-file attempts:
  - Upstream `sansio/app.py` only: rc=1, 3 failed (all in `test_blueprints.py`), 89 passed.
  - Upstream `sansio/blueprints.py` only: rc=1, 3 failed (all in `test_templating.py`), 89 passed.
  - Own one-file fix: not separately written; the two decorators share no code, so each file's fix is exactly its half above. A cross-file hack (app.py patching Blueprint at import) is the only route and was not attempted.
- Caveat: the shape is two parallel implementations rather than a signature change plus caller. It survives the one-file test because each test module calls its own class directly, but a reviewer may judge it as "same change twice".
- Issue text vs tests: issue #5729 shows only `@app.template_filter` without parens. Tests also assert the same for template_test and template_global and for the Blueprint variants. The prompt must say "template_filter, template_test and template_global, on Flask and on Blueprint".

## Rejected (tried, one-file fix reproduced)

- click#2836 -> PR #3328 (merge 76552ff1e8c85837f911fc34037e702ae4327eda, ref 8c95c73bd5ef89eac638f85f1904a104ba4b1a32; core.py + termui.py): RED rc=1 (8 failed), GREEN rc=0 (744 passed). Own core.py-only fix (Option.prompt_for_value appends ` [(custom)]` to the prompt text itself and forces show_default=False for str values) gives rc=0, 744 passed. All tests go through `click.option`, none call `termui.prompt` directly.
- flask#5625 -> PR #5626 (merge 6f2014d353d514e404c1f40e8f0a24e2bf62b941; app.py + wrappers.py): RED rc=1 (1 failed), GREEN rc=0 (128 passed). app.py only adds two config defaults; wrappers.py alone with `config.get("MAX_FORM_MEMORY_SIZE", 500_000)` passes because the test sets config keys itself. Not run, reasoned from the test body (test_limit_config writes the keys it reads); the upstream wrappers half alone fails only on a KeyError for the missing default.
- werkzeug#3289 -> PR #3292 (merge cdc9e2d2fff5f576580d7c73ad5280778ec5d55b, ref 6048fa48753c7b61e35cc34537667809dee8fa35; datastructures/etag.py + sansio/http.py): RED rc=1 (17 failed), GREEN rc=0 (314 passed). Upstream etag.py alone fails only because `contains` now warns and sansio/http.py still calls it; removing that one `warnings.warn` from etag.py leaves rc=0, 314 passed (no test asserts the deprecation). Deprecation PRs are a bad shape.
- platformdirs#558 -> PR #561 (merge ae8dea72da9e996256a9b415d1d2732e56b6ad9b, ref 9ce60680d1fec795a02b1bff5afff1c1f203c10a; _xdg.py + api.py + unix.py): RED rc=1 (13 failed), GREEN rc=0 (775 passed). Own unix.py-only fix (override `_user_media_dir` and `_xdg_media_dir` in class Unix, tolerate FileExistsError for dangling symlinks) gives rc=0, 775 passed.
- tomlkit#408 -> PR #409 (items.py + parser.py): not evaluated; tests/test_items.py fails collection at ref and merge without the toml-test git submodule (FileNotFoundError), so it needs a fixture decision first.

## Rejected without running (reason from the PR listing or diff)

- werkzeug#3301 -> #3306 (FileWrapper) and werkzeug#3275 -> #3276 (environ properties): deprecation PRs, same failing shape as #3292.
- click#3645 (merge of stable), click#3228 (NoSuchCommand, new feature with large API), click#3030 (multi-issue default-handling rewrite), click#2873 (release merge): too broad or not one behavior.
- arrow#813 (normalize_spaces flag threads a parameter factory -> parser): known failing shape (threads a parameter).
- platformdirs#426 (use_site_for_root): new parameter threading.
- packaging#1351 and #1150: packaging#577 is on the dropped list; #1150 adds an option argument.
- black 5425, 5297, 5237, 5170, 5095, 4811, 4720: tests are data-file cases routed through one entry point, so a linegen.py-only fix is likely; not tried.
- attrs#886, #815, #950 (old, `_make.py` dominant), attrs#1328 (Converter API, dropped as #1327), attrs#1329 (3.14 compat).
- isort#2576 (same literal.py/core.py pair as already-used #2646), itsdangerous#151 (old tz rewrite), jedi and astroid PRs (astroid#3192/#3302 and pyflakes#684/#668 are plausible leads but were not run for lack of time; a next pass should try astroid#3192 and pyflakes#684 first).
- jinja#1233, jinja#1960: compiler-heavy or async/trio environment dependent.

## Notes for the next pass
- Every rejected pass came from a test suite that enters through one public API (click.option, Flask app, Unix class). Prefer PRs whose two test modules each call a different class or function (as platformdirs MacOS vs Unix does).
- Check that an exported helper is not the only thing file two adds (platformdirs#561 and flask#5626 both failed this).
- Deprecation PRs reject: the old-API caller only needs its warning silenced.
