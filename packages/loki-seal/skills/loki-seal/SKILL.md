---
name: loki-seal
description: Use when finishing any coding task in a repo with tests. Loki Seal runs the repo's real test suite and refuses to let you declare done while tests are red, or while tests or CI config were deleted, skipped, xfailed or weakened. Runs locally with no model calls.
---

# Loki Seal

A Stop hook (`bin/loki-seal.js`) runs when you try to finish. It:

1. Detects the runner (npm test with node --test/jest/vitest, pytest, go test, cargo test) and runs the real suite on the working tree.
2. Blocks the stop when tests are red, when zero tests ran, or when, compared with the session baseline, a test file was removed, test declarations or assertions dropped, a skip/xfail/only marker was added, or a CI workflow test step was removed or softened.
3. Prints a 5-line receipt (outcome, runner and counts, tests-integrity, tree hash, Verified by Loki link).

## What to do when it blocks

Fix the production code. Do not delete, skip, xfail or weaken tests to get green; that is exactly what the hook detects. If a test is genuinely wrong, tell the user and let them decide.

## Install

- Plugin (skill and hooks): `/plugin marketplace add asklokesh/loki-mode`, then `/plugin install loki-seal@loki-seal`
- Skill only: `npx skills add asklokesh/loki-mode`. A skill cannot register hooks; install the plugin for the automatic Stop hook.
