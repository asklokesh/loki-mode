# Held-out calibration set 3 (hc3), 2026-11-21

hc2 (HELDOUT-CAL-2.md) is a tuning set from 2026-11-21: the three label causes fixed in the NEXT4 work were
found on its receipts, so it cannot score those fixes. The `hc3-` tasks in this directory are the held-out
scoring set for the verifier's labels after those fixes. They are chosen by the rule below, written down
before any pull request, issue or file of any candidate repository was read, and no task may be swapped
after a calibration label is seen. hc3 is spent once it is scored.

## Pre-registered rule (written before any PR query)

- Same repository, PR, task-build and verification rules as HELDOUT-CAL-2.md "Pre-registered rule" (bug fix; exactly one non-test source file;
  a test file added or changed that fails at parent_commit with the fix's source reverted and passes at fix_commit; pytest or go test without
  network or services; newest first over the most recent 100 merged PRs; every skip recorded with its reason), with these changes:
  - Python walk interleaves the two lists, D1, N1, D2, N2, and so on, until there are 5 Python tasks with at least 2 of class D and at least 2 of
    class N (no class above 3). Class is read from the manifest at parent_commit: D means at least one runtime requirement ([project]
    dependencies, install_requires, poetry main dependencies) whose marker is true on Python 3.14.6 and which imports in the scored
    environment; N means no runtime requirement at all (an empty list counts as N). A repository whose only runtime requirements are
    marker-false on 3.14 (the hc2 annotated-types and async-timeout shape) is class M: it may be taken only after both D and N quotas are met.
    The manifest decides, not the list.
  - Go: the first 3 repositories of the Go list that yield a qualifying PR. The go.mod rule is checked on EACH candidate PR's own parent
    commit (no require line, go directive at most 1.26.3), never on one commit for all (the hc2 go-cmp deviation).
  - Scored environment, as measured for hc2: system python3 3.14.6 with PYTHONNOUSERSITE=1 and a throwaway HOME (homebrew site-packages only),
    go 1.26.3 with GOTOOLCHAIN=local and GOPROXY=off, nothing installed.
  - Task ids: `hc3-<py|go>-<repo-short>-<slug>`; meta.json, task.txt and snapshot exactly as the hc2 tasks (vendored_paths rule, conftest for a
    src layout, dash and emoji rewrites with exact counts, --ignore with a written reason).
  - Before any loki-cal run, record for each task the plain full suite on the base snapshot (no --ignore), as HELDOUT-CAL-2.md did.

### Exclusion list

Every `source.upstream` in benchmarks/h2h/**/meta.json, every repository named in HELDOUT-CAL-2.md, and the C2 repositories:

- h2h upstreams: aio-libs/async-timeout, andialbrecht/sqlparse, annotated-types/annotated-types, dustin/go-humanize, expr-lang/expr,
  facelessuser/bracex, google/uuid, huandu/xstrings, jd/tenacity, lepture/mistune, mahmoud/boltons, Masterminds/semver,
  more-itertools/more-itertools, pallets/click, python-poetry/tomlkit, pytoolz/toolz, r1chardj0n3s/parse, sybrenstuvel/python-rsa,
  tkem/cachetools, tobymao/sqlglot, toml-lang/toml-test.
- Named in HELDOUT-CAL-2.md (walked, reserves or excluded): BurntSushi/toml, spf13/pflag, cespare/xxhash, google/go-cmp, agnivade/levenshtein,
  go-logfmt/logfmt, rivo/uniseg, shopspring/decimal, facelessuser/wcmatch, python-humanize/humanize, python-trio/outcome, python-trio/trio,
  python-trio/async_generator, theskumar/python-dotenv, executablebooks/markdown-it-py, tox-dev/platformdirs, fastapi/annotated-doc,
  python-attrs/attrs, litl/backoff, pypa/build, cloudpipe/cloudpickle, python-distro/distro, rr-/docstring_parser.
- C2: anomalyco/opencode, NousResearch/hermes-agent, microsoft/playwright. Also never asklokesh/FireLater.
- The held-out corpora (the benchmark and eval held-out paths). The builder reads none of them; the lead clears the pool against them.

### Candidate pool, fixed in this order before anything is read

D: a runtime dependency active on 3.14 and importable in the scored environment; N: no runtime dependency. The planner's spec
(NEXT4-SPEC-2026-11-21.md section 5) states that each D dependency below was measured installed in the scored environment; the
builder did not re-probe them (several are themselves candidates). The class in this list is a prediction: the manifest at
parent_commit decides.

- Python D, in order: 1 pallets/jinja (MarkupSafe), 2 sqlalchemy/mako (MarkupSafe), 3 pexpect/pexpect (ptyprocess), 4 pyasn1/pyasn1-modules
  (pyasn1), 5 httplib2/httplib2 (pyparsing), 6 googleapis/proto-plus (protobuf), 7 psf/requests (charset-normalizer, idna, urllib3, certifi),
  8 pytest-dev/pytest-mock (pytest), 9 pytest-dev/pytest-asyncio (pytest). Reserves 8 and 9 were added by rule: an installed distribution in
  the scored environment (67 listed by importlib.metadata) whose own runtime requirements are all installed there. hc2's four D candidates
  gave one active-dependency task, so the D list is the long one.
- Python N, in order: 1 pyparsing/pyparsing, 2 PyCQA/pycodestyle, 3 jpadilla/pyjwt, 4 kjd/idna, 5 python-hyper/uritemplate, 6 eliben/pycparser,
  7 pytest-dev/iniconfig, 8 pygments/pygments, 9 pyasn1/pyasn1.
- Go, in order: 1 hashicorp/go-version, 2 yuin/goldmark, 3 dlclark/regexp2, 4 oklog/ulid, 5 rs/xid, 6 segmentio/ksuid, 7 gofrs/uuid,
  8 kballard/go-shellquote, 9 gobwas/glob, 10 russross/blackfriday.
- Reserves are part of the list, so one clearance round covers the build. Candidates the lead excludes are dropped in place; the order of
  the rest does not change.
- The owner/name slugs were written from memory, not looked up (nothing about a candidate may be read before clearance). After clearance the
  builder resolves each slug to its current canonical repository (a moved or renamed repo keeps its place in the order; one that does not
  exist is recorded as skipped, reason "no such repository").
- One shares a repository name with an excluded one: gofrs/uuid (google/uuid is hc2). It is a different library and stays unless the lead
  excludes it.
- One has a name-only hit in HELDOUT-CAL-2.md: pyasn1. HELDOUT-CAL-2.md names it at lines 22, 128 and 147 as python-rsa's runtime
  dependency, not as a walked, reserve or excluded repository. It is candidate N9 (pyasn1/pyasn1) and the dependency of D4
  (pyasn1/pyasn1-modules). It is not an exact owner/name match, so the exclusion rule does not drop it, but the system-interpreter fix
  (item 1d) was reasoned on python-rsa and pyasn1, so the lead rules on both N9 and D4 at clearance.

Overlap check against the parts of the exclusion list this builder may read, run 2026-11-21 in the build worktree (it covers the
benchmarks/h2h meta.json upstreams, HELDOUT-CAL-2.md and the C2 and FireLater slugs; it does not cover the held-out corpora, which
only the lead clears): the case-folded owner/name of each candidate, matched exactly against the union of every `source.upstream`
in the 66 git-tracked benchmarks/h2h meta.json files (20 distinct upstreams; toml-lang/toml-test is named in the spec's list but is
not a meta.json upstream on this base), every owner/name token in HELDOUT-CAL-2.md, and the four C2 and FireLater slugs. Result:
28 candidates, 28 distinct, 0 in the list.

Verification, as h2h does it: `bash benchmarks/h2h/run.sh --suite hc3 --configs oracle,noop --jobs 2` with a run-owned TMPDIR: oracle
8 of 8, noop 0 of 8, snapshot_sha256 rebuilt from a clean cache. No loki-cal-* config is run on hc3 before the set is frozen.

Scoring run (after the release, by the lead; no model). Do not run it before the task commit: until hc3- tasks exist, `--suite hc3`
with any config writes an empty result and exits 0 (h2h.py main; the same holds for any empty suite). Such a run cannot pass the bar,
since merged VERIFIED at least 7 of 8 fails on zero tasks, but it is not a result:
`H2H_CAL_ENGINE=dist TMPDIR=<dir from loki_run_tmp_create> bash benchmarks/h2h/run.sh --suite hc3 --configs loki-cal-merged,loki-cal-nofix,loki-cal-plant,loki-cal-inert --jobs 1 --timeout 1800 --out benchmarks/h2h/results/calibration-heldout3-<date>.json`
on the release commit's built dist (its sha1 recorded before and after). Bar: merged VERIFIED at least 7 of 8 (above 6), false
VERIFIED 0 of 24. Base-green and base-red merged runs are reported apart, and right and verifier_right apart (a stub stand-in hold
such as hc2 uuid's "open note" is not a label error).

## What each step returned

### Clearance

Pending. The lead's answer to the clearance request was: treat every listed upstream as cleared except any whose name appears in
the benchmark or eval held-out paths, which the builder must not read itself; the builder stops after this selection record and
reports the list as pending clearance. The builder cannot tell which names appear in those paths without reading them, so no
candidate is cleared yet. As of this record no PR, issue, file, clone or API query of any of the 28 candidates has been made.

What the lead still has to answer: which of the 28 candidates the held-out corpora exclude (or that none are), and a ruling on pyasn1
(N9 and D4, above). This file is so far a selection record, not the WP-3 delivery: WP-3 merges when its build check passes (the oracle
and noop verification above), and that needs the 8 tasks.

### Python walk

Not started (waiting on clearance).

### Go walk

Not started (waiting on clearance).

### The 8 tasks

None built yet. `--suite hc3` (benchmarks/h2h/h2h.py, prefix `hc3-`) lists 0 tasks until they are.

### What the engine will see on the base commit

Not measured yet (needs the tasks).

### Verification as h2h does it

Not run yet (needs the tasks).
