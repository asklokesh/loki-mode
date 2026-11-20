# Calibration seed, 2026-11-20 (VERIFY-PLAN V1)

Loki's label on 8 merged upstream fixes (benchmarks/h2h/replay), each replayed four ways through the real engine on the stub CLI's apply mode. No model was called. Truth is the task's hidden tests; a run where they disagree with the change is invalid and not counted.

## How it was run

- Command: `TMPDIR=<run-owned scratch dir> bash benchmarks/h2h/run.sh --suite replay --configs loki-cal-merged,loki-cal-nofix,loki-cal-plant,loki-cal-inert --jobs 1 --timeout 1800 --keep --out benchmarks/h2h/results/calibration-seed-2026-11-20.json`
- Engine commit: `061145c7cbf322b1ec6100e2d832a0d0f8a75bcc` (citable: True)
- Start 1-minute load: { 2.16 2.54 2.97 }; one case at a time (`--jobs 1`), each started only at a 1-minute load of 12 or below (wait_for_load).
- Wall time: 674 s in all; per case below.
- No H2H_LOKI_ENV: the arm is the default engine, the same command the release gate asks for.

## Findings (read from the receipts' held_by)

- No false VERIFIED: none of the 24 bad changes (tests without the fix, the fix with a planted import break, an unused function with no tests) sealed VERIFIED. 23 of 24 got the expected label; the inert change on py-toolz-partition-len read FAILED, not PARTIAL, held by its failing full pytest suite (see the toolz finding below).
- Only 1 of 8 merged fixes sealed VERIFIED (go-semver-dirty-lte). The first finding, as the probe run showed before the seed: "verify not proven: tests ran on the system interpreter" holds 6 of the 8 merged fixes (every Python task). Each of these repos declares a project (pyproject.toml, read from the cached snapshots), so a pass on the system python3 is read as unproven. On 4 of them (boltons, both cachetools, more-itertools) it is the only hold.
- go-semver-four-part (merged) is held by "no fail-then-pass test" and "changed symbol not referenced: init"; py-parse-tz-groups (merged) by a test collection ImportError on the full suite, the system-interpreter line and "weakened test: tests/test_parse.py" (the maintainer's own test edit); py-toolz-partition-len (merged) reads FAILED on a correct fix. Measured afterwards (a rerun of that one case with --keep, and pytest on a copy of the base snapshot): the full suite is red on the base commit too (1 failed, 185 passed: toolz/tests/test_package.py::test_has_version, PackageNotFoundError, toolz is not installed as a package), and the same id fails on the fix. Verify excused the per-file check (pre_red) but not the full suite ("every failing id is red on base but the error text differs from base and a failure names a changed file or symbol") and listed it in introduced_checks, so it held the label at FAILED. V2 (observe) read the same record as introduced, agreeing with verify, so it wrote no entry: a false FAILED that no observe rule flags.
- No observe-mode rule wrote an entry on any run. V2 is the only one on by default with failing checks to read; on the one run checked afterwards (toolz merged) its failure_classes were introduced only. The others are off by default (V3, V5, V8, V4, V6, V11) or had nothing to fire on (V10: no checklist in these repos; R1 is enforce).
- Counting note: the JSON's good_holds and bad_holds count held_by entries (a run held twice by one kind counts twice), while table (b) counts runs (verify not proven: 7 entries on 6 merged runs).

## (a) Label accuracy

| config | expected | n (valid) | right | verifier_right | false VERIFIED | go-semver-dirty-lte | go-semver-four-part | py-boltons-research-tuples | py-cachetools-grow-evict | py-cachetools-ttl-overflow | py-moreit-value-chain | py-parse-tz-groups | py-toolz-partition-len |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| loki-cal-merged | VERIFIED | 8 | 1 | 1 | 0 | VERIFIED 10s | PARTIAL 10s | PARTIAL 8s | PARTIAL 27s | PARTIAL 21s | PARTIAL 34s | PARTIAL 6s | FAILED 9s |
| loki-cal-nofix | FAILED | 8 | 8 | 8 | 0 | FAILED 10s | FAILED 9s | FAILED 14s | FAILED 45s | FAILED 30s | FAILED 53s | FAILED 7s | FAILED 11s |
| loki-cal-plant | FAILED | 8 | 8 | 8 | 0 | FAILED 13s | FAILED 11s | FAILED 10s | FAILED 35s | FAILED 36s | FAILED 32s | FAILED 17s | FAILED 24s |
| loki-cal-inert | PARTIAL | 8 | 7 | 7 | 0 | PARTIAL 7s | PARTIAL 6s | PARTIAL 7s | PARTIAL 26s | PARTIAL 21s | PARTIAL 29s | PARTIAL 6s | FAILED 9s |
| all | | 32 | 24 | 24 | 0 |  |  |  |  |  |  |  |  |

Label accuracy: right 24/32 (75%), verifier_right 24/32 (75%), false VERIFIED 0.

Invalid runs (not counted):

- none

## (b) Every hold, by the changes it fired on

Counted once per run: fired on N of the 8 valid merged (good) runs and on M of the 24 valid nofix, plant and inert (bad) runs. A hold on a good run is a false positive. Stand-in kinds are holds only a real model session can clear (the stub cannot write a review or close an open note).

| held_by kind | good (merged) | bad (nofix, plant, inert) | stand-in |
|---|---|---|---|
| changed symbol not referenced | 2 | 17 |  |
| check fails | 1 | 17 |  |
| check not run | 1 | 1 |  |
| no agent-independent proof | 0 | 16 |  |
| no fail-then-pass test | 1 | 7 |  |
| open note | 0 | 6 | yes |
| verify not proven | 6 | 22 |  |
| weakened test | 1 | 2 |  |

## (c) Observe-mode rules

right_if_enforced_upper_bound reads the label the rule gave at its own step of the seal; later steps can only lower a label, so it is an upper bound, not a measurement of enforcing the rule.

| rule | fired | right now | right if enforced (upper bound) | false VERIFIED if enforced |
|---|---|---|---|---|
| (no observe-mode rule fired) | | | | |

## (d) r4_candidates (from calibration_stats)

none

## (e) R1: report only; the default stays enforce until the C2 rerun scores it

- `changed symbol not referenced` fired on 2 of 8 valid merged runs and on 17 of 24 valid nofix, plant and inert runs (nofix 1, plant 8, inert 8).
- It was the only hold outside the stand-in kinds on 0 merged run(s).
- Why the seed cannot decide the default: the receipt records every hold kind whatever the verdict, and no seed case has a base-red test broken another way or an untouched regression, so a zero false VERIFIED here says nothing about turning the hold off.

## (f) R4: holds that fire on good changes (report only; no default changes, nothing deleted)

R4 candidates (fired on at least 3 good runs and on no bad run), each needs the C2 rerun before any default change:

- none

Not decided (every other kind outside the stand-ins):

- `changed symbol not referenced`: good 2, bad 17; owner knob: LOKI_E10_LEAN_SYMBOL_HOLD (item 12)
- `check fails`: good 1, bad 17; owner knob: LOKI_E10_INTRODUCED (observe, column (c))
- `check not run`: good 1, bad 1
- `no agent-independent proof`: good 0, bad 16
- `no fail-then-pass test`: good 1, bad 7
- `verify not proven`: good 6, bad 22
- `weakened test`: good 1, bad 2

