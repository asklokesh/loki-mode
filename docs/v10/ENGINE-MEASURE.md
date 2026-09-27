# Loki 10 engine: measured stage times (2026-09-27)

Source: read-only measurement of four real runs from their own logs. Every
duration comes from a logged timestamp; rows marked (inferred) come from gaps
between logged events.

## Runs

| Run | Log directory | Wall time | Tasks completed |
|---|---|---|---|
| R1 augmentiq #52 "add a search bar" | /Users/lokesh/git/augmentiq/.loki/ | 73.7+ min, still running at 21:46:12Z | 0 (`orchestrator.json` tasksCompleted 0) |
| R2 anonima | /Users/lokesh/git/anonima/.loki/ (2026-09-12 14:15Z) | 20.5 min | 1 (reached COMPLETED although code review returned fail) |
| R3 lokimode-anthropic, empty PRD | /Users/lokesh/git/lokimode-anthropic/.loki/ (2026-09-12 01:16Z) | 6.0+ min, log stops mid provider call | 0 |
| R4 fizzbuzz toy | /Users/lokesh/loki-council-1789161950/.loki/ (2026-09-11 21:25Z) | 3.8 min | 1 |

## Where the minutes go (minutes, logged durations only)

| Stage | R1 augmentiq #52 | R2 anonima | R3 lokimode | R4 fizzbuzz |
|---|---|---|---|---|
| Boot, intake, spec interrogation, PRD parsing | 1.3 | 0.5 | 0.6 | 0.3 |
| Agent provider calls | 3.9 (iterations 1-2) + 57.7+ (iteration 3, still running) | 3.9 | 5.4+ (cut off) | 0.6 |
| Of which: agent running the full E2E suite inside iteration 3 | about 41 (17:05-17:46 EDT, inferred from log file times) | not measured | not measured | not measured |
| App runner / docker | 1.8 | 0 | 0 | 0 |
| Gates (static through LSP) plus unlabelled gaps | 2.7 | 0.1 | 0 | 0 |
| Code review | 0.6 | 4.4 | 0 | 0.8 |
| Doc generation | 5.0 (timed out at 300s) | 4.3 | 0 | 0 |
| Checklist, evidence gate, council | 0.6 (council never voted) | 7.2 | 0 | 1.8 |
| Total wall time | 73.7+ | 20.5 | 6.0+ | 3.8 |

Agent share of wall time where the run finished: R2 19% (234s of 1231s), R4
15% (35s of 228s). The rest is harness stages around the agent.

## R1 detail (augmentiq #52)

| Stage | Start (Z) | End (Z) | Duration | Evidence |
|---|---|---|---|---|
| Issue fetch + boot | 20:32:30 | 20:32:43 | 13s | issue-context.json captured_at 20:32:30 |
| Spec interrogation | 20:32:44 | 20:33:09 | 24s | 20 assumptions recorded |
| PRD to tasks, LLM enrichment, complexity | 20:33:09 | 20:33:48 | 39s (inferred) | "Enriched 3 PRD task(s) via LLM"; complexity "complex" (9584 files) |
| Iteration 1 provider call | 20:33:48 | 20:36:34 | 166s | agent found search already built; COMPLETION_REQUESTED |
| App runner + checkpoint | 20:36:34 | 20:37:48 | 74s | "docker: unknown command: docker compose" |
| Gates | 20:37:48 | 20:38:01 | 13s | test_suite not_run |
| LSP, semantic, invariant gates, review diff | 20:38:01 | 20:39:10 | 69s (inferred) | |
| Code review (6 reviewers) | 20:39:10 | 20:39:43 | 33s | 5 pass, 1 fail (non-blocking) |
| Auto-documentation | 20:39:43 | 20:44:43 | 300s | "Auto-documentation: timed out after 300s" |
| Wiki + evidence gate | 20:44:43 | 20:45:19 | 36s | evidence gate BLOCKED |
| Iteration 2 provider call | 20:45:22 | 20:46:31 | 69s | claimed done again |
| App runner restart | 20:46:31 | 20:47:07 | 36s | "crash limit reached (5)" |
| Gates + diff | 20:47:07 | 20:48:26 | 79s | |
| Code review | 20:48:26 | 20:48:26 | 0s | refused: context 431361 bytes over 400000 limit |
| Iteration 3 provider call | 20:48:29 | running at 21:46:12 | 57m43s+ | 340+ tool calls; full vitest, pytest (2847 passed), Playwright 639 tests (88 failures in unrelated specs) |

## Five proven causes of non-completion (R1)

1. The app runner's docker invocation fails ("docker: unknown command: docker compose", then "unknown shorthand flag: 'd' in -d") while the containers report healthy, so the evidence gate records app_boot_failed (metrics/trust-events.jsonl 20:45:21Z; app-runner/state.json crash_count 5).
2. A secret-leak match in the changed file SETUP.md blocks completion ("Evidence gate BLOCKED: a secret/credential was detected in the changed files").
3. The test gate finds no test runner ("no test runner detected, recording inconclusive"; tests_ok=inconclusive runner=none) while the agent's own runs show pytest 2847 passed and vitest 1552 passed.
4. Code review refuses a 431361-byte context (committed USAGE.md, TESTING.md, SETUP.md), and completion is then rejected "because code review is BLOCKED (Critical/High findings)" although no review ran.
5. Iteration 3 is one provider call with no time limit and no progress events: the last events.jsonl entry is 20:48:28Z iteration_start 3, and dashboard-state.json still shows iteration 0 and council total_votes 0 at 21:45:53Z. Inside it the agent drifted into the unrelated full E2E suite at 94-100% CPU and killed processes with pkill -f and kill -9.

Also: the feature already existed before the run (iteration 1: "The search feature already appears fully built across many prior commits"), and both iteration 1 and 2 completion claims were rejected by the gates.

## Design consequences for ENGINE.md

- No PRD generation, spec interrogation, doc generation or council on the fast path (R1: 7+ min before and around the agent; R2: 16 of 20.5 min).
- The implement session needs a wall cap and progress events; the run state must come from one event log, never a separate dashboard-state file that goes stale.
- Verification runs impacted tests only on the fast path; full suites, app boot and council move to async deep verify after the PR.
- Test runner detection must read the repo's real runners (pytest, vitest, npm scripts), or the gate says inconclusive while the suites pass.
- Review context must exclude generated docs, and a refused review must never be reported as a blocking finding.
