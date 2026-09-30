# loki-seal

Your agent says done. Loki proves it.

loki-seal is a Claude Code Stop hook. When the agent tries to finish, it runs your repo's real test suite and refuses "done" if tests are red or if tests or CI config were deleted, skipped, xfailed or weakened. It runs inside your existing session: no model calls, no global CLI, no dangerous flags, no dependencies beyond node.

## Install

From a terminal: `claude plugin marketplace add <owner/repo or local path>`, then open `/plugin` in Claude Code and install `loki-seal` from that marketplace (the `/plugin` UI is the documented install path). A local checkout of `packages/loki-seal` works as the path until anything is published.

The plugin is the enforcing install: its `hooks/hooks.json` registers SessionStart and Stop. The skill (`skills/loki-seal/SKILL.md`) also declares the same hooks in its frontmatter, resolved relative to the skill directory (`${CLAUDE_SKILL_DIR}/../../bin/loki-seal.js`). That only works when the skill stays inside this package layout; a skill copied on its own (for example by a skills registry) has no script beside it, so treat that path as advisory. Do not enable both at once, or the suite runs twice per stop.

## What it checks

1. Runner detection: `npm test` (node --test, jest, vitest), `pytest`, `go test ./...`, `cargo test`. The suite runs on the current working tree.
2. A new failing test blocks; so does a suite that ran zero tests. The suite is run once at SessionStart and only failures that are new since then block (baseline-subtract); tests already red are reported, not blamed. If the start run could not happen, every red blocks.
3. Weakening scan against a snapshot taken at session start (git HEAD if the hook missed SessionStart):
   - removed test file
   - fewer test declarations in a file (removed test functions)
   - fewer assertions in a file
   - new `.skip`, `.only`, `.todo`, `xit`, `xtest`, `skip: true`, `@pytest.mark.skip/skipif/xfail`, `pytest.skip/xfail`, `@unittest.skip`, `t.Skip`, `#[ignore]`
   - CI config (GitHub workflows, GitLab, CircleCI, Azure, Jenkinsfile) deleted, test/check lines removed, or softened with `continue-on-error: true`, `|| true`, `if: false`
4. A tree hash over all test files is printed in every receipt.

## Receipt

```
loki-seal: PASS
runner: npm test (node --test): 12 passed, 0 failed
tests-integrity: intact; baseline: session start
tree: 9f2c41d07ab3e5c8
Verified by Loki https://github.com/asklokesh/loki-mode
```

## Limits

- Failing tests are matched by name where the runner prints names (node:test, pytest -rf, go, cargo), otherwise by failing count.
- Test-count heuristics are line based; a test rewritten to be weaker without dropping assertions is not caught.
- Rust inline `#[test]` in src files is counted only under tests/.
- Blocking is exit code 2 with the reason on stderr. The check re-runs on every stop attempt, including when `stop_hook_active` is true. After 5 consecutive blocks (`LOKI_SEAL_MAX_BLOCKS`) it releases with "NOT VERIFIED (released after 5 blocks)" so a session is never trapped.
- Env: `LOKI_SEAL_TIMEOUT_MS` (default 300000), `LOKI_SEAL_START_TIMEOUT_MS` (default 120000), `LOKI_SEAL_STATE_DIR`.

## Develop

```
bash test/run.sh
```
