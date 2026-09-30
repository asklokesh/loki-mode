# loki-seal submission drafts

DRAFTS ONLY. Nothing here has been posted, submitted or published. Every item below waits on the founder queue (public repo, license, CLA on the e2b PR, tagline veto). No agent counts and no percentages anywhere in this file. Replace REPO_URL once the public repo exists.

## 1. Anthropic plugin directory

Manifest: `.claude-plugin/plugin.json` and `.claude-plugin/marketplace.json` in this package (name `loki-seal`, version 0.1.0).

Entry text:

> **Loki Seal** - A Stop hook that refuses "done" while your tests are red or were deleted, skipped, xfailed or weakened. Detects your runner (npm test, pytest, go test, cargo test), runs the real suite, scans the diff and CI config against a session-start baseline, and prints a 5-line receipt. Runs locally: no model calls, no global CLI, no dangerous flags.

Category: testing. Install: `/plugin marketplace add REPO_URL` then `/plugin install loki-seal@loki-seal`.

## 2. awesome-claude-code

Section: Hooks (or Tooling, per maintainers).

> - [loki-seal](REPO_URL) - Stop hook that blocks the agent from finishing when tests are red, or when tests and CI config were deleted, skipped or weakened. Local, zero model cost, prints a verification receipt.

## 3. e2b awesome list (PR #1106, CLA pending)

> **loki-seal** - Verification hook for coding agents in sandboxes: runs the repo's real tests at the end of a session and rejects completion if tests were removed, skipped or weakened. Works in any sandbox with node and the repo's own test runner.

## 4. Skills registries (npx skills, skills directories)

`skills/loki-seal/SKILL.md` carries the frontmatter (name, description).

> loki-seal: tells the agent that finishing means a green, unweakened suite, and what to do when the Stop hook blocks. Pair with the plugin for the hook itself.

## 5. GitHub About

Description: `Claude Code Stop hook: your agent says done, Loki proves it. Blocks finishing on red or weakened tests. No model calls.`

Topics: `claude-code`, `claude-code-plugin`, `agent-skills`, `claude-skills`, `mcp`

## 6. Show HN draft

Title: `Show HN: A Claude Code hook that stops the agent from deleting the failing test`

Body (lead with demo/loki-seal.gif):

> [GIF: agent deletes a failing test, the hook blocks, the agent fixes the code, green]
>
> Coding agents under pressure to finish sometimes make red tests disappear: delete the test, add a skip, loosen an assertion, edit the CI step. loki-seal is a Stop hook that runs when the agent says it is done. It runs your real test suite and compares test files and CI config to a snapshot taken at session start. If tests are red, or any of those weakening moves happened, the stop is blocked with the reason, and the agent has to fix the code.
>
> It is a small node script with no dependencies and makes no model calls. It prints a 5-line receipt including a hash of the test tree.
>
> Known limits: line-based heuristics, not baseline-subtracting, and it only sees what the diff scan can see.
>
> | Harness | Stop hook support | Tested | Notes |
> |---|---|---|---|
> | Claude Code | yes | TABLE PLACEHOLDER | |
> | (other harnesses) | TABLE PLACEHOLDER | TABLE PLACEHOLDER | |
>
> Repo: REPO_URL. Feedback wanted on weakening patterns I am missing.

## 7. r/ClaudeAI draft

Title: `I made a Stop hook that blocks Claude Code from finishing when it deleted or skipped the failing test`

> [GIF first]
>
> It runs your real tests when Claude says done, and compares test files and CI config against the session start. Red suite, removed test, new skip or xfail, fewer assertions, or a softened CI test step: the stop is blocked and Claude is told to fix the code instead.
>
> No model calls, no extra cost, no dangerous flags, one node file. Install with `/plugin marketplace add REPO_URL`.
>
> Harness comparison: TABLE PLACEHOLDER. What weakening patterns should I add?
