# Module 5: Troubleshooting

## Overview

This module covers diagnosing and resolving common issues in Loki Mode: gate failures, session conflicts, circuit breakers, dead-letter queue processing, signal handling, and recovery procedures. The primary reference is `skills/troubleshooting.md`.

## Common Issues

| Issue | Cause | Solution |
|-------|-------|----------|
| Agent stuck / no progress | Lost context | Read `.loki/CONTINUITY.md` at session start |
| Task repeating | Not checking queue state | Check `.loki/queue/*.json` before claiming |
| Code review failing | Skipped static analysis | Run static analysis BEFORE AI reviewers |
| Tests failing after merge | Skipped quality gates | Never bypass severity-based blocking |
| Rate limit hit | Too many parallel agents | Check circuit breakers, use exponential backoff |
| Cannot find what to do | Not following RARV cycle | Check `orchestrator.json`, follow decision tree |

## Quality Gate Failures

When a quality gate fails, identify which gate triggered the failure (the 8-gate
system is detailed in `skills/quality-gates.md`):

**Gates 1-2 (Static analysis and test suite):**
- Gate 1 (Static Analysis): fix CodeQL/ESLint/Pylint/type-checker findings
- Gate 2 (Test Suite): the test runner must pass; red blocks. Coverage % is not
  measured this release. Fix failing tests before proceeding (never delete or
  skip tests)

**Gates 3-4 (Review gates):**
- Check the review output for severity levels
- Critical/High = BLOCK; Medium/Low advisory (recommended to fix)
- Low/Cosmetic = TODO (informational)
- If all 3 reviewers pass unanimously, Gate 4 runs Devil's Advocate

**Gate 5 (Mock integrity detector):**
- Runs `tests/detect-mock-problems.sh`
- Flags tests that mock internal modules instead of using real code
- Flags tautological assertions and high internal mock ratios
- Disable with `LOKI_GATE_MOCK=false` (not recommended)

**Gate 6 (Test mutation detector):**
- Runs `tests/detect-test-mutations.sh`
- Detects assertion values changed alongside implementation (test fitting)
- Detects low assertion density
- Disable with `LOKI_GATE_MUTATION=false` (not recommended)

**Gate 7 (Documentation coverage):**
- Checks README presence, docs freshness within 10 commits, and API docs for packages
- Disable with `LOKI_GATE_DOC_COVERAGE=false` (not recommended for packages)

**Gate 8 (Magic Modules debate):**
- Runs the spec-vs-implementation debate on generated Magic Modules
- BLOCK-severity findings block; disable with `LOKI_GATE_MAGIC_DEBATE=false`

## Circuit Breaker System

The circuit breaker prevents cascading failures when API providers are unavailable. State is tracked in `.loki/state/circuit-breakers.json`.

### States

| State | Behavior | Transitions |
|-------|----------|-------------|
| **CLOSED** | Normal operation, all requests pass | -> OPEN after 3 failures in 60s |
| **OPEN** | All requests blocked | -> HALF_OPEN after 300s cooldown |
| **HALF_OPEN** | Limited probe requests | -> CLOSED after 3 successes; -> OPEN on any failure |

### Inspecting Circuit Breaker State

```bash
cat .loki/state/circuit-breakers.json | jq .
```

Example output:

```json
{
  "api/claude": {
    "state": "CLOSED",
    "failure_count": 0,
    "last_failure_time": null,
    "cooldown_until": null
  },
  "api/openai": {
    "state": "OPEN",
    "failure_count": 3,
    "last_failure_time": "2025-01-20T10:35:42Z",
    "cooldown_until": "2025-01-20T10:40:42Z"
  }
}
```

### Recovery Protocol

When a circuit breaker is OPEN:
1. Check the `cooldown_until` timestamp
2. Reduce parallel agent count (e.g., from 10 to 2)
3. Disable non-critical background operations
4. Wait for HALF_OPEN state
5. Monitor probe request results
6. After CLOSED state is restored, gradually increase parallelism

## Dead-Letter Queue

Tasks that fail 5+ times are moved to `.loki/queue/dead-letter.json`. This prevents infinite retry loops.

### Inspecting the Dead-Letter Queue

```bash
cat .loki/queue/dead-letter.json | jq '.tasks | length'    # Count failed tasks
cat .loki/queue/dead-letter.json | jq '.tasks[0]'          # View first failed task
```

### Recovery Strategies

| Strategy | When to Use |
|----------|-------------|
| `retry_with_simpler_approach` | Complex implementation failed multiple times |
| `dependency_blocked` | Task needs output from another failed task |
| `requires_human_review` | Security decision, unclear spec, or irreversible action |
| `permanent_abandon` | 10+ attempts, or same error across 3 different approaches |

### Retry Conditions

A dead-letter task can be retried when:
- A dependency that was blocking it is now available
- A new approach has been identified
- A simpler scope has been defined
- A blocking bug has been fixed

### Permanent Abandon Criteria

Move to `.loki/queue/abandoned.json` when:
- 10+ total attempts across all strategies
- Same error with 3 different approaches
- Dependency will never be available
- Scope is no longer relevant

## Signal Processing

Signals in `.loki/signals/` are inter-process communication files. Key signals:

### PAUSE and STOP

```bash
# Pause after current iteration
touch .loki/PAUSE

# Stop immediately
touch .loki/STOP
```

Or use CLI commands:

```bash
loki pause
loki stop
```

### DRIFT_DETECTED

Recorded when an agent's actions diverge from the task goal. The file is append-only (JSON lines format).

```json
{
  "timestamp": "2026-01-25T10:30:00Z",
  "task_id": "task-042",
  "severity": "medium",
  "detected_drift": "Started refactoring database schema instead of implementing auth"
}
```

Processing rules:
- 1 drift: Log warning, continue with correction
- 2 drifts on same task: Escalate to orchestrator
- 3+ accumulated drifts: Trigger context clear and full state reload

### CONTEXT_CLEAR_REQUESTED

Created when the context window becomes heavy. Can be triggered by:
- Agent self-assessment ("context feels heavy")
- After 25+ iterations
- 3+ accumulated DRIFT_DETECTED events
- Same error occurring 3+ times

The wrapper (`run.sh`) handles this by starting a fresh session with injected state from `.loki/CONTINUITY.md`.

### HUMAN_REVIEW_NEEDED

Created when autonomous action is inappropriate:
- Confidence below 0.40 on a critical decision
- Security-critical operations
- Irreversible operations without rollback
- 3+ consecutive failures on the same task

The task is blocked until a human provides input.

## Rationalization Detection

Agents can rationalize failures to avoid acknowledging mistakes. Common patterns to watch for:

| Rationalization | Required Action |
|-----------------|-----------------|
| "I'll refactor later" | Refactor now or reduce scope |
| "This is just an edge case" | Handle the edge case |
| "The tests are flaky" | Fix the flaky test first |
| "It works on my machine" | Must pass in CI |
| "This is good enough" | Run full test suite before claiming completion |

**Red flag language patterns:**
- Hedging: "probably", "should be fine", "most likely"
- Minimization: "just a small change", "simple fix", "minor update"
- Verification skipping: Moving to next task without running tests

When rationalization is detected: stop, identify the specific rationalization, apply the required action, and log the attempt to `.loki/memory/episodic/`.

## Recovery Procedures

### Context Loss Recovery

1. Read `.loki/CONTINUITY.md` for current state
2. Check `.loki/state/orchestrator.json` for current phase
3. Review `.loki/queue/in-progress.json` for interrupted tasks
4. Resume from last checkpoint

### Rate Limit Recovery

1. Check circuit breaker state in `.loki/state/circuit-breakers.json`
2. Wait for cooldown period to expire
3. Reduce `LOKI_MAX_PARALLEL_AGENTS`
4. Resume with exponential backoff (base: 5s, max: 300s, multiplier: 2)

### Test Failure Recovery

1. Read test output carefully
2. Determine if the test is flaky or a real failure
3. Roll back to last passing commit if needed (`loki checkpoint` can help)
4. Fix the code (never the test) and re-run the full suite

### Session Reset

If the session state becomes corrupted:

```bash
loki reset all        # Reset all session state
loki reset retries    # Reset retry counters only
loki reset failed     # Reset failed task status only
```

## Debugging Tools

### Logs

```bash
loki logs             # Show recent log output
loki status           # Show current session status
loki status --json    # Machine-readable status
```

### Audit Trail

```bash
loki audit            # View recent agent actions
```

### State Inspection

```bash
cat .loki/state/orchestrator.json | jq .    # Current phase and progress
cat .loki/queue/pending.json | jq .         # Pending tasks
cat .loki/queue/dead-letter.json | jq .     # Failed tasks
cat .loki/state/circuit-breakers.json | jq . # API health
```

## Summary

Troubleshooting Loki Mode involves inspecting the `.loki/` directory state: orchestrator phase, task queues, circuit breakers, signals, and memory. The circuit breaker system prevents cascading API failures. The dead-letter queue captures persistently failing tasks. Signals coordinate between processes. Rationalization detection helps identify when agents are avoiding real problems. Recovery procedures exist for context loss, rate limits, test failures, and corrupted state.
