# loki-seal

Your agent says done. Loki proves it.

loki-seal is a Claude Code Stop hook. When the agent tries to finish, it runs your repo's real test suite and refuses "done" if tests are red or if tests or CI config were deleted, skipped, xfailed or weakened. It runs inside your existing session: no model calls, no global CLI, no dangerous flags, no dependencies beyond node.

## Install

```
/plugin marketplace add asklokesh/loki-mode
/plugin install loki-seal@loki-seal
```

Skill text only (no hook): `npx skills add asklokesh/loki-mode`.

Nothing is published yet; these are the intended commands. Until then, point `/plugin marketplace add` at a local checkout of `packages/loki-seal`.

## What it checks

1. Runner detection: `npm test` (node --test, jest, vitest), `pytest`, `go test ./...`, `cargo test`. The suite runs on the current working tree.
2. Red suite, or a suite that ran zero tests, blocks.
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
tests-integrity: intact (baseline: session start)
tree: 9f2c41d07ab3e5c8
Verified by Loki https://github.com/asklokesh/loki-mode
```

## Limits

- Not baseline-subtracting: a suite that was already red before the session blocks too.
- Test-count heuristics are line based; a test rewritten to be weaker without dropping assertions is not caught.
- Rust inline `#[test]` in src files is counted only under tests/.
- After 5 consecutive blocks the hook releases with "NOT VERIFIED" so a session is never trapped.
- Env: `LOKI_SEAL_TIMEOUT_MS` (default 600000), `LOKI_SEAL_STATE_DIR`.

## Develop

```
bash test/run.sh
```
