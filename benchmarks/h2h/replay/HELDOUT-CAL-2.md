# Held-out calibration set 2 (hc2), 2026-11-20

The 8 replay tasks without a prefix in this directory are a tuning set: the BUILD-REQUIRES verifier fix
(loki-ts/src/util/python.ts pyprojectDeclaresDeps) was found on them. The 8 `hc2-` tasks are the held-out
scoring set for the verifier's labels. They were chosen by the rule below, written down before any pull
request of any candidate repository was read, and no task was swapped after a calibration label was seen.

## Pre-registered rule (written before any PR query)

Repositories. Small open-source libraries under MIT, BSD or Apache licenses (a NOASSERTION from the GitHub
API is settled by reading the LICENSE file), not already an upstream anywhere under benchmarks/h2h
(cachetools, boltons, more-itertools, parse, toolz, Masterminds/semver, sqlparse, expr-lang/expr, mistune,
click, tomlkit, sqlglot, toml-lang/toml-test), not a C2 repository (opencode, hermes-agent, playwright), and
cleared by the lead against the held-out corpora (this agent reads none of them). The candidate pool was
written from memory of small, actively used, pure Python or pure Go libraries; it is fixed here, in order,
with reserves, before any PR was looked at.

Python candidates, walked in this interleaved order (D: declares runtime dependencies, N: declares none):

1. facelessuser/wcmatch (D: bracex)
2. jd/tenacity (N)
3. sybrenstuvel/python-rsa (D: pyasn1)
4. python-humanize/humanize (N)
5. python-trio/outcome (D: attrs)
6. theskumar/python-dotenv (N)
7. executablebooks/markdown-it-py (D: mdurl)
8. tox-dev/platformdirs (N)
9. facelessuser/bracex (N)

Walk the list in order; a repository that yields a qualifying PR gives one task, until there are 5 Python
tasks with at least 2 of class D and at least 2 of class N (so neither class takes more than 3). The class
is read from the manifest at the task's parent_commit (a non-empty [project] dependencies list or a
setup.cfg/setup.py install_requires counts as D), not from this list; a repository whose manifest
contradicts its listed class is classed by the manifest.

Go candidates, in this order: BurntSushi/toml, spf13/pflag, google/uuid, dustin/go-humanize,
cespare/xxhash, google/go-cmp. The first 3 that yield a qualifying PR give one task each.

Environment conditions that come from "tests run with the repo's standard runner without network or
services" (this machine: system python3 3.14.6 with pytest 9.0.2, go 1.26.3 with GOTOOLCHAIN=local and
a fresh GOPATH per invocation, nothing may be installed): a Python repository's runtime dependencies and
test plugins must already import on the system python3; a Go module's go.mod at parent_commit may have no
require (any module fetch is network) and a go directive no higher than 1.26.3.

PR. In each repository, walk merged PRs newest first by mergedAt (gh pr list --state merged, read-only,
the most recent 100) and take the first that:

- fixes a bug: the PR title or body, a label, or the linked issue describes wrong behaviour being corrected
  (not a feature, refactor, performance, typing-only, docs or CI change);
- changes exactly one non-test source file (.py or .go) in the diff from the merge's first parent to the
  merge commit; docs, changelog and non-code config files are not counted; a test file is one under a
  tests/ or test/ directory, a test_*.py, *_test.py, conftest.py or *_test.go file, or anything under
  testdata/;
- adds or changes a test file, and that test fails at parent_commit with the fix's source reverted and
  passes at fix_commit (checked the way h2h does it, below);
- runs with pytest or go test without network or services.

A PR is skipped only for a reason taken from this rule, and every skip is recorded below. PRs that change
no non-test source file, or no test file, are recorded in bulk per repository as a count with their
numbers, since they fail the rule mechanically.

Task build. fix_commit is the merge commit (the squash or rebase commit when the PR was not merged with a
merge commit) and parent_commit is its first parent. hidden is every test file the PR changed or added;
solution_files is the one non-test source file. vendored_paths, the same rule for every task: the license
file, the readme, every root-level packaging and test configuration file that exists (pyproject.toml,
setup.py, setup.cfg, tox.ini, pytest.ini, conftest.py, requirements*.txt, go.mod, go.sum), the package
source directory (or the root .go files for a Go module) and the tests directory. A src-layout Python
repository gets the same added conftest.py as the cachetools tasks, so the snapshot, not an installed copy,
is imported. hidden_cmd and visible_cmd run the whole test directory (pytest -q -p no:cacheprovider, or go
test -count=1 ./...); a test file that cannot run on this machine for a reason unrelated to the fix is
ignored with --ignore and the reason is written in the task's note. En and em dashes (U+2013, U+2014) and
emoji in task.txt and the vendored files are rewritten as the existing tasks do (patch_files with exact
counts). task.txt is the linked issue's title and body, or the PR's when there is no issue.

Verification, as h2h does it: `bash benchmarks/h2h/run.sh --suite replay --configs oracle,noop --tasks
<the 8 ids>`: the hidden tests must pass with the solution applied (oracle) and fail on the parent with the
fix's source reverted and the hidden tests copied in (noop). No loki-cal-* config was run on an hc2 task
before the set below was frozen.

## What each step returned


### Clearance

The lead cleared the 15 first-list candidates against the held-out corpora and excluded two: BurntSushi/toml
and spf13/pflag (excluded: held-out overlap, cleared by the lead). The first lists ran out (4 Python and 2
Go tasks qualified on the first pass), so reserves were added. They were hand-picked, as the first lists were, not a
mechanical sample: Python reserves are small pure-Python libraries taken in alphabetical order from the
distributions installed on this machine (`pip list`), passing over the ones that are not small libraries,
not pure Python, not permissively licensed or already used (aiokafka, aiosmtplib, aiosqlite, alembic, the
ansible packages, anthropic, anyio, APScheduler, argon2-cffi, asgiref, and later bcrypt, black, cachetools,
certifi, cffi, charset-normalizer, click, chromadb): fastapi/annotated-doc, annotated-types/annotated-types,
python-trio/async_generator, aio-libs/async-timeout, then python-attrs/attrs, litl/backoff, pypa/build,
cloudpipe/cloudpickle, python-distro/distro, rr-/docstring_parser. Go reserves are small Go libraries in
alphabetical order, chosen as likely to have few dependencies (agnivade/levenshtein, go-logfmt/logfmt,
huandu/xstrings, rivo/uniseg, shopspring/decimal; levenshtein and logfmt turned out to have require lines,
which the go.mod rule handles per PR). The lead cleared every reserve with no held-out overlap, but the order
was not as clean as clearance-first: annotated-doc and annotated-types were scanned and annotated-types #69
and #63 A/B-tested before the second clearance request was sent, and levenshtein, logfmt and xstrings were
scanned while it was pending. The answer was all clear, so no selection changed.

### Correction made while building (same rule, environment read right)

The first pass judged "imports on the system python3" from an interactive shell, which also sees the user
site-packages (~/Library/Python/3.14). The oracle self-check showed that the scored environment does not:
every contestant and every scoring run gets a throwaway HOME, so only /opt/homebrew site-packages import
(click, mdurl, attrs, bracex, freezegun, hypothesis and pytest-cov do not). The rule was re-applied to every
repository with that environment (`PYTHONNOUSERSITE=1` for the A/B checks). Two repositories that had
qualified dropped out for it: theskumar/python-dotenv (#669 had qualified; tests/conftest.py imports click)
and executablebooks/markdown-it-py (#440 had qualified; its runtime dependency mdurl does not import). The
re-walk also showed that jd/tenacity, first skipped for typeguard, has a qualifying PR (#556) whose test
file needs neither typeguard nor tornado; it was walked before the reserves, so it takes the slot that
rr-/docstring_parser #192 had briefly held (that task was built, self-checked and deleted, and never
calibrated).

Limit of the set, stated plainly: eligibility requires that the scored environment (the throwaway HOME,
homebrew site-packages only, nothing installed) can import the task's runtime and test dependencies. That
biases the set toward projects the system interpreter can run as they are, and against projects whose
dependencies or test plugins live only in a virtualenv. python-dotenv and markdown-it-py dropped out for
this reason alone.

### Python walk

| # | repository | class at parent | result |
|---|---|---|---|
| 1 | facelessuser/wcmatch | D (bracex>=3.2.3) | skipped: the runtime dependency bracex does not import in the scored environment (the user-site copy is 2.6, below the declared 3.2.3); at #281, the newest bug fix, 103 tests fail at the fix commit |
| 2 | jd/tenacity | N (setup.cfg `install_requires =` empty, no [project] dependencies) | **#556** taken. Skipped before it: #696 (its test file tests/test_tornado.py needs tornado), #677 (the changed tests pass before the fix: the edit removes type-ignore comments), #668 (typing only), #660, #656, #651, #654, #640, #606, #603 (the changed tests/test_tenacity.py imports typeguard, not installed), #629, #628, #605 (features), #620 (refactor), #591 (tests/test_after.py imports tests/test_tenacity.py, so typeguard), #568 (typing only). Mechanical: no source file #772, #754, #743, #744, #742, #725, #739, #737, #736, #734, #733, #726, #707, #681, #678, #683, #676, #666, #672, #673, #671, #648, #641, #637, #621, #618, #612, #602, #599, #585, #578, #575, #570, #569, #562, #561, #560, #559; 2+ source files #741, #645, #694, #682, #679, #664, #670, #653, #643, #622, #616, #614, #615, #609, #604, #601, #597, #584, #571, #558; no test file #680, #619, #617, #590, #589, #588, #587, #586, #577, #579, #576, #563 |
| 3 | sybrenstuvel/python-rsa | D (pyasn1, in [tool.poetry.dependencies]) | **#215** taken (newest PR passing the mechanical filter). Mechanical: 2+ source files #207, #206; no source file #223, #225, #218, #217; no test file #210 |
| 4 | python-humanize/humanize | N | skipped: the package does not import from source (humanize/_version.py is generated by the build) and freezegun is not installed |
| 5 | python-trio/outcome | D (attrs) | skipped: #29 is a GC and performance change (python-trio/trio#1770, cyclic garbage causing GC stalls), not a bug fix; #18, the only other candidate, cannot be collected (its conftest.py uses pytest.collect, removed from pytest); attrs does not import in the scored environment either |
| 6 | theskumar/python-dotenv | N | skipped: tests/conftest.py imports click, which does not import in the scored environment, so no test file runs (#742 and #669 were examined under the wrong environment first; see the correction) |
| 7 | executablebooks/markdown-it-py | D (mdurl) | skipped: the runtime dependency mdurl does not import in the scored environment (#458 performance, #464 needs pytest-regressions, #440 qualified only under the wrong environment) |
| 8 | tox-dev/platformdirs | N | skipped: the package does not import from source (platformdirs/version.py is generated by the build) and appdirs is not installed |
| 9 | facelessuser/bracex | N (no [project] dependencies; hatch env lists only) | **#64** taken (the newest PR, no skip) |
| R1 | fastapi/annotated-doc | N | skipped: the only PR passing the mechanical filter, #69, automates releases (not a bug fix; its source file is scripts/prepare_release.py) |
| R2 | annotated-types/annotated-types | D (`typing-extensions>=4.0.0; python_version<'3.9'`) | **#63** taken. Skipped before it: #115 (quote style), #105 (tooling), #97 (Python version support), #65 (feature: Unit type), #69 (typing and docstring only; the suite passes before the fix). Mechanical: no test file #119, #118, #109, #103, #100, #90, #84, #80, #70; no source file #120, #116, #117, #111, #114, #110, #104, #96, #92, #88, #87, #86, #83 |
| R3 | python-trio/async_generator | not read (no PR qualified, so the manifest was never needed) | skipped: none of its 9 merged PRs passes the mechanical filter |
| R4 | aio-libs/async-timeout | D (`typing_extensions>=3.6.5; python_version < "3.8"` in setup.cfg install_requires) | **#363** taken (fixes #362, "Tasks are not uncancelled in python 3.11"; upstream filed its changelog entry as CHANGES/362.feature, but the linked issue describes wrong behaviour, which is the rule's bug-fix test). Skipped before it: #422 (feature: asyncio.Timeout compatibility), #421 (removes a deprecated API). Mechanical: no test file #364; no source file for the other 78 newer PRs (#473 to #334) |

With R4 the quota is full: 5 Python tasks, D 3 (python-rsa, annotated-types, async-timeout), N 2 (tenacity,
bracex). python-attrs/attrs, litl/backoff, pypa/build, cloudpipe/cloudpickle, python-distro/distro and
rr-/docstring_parser were examined while tenacity was still wrongly skipped, and are not needed (for the
record: attrs, conftest imports hypothesis; backoff, #161 and #88 fail at the fix commit on Python 3.14 and
#31 cannot be collected; build, D quota full; cloudpickle, its main test file imports psutil; distro, every
distribution test is skipped off Linux; docstring_parser, #192 would have qualified).

How "declares real runtime dependencies" reads on these five, stated plainly: python-rsa needs pyasn1 at run
time on every Python. The annotated-types and async-timeout declarations are non-empty lists, so they count
as D under the rule as written, but each entry carries a python_version marker that is false on 3.14, so on
this machine neither installs anything. Counting only dependencies active on Python 3.14, the set has 1
task with real runtime dependencies, not 2. Only python-rsa has dependencies active on 3.14. The lead ruled, before the run, that the
classification stands as written (the rule under test counts any non-empty dependencies or install_requires,
whatever its markers), and it is not changed after the results. The engine's own reading (loki-ts/src/util/python.ts
declaresPythonEnv) treats 4 of the 5 as declaring a Python environment: python-rsa ([tool.poetry]),
annotated-types ([project] dependencies), async-timeout (setup.py, requirements.txt and install_requires)
and tenacity (setup.py, and setup.cfg `install_requires =` with an empty value); only bracex reads as none.

### Go walk

| # | repository | result |
|---|---|---|
| 1 | BurntSushi/toml | excluded: held-out overlap, cleared by the lead |
| 2 | spf13/pflag | excluded: held-out overlap, cleared by the lead |
| 3 | google/uuid | **#150** taken (issue #148). Skipped before it: #166, #163 (features), #106 (refactor: MustParse in place of Must(Parse)), #156 (doc typos). Mechanical: 2+ source files #172, #162, #161; no source file #151, #154, #143; no test file #153 |
| 4 | dustin/go-humanize | **#165** taken. Mechanical: no source file #168, #162, #163; 2+ source files #160; no test file #164 |
| 5 | cespare/xxhash | skipped: its 3 PRs passing the mechanical filter are performance (#50, #2) or a feature (#19) |
| 6 | google/go-cmp | recorded as skipped, wrongly (see the deviation below): #410 is a feature, #299 and #275 tune a diff heuristic for readability, #292 removes a dependency, and the parents of #292 back to #201 require golang.org/x/xerrors; but the parents of #178, #177, #171, #158 and #142 have no require, and #142 ("Invoke String when formatting map keys", fixes #141, a regression) qualifies |
| R1 | agnivade/levenshtein | skipped: both PRs passing the mechanical filter are performance work, and go.mod requires two modules |
| R2 | go-logfmt/logfmt | skipped: #17 (DEL encoding) fails its own test at the fix commit on go 1.26.3 (`[]byte{0x7f}` encodes as `k=`); #15 is a feature; #8 changes key handling by design; #7 has no go.mod at its parent, so go test cannot run |
| R3 | huandu/xstrings | **#78** taken (fixes #77; the newest PR, merged 2026-11-20) |

### Deviation found after the calibration run

A check made after the run, at a reviewer's request, showed that the go-cmp skip above was measured on one
commit (#266) and stated for every older PR. Checking every candidate's parent go.mod: 23 parents back to #201
require golang.org/x/xerrors, but the parents of #178, #177, #171, #158 and #142 require nothing. #178 and #158
are features, #177 is style, #171 improves a panic message, and #142 (fix_commit 917e382dab80, fixes #141, a
regression where map keys stopped calling String) passes the rule: its cmp/compare_test.go fails at the parent
with the fix's source reverted and passes at the fix (`GOPROXY=off go test -count=1 ./...`). So by the rule
the third Go task is google/go-cmp #142, not huandu/xstrings #78 (a reserve). The set was already calibrated,
so it was not changed: a held-out set is spent once it is scored, and swapping a task after seeing labels is
what the rule forbids. hc2-go-xstrings-negative-rune stays in the set and is marked here as taken out of turn.
The same check for python-dotenv held: tests/conftest.py has imported click.testing since 254d5bf (2019-01-01,
"Isolate test files (#160)"), older than every PR in the 100-PR window, so no dotenv PR could run.

### The 8 tasks

| task | upstream PR | fix_commit | parent_commit | hidden tests | solution |
|---|---|---|---|---|---|
| hc2-py-rsa-encrypt-modulus | sybrenstuvel/python-rsa#215 | b94766f775aa | 5045b149ba25 | tests/test_integers.py | rsa/core.py |
| hc2-py-tenacity-ordinal-teens | jd/tenacity#556 | 0bdf1d9e5f42 | d4e868d6b836 | tests/test_utils.py | tenacity/_utils.py |
| hc2-py-bracex-int64-span | facelessuser/bracex#64 | cd73b9c37786 | 33190b8168d1 | tests/brace-cases.txt, tests/brace-results.txt, tests/test_brace.py | bracex/__init__.py |
| hc2-py-annotated-types-isdigit | annotated-types/annotated-types#63 | 89e3d2ec0c82 | 59a50d17126f | annotated_types/test_cases.py | annotated_types/__init__.py |
| hc2-py-async-timeout-uncancel | aio-libs/async-timeout#363 | 3cfabe24a10a | adf9e28f6a91 | tests/test_timeout.py | async_timeout/__init__.py |
| hc2-go-uuid-v7-monotonic | google/uuid#150 | a2b2b32373ff | c58770eb495f | uuid_test.go | version7.go |
| hc2-go-humanize-si-nonfinite | dustin/go-humanize#165 | 1b638b2c0d9b | ac100271b177 | si_test.go | si.go |
| hc2-go-xstrings-negative-rune | huandu/xstrings#78 | e5f85a2a42a0 | 28aabebffe3c | translate_test.go | translate.go |

Full 40-character commits, vendored paths, ignored test files (each with its reason) and every text rewrite
are in each task's meta.json. Per-task adjustments, all of the kinds the existing tasks use: tenacity
ignores 4 test files that need typeguard or tornado; python-rsa ignores tests/test_mypy.py (needs mypy);
python-rsa and async-timeout drop the pytest --cov addopts (pytest-cov is not in the benchmark toolchain,
as for py-parse-tz-groups); emoji in annotated-types and xstrings test string literals become escapes; en
dashes in tenacity copyright comments become '-'.

### What the engine will see on the base commit (measured before the calibration run)

Oracle and noop score with hidden_cmd, ignored files included; Loki's verifier runs the repository's suite
itself. The plain full suite with no --ignore (`python3 -m pytest -q -p no:cacheprovider` with
PYTHONNOUSERSITE=1 and a throwaway HOME, or `go test -count=1 ./...`), run on a copy of each cached base
snapshot: red for hc2-py-rsa-encrypt-modulus (exit 2, tests/test_mypy.py cannot import mypy) and
hc2-py-tenacity-ordinal-teens (exit 2, 4 collection errors: typeguard and tornado); green for
annotated-types (252 passed), async-timeout (33 passed), bracex (417 passed) and the three Go tasks. This was
recorded before any loki-cal-* run and changes no selection; the report reads base-green and base-red merged
runs separately.

### Verification as h2h does it

`bash benchmarks/h2h/run.sh --suite hc2 --configs oracle,noop --jobs 2` (run-owned TMPDIR, exit 0): oracle
passes 8 of 8 (the merged fix with its tests), noop passes 0 of 8 (the parent commit, the fix's source not
applied, the hidden tests copied in). Each snapshot was rebuilt from a clean cache and matched its
snapshot_sha256. Before that, each PR was checked by hand the same way on a clone (parent tree plus the fix's
test files: fails; fix commit: passes).
