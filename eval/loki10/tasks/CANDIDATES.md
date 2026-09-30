# Medium-tier candidates (S41-20h mining pass)

S41-20i outcome: both shortlisted candidates below were built and then DROPPED by a reproduced one-file fix (see the "S41-20i verification" notes under each). No task directory was kept.

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
- S41-20i verification: DROPPED. Own `_xdg.py`-only change (upstream `_xdg.py` hunks, plus `XDGMixin.user_documents_dir` temporarily deleting a relative XDG_CONFIG_HOME from os.environ around `super().user_documents_dir`, unix.py left at ref): `pytest tests/test_api.py tests/test_macos.py tests/test_unix.py -q -p no:cacheprovider` rc=0, 809 passed. The unix.py-dependent test does not require unix.py. Issue #539 states the general rule in its first sentence, so no trim would help.
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
- S41-20i verification: DROPPED. Reproduced RED rc=1 (6 failed, 86 passed). Own `sansio/app.py`-only fix (`if callable(name): self.add_template_X(name); return name` in template_filter/test/global): 3 failed (all test_blueprints.py), 89 passed. Own `sansio/app.py`-only cross-file hack (a module-level `_patch_blueprint()` wrapping Blueprint.app_template_filter/test/global so a callable first argument calls add_app_template_X): rc=0, 92 passed. Blueprint decorators do not route through app.py at call time (they only do so at registration via record_once), so the hack is the only one-file route, but the tests cannot reject it, and issue #5729 names only app.template_filter, so the Blueprint and template_test/global assertions are unstated behavior. Trimming to the stated behavior makes it a one-file task.
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

## S41-20j screening (2026-09-30): 0 kept, 6 dropped

Method: `gh pr list --state merged --limit 300 --json files,closingIssuesReferences` over pyflakes, pycodestyle, parso, jedi, sortedcontainers, boltons, tomli, itsdangerous, jinja, attrs, astroid, pygments, pluggy, cattrs, markdown, charset_normalizer, idna, wtforms, loguru, mkdocs; filter: closes an issue, 2-4 non-test .py files, at least 2 test .py files. docutils/pycodestyle/parso/sortedcontainers/itsdangerous produced no hit. Two candidates were cloned and run; the rest were rejected from the diff.

- astroid#3192 (merge 8666418153de; PR is a 3-commit rebase merge, so merge^ is NOT the base; real base a68e42c5): three unrelated crash fixes (issues #3189, #3190, #3191) in brain_namedtuple_enum.py and helpers.py. RED at a68e42c5 with upstream tests tests/brain/test_brain.py tests/brain/test_enum.py tests/test_helpers.py: 5 failed (one, test_typed_dict_required_and_optional_keys, fails at merge too under py3.12, env). GREEN at merge: 203 passed, 1 env failure. Own brain_namedtuple_enum.py-only fix with an import-time wrapper around helpers.has_known_bases: 203 passed, 1 env failure (same as GREEN), i.e. the contrived route passes. More important, test_is_subtype_supertype_function_metaclass asserts `_NonDeducibleTypeHierarchy` from `helpers.is_subtype`, and test_namedtuple_class_form_assignment_targets asserts unpacked names become attributes; none of that is stated by the issues ("No crash"), so the tests over-specify and an authored closing test cannot fix that. DROPPED.
- mkdocs#3022 -> issue #3015 (merge 32359f3e93f5, ref 1fa2af79..., py3.10 venv needed, distutils): RED 5 failed, GREEN 82 OK. Upstream files.py only: 2 failed (Page.url / is_homepage need the pages.py half); upstream pages.py only: 5 failed. Only a contrived route (File.url as a str subclass equal to both '.' and './', or import-time patch of Page.url from files.py) passes. But file_tests also assert `File.url == './'`, which the issue (missing trailing slash in a link) does not state: a fix that leaves url '.' and adds the slash in url_relative_to is valid and fails. DROPPED (over-specified test, not closable by an issue-stated authored test).
- Not run, rejected from the diff: pyflakes#684 (removal of `# type:` comment handling, not a bug fix), pygments#3078 (tests assert a new `html_escape` helper in util.py that the issue never names), idna#145 (three codec issues; the core.py hunk only widens bytes-like input, codec.py can convert in place), cattrs#617 (asserts an exact new error message; v.py hunk only deletes a branch), loguru#834 (_logger.py hunk is docstring only), jinja#1383 (feature, is filter/is test with decorators, 4 files of unrelated docs and compiler changes), wtforms#721 (utils.py is a signature-change helper for datetime.py), astroid#3302 (two parallel except clauses for f-string and str.format; only route to cover both from one file is an import-time patch and no issue-stated test can close it), boltons#440 (performance), boltons#425 (multi-issue grab bag), tomli#163 (src-layout move), jedi 1511/1956/2003/2097 (completion-data or version-support PRs), pluggy (API redesigns), attrs#1065/#1267/#1328/#1329 (already judged), wtforms large PRs (feature work).
- Lesson: check `gh pr view --json commits` first; a rebase-merged multi-commit PR has a merge^ that already contains earlier commits (astroid#3192).

## S41-20k screening (2026-09-30): 1 kept, 4 dropped

Method: `gh pr list --state merged --limit 400 --json number,title,files,closingIssuesReferences` over starlette, h11, wsproto, h2, hpack, python-multipart, anyio, typer, click-repl, httpcore, marshmallow_dataclass, pydantic-settings, cachecontrol, requests-toolbelt, pyyaml, python-dotenv; filter: closes an issue, 2-4 non-test .py files, test .py changed. Strategy: layered libraries where an issue crosses a public boundary between two modules with their own direct tests. Checked `gh pr view --json commits`: dotenv#680 is a one-commit squash; the anyio PRs are squash merges (the merge commit has one parent).

### Kept
- python-dotenv#661 -> PR #680 (merge f7b18d9c72d1, ref 751f8c148222): set_key (main.py serializer) plus single and double quoted value regexes (parser.py). Hidden file is upstream tests/test_main.py whole. RED rc=1 (5 failed, 123 passed), GREEN rc=0 (128 passed). main.py-only (upstream or own): 2 failed, rc=1 (trailing-backslash round trips); parser.py-only: 6 failed, rc=1. Built as pub-dotenv-661.

### Dropped
- anyio#1132 -> PR #1133 (merge 01b8d02381ba, ref b97910871571): both backends' wrap_listener_socket need the upstream change, RED rc=1 (8 failed in TestUNIXListener), upstream asyncio-only half leaves 2 trio failures. But an own abc/_sockets.py-only fix (`if sock.family == socket.AF_UNIX: return get_async_backend().create_unix_listener(sock)` in SocketListener.from_socket) gives 36 passed, 36 skipped, rc=0. Natural one-file fix.
- anyio#798 -> PR #799: tests assert the new message "Attempted to acquire an already held Lock"; the issue states only that a RuntimeError is expected (the old message was "attempt to re-acquire an already held Lock"). Over-specified; not run.
- anyio#1109 -> PR #1110 (20 commits, squash): asserts "TaskGroup cannot be entered more than once"; the issue asks only for a different exception than AttributeError. Not run.
- starlette#3357 -> PR #3471 (merge 6ad24bb7809c): the issue covers only TrustedHostMiddleware with `[::1]`; tests also pin TestClient IPv6 base_url headers (testclient.py) and about 15 malformed-host 400 cases. A trustedhost.py-only fix passes the issue-stated behavior. Not run.
- Not run, rejected from the diff: starlette#2812 (one middleware entry), h11#122/#115/#104 (readers/receivebuffer internals, one public entry), pydantic-settings#917 (independent one-line encoding change per source, unverified), click-repl#132 (click version dependent), marshmallow_dataclass PRs (feature additions threading setup.py).

### Lessons
- Backend-pair fixes (asyncio/trio) look like two required files, but check for a shared caller in abc/ or _core/ that can dispatch; here one existed.
- Serializer plus parser round trips (python-dotenv) are a good shape: exact-output rows pin the writer, trailing-delimiter round trips pin the reader.

## S41-20l screening (2026-09-30): 0 kept, layered-library pass 2

Method: same `gh pr list` dump as S41-20k, now over marshmallow, tomlkit, iniconfig, python-json-logger, email-validator, python-dateutil (new) plus the already dumped pyyaml, python-multipart, wsproto, h2, hpack, cachecontrol, requests-toolbelt; filter run twice (closes an issue; and 2-4 source files with tests but no closing keyword, to catch "Fixes #N" in prose). ruamel.yaml is not on GitHub and was skipped.

- h2 PR #1314 (merge b08b9d7ceb2d, one commit): 0-byte DATA frame with a negative flow-control window. NEAR MISS, not built. It is a real two-file shape: connection.py send_data (size check plus assert) and stream.py send_data (assert) each block the test, so neither single-file fix passes by reasoning (connection-only hits the stream assert; stream-only hits the connection FlowControlError). But there is no linked issue (only a PR body quoting RFC 9113), and the test sets private state (`_get_stream_by_id`). Not run.
- h2 PR #1318 (issue #316 cited in prose): a connection.py-only inline check of ENABLE_PUSH in the received SETTINGS frame passes the only test (test_invalid_frame_sequences); settings.py is not directly tested. One-file route.
- h2 PR #1165: tests import the new private class SizeLimitDict. Not stated by the issue.
- marshmallow#2123/#2118 (absolute=False): tests name a new `absolute` parameter, the repr and a ValueError message; the issue only asks for relative-only URL validation. Over-specified.
- marshmallow PR #2792 (data_key in validator errors): behavior lives in schema.py only; decorators.py and types.py are typing.
- tomlkit#168/#165 (tomlkit.value rejects bool-like): every test enters through tomlkit.value, api.py-only fix likely; #155 one file (items.py); #234 and #379: container.py fix, items.py/__init__ half is a one-token change; #409 already dropped.
- dateutil#581/#259 (tzstr invalid strings): 9-commit PR, rewrites the whole _TzStrParser token bookkeeping in _parser.py; py3.12 baseline of the old suite unverified. Not run.
- iniconfig#70 (inline comments): adds IniConfig.parse(), a new API. python-json-logger#33/#52/#53: renames and import shims. wsproto, hpack, cachecontrol, requests-toolbelt, pyyaml: only feature PRs, typing or refactors in the 2-4 file range.
- Lesson: in these protocol libraries most bug fixes are one source file; the two-file fixes are refactors or new APIs whose tests name the new symbol.


## S41-20m screening (2026-09-30): application-scale Python tools, 0 kept, 1 built and dropped

Method: `gh pr list --state merged --limit 300 --json number,title,files,closingIssuesReferences` over httpie/cli, pipx, tox, cookiecutter, pre-commit, mkdocs, twine, coveragepy, black, isort, pylint; filter: closes an issue, 2-3 non-test .py files, test .py changed, at most 8 files. About 75 PRs passed the filter; about 10 were read in diff.

### Built and dropped
- tox#3127 -> PR #3736 (merge 69c0b42654cc, ref 3c734ce7; one commit). TOX_OVERRIDE `+=` with an alias key (passenv vs pass_env). Hidden test: tests/config/test_main.py (whole file). RED rc=1 (2 failed, 21 passed; py3.12 venv via uv, `pip install -e .` with SETUPTOOLS_SCM_PRETEND_VERSION plus pytest pytest-mock pytest-timeout devpi-process flaky time-machine re-assert psutil). Upstream splits the fix across config/loader/api.py (Loader.load all_keys) and config/of_type.py. A one-file change to of_type.py alone (merge alias overrides across self.keys per loader, and try keys present in a loader first) gives `pytest tests/config/test_main.py -q` rc=0, 23 passed. Natural enough (8 lines, public attributes only), so DROPPED.

### Dropped after reading the diff (not built)
- httpie#1163/#1133 (tests import the new names load_json_preserve_order_and_dupe_keys and JsonDictPreservingDuplicateKeys: over-specified). httpie#1094 (internal refactor of response.raw access, no user-visible bug). httpie#929 (27 commits, feature-sized).
- pipx#1937/#540 (issue is a Windows-only duplicate-app uninstall crash; the PR is a copy-mode/force rework, so hidden tests would pin behavior the issue never states). Most other pipx PRs are new commands or need network pip installs at test time.
- black#5129 (NO_COLOR: click `ctx.color = False` in __init__.py alone would likely strip ANSI everywhere; not run), black#5386 (Windows different-drive case, platform specific), black#5411 (stdout.buffer; one path).
- coveragepy#1849 (lcov rewrite plus a new config option lcov_line_checksums: feature).
- pylint#11476/#11217 (helper added to checkers/utils.py; the checker can inline the logic). tox#3724, #3799, #3787, #3759 (single config layer). pre-commit#2746 (deprecation feature). cookiecutter#1669 and extension PRs (features).
- Not examined further: mkdocs and twine yielded no new filter hits beyond mkdocs#3022 (already dropped); isort hits are on the prior drop list or single-module parse/output fixes.

### Lessons
- Application-scale PRs that pass the two-file filter are mostly features, internal refactors, or a single layer with a helper; command-layer plus core-layer bug fixes with both sides tested did not appear in the 300 most recent merged PRs of these repos.
- Alias/override fixes split across a loader and its caller (tox) can still be closed from the caller by reordering keys and merging shared state.
