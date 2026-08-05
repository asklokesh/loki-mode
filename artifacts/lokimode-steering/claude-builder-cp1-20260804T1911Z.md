# CP-1 receipt: the help-recursion cap was an absolute bound on a relative quantity

Date: 2026-08-04T19:11Z
Worktree: `.claude/worktrees/pre-push-scoped-pytest`
Branch: `worktree-pre-push-scoped-pytest`
Parent SHA: `7156d789109ae29f77385aa4d3176b33d87f5602`
File changed: `tests/test-help-no-recursion.sh` (+57 / -7)
Product runtime changed: **none** (`autonomy/loki` byte-identical to HEAD, verified
via `git diff --quiet HEAD -- autonomy/loki`)

## The defect

`ulimit -u` is RLIMIT_NPROC. It counts every process owned by the UID, not just
the descendants of the subshell that sets it. The harness capped at an absolute
`ulimit -u 400`.

Measured on this host:

    hard nproc (ulimit -Hu)      6000
    soft nproc (ulimit -Su)      4000
    kern.maxprocperuid           4000
    processes owned by this UID  447-455 across samples

The baseline exceeds the cap. The subshell could not fork its **first** child.
Every assertion in the test failed for want of a process, and not one of them was
about `loki`.

Pre-fix focused run on `7156d789` (RED, 4 passed / 3 failed, exit 1):

    FAIL: loki help --help exited 254; asking for help is not a failure
    FAIL: loki help --help printed only 0 lines -- it died instead of printing
    PASS: loki help --help did not exhaust the process cap        <-- see below
    FAIL: loki help verify printed nothing -- the fix broke real delegation

The product was never broken. Uncapped, on the unmodified `autonomy/loki`:

    bash autonomy/loki help --help   -> rc=0, 178 lines
    bash autonomy/loki help verify   -> rc=0,  90 lines

Both existing stops are present and correct at `autonomy/loki:19338`
(help-shaped target case) and `autonomy/loki:19346` (`LOKI_HELP_ONLY` re-entry
guard). This was a harness arithmetic defect, nothing more.

## The second defect, found while fixing the first

Look again at the pre-fix line marked above. `did not exhaust the process cap`
**PASSED** on a run that produced zero bytes.

Two causes, both fixed:

1. When the cap bites it is the **shell** that reports
   `fork: Resource temporarily unavailable`, not the command. That went to the
   harness's own stderr; the inner redirection only captured the command's.
   `$_out` stayed empty, so the grep was searching a file that could never
   contain what it was looking for. The subshell's own stderr now appends to
   `$out` (truncate once outside, append within).
2. A substring search over an empty file reports nothing wrong, which reads
   exactly like a clean run. The assertion now fails closed on `[ ! -s "$_out" ]`
   as an **absent measurement**. The same check was added to the `-h` / `help`
   spelling loop, which previously judged on exit code alone and so read a
   cap-blocked run as "terminates".

This is the repo's own documented failure mode (an empty result is not evidence;
it is an absent measurement) reproducing inside the very test written to guard
against it.

## The repair

Budget from the measured baseline, so the **headroom** is what stays fixed:

    _uid_procs() { ps -u "$(id -u)" 2>/dev/null | wc -l | tr -d ' '; }
    _PROC_BUDGET=150
    _CAP=$(( baseline + _PROC_BUDGET ))

Plus a pre-flight that refuses to proceed if the cap cannot be **set**. A cap we
failed to set is worse than no cap, because the subshell would then run the fork
bomb unbounded; `ulimit -u N 2>/dev/null` silently falls through on a container
with a low hard limit. The pre-flight is deliberately separate from
`_run_capped` so that function's exit status stays a clean signal about `loki`
and never about the harness failing to budget. It SKIPs (exit 0), it does not
fail, since an unsettable cap is an environment fact.

Nothing was weakened. Retained: a finite process budget, the 20s timeout,
fail-closed fork/timeout detection, the >=20-line real-output check, the
delegation anti-overfit check, and the post-run process-stability check.

## Evidence

Focused, 5 consecutive runs, all **7 passed / 0 failed / exit 0**:

    run 1: baseline 451 + 150 = cap 601   7/0
    run 2: baseline 451 + 150 = cap 601   7/0
    run 3: baseline 451 + 150 = cap 601   7/0
    run 4: baseline 455 + 150 = cap 605   7/0
    run 5: baseline 455 + 150 = cap 605   7/0

The baseline drifted 451->455 mid-sequence and the cap tracked it. That drift is
the exact thing the absolute 400 could not survive. No `/tmp/loki-helprec*`
residue after the sequence.

## Mutation probe

The probe that matters, because there are **two** independent stops: neutralizing
only the `:19338` case leaves the `LOKI_HELP_ONLY` guard at `:19346`, which halts
recursion at depth 1. The mutant would not bomb, the cap would never be
exercised, and "cap holds" would be a false green having tested nothing.

Both stops were neutralized, on a **copy** at `/tmp/loki-mut` (product runtime
never touched, no revert-failure risk). Neutralization was verified before
drawing any conclusion -- worth recording that the first attempt silently failed:
a `perl -0pi -e` substitution errored on the `${LOKI_HELP_ONLY:-}` interpolation
and left stop 2 intact. Had that gone unchecked it would have produced precisely
the false green described above. Redone in Python, then confirmed:
stop 1 neutralized = 1 occurrence, stop 2 originals remaining = 0.

Unmodified harness against the fully-neutralized mutant:

    FAIL: loki help --help TIMED OUT (rc=124) -- it is recursing
    FAIL: loki help --help printed only 4 lines -- it died instead of printing
    FAIL: loki help --help hit the process cap (budget 150) -- still forking
    FAIL: loki help -h TIMED OUT -- that spelling still recurses
    FAIL: loki help help TIMED OUT -- that spelling still recurses
    PASS: process count stable across the run (735 -> 735)
    2 passed / 5 failed, exit 1

Host user processes: 448 before, 450 after. Contained at ~150 deep against the
original incident's 3,788. The fork-exhaustion assertion fired for real -- under
the pre-fix harness that same assertion passed on an empty file.

Mutant removed (`rm -rf /tmp/loki-mut`).

## Residue and scope

Pre-existing dirty files left untouched exactly as found, none staged:
`coverage/clover.xml`, `coverage/lcov-report/index.html`,
`dashboard-ui/dist/loki-dashboard-standalone.html`, deleted `f.txt`,
untracked `benchmarks/results/prompt-ablation.jsonl`.

No dependency added. No product runtime change. No push, workflow, release,
deploy, credential, or spend action.

## Remaining steps, not done here

- **The full ~50-minute local gate has NOT been run** on this SHA, per the
  instruction to hold it. `bash scripts/local-ci.sh` is the release gate and is
  still outstanding. Nothing here claims gate-green.
- This is the **only** `ulimit` in `tests/`, `scripts/`, and `autonomy/` -- there
  is no shared process-budget helper to update, and nothing else inherits the
  bug. Flagged because "portable process budget" is the kind of pattern a future
  test copies from here; copy the relative form, not an absolute number.

## Risks

- `_PROC_BUDGET=150` is a judgement call. It is two orders of magnitude below the
  observed 3,788-process bomb and comfortably above what help needs, but it is
  not derived from a measurement of legitimate peak help usage. If a future
  `loki help` path legitimately forks >150 processes this goes red; the message
  names the budget, so the diagnosis is one line.
- Sample-then-spike: the baseline is sampled once, so a burst of >150 new UID
  processes between sampling and the run would red the test. The printed
  baseline line makes that diagnosable rather than mysterious.
- On a host near `kern.maxprocperuid`, `baseline + 150` may exceed the hard limit
  and the test SKIPs rather than running. That is intentional (better than an
  unbounded probe) but it does mean the guard is silently absent on such a host.
