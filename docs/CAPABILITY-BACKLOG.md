# Capability Backlog

Generated 2026-08-03. Companion to `docs/COMPETITIVE-SCORECARD.md`.

Gaps are referenced by their number in that file's section 4 ("What we do NOT
know") and are not restated here. Ordering is by pillars unblocked per unit of
free work, where "free" means no paid model calls and no third-party installs.

Pillar numbers refer to the seven-pillar system in the scorecard's "How to read
this document" section.

## Priority order

| # | Item | Closes | Pillars | Free? | Measurement that closes it |
|---|---|---|---|---|---|
| 1 | Verification tax instrumentation | Gap 13 | 5, 7 | Yes | SHIPPED 2026-08-03, partial. `tools/verification-tax.py` + 14 tests. First reading: 19.0s wall, outcome changed 1/1. Remaining: token cost, and hit rate over real history |
| 2 | Confidence calibration audit | Gap 14 | 3, 5 | Yes | Reliability diagram of self-reported confidence against observed outcome, over existing run history |
| 3 | Provider parity measurement | Pillar 7 cell | 7 | No (paid) | Identical task across `--provider` values, scored on completion quality not flag presence |
| 4 | T0-T1 tier harness | Gaps 2, 11 | 1, 6 | No (paid) | Completion quality and intervention rate on single-file and multi-file tasks |
| 5 | T2-T4 architecture tiers | Gaps 2, 12 | 2, 3 | No (paid) | Same dimensions on migration, performance, and distributed-system tasks |
| 6 | T5 research tier | Gap 11 | 4 | No (paid) | Novelty and usefulness of a research result, needs a domain judge |

Items 3-6 require spend and are therefore not startable under the current
constraint. They are listed so the ordering is visible, not because they are
actionable now.

## Why item 1 is the slice

It is the only candidate that clears all four constraints: free, measurement
rather than new verification machinery, testable with one runnable check, and it
closes a numbered gap.

It is also a prerequisite rather than an end in itself. The mandated trajectory
for verification is toward near-zero overhead, applied selectively where
calibrated confidence is low. Neither "shrink the tax" nor "bypass it
selectively" can be validated as an improvement without a baseline for what the
tax currently costs and how often it earns its keep. Item 2 depends on item 1's
outcome-change data for the same reason.

Explicit non-goal: this must not become another gate, another artifact format, or
another blocking check. If the implementation starts adding verification
machinery rather than measuring the machinery that exists, it has failed its own
filter and should be stopped.

## Deliberately not on this list

- Any new gate, reviewer, council, or evidence format. The founder constraint is
  to avoid building more verification machinery unless it directly unlocks
  broader capability. Items 1 and 2 measure existing machinery so it can be made
  cheaper or skipped; neither adds any.
- Marketing-facing comparison content. The scorecard is an evidence ledger and
  two thirds of it is UNKNOWN; it is not ready to be a positioning asset and
  should not be turned into one.
