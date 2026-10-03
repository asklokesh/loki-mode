# loki-seal

Your agent says done. Loki proves it.

loki-seal is a Claude Code Stop hook. When the agent tries to finish, it runs your repo's real test suite and refuses "done" if tests newly fail or if tests or CI config were deleted, skipped, xfailed or weakened. It runs inside your existing session: no model calls, no global CLI, no dangerous flags, no dependencies beyond node.

## Install

In Claude Code: `/plugin marketplace add asklokesh/loki-mode`, then `/plugin install loki-seal@loki-mode`. A local checkout also works: `/plugin marketplace add <path to a loki-mode checkout>`.

The plugin is the enforcing install: its `hooks/hooks.json` registers SessionStart and Stop. The skill (`skills/loki-seal/SKILL.md`) is advisory guidance only and registers no hooks, so a skill-only install does not enforce anything.

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
5. Delivery contract (`bin/contract.js`, no model calls, no network). It prefers under-deriving: when in doubt the receipt says "NOT VERIFIED: no contract" and the stop is allowed. The hook reads the first user message from `transcript_path`. Acceptance items are bullet or checkbox lines and sentences with must, shall, needs to, has to, have to, required or cannot (conversational should, make sure, never and ensure do not count; neither do pasted paths, git status or log lines, or requests that open with a question such as "explain ..."; chat about the speaker (I, we, you, my), deadlines and time, and environment or tooling talk is also ignored). The assertion scan ignores comments and string literals and accepts assert, expect, self.assert*, t.Error/Fatal, testify require./assert., pytest.raises and chai .should. An item needs at least 2 keywords. A local spec file is read only when the request marks it: "spec: docs/x.md", "per docs/x.md", "implement docs/x.md" or "according to docs/x.md" (inside the repo, max 5, never URLs); a bare mention such as "fix the typo in README.md" is not a spec. Each item is matched to tests by keyword overlap with test names (at least min(n,2) and ceil(n/2) of its n keywords), and the matched test body must contain an assertion. An item with no such test, or whose matched tests all fail now (exact test id, regardless of whether they were already red at session start; failing tests never count as covered), blocks with "NOT VERIFIED" naming the item. A missing or unreadable transcript is NOT VERIFIED with the reason, and the hook still exits cleanly. Contract blocks have their own release counter (`LOKI_SEAL_MAX_BLOCKS`; a repeated stop when there is no state) and never consume the integrity valve, so a later skipped or deleted test still blocks.

## Receipt

```
loki-seal: PASS
runner: npm test (node --test): 12 passed, 0 failed
tests-integrity: intact; baseline: session start
contract: 1 item(s), 1 covered by passing tests
tree: 9f2c41d07ab3e5c8
Verified by Loki https://github.com/asklokesh/loki-mode
```

## Limits

- Known limits of a text-scanning design: replacing real assertions with `assert.ok(true)` is not caught (the assertion count does not drop), and a model with shell access can forge the baseline state file under `${CLAUDE_PLUGIN_DATA}/state` (or `~/.loki-seal/state`) or edit the hook itself. The receipt's tree hash and your own diff review are the audit trail.
- A total test count below the session-start count blocks (catches an early `process.exit(0)` or a test script changed to run nothing); a non-zero exit with zero tests run blocks as a crash.
- On pass the receipt is printed as JSON `systemMessage`, because the hooks docs say plain Stop stdout goes only to the debug log.

- Failing tests are matched by name where the runner prints names (node:test, pytest -rf, go, cargo), otherwise by failing count.
- Test-count heuristics are line based; a test rewritten to be weaker without dropping assertions is not caught.
- Rust inline `#[test]` in src files is counted only under tests/.
- Blocking is exit code 2 with the reason on stderr. The check re-runs on every stop attempt, including when `stop_hook_active` is true. After 5 consecutive blocks (`LOKI_SEAL_MAX_BLOCKS`) it releases with "NOT VERIFIED (released after 5 blocks)" so a session is never trapped. Hook errors count toward the same valve through a separate per-session counter file in the temp dir, and unreadable directories outside test paths are skipped and noted on the receipt instead of erroring.
- Env: `LOKI_SEAL_TIMEOUT_MS` (default 270000, below the 300s hook timeout; the suite's process group is killed on timeout), `LOKI_SEAL_START_TIMEOUT_MS` (default 120000), `LOKI_SEAL_STATE_DIR`. State lives in `${CLAUDE_PLUGIN_DATA}/state` when set, else `~/.loki-seal/state` (mode 0700, must be owned by you and not a symlink; files older than 7 days are pruned).
- Fail closed: any internal error at Stop exits 2 with "loki-seal: NOT VERIFIED (hook error: ...)". Symlinked test files are recorded by target and never followed.

## Develop

```
bash test/run.sh
```
