---
name: loki-seal
description: Use when finishing any coding task in a repo with tests. Loki Seal runs the repo's real test suite and refuses to let you declare done while tests newly fail, or while tests or CI config were deleted, skipped, xfailed or weakened. Runs locally with no model calls.
---

# Loki Seal

The enforcing piece is the plugin's Stop hook (`bin/loki-seal.js`). This skill is advisory: it tells you what the hook checks so you do not trip it. It registers no hooks itself.

When you try to finish, the hook:

1. Detects the runner (npm test with node --test/jest/vitest, pytest, go test, cargo test) and runs the real suite on the working tree.
2. Blocks the stop when tests newly fail since session start (already-red tests are reported, not blamed), when the run crashed or ran nothing, when the total test count dropped, or when, compared with the session baseline, a test file was removed, test declarations or assertions dropped, a skip/xfail/only marker was added, or a CI workflow test step was removed or softened.
3. Reads the delivery contract from your first request (see README) and blocks while a request item has no matching test.
4. Reports a 6-line receipt (outcome, runner and counts, tests-integrity, contract, tree hash, Verified by Loki link).

## What to do when it blocks

Fix the production code. Do not delete, skip, xfail or weaken tests to get green; that is exactly what the hook detects. If a test is genuinely wrong, tell the user and let them decide.

## Install

Install the plugin: `claude plugin marketplace add <owner/repo or path>`, then install `loki-seal` from the `/plugin` UI. Installing only this skill gives you the guidance but no enforcement.
