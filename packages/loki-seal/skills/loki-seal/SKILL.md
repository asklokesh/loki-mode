---
name: loki-seal
description: Use when finishing any coding task in a repo with tests. Loki Seal runs the repo's real test suite and refuses to let you declare done while tests are red, or while tests or CI config were deleted, skipped, xfailed or weakened. Runs locally with no model calls.
hooks:
  SessionStart:
    - hooks:
        - type: command
          command: node "${CLAUDE_SKILL_DIR}/../../bin/loki-seal.js" start
          timeout: 300
  Stop:
    - hooks:
        - type: command
          command: node "${CLAUDE_SKILL_DIR}/../../bin/loki-seal.js" stop
          timeout: 300
---

# Loki Seal

A Stop hook (`bin/loki-seal.js`) runs when you try to finish. It:

1. Detects the runner (npm test with node --test/jest/vitest, pytest, go test, cargo test) and runs the real suite on the working tree.
2. Blocks the stop when tests newly fail since session start (already-red tests are reported, not blamed), when zero tests ran, or when, compared with the session baseline, a test file was removed, test declarations or assertions dropped, a skip/xfail/only marker was added, or a CI workflow test step was removed or softened.
3. Prints a 5-line receipt (outcome, runner and counts, tests-integrity, tree hash, Verified by Loki link).

## What to do when it blocks

Fix the production code. Do not delete, skip, xfail or weaken tests to get green; that is exactly what the hook detects. If a test is genuinely wrong, tell the user and let them decide.

## Install

- Plugin (enforcing): `claude plugin marketplace add <owner/repo or path>`, then install `loki-seal` from the `/plugin` UI. Its hooks.json registers the hooks.
- Skill only: the frontmatter above declares the same hooks relative to the skill directory, which only resolves while the skill sits inside the package layout. A standalone skill copy is advisory.
