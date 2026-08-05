
## test-model-catalog-staleness.sh.wip (parked 2026-07-31)

Written by a build agent as a SPEC for a feature that was never implemented. It
asserts a `probe-model-catalog.py` script that does not exist, and expects
refresh wording ("never auto-applied") that no code emits.

Verified before parking: the two failures that looked like PRODUCT bugs are not.
`doctor --json` returns rc 0 with both a fresh and a deliberately stale catalog
(tested by rewriting `updated` to 2020-01-01), so the test's "exit code changed
0 -> 127" is its own harness dying, not the product.

The staleness WARNING itself is implemented and correct: it reports catalog age
and stays informational, never touching pass/warn/fail counts or the exit code.

Unpark when the refresh tool is actually built. Do not register a test that
asserts an unbuilt tool -- a red suite that everyone learns to ignore is worse
than a missing test.
