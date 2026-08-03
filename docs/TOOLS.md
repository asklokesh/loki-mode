# Bundled tools

`tools/` holds 32 standalone scripts that ship with loki-mode. They read
artifacts a run leaves behind and answer one question each. None of them starts
a build or spends money on inference.

Two qualifications to that, because "read-only" is not true of all 32:
`probe-model-catalog.py` makes network requests to provider documentation pages,
and several write files (`gate-init.py`, `cost-history.py record`,
`baseline-pin.py set`, `receipt-export.py --out`, `gate-log.py record`). Where a
tool asserts read-only in its own help, this page repeats the assertion;
`preflight.sh`, `gate-status.py`, `cost-attribute.py` and `run-replay.py` do.

Every command and every output on this page was executed against loki-mode
9.8.1 before being written down. Where a tool reports UNKNOWN or refuses to
answer, that real output is shown rather than a prettier invented one.

## Running them

Most of these files are not marked executable, so invoke them through the
interpreter rather than as `./tools/x.py`:

```
python3 tools/<name>.py [args]
bash    tools/<name>.sh [args]
```

Installed from npm, they live under the package root. `python3 tools/tool-index.py`
lists what shipped.

**Where you run them from matters.** The receipt and gate tools check drift and
the working tree against the **current directory**, and several read or write
their state files relative to cwd (`.loki-policy.json`, `.loki/cost-history.jsonl`,
`.loki/gate-log.jsonl`, `.loki/baseline.json`). Run those from the workspace the
receipt describes, not from the loki-mode package directory. The examples below
show this as an explicit `cd`, with the tool referenced through a `$LOKI`
variable pointing at the package root:

```
LOKI=/path/to/loki-mode      # or the npm package root
cd /path/to/your/workspace
python3 $LOKI/tools/receipt-attest.py .loki/proofs/good/proof.json
```

Tools that take a workspace as a positional argument and read nothing relative
to cwd (`cost-attribute.py`, `run-replay.py`, `receipt-find.py`,
`estimate-run.py`, `model-advisor.py`, `preflight.sh`) can be run from anywhere.

## The exit-code convention

The tools that compose in CI share one convention. It is enforced by
`tests/test_tool_exit_contract.py`, which walks the real directory rather than
testing tools one at a time.

Enforcement covers exactly **24** of them: that test globs `tools/*.py` (30
files) and excludes six by name. The two shell tools, `preflight.sh` and
`verify-demo.sh`, are never globbed by it at all; they follow the convention by
observation here, not by enforcement.

| Code | Meaning |
|---|---|
| 0 | Checked, and it passed |
| 1 | Checked, and it FAILED |
| 2 | Could NOT be checked; no policy configured, or no measurement exists |
| 3 | Nothing to check (empty) |
| 64 | Usage error |
| 66 | Input missing (the path does not exist) |

Two properties are worth knowing before you build a gate on these.

**2 is not a pass.** A gate that cannot evaluate its axis exits 2, never 0. If
cost was never measured, `cost-guard.py` refuses to say the run was within
budget, because it does not know. Treat any code `>= 2` as "do not merge on
this axis".

**Gates and advisors differ deliberately.** A tool named `*-gate`, `*-guard`,
or `gate-*`, plus `ci-gate.py`, `receipt-attest.py` and `receipt-bundle.py`, is
a gate: its exit code is a verdict a machine branches on, and it may never exit
0 while its own output says it could not evaluate. An advisor such as
`model-advisor.py` answering "NO BASIS" has answered the question honestly and
exits 0. Forcing advisors non-zero would train operators to ignore them.

Six Python tools are excluded from the convention by name, and are described
under [Internal and maintenance](#internal-and-maintenance) below. They are
benchmark harnesses and repo-maintenance scripts that predate it. One of the six,
`hybrid_search.py`, is genuinely user-facing and is documented under
[Diagnose a run](#diagnose-a-run) instead.

For the exit codes of the `loki` CLI itself (`loki start`, `loki verify`,
`loki ci`, `loki doctor`), see [exit-codes.md](./exit-codes.md). That is a
separate contract; this page does not restate it.

---

## Verify a receipt

An Evidence Receipt (`proof.json`) is what a run leaves behind to describe what
it did. These tools re-check one.

### `verify-demo.sh`

**Answers:** what does the verification chain actually do, without paying for a
build? It creates a scratch git repo in a tempdir, generates a real receipt over
it, verifies it, then tampers with the receipt and verifies again so you can see
the failure. Synthetic receipts, real verifier: every verdict shown is printed by
the actual tool.

```
$ bash tools/verify-demo.sh
...
STEP 3 of 3 -- tamper with the receipt, then re-verify
  edited facts.git.diff.count: 1 -> 999 (claims work that is not there)
  $ tools/receipt-attest.py .loki/proofs/tampered/proof.json

FAILED -- drift, integrity did not pass here; receipt is UNSIGNED, so origin rests on its generator

integrity  FAILED
           hash mismatch: recorded 34175ce3..., computed 64eb7c52... -- proof.json was edited after it was written

  -> exit 1. Caught, with the reason printed above.
```

Pass `--keep` to leave the scratch directory in place. Exits 0 when the whole
chain behaves as expected, so it doubles as a smoke test.

### `receipt-attest.py`

**Answers:** does this receipt hold up, checked from here? Scores five axes
independently (integrity, drift, headline, cost, tree) plus signature state, and
never collapses "could not check" into either pass or fail.

```
$ cd /path/to/your/workspace
$ python3 $LOKI/tools/receipt-attest.py .loki/proofs/good/proof.json
VERIFIED -- every axis checked here passed; receipt is UNSIGNED, so origin rests on its generator

receipt      proof.json
sha256       5854c7a5271d567f915e495b81644551f7418d485422ba1e9dcc3f62f364edc8
checked from /private/var/folders/.../loki-doccheck2-pdtkmezm

integrity  VERIFIED
drift      VERIFIED
headline   VERIFIED
cost       VERIFIED
tree       VERIFIED
signature  UNSIGNED (unsigned)
           the receipt carries no gpg signature, so its origin rests on the generator that produced it, not on cryptographic proof
```
(the sha256 and path are specific to that receipt; yours will differ)

Exit 0 all axes verified, 1 something FAILED, 2 something was UNVERIFIABLE, 64
usage error.

**Important:** the drift and tree axes are checked against the **current working
directory**, and this tool has no flag to point them elsewhere. Run it from the
repository the receipt describes. Run it from anywhere else and you get a
truthful but useless FAILED, because the tree genuinely does not match:

```
$ cd /path/to/loki-mode          # the WRONG directory for this receipt
$ python3 tools/receipt-attest.py /tmp/other-repo/.loki/proofs/good/proof.json
FAILED -- drift, tree did not pass here
drift      FAILED
           diff drift: the receipt recorded 1 files / +2 / -0, the repository now has 4178 files / +878921 / -0
```

`receipt-bundle.py` and `receipt-export.py` accept `--repo-dir` for exactly this
case; `receipt-attest.py` does not.

### `receipt-bundle.py`

**Answers:** do ALL the receipts under this workspace hold up, as one audit
trail? A bundle is only as good as its weakest receipt, and failures are counted,
never dropped.

```
$ python3 tools/receipt-bundle.py /tmp/ws
Receipt bundle: /tmp/ws

  VERIFIED      /tmp/ws/.loki/proofs/good/proof.json

total cost UNKNOWN (0 of 1 receipts measured cost)

VERIFIED -- all 1 receipts verified. total cost UNKNOWN (0 of 1 receipts measured cost)
```

Takes `--repo-dir` to name the repository the receipts are re-checked against.

### `receipt-export.py`

**Answers:** can I hand a third party one self-describing evidence file? Writes
every receipt under a workspace into a single record, and includes an explicit
"what this export does NOT prove" section rather than letting the reader assume.

```
$ python3 tools/receipt-export.py /tmp/ws --out /tmp/ws/evidence.json
...
What this export does NOT prove:
  - An UNSIGNED receipt proves INTEGRITY, not ORIGIN: the recorded bytes were not
    edited after they were hashed, but nothing here shows WHICH machine produced them.
```

`--force` overwrites an existing `--out`. Exits 1 when any receipt fails.

### `receipt-diff.py`

**Answers:** what actually changed between two runs? Reports UNKNOWN where a
value was never measured, rather than printing a misleading zero.

```
$ python3 tools/receipt-diff.py a/proof.json b/proof.json
Evidence Receipt diff
  cost             UNKNOWN -> UNKNOWN   delta UNKNOWN
  cache hit ratio  UNKNOWN -> UNKNOWN   delta UNKNOWN
  iterations       0 -> 0   delta +0
  duration         0 -> 0   delta +0s

  gates       no verdict changes

  NOT COMPARABLE (reported UNKNOWN, not zero):
    cost: cost was not measured in a/proof.json and b/proof.json
```

It refuses to diff a receipt that fails integrity, rather than comparing numbers
that were edited after the fact:

```
$ python3 tools/receipt-diff.py good/proof.json tampered/proof.json
REFUSED: receipt failed integrity verification: tampered/proof.json
  hash mismatch: recorded 34175ce3..., computed 64eb7c52... -- proof.json was edited after it was written
```
Exit 2, because nothing could be checked.

### `receipt-find.py`

**Answers:** which receipts, out of a workspace full of them, does an auditor
actually need? Filters by measurable criteria only.

```
$ python3 tools/receipt-find.py /tmp/ws
/tmp/ws/.loki/proofs/good/proof.json  [-]
/tmp/ws/.loki/proofs/tampered/proof.json  [-]

2 of 2 receipt(s) matched. Filters applied: none (no filter applied).
```

Filters: `--min-usd`, `--max-usd`, `--failed-only`, `--since YYYY-MM-DD`.

### `signing-status.py`

**Answers:** can this machine produce SIGNED receipts? It proves the answer by
attempting a sign-and-verify round trip rather than assuming from config.

```
$ python3 tools/signing-status.py
Receipt signing: UNSIGNED  receipts prove integrity but NOT origin

  gpg installed:      /opt/homebrew/bin/gpg
  LOKI_PROOF_GPG_KEY: not set
  sign+verify proof:  not proven

  Why: LOKI_PROOF_GPG_KEY is not set

  Nothing is broken. Signing is opt-in and off. Turn it on to prove
  a receipt came from you and not merely that its bytes are intact.

  Next: gpg --list-secret-keys --keyid-format=long   # then: export LOKI_PROOF_GPG_KEY=<key-id>
```
Exit 2 here: signing is off, so the question could not be answered affirmatively.

---

## Set up a merge gate

One exit code a CI job branches on, plus the tools that configure, render, and
track it.

### `gate-status.py`

**Answers:** is this repo's merge gate actually set up and working? Start here.
One screen, read-only.

```
$ python3 tools/gate-status.py /tmp/ws
Merge gate status for /tmp/ws
  (read-only: starts nothing, spends nothing, contacts no provider)

COMPONENT      STATE     DETAIL
policy         OK        /tmp/ws/.loki-policy.json is valid and enforces: --require-receipt
baseline       PROBLEM   NO BASELINE: no baseline pinned. Pin one with: tools/baseline-pin.py set <workspace>
signing        UNKNOWN   signing is opt-in and off (LOKI_PROOF_GPG_KEY unset)
cost_history   UNKNOWN   no measured cost history; record a run first.
would_run      OK        yes: ci-gate would enforce the loaded policy on the next run

GATE: UNKNOWN -- the merge gate cannot be fully verified from here, so it is not known to be working
```
Exit 2: a gate that is not known to be working is not reported as working.

### `gate-init.py`

**Answers:** what policy file and CI snippet turn the gate on? Scaffolds them
from measured history, and refuses to invent a cost ceiling it has no basis for.

```
$ cd /path/to/your/workspace
$ python3 $LOKI/tools/gate-init.py .
wrote .loki-policy.json
{
  "require_receipt": true
}

validated by policy-load.py; ci-gate args: --require-receipt

NO CEILING WAS SET: no measured runs in this workspace's cost history.
The max_usd key is ABSENT rather than guessed. You must choose a ceiling and add it, for example:
    "max_usd": 5.00
```
`--print-workflow` also prints a starting-point CI snippet. `--force` overwrites.

### `ci-gate.py`

**Answers:** does this run pass every configured merge policy? This is the one a
CI job calls.

```
$ cd /path/to/your/workspace
$ python3 $LOKI/tools/ci-gate.py . --require-receipt
POLICY     STATE        DETAIL
receipt    PASS         VERIFIED

GATE: PASS -- 1 of 1 policies passed
```

And on a workspace whose receipt does not hold up:

```
$ python3 $LOKI/tools/ci-gate.py . --require-receipt
POLICY     STATE        DETAIL
receipt    FAIL         FAILED

GATE: FAIL -- 0 of 1 policies passed
```
Exit 1. `--max-usd N` adds the cost ceiling. `--json` emits the verdict that the
four renderers below consume on stdin.

The `--require-receipt` policy runs `receipt-attest.py` underneath, so it
inherits the cwd dependence described above. Run it from the workspace; run it
from elsewhere and it FAILs on drift even for a sound receipt.

### `policy-load.py`

**Answers:** what does my version-controlled policy file actually enforce? Keeps
the policy reviewable in git instead of buried in a CI flag.

```
$ cd /path/to/your/workspace     # where .loki-policy.json lives
$ python3 $LOKI/tools/policy-load.py --as-args
--require-receipt
```

With no policy file present it is explicit about what that means:

```
$ python3 $LOKI/tools/policy-load.py
policy-load: no policy file at .loki-policy.json: a gate with no policy enforces nothing
```
Exit 1. `--file` names a different path; `--json` emits the validated policy.

### `policy-diff.py`

**Answers:** does this policy edit tighten the gate or weaken it? A loosening
looks like any other line in a diff, so this classifies by safety direction.

```
$ python3 tools/policy-diff.py old-policy.json new-policy.json
WEAKENS: max_usd: 5.0 -> 20.0
1 weakening(s), 0 unknown direction, 1 change(s) total
```

`--fail-on-weaken` makes that a blocking review step:

```
$ python3 tools/policy-diff.py old-policy.json new-policy.json --fail-on-weaken
WEAKENS: max_usd: 5.0 -> 20.0
policy-diff: 1 weakening(s) require an explicit human ack
```
Exit 1.

### `gate-report.py`

**Answers:** how do I show this verdict in CI-native form? Reads a `ci-gate --json`
verdict on stdin and re-renders it. It never invents a verdict.

```text
$ cd /path/to/your/workspace
$ python3 $LOKI/tools/ci-gate.py . --require-receipt --json | python3 $LOKI/tools/gate-report.py --format markdown
    ## Merge gate: PASS

    | Policy | State | Detail |
    | --- | --- | --- |
    | receipt | PASS | VERIFIED |

    PASS -- 1 of 1 policies passed
```
(the output is markdown; it is indented here only so it does not render as a
heading on this page)

`--format github` emits workflow annotations instead. Shown here on a FAILING
verdict, since a passing gate has no annotations worth reading:

```
::error title=gate: receipt (FAIL)::FAILED
::error title=merge gate FAIL::0 of 1 policies passed
```
Formats: `markdown` (step summary), `github` (annotations), `text`. `--file`
attaches a path to github annotations, omitted when not given because an
annotation on the wrong file is worse than none.

### `gate-explain.py`

**Answers:** the gate failed, so what do I run next? Turns a verdict into an
actionable command. On a FAILING verdict:

```
$ python3 $LOKI/tools/ci-gate.py . --require-receipt --json | python3 $LOKI/tools/gate-explain.py
POLICY: receipt [FAIL]
  CHECKED: the gate checked this and it failed
  FOUND:   FAILED
  NEXT:    attestation was required and did not hold. Read the attestation's own per-axis states before changing anything:
               python3 tools/receipt-attest.py <workspace>/.loki/proofs/*/proof.json --json

GATE: FAIL -- 0 of 1 policies passed
```

And on a passing one, it says so rather than manufacturing advice:

```
POLICY: receipt [PASS]
  CHECKED: the gate checked this and it passed
  FOUND:   VERIFIED
  NEXT:    nothing to do

GATE: PASS -- 1 of 1 policies passed
```

### `gate-badge.py`

**Answers:** what is the live gate state, as a README badge? Emits shields.io
endpoint JSON without laundering a failure into a green badge.

```
$ python3 $LOKI/tools/ci-gate.py . --require-receipt --json | python3 $LOKI/tools/gate-badge.py
{"schemaVersion": 1, "label": "gate", "message": "passing", "color": "brightgreen"}
```

On a failing verdict the same command emits, and the badge exit code follows the
verdict rather than always succeeding:

```
{"schemaVersion": 1, "label": "gate", "message": "failing", "color": "red"}
```
`--label` changes the badge label.

### `gate-log.py`

**Answers:** one verdict is a fact; what is the pattern across a hundred? A gate
that was never recorded is not a gate that never blocked.

```
$ cd /path/to/your/workspace
$ python3 $LOKI/tools/ci-gate.py . --require-receipt --json | python3 $LOKI/tools/gate-log.py record
gate-log: recorded pass to .loki/gate-log.jsonl

$ python3 $LOKI/tools/gate-log.py report
gate-log: 1 record(s)

  pass                       1
  fail                       0
  unevaluable (NOT a pass)   0
  corrupt                    0

most failing policy: none -- no FAIL in 1 readable record(s)
trend: UNKNOWN -- fewer than 2 readable records (1)
```
Note that `unevaluable` is counted separately and never folded into `pass`.

With no log at all it reports UNKNOWN, not a clean history:

```
$ python3 $LOKI/tools/gate-log.py report
gate-log: no log at .loki/gate-log.jsonl -- UNKNOWN, not a clean history. A gate that was never recorded is not a gate that never blocked.
```
Exit 66. The log path is relative to cwd, so `record` and `report` must run from
the same directory.

---

## Govern cost

Every tool here reports UNKNOWN when cost was not measured. None of them
substitutes zero for an absent measurement.

### `preflight.sh`

**Answers:** will this run succeed, and what will it cost? Answered BEFORE the
run. Read-only.

```
$ bash tools/preflight.sh /tmp/ws
Loki preflight -- /tmp/ws
Read-only: starts nothing, spends nothing, contacts no provider.

Provider
  OK    auto-detection would select: claude

Environment
  OK    doctor: 12 checks passed, 1 warning(s)

Saved state
  no resumable run found

Projected cost
  UNKNOWN  no measured, priced iteration in this workspace
           no iteration records found in this workspace: there is NO history to project from, so no cost is estimated (not $0.00)

========================================
VERDICT: READY
```
`--iterations N` projects over N iterations; without it the total reads UNKNOWN
rather than being guessed.

### `cost-guard.py`

**Answers:** did this run's cost regress past a budget policy? A cost gate for CI.

```
$ python3 tools/cost-guard.py /tmp/ws --max-usd 5
CANNOT EVALUATE: cost is UNMEASURED for /tmp/ws -- no efficiency record carried an observed cost or token count. Unmeasured is not within budget: this gate cannot say whether the run complied, so it reports no verdict rather than a green one.
```
Exit 2. This is the convention's sharpest case: an unmeasured run is not a
passing run. `--baseline` plus `--max-increase-pct` gates on relative growth
instead of an absolute ceiling.

### `token-guard.py`

**Answers:** did token usage regress? A provider-independent work ceiling, for
when you want a limit that does not move with pricing.

```
$ python3 tools/token-guard.py /tmp/ws --max-output-tokens 100000
CANNOT EVALUATE: tokens are UNMEASURED for /tmp/ws -- no efficiency record carried an observed token count. Unmeasured is not within budget: this gate cannot say whether the run complied, so it reports no verdict rather than a green one.
```
Exit 2. `--max-output-tokens` bounds output alone (the work signal);
`--max-total-tokens` bounds input + output + cache reads, which cache reads
dominate.

### `baseline-pin.py`

**Answers:** which run is THE cost baseline? Pin one, resolve it later for
`cost-guard --baseline`.

```
$ cd /path/to/your/workspace
$ python3 $LOKI/tools/baseline-pin.py set .
REFUSED TO PIN: receipt ./.loki/proofs/good/proof.json records NO MEASURED COST, so it must not become a baseline: a percentage increase against an unmeasured number is undefined. Unmeasured is not $0.00. Fix the cost instrumentation for that run, then pin it.
```
Exit 1. Subcommands: `set` pins the newest receipt in a workspace, `show` reports
what is pinned and whether it is intact, `path` prints the pinned proof path for
feeding to `--baseline`.

### `cost-history.py`

**Answers:** what is the cost trend across MANY runs? Unmeasured runs are stored
as null and excluded from the trend, never counted as zero.

```
$ cd /path/to/your/workspace
$ python3 $LOKI/tools/cost-history.py record .
recorded /private/var/folders/.../loki-doccheck-cayf1yk6: UNMEASURED (stored as null, excluded from the trend)

$ python3 $LOKI/tools/cost-history.py report
1 run(s), 0 measured
NO TREND: 1 run(s) recorded but none carried a measured cost; there is nothing to trend. Unmeasured runs are kept as null, not 0.
```

### `estimate-run.py`

**Answers:** what is this run likely to cost, and on what basis? Projects from
measured history only.

```
$ python3 tools/estimate-run.py /tmp/ws --iterations 5
Run cost ESTIMATE -- /tmp/ws

  NO BASIS: no measured, priced iteration to project from.
  Cost per iteration:  UNKNOWN
  Projected cost:      UNKNOWN
  Records found: 0  measured: 0  priced: 0
  Basis model(s):      not recorded
  Model now:           not pinned

  - no iteration records found in this workspace: there is NO history to project from, so no cost is estimated (not $0.00)
```
Exit 0: "no basis" is an honest answer to the question asked, and no gate
consumes this exit code.

### `cost-attribute.py`

**Answers:** where did a run's cost and time actually GO, stage by stage?

```
$ python3 tools/cost-attribute.py /tmp/ws
NO DATA: no events at /tmp/ws/.loki/events.jsonl -- pass the workspace directory of a completed run
```
Exit 66. Needs `.loki/events.jsonl` from a completed run.

### `model-advisor.py`

**Answers:** would a cheaper model have done this job, and what would it have
saved? An advisor, deliberately not a gate.

```
$ python3 tools/model-advisor.py /tmp/ws
Model cost advisor -- /tmp/ws

  NO BASIS: no measured, priced iteration in this workspace.
  Model used:          UNKNOWN
  Measured cost:       UNKNOWN
  Recommendation:      NONE -- there is no measured basis
  Projected saving:    UNKNOWN
  Records found: 0  measured: 0  priced: 0

  Cited external benchmark (SWE-bench verified) -- NOT a measurement of your workload:
    MiniMax M2.5 (open weights)    score 75.8   cost $36.64
    Claude Opus 4.6                score 75.6   cost $275.76
    the harness itself was worth about 3.4 points on an identical model
    equal-or-better score at roughly 7.5x lower cost ON THAT BENCHMARK. It is not
    a measurement of your workload and does not predict that a cheaper model would
    complete YOUR task
```
Exit 0 with no basis, by design. `tests/test_tool_exit_contract.py` pins this
judgement so a future reader does not "fix" it: forcing an advisor non-zero
trains operators to ignore a failing advisor.

---

## Diagnose a run

### `run-replay.py`

**Answers:** what did a completed run actually do, iteration by iteration?
Reconstructs from artifacts; starts nothing, spends nothing.

```
$ python3 tools/run-replay.py /tmp/ws
no events at /tmp/ws/.loki/events.jsonl -- pass the workspace directory of a completed run
```
Exit 66. Point it at the workspace of a run that finished.

### `tool-index.py`

**Answers:** what tools shipped, and which can a user reach?

```
$ python3 tools/tool-index.py
loki tools

        baseline-pin.py              Pin one run as THE cost baseline, then resolve it later.
        ci-gate.py                   One exit code for EVERY merge policy. The gate a CI job actually calls.
        cost-attribute.py            Where did a run's cost and time actually GO, stage by stage.
        ...
```
`--json` adds a `shipped` flag per tool. `--tools-dir` points at a different
directory.

### `hybrid_search.py`

**Answers:** where in this codebase is X? Merges lexical (grep/ripgrep) and
semantic search under a token budget.

```
$ python3 tools/hybrid_search.py council_should_stop --grep-only --top 3
hybrid search: 'council_should_stop' [grep-only] (ripgrep not found, using grep)
budget: 3000 tokens, 3 result(s)

[1] tests/test-council-convergence-floor.sh:223  (match: grep, score: 0.016393)
    # The HARD floor in council_should_stop (ITERATION_COUNT < floor -> not allowed to
```
`--semantic-only` requires the codebase index (see `index-codebase.py` below,
which currently does not run on Python 3.14). `--grep-only` needs nothing.

---

## Internal and maintenance

Five of the tools below are excluded from the exit-code convention **by name** in
`tests/test_tool_exit_contract.py` (the sixth named exclusion, `hybrid_search.py`,
is user-facing and appears under [Diagnose a run](#diagnose-a-run)). They are
benchmark harnesses and repo maintenance scripts, not CI-composable gates.

`verify-demo.sh` is listed here for a different reason: it is user-facing and is
documented in full under [Verify a receipt](#verify-a-receipt), but as a shell
script it is never globbed by the contract test, so nothing enforces its exit
codes.

Several of these carry version-stamped internal release notes as their
docstrings rather than user-facing descriptions, so what follows is a description
of observed behaviour, not a quoted one.

### `bench_memory_retrieval.py`

Memory retrieval cold-start benchmark. Seeds N episodes, performs cold
retrievals, reports percentiles against a threshold.

```
$ python3 tools/bench_memory_retrieval.py --episodes 50 --runs 5 --json
{
  "episodes_seeded": 50,
  "runs": 5,
  "seed_ms": 47.5,
  "p50_ms": 4.7,
  "p95_ms": 5.2,
  "p99_ms": 5.2,
  "threshold_ms": 500.0,
  "p95_under_threshold": true,
  "generated_at": "2026-08-03T02:38:51.517506+00:00"
}
```
Defaults are 1000 episodes, 100 runs, 500ms threshold. Its own `--help` notes
that 10000 episodes does NOT meet the 500ms bar with file-based storage.

### `bench_cross_project_lift.py`

Measures how much retrieval coverage a project gains from sibling projects'
memory. The `method` field names its own limitation.

```
$ python3 tools/bench_cross_project_lift.py --json
{
  "goals": 6,
  "baseline_covered": 0,
  "cross_covered": 3,
  "lift_absolute": 3,
  "lift_pct_points": 50.0,
  "net_new_from_siblings": 3,
  "top_k": 5,
  "method": "retrieval-coverage (keyword-overlap relevance proxy), NOT task-success"
}
```

### `probe-model-catalog.py`

Fetches provider documentation pages, extracts model IDs by regex, and compares
them against `providers/model_catalog.json`. It reports and never auto-rewrites
the catalog.

```
$ python3 tools/probe-model-catalog.py
== claude ==
   known in catalog: 4
   found in docs:    14
   NEW CANDIDATES:   claude-haiku-4-5-20251001, claude-opus-4-1, ...

To adopt a new model: edit providers/model_catalog.json -> bump latest_<tier>
and add to models[]. Then re-run this script to confirm it disappears from new_candidates.
```
`--strict` exits nonzero when new models are found. Note it still probes a
`gemini` section; Gemini was removed as a provider, so those candidates are not
adoptable.

### `regen-state-machine-refs.py`

Verifies that every `file:line (function)` reference in
`docs/architecture/STATE-MACHINES.md` still points at that function's definition.
`--fix` rewrites stale numbers in place, `--strict` exits nonzero on drift (for
CI).

### `index-codebase.py`

Builds the semantic index that `hybrid_search.py --semantic-only` consumes.

**This does not currently run on this machine.** It imports `chromadb`, which
fails on Python 3.14:

```
$ python3 tools/index-codebase.py --help
Traceback (most recent call last):
  File ".../tools/index-codebase.py", line 41, in <module>
    import chromadb
  ...
UserWarning: Core Pydantic V1 functionality isn't compatible with Python 3.14 or greater.
```
Exit 1 even for `--help`. Use `hybrid_search.py --grep-only` until the
dependency supports your interpreter. No usage example is given here because
none could be executed.

### `verify-demo.sh`

Documented under [Verify a receipt](#verify-a-receipt) above; it is user-facing
despite also serving as a smoke test.
