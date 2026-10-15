---
description: Run Loki's deterministic PR verification on the current change and summarize the evidence verdict.
argument-hint: "[--fast] [base-ref] (default: main; --fast defaults to HEAD, the uncommitted changes)"
allowed-tools: Bash(loki verify:*), Bash(command -v:*), Read
---

Run Loki's Autonomi Verify on the current working tree and report the verdict
with its evidence, not just an opinion in chat. The differentiator is the
auditable artifact: a verdict that refuses to silently pass on inconclusive
evidence.

Fast mode: if $ARGUMENTS starts with `--fast`, check `command -v loki` (stop if
missing) and run `loki verify --fast --diff-base <ref>` (ref defaults to
`HEAD`). It is deterministic, with no model or network call. Exit codes: 0 PASS,
1 FAIL, 3 INCONCLUSIVE. Print the verdict line and each finding as
`severity rule path:line`, say which findings block (severity high), and never
describe INCONCLUSIVE as a pass. Skip the steps below.

Steps:

1. Run the verifier against the base ref ($ARGUMENTS, or `main` if empty):

   ```
   loki verify $ARGUMENTS
   ```

   It computes the PR-style delta merge-base(base, HEAD)..HEAD and runs
   deterministic gates (build, tests, static analysis, secret scan, dependency
   audit, and spec drift when a spec lock exists). Exit codes:
   0 VERIFIED, 1 CONCERNS, 2 BLOCKED, 3 verifier error.

2. Read the evidence artifacts it wrote:
   - `.loki/verify/evidence.json` (machine-readable: schema, gates, findings)
   - `.loki/verify/report.md` (human verdict + findings table)

3. Summarize for the user:
   - The verdict (VERIFIED / CONCERNS / BLOCKED) and exit code.
   - Each gate and its status (pass / fail / inconclusive / skipped).
   - Every finding: severity, category, file:line, and whether it is blocking.
   - If the verdict is CONCERNS or BLOCKED, list exactly what to fix.

Be honest about inconclusive evidence: an inconclusive gate (for example a test
runner that could not run) is never upgraded to VERIFIED. If the diff is empty,
the verdict is CONCERNS (nothing to verify), not VERIFIED. Do not claim the
change is verified unless the evidence says VERIFIED.
