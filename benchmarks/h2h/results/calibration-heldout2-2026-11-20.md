# Calibration held-out set 2, 2026-11-20 (VERIFY-PLAN V1)

Loki's label on 8 merged upstream fixes that no verifier change was tuned on (benchmarks/h2h/replay/hc2-*, chosen by the pre-registered rule in benchmarks/h2h/replay/HELDOUT-CAL-2.md), each replayed four ways through the real engine on the stub CLI's apply mode. No model was called. Truth is the task's hidden tests; a run where they disagree with the change is invalid and not counted.

## How it was run

- Command: `H2H_CAL_ENGINE=dist TMPDIR=<run-owned dir from loki_run_tmp_create> bash benchmarks/h2h/run.sh --suite hc2 --configs loki-cal-merged,loki-cal-nofix,loki-cal-plant,loki-cal-inert --jobs 1 --timeout 1800 --out benchmarks/h2h/results/calibration-heldout2-2026-11-20.json`. `--suite hc2` (added with the set) lists only the hc2- tasks; `--suite replay` now leaves them out.
- Engine: the built dist, loki-ts/dist/loki.js sha1 34e2d3d697a4a53e4e581799e0c0cec8c7775920, the same before and after the run. It holds the BUILD-REQUIRES pyproject rule (the new `dependencies\s*=\s*\[(.*)$` pattern; the old combined `optional-dependencies|requires)` pattern is absent), and loki-ts/ is unchanged from a6080b5d5 to the run's commit.
- Engine commit: `f96e2c9e33c9e352bce509b1455be55bdf59d922` (citable: True, 0 dirty paths).
- Start 1-minute load: { 1.93 1.76 1.93 }; end { 2.76 2.33 2.14 }; one case at a time (`--jobs 1`), each started only at a 1-minute load of 12 or below (wait_for_load never had to wait).
- Wall time: 304 s in all (21:53:21 to 21:58:25), 277 s summed over the 32 cases; per case below.
- No H2H_LOKI_ENV: the arm is the default engine.
- 32 runs, 0 harness errors, 0 invalid. Run once; nothing was rerun.

## Findings (read from the receipts' held_by)

- No false VERIFIED: none of the 24 bad changes sealed VERIFIED, and all 24 got the expected label (nofix 8/8 FAILED, plant 8/8 FAILED, inert 8/8 PARTIAL).
- 2 of 8 merged fixes sealed VERIFIED: hc2-go-humanize-si-nonfinite and hc2-go-xstrings-negative-rune. verifier_right adds hc2-go-uuid-v7-monotonic, held only by the stand-in "open note" (the post-implement probe wrote no usable cases for NewV7FromReader).
- Base-green and base-red merged runs, read apart (the plain full suite with no --ignore on each base snapshot, measured and recorded before the run): base-green 6 (the 3 Go tasks, annotated-types, async-timeout, bracex), VERIFIED 2 of 6; base-red 2 (python-rsa: tests/test_mypy.py needs mypy; tenacity: 4 test files need typeguard or tornado), VERIFIED 0 of 2. Both base-red runs are held by "check not run: full suite: pytest" and "runner could not load: collection error".
- "verify not proven: tests ran on the system interpreter" holds 4 of the 5 Python merged fixes, exactly the 4 that the engine's declaresPythonEnv reads as declaring an environment (python-rsa [tool.poetry], annotated-types [project] dependencies, async-timeout setup.py, requirements.txt and install_requires, tenacity setup.py and an empty `install_requires =`). It does not fire on bracex, the only one with nothing declared. On annotated-types and async-timeout every declared entry is version-marked and inactive on 3.14, and on tenacity install_requires is empty; only python-rsa has a dependency active on 3.14.
- bracex (merged, base-green, not flagged by the interpreter rule) is held by "no fail-then-pass test" ("test fails without the fix: no (warning: the Wall tests also pass on the old code)") and "changed symbol not referenced: ExpandBrace". Its fix's evidence is in the data files tests/brace-cases.txt and tests/brace-results.txt, read by test_bash_cases. annotated-types adds "check not run: pytest:annotated_types/test_cases.py" (its test cases live in the package). async-timeout adds "no agent-independent proof", "no fail-then-pass test" (detail "test fails without the fix: yes") and three "changed symbol not referenced" (_uncancel_task, Timeout, _on_timeout).
- No observe-mode rule wrote an entry on any run (0 observe entries).
- Counting note: the JSON's good_holds and bad_holds count held_by entries (a run held twice by one kind counts twice), while table (b) counts runs.

## (a) Label accuracy

| config | expected | n (valid) | right | verifier_right | false VERIFIED | hc2-go-humanize-si-nonfinite | hc2-go-uuid-v7-monotonic | hc2-go-xstrings-negative-rune | hc2-py-annotated-types-isdigit | hc2-py-async-timeout-uncancel | hc2-py-bracex-int64-span | hc2-py-rsa-encrypt-modulus | hc2-py-tenacity-ordinal-teens |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| loki-cal-merged | VERIFIED | 8 | 2 | 3 | 0 | VERIFIED 10s | PARTIAL 9s | VERIFIED 7s | PARTIAL 4s | PARTIAL 7s | PARTIAL 8s | PARTIAL 5s | PARTIAL 10s |
| loki-cal-nofix | FAILED | 8 | 8 | 8 | 0 | FAILED 7s | FAILED 7s | FAILED 8s | FAILED 5s | FAILED 10s | FAILED 11s | FAILED 6s | FAILED 9s |
| loki-cal-plant | FAILED | 8 | 8 | 8 | 0 | FAILED 19s | FAILED 13s | FAILED 13s | FAILED 9s | FAILED 8s | FAILED 11s | FAILED 13s | FAILED 16s |
| loki-cal-inert | PARTIAL | 8 | 8 | 8 | 0 | PARTIAL 6s | PARTIAL 6s | PARTIAL 6s | PARTIAL 4s | PARTIAL 5s | PARTIAL 7s | PARTIAL 6s | PARTIAL 10s |
| all | | 32 | 26 | 27 | 0 |  |  |  |  |  |  |  |  |

Label accuracy: right 26/32 (81%), verifier_right 27/32 (84%), false VERIFIED 0.

Invalid runs (not counted):

- none

## (b) Every hold, by the changes it fired on

Counted once per run: fired on N of the 8 valid merged (good) runs and on M of the 24 valid nofix, plant and inert (bad) runs. A hold on a good run is a false positive. Stand-in kinds are holds only a real model session can clear (the stub cannot write a review or close an open note).

| held_by kind | good (merged) | bad (nofix, plant, inert) | stand-in |
|---|---|---|---|
| changed symbol not referenced | 2 | 16 |  |
| check fails | 0 | 16 |  |
| check not run | 3 | 3 |  |
| no agent-independent proof | 1 | 16 |  |
| no fail-then-pass test | 2 | 8 |  |
| open note | 1 | 5 | yes |
| verify not proven | 4 | 19 |  |

## (c) Observe-mode rules

right_if_enforced_upper_bound reads the label the rule gave at its own step of the seal; later steps can only lower a label, so it is an upper bound, not a measurement of enforcing the rule.

| rule | fired | right now | right if enforced (upper bound) | false VERIFIED if enforced |
|---|---|---|---|---|
| (no observe-mode rule fired) | | | | |

## (d) r4_candidates (from calibration_stats)

none

## (e) R1: report only; the default stays enforce until the C2 rerun scores it

- `changed symbol not referenced` fired on 2 of 8 valid merged runs (async-timeout, bracex) and on 16 of 24 valid nofix, plant and inert runs (nofix 0, plant 8, inert 8).
- It was the only hold outside the stand-in kinds on 0 merged run(s): on bracex it comes with "no fail-then-pass test", on async-timeout with four other kinds.

## (f) R4: holds that fire on good changes (report only; no default changes, nothing deleted)

R4 candidates (fired on at least 3 good runs and on no bad run), each needs the C2 rerun before any default change:

- none

Not decided (every other kind outside the stand-ins):

- `changed symbol not referenced`: good 2, bad 16; owner knob: LOKI_E10_LEAN_SYMBOL_HOLD (item 12)
- `check fails`: good 0, bad 16; owner knob: LOKI_E10_INTRODUCED (observe, column (c))
- `check not run`: good 3, bad 3
- `no agent-independent proof`: good 1, bad 16
- `no fail-then-pass test`: good 2, bad 8
- `verify not proven`: good 4, bad 19
