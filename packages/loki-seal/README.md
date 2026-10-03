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
5. Delivery contract (`bin/contract.js`, no model calls, no network). It prefers under-deriving: when in doubt the receipt says "NOT VERIFIED: no contract" and the stop is allowed. The hook reads the first user message from `transcript_path`. Acceptance items are bullet or checkbox lines and sentences with must, shall, needs to, has to, have to, required or cannot (conversational should, make sure, never and ensure do not count; neither do pasted paths, git status or log lines, or requests that open with a question such as "explain ..."; a sentence that opens with I, I'm, I've, I'll, I'd, we, we're, we've, we'll, let me or let's, a tool version note such as "Node 20 is required" and a status such as "needs to be done" is ignored as chat, and each such filtered sentence is listed in the contract line as "filtered as chat: N sentence(s)" so a real promise is never dropped silently). Sentences that open with You, Our, My or Please are not filtered: a modal sentence among them is a requirement item. The assertion scan ignores line comments, block comments (including multi-line), Python docstrings and triple-quoted strings, string literals, multi-line template literals and regex literals (a quote or comment marker inside a regex does not open a string or comment), and accepts assert, expect, self.assert*, t.Error/Fatal, testify require./assert., pytest.raises and chai .should. An item needs at least 2 keywords. A local spec file is read only when the request marks it: "spec: docs/x.md", "per docs/x.md", "implement docs/x.md" or "according to docs/x.md" (inside the repo, max 5, never URLs); a bare mention such as "fix the typo in README.md" is not a spec. Each item is matched to tests by keyword overlap with test names (at least min(n,2) and ceil(n/2) of its n keywords), and the matched test body must contain an assertion token somewhere in its text (a text scan, not proof the assertion runs; see Known limits). Coverage requires a runner-reported pass: a matched test counts only when its id appears among the tests the runner reported as passed (node:test TAP or spec `ok` and check-mark lines, pytest `PASSED` via `-rA`, go `--- PASS:`, cargo `... ok`, jest/vitest check-mark lines when the runner prints them). A test in a file the runner never ran, or skipped by any mechanism (a skip marker, ctx.skip(), a class-level or module-level pytest or unittest skip, a skip passed through an options variable, describe.skip), is not listed as passed and so never counts, whether the skip is new or already existed; if the runner's output does not list test names (for example jest without --verbose over several files) the item is NOT VERIFIED rather than assumed covered. Static skip detection (skip, it.skip, describe.skip, xit, test.todo, pytest skip markers, t.Skip, #[ignore]) still drops such tests from matching earlier. An item with no such test, or with ANY matched test failing now (exact test id, regardless of whether it was already red at session start; failing tests never count as covered, so a request item whose tests fail now always blocks), blocks with "NOT VERIFIED" naming the item. A missing or unreadable transcript is NOT VERIFIED with the reason, and the hook still exits cleanly. Contract blocks have their own release counter (`LOKI_SEAL_MAX_BLOCKS`; a repeated stop when there is no state) and never consume the integrity valve, so a later skipped or deleted test still blocks.

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

- Coverage limits of the delivery contract (a text scan plus runner output, not execution analysis):
  - A matched test with an empty body, or an early return before its assertion, still counts as covering, because the scan only looks for an assertion token in the body.
  - An assertion that lives only in a helper declared after the test still counts.
  - Tests with the same name, or keyword matches, in different files collide: a passing test in one file can cover a target in a file the runner never runs.
  - A test that prints lines in the runner's own format (for example "ok 99 - name", "PASSED tests/x.py::test_y", "--- PASS: TestX") can forge a pass, because coverage is read from the combined runner output. This is the same class as forging the baseline state file. What is caught: pass lines that contradict the runner's own summary give NOT VERIFIED (BLOCKED for TAP, which is exact: describe() suites are dropped by their `type: 'suite'` block, t.test() parents are kept, and more passing lines than the summary counts is a contradiction). The node:test spec reporter (the default in a terminal) cannot be reconciled exactly, because a suite and a parent test print the same lines. So the spec path fails closed: coverage is granted from spec output only when it has no ambiguous shape (empty names, a # directive after the duration such as todo, failing or cross-mark lines that differ from the summary fail count, pass lines in another shape, a todo or cancelled count, an unattributable suite count) and the check lines minus the attributable suites equal the summary pass count exactly. Otherwise no coverage is granted and the result is NOT VERIFIED, which can also happen for an honest run that uses todo tests or a failing describe(); run with `--test-reporter=tap` to avoid it. A result-mark line that does not fully parse, or that contains a carriage return (including a trailing one), U+2028, U+2029 or another control character, is also ambiguous (NOT VERIFIED, never BLOCKED), so a line separator in a name cannot hide a line. A line that has a result mark anywhere other than first after its indent (for example a test writing a character with no newline before the runner prints its own line, giving `X✔ name`) is ambiguous too, for pass and fail marks alike, so it cannot push a real result line out of the count. A runner summary key (`tests`, `suites`, `pass`, `fail`, `cancelled`, `skipped`, `todo` or `duration_ms` after a `ℹ` or `#`) anywhere other than at the start of its line is ambiguous too (an unterminated write moves the real summary off the line start so a forged block would be the only one seen), for spec and TAP alike. Only the last summary block is used for the cross-check and for the receipt counts; it must be complete and end the output (a failing run may list failures after it), and output with more than one summary block is NOT VERIFIED. Output beyond the 64 MiB capture limit is treated as truncated and gives NOT VERIFIED, because the real summary may have been dropped. Not caught: a child that writes forged runner-protocol messages (for example the runner's own IPC channel), and a forged complete summary printed after the runner finished (for example from a detached process); `go test`, which prints no count summary, so forged "--- PASS:" lines are never cross-checked; any runner with no summary line; pytest, cargo and jest are checked only against their "N passed" text, which a test can also print.
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
