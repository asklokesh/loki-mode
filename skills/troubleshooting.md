# Troubleshooting

## Common Issues & Solutions

| Issue | Cause | Solution |
|-------|-------|----------|
| Agent stuck/no progress | Lost context | Read `.loki/CONTINUITY.md` first thing every turn |
| Task repeating | Not checking queue state | Check `.loki/queue/*.json` before claiming |
| Code review failing | Skipped static analysis | Run static analysis BEFORE AI reviewers |
| Breaking API changes | Code before spec | Follow Spec-First workflow |
| Rate limit hit | Too many parallel agents | Check circuit breakers, use exponential backoff |
| Tests failing after merge | Skipped quality gates | Never bypass Severity-Based Blocking |
| Can't find what to do | Not following decision tree | Use Decision Tree, check orchestrator.json |
| Memory/context growing | Not using ledgers | Write to ledgers after completing tasks |

---

## Red Flags - Never Do These

### Implementation Anti-Patterns
- **NEVER** skip code review between tasks
- **NEVER** proceed with unfixed Critical/High/Medium issues
- **NEVER** dispatch reviewers sequentially (always parallel - 3x faster)
- **NEVER** dispatch multiple implementation subagents in parallel WITHOUT worktree isolation
- **NEVER** implement without reading task requirements first

### Review Anti-Patterns
- **NEVER** use opus for reviews (always sonnet for balanced quality/cost)
- **NEVER** aggregate before all 3 reviewers complete
- **NEVER** skip re-review after fixes

### System Anti-Patterns
- **NEVER** delete .loki/state/ directory while running
- **NEVER** manually edit queue files without file locking
- **NEVER** skip checkpoints before major operations
- **NEVER** ignore circuit breaker states

### Always Do These
- **ALWAYS** launch all 3 reviewers in single message (3 Task calls)
- **ALWAYS** specify model: "sonnet" for each reviewer
- **ALWAYS** wait for all reviewers before aggregating
- **ALWAYS** fix Critical/High/Medium immediately
- **ALWAYS** re-run ALL 3 reviewers after fixes
- **ALWAYS** checkpoint state before spawning subagents

---

## Rationalization Tables

**Source:** Superpowers (obra) - 35K+ stars GitHub project

Agents rationalize failures to avoid acknowledging mistakes. This table provides explicit counters to common rationalizations.

### Common Agent Rationalizations

| Rationalization | Why It's Wrong | Required Action |
|-----------------|----------------|-----------------|
| "I'll refactor later" | Technical debt accumulates, later never comes | Refactor now or reduce scope |
| "This is just an edge case" | Edge cases are features users encounter | Handle edge case or document limitation |
| "The tests are flaky" | Flaky tests hide real bugs | Fix flaky test before proceeding |
| "It works on my machine" | Only CI environment matters | Must pass CI |
| "This is a temporary workaround" | Temporary becomes permanent | No workarounds without issue filed |
| "The spec is unclear" | Unclear spec = ask for clarification | Block until spec clarified |
| "This is out of scope" | Scope creep rationalization | Verify against `.loki/queue/` task definition |
| "We can optimize later" | Performance issues compound over time | Implement acceptable performance OR document as known limitation |
| "This is good enough" | Premature completion before verification | Run full test suite before claiming completion |
| "The error is benign" | Dismissing errors without investigation | Investigate error, document root cause |
| "I already verified this" | Claiming verification without evidence | Show command output or test results |
| "The documentation is outdated" | Dismissing doc conflicts without checking | Verify claim, update docs if true, follow docs if false |

### Red Flag Detection Patterns

Behaviors that indicate rationalization in progress:

**Hedging Language**
- "probably" - Replace with verified facts
- "should be fine" - Replace with test results
- "most likely" - Replace with confirmed behavior
- "I think" - Replace with verified knowledge

**Minimization Language**
- "just a small change" - All changes require verification
- "simple fix" - Complexity is determined by test results
- "minor update" - Impact is determined by CI, not assumption
- "quick tweak" - Speed claims require evidence

**Scope Changes Mid-Task**
- Expanding scope without explicit justification
- Reducing scope without documenting limitations
- Changing requirements interpretation silently
- Adding "nice to have" features not in spec

**Verification Skipping**
- Moving to next task without running tests
- Claiming success without evidence
- Dismissing failed checks as irrelevant
- "The other component handles this" - Verify integration, don't assume

**Unverified Claims**
- "I checked and it's fine" without showing output
- Referencing tests that were not actually run
- Claiming compatibility without testing
- Asserting behavior without demonstration

### Enforcement Protocol

When rationalization is detected:
1. **Stop** - Do not proceed with the rationalized action
2. **Identify** - Name the specific rationalization from the table
3. **Counter** - Apply the required action from the table
4. **Document** - Log the rationalization attempt in `.loki/memory/episodic/`

---

## Multi-Tiered Fallback System

### Model-Level Fallbacks
```
Primary (opus) fails -> Try sonnet -> Try haiku -> Escalate
```

### Workflow-Level Fallbacks
```
Complex approach fails -> Try simpler approach -> Try minimal approach -> Escalate
```

### Human Escalation Triggers
- Confidence score below 0.40
- 3+ consecutive failures on same task
- Security-critical decisions
- Irreversible operations without clear rollback

---

## Rate Limit Handling

```yaml
rate_limit_handling:
  detection:
    - HTTP 429 responses
    - "rate limit" in error message
    - Exponential backoff triggers

  strategy:
    initial_delay: 5s
    max_delay: 300s
    backoff_multiplier: 2
    max_retries: 5

  circuit_breaker:
    threshold: 3 failures in 60s
    cooldown: 300s
    state_file: ".loki/state/circuit-breakers.json"
```

### Circuit Breaker System

The circuit breaker prevents cascading failures by temporarily disabling operations that are repeatedly failing.

#### JSON Schema: `.loki/state/circuit-breakers.json`

```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "type": "object",
  "additionalProperties": {
    "type": "object",
    "required": ["state", "failure_count", "last_failure_time", "last_state_change"],
    "properties": {
      "state": {
        "type": "string",
        "enum": ["CLOSED", "OPEN", "HALF_OPEN"],
        "description": "Current circuit breaker state"
      },
      "failure_count": {
        "type": "integer",
        "minimum": 0,
        "description": "Number of failures in current window"
      },
      "success_count": {
        "type": "integer",
        "minimum": 0,
        "description": "Consecutive successes in HALF_OPEN state"
      },
      "last_failure_time": {
        "type": "string",
        "format": "date-time",
        "description": "ISO 8601 timestamp of last failure"
      },
      "last_state_change": {
        "type": "string",
        "format": "date-time",
        "description": "ISO 8601 timestamp of last state transition"
      },
      "cooldown_until": {
        "type": "string",
        "format": "date-time",
        "description": "ISO 8601 timestamp when OPEN state expires"
      },
      "failure_window_start": {
        "type": "string",
        "format": "date-time",
        "description": "Start of 60s failure counting window"
      }
    }
  }
}
```

#### Example File

```json
{
  "api/claude": {
    "state": "CLOSED",
    "failure_count": 0,
    "success_count": 0,
    "last_failure_time": null,
    "last_state_change": "2025-01-20T10:30:00Z",
    "cooldown_until": null,
    "failure_window_start": null
  },
  "api/openai": {
    "state": "OPEN",
    "failure_count": 3,
    "success_count": 0,
    "last_failure_time": "2025-01-20T10:35:42Z",
    "last_state_change": "2025-01-20T10:35:42Z",
    "cooldown_until": "2025-01-20T10:40:42Z",
    "failure_window_start": "2025-01-20T10:34:50Z"
  },
  "api/codex": {
    "state": "HALF_OPEN",
    "failure_count": 0,
    "success_count": 1,
    "last_failure_time": "2025-01-20T10:25:00Z",
    "last_state_change": "2025-01-20T10:30:00Z",
    "cooldown_until": null,
    "failure_window_start": null
  }
}
```

#### State Machine

```
                    +-----------+
                    |  CLOSED   |  <-- Normal operation
                    |           |      Requests flow through
                    +-----+-----+
                          |
                          | 3 failures within 60s
                          v
                    +-----------+
                    |   OPEN    |  <-- Circuit tripped
                    |           |      All requests BLOCKED
                    +-----+-----+
                          |
                          | After cooldown (300s)
                          v
                    +-----------+
                    | HALF_OPEN |  <-- Testing recovery
                    |           |      Limited requests allowed
                    +-----+-----+
                         /|\
                        / | \
           success(3)  /  |  \  any failure
                      v   |   v
              +-------+   |   +-------+
              |CLOSED |   |   | OPEN  |
              +-------+   |   +-------+
                          |
                     partial success
                     (stay in HALF_OPEN)
```

#### State Behaviors

| State | Behavior | Requests | Transitions |
|-------|----------|----------|-------------|
| **CLOSED** | Normal operation | All requests pass through | -> OPEN: 3+ failures in 60s window |
| **OPEN** | Circuit tripped | All requests immediately rejected with cached error | -> HALF_OPEN: After 300s cooldown expires |
| **HALF_OPEN** | Recovery testing | 1 request allowed per 10s interval | -> CLOSED: 3 consecutive successes |
| | | | -> OPEN: Any single failure |

#### State Transition Rules

**CLOSED -> OPEN**
- Trigger: `failure_count >= 3` within 60-second `failure_window`
- Action: Set `cooldown_until = now + 300s`
- Effect: All requests return immediately with last error

**OPEN -> HALF_OPEN**
- Trigger: `current_time >= cooldown_until`
- Action: Reset `failure_count = 0`, `success_count = 0`
- Effect: One probe request allowed through

**HALF_OPEN -> CLOSED**
- Trigger: `success_count >= 3` (consecutive)
- Action: Reset all counters, clear timestamps
- Effect: Resume normal operation

**HALF_OPEN -> OPEN**
- Trigger: Any single failure
- Action: Set new `cooldown_until = now + 300s`
- Effect: Back to blocking all requests

#### Recovery Protocol

When a circuit breaker is OPEN:

1. **Check State**
   ```bash
   cat .loki/state/circuit-breakers.json | jq '.["api/claude"]'
   ```

2. **Calculate Wait Time**
   ```bash
   # Check cooldown_until timestamp
   # Wait until: cooldown_until - current_time
   ```

3. **Reduce Load**
   - Reduce parallel agent count from 5 to 2
   - Disable non-critical background operations
   - Queue non-urgent requests

4. **Monitor HALF_OPEN**
   - Watch for probe request results
   - Do not send additional requests during probing

5. **Gradual Recovery**
   - After CLOSED state restored, gradually increase parallelism
   - Start at 50% capacity, increase by 25% every 60s
   - Monitor for new failures during ramp-up

6. **Log Recovery**
   ```bash
   echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) Circuit recovered: api/claude" >> .loki/logs/circuit-recovery.log
   ```

#### Configuration Tuning

| Parameter | Default | Description | When to Adjust |
|-----------|---------|-------------|----------------|
| `threshold` | 3 | Failures to trip circuit | Increase for flaky networks |
| `window` | 60s | Failure counting window | Increase for bursty errors |
| `cooldown` | 300s | OPEN state duration | Decrease if errors resolve quickly |
| `half_open_interval` | 10s | Time between probe requests | Increase for slow recovery APIs |
| `recovery_threshold` | 3 | Successes to close circuit | Increase for critical paths |

---

## Recovery Procedures

### Context Loss Recovery
1. Read `.loki/CONTINUITY.md`
2. Check `.loki/state/orchestrator.json` for current phase
3. Review `.loki/queue/in-progress.json` for interrupted tasks
4. Resume from last checkpoint

### Rate Limit Recovery
1. Check circuit breaker state
2. Wait for cooldown period
3. Reduce parallel agent count
4. Resume with exponential backoff

### Test Failure Recovery
1. Read test output carefully
2. Check if test is flaky vs real failure
3. Roll back to last passing commit if needed
4. Fix and re-run full test suite

---

## Dead Letter Queue

Tasks that fail repeatedly (5+ attempts) are moved to the dead-letter queue for structured handling. This prevents infinite retry loops while preserving failed task context for recovery or human review.

### Location

```
.loki/queue/dead-letter.json
```

### Schema

```json
{
  "tasks": [
    {
      "task_id": "task-uuid-here",
      "original_queue": "pending|in-progress",
      "failure_count": 5,
      "first_failure": "2026-01-25T10:00:00Z",
      "last_failure": "2026-01-25T14:30:00Z",
      "error_summary": "Brief description of the failure pattern",
      "attempts": [
        {
          "attempt_number": 1,
          "timestamp": "2026-01-25T10:00:00Z",
          "approach": "initial implementation",
          "error_type": "test_failure|timeout|dependency|validation",
          "error_message": "Full error text",
          "agent_id": "agent-that-attempted"
        }
      ],
      "recovery_strategy": "retry_with_simpler_approach|dependency_blocked|requires_human_review|permanent_abandon",
      "task_data": {
        "title": "Original task title",
        "description": "Original task description",
        "dependencies": [],
        "priority": "high|medium|low"
      }
    }
  ],
  "metadata": {
    "last_reviewed": "2026-01-25T08:00:00Z",
    "total_abandoned": 0,
    "total_recovered": 0
  }
}
```

### Processing Protocol

**Daily Review Schedule:**
1. At session start, check if `metadata.last_reviewed` is >24h old
2. If stale, process dead-letter queue before new work
3. Update `last_reviewed` timestamp after processing

**Review Process:**
```
For each task in dead-letter.json:
  1. Analyze failure pattern across all attempts
  2. Check if any retry conditions now apply
  3. Apply recovery strategy based on failure analysis
  4. Either: retry, escalate, or permanently abandon
```

### Retry Conditions

A dead-letter task can be retried when:

| Condition | Action |
|-----------|--------|
| Dependency now available | Move back to pending queue with `recovery_strategy: "dependency_resolved"` |
| New approach identified | Reset `failure_count` to 0, document new approach in attempts |
| Simpler scope defined | Create new task with reduced scope, link to original |
| Blocking bug fixed | Re-queue with reference to fix commit |

### Permanent Abandon Criteria

A task should be permanently abandoned when:

| Criteria | Justification |
|----------|---------------|
| 10+ total attempts | Diminishing returns, likely architectural issue |
| Same error across 3 different approaches | Fundamental blocker, not solvable with current tools |
| Dependency will never be available | External blocker with no workaround |
| Scope no longer relevant | Project direction changed |
| Human explicitly abandons | Documented decision to deprioritize |

When abandoning, move task to `.loki/queue/abandoned.json` with reason documented.

### Recovery Strategies

| Strategy | When to Use | Agent Action |
|----------|-------------|--------------|
| `retry_with_simpler_approach` | Complex implementation failed multiple times | Break into smaller subtasks, reduce scope, use simpler patterns |
| `dependency_blocked` | Task needs output from another task that failed | Wait for dependency resolution, check daily |
| `requires_human_review` | Security decision, unclear spec, or irreversible action | Log to `.loki/escalations/` and notify, do not retry |
| `permanent_abandon` | Met abandon criteria above | Move to `abandoned.json`, document reason, move on |

### Human Escalation Triggers

Automatically escalate to human review when:

1. **Security-critical task fails** - Any task touching auth, secrets, or permissions
2. **Data loss risk** - Task involves deletion or migration with failed rollback
3. **3+ tasks with same root cause** - Systemic issue requiring architectural review
4. **Confidence below 0.30** - Agent cannot determine correct recovery strategy
5. **External service dependency** - Requires API keys, credentials, or third-party action
6. **Spec ambiguity detected** - Multiple valid interpretations, need human decision

**Escalation Format:**
```
File: .loki/escalations/{timestamp}-{task_id}.md

## Escalation: {task_title}

**Task ID:** {task_id}
**Failure Count:** {count}
**Trigger:** {escalation_reason}

### Failure Summary
{error_summary}

### Attempts Log
{formatted attempts array}

### Agent Analysis
{what was tried and why it failed}

### Recommended Options
1. {option with tradeoffs}
2. {option with tradeoffs}

### Awaiting
Human decision on recovery path.
```

### Agent Workflow for Dead Letter Processing

```
1. READ dead-letter.json at session start

2. FOR each task:
   a. Analyze failure pattern across all attempts
   b. Check if any retry conditions now apply
   c. IF retry condition met:
      - Move task back to pending queue
      - Document recovery reason
      - Reset failure_count if new approach
   d. ELSE IF meets abandon criteria:
      - Move to abandoned.json
      - Document reason
   e. ELSE IF needs human:
      - Create escalation file
      - Leave in dead-letter queue with "requires_human_review" strategy
   f. ELSE:
      - Leave in queue for next review cycle

3. UPDATE metadata.last_reviewed

4. CONTINUE to normal task processing
```

---

## Signal Processing

Signals are inter-process communication files in `.loki/signals/` that trigger automated responses.

### DRIFT_DETECTED Signal

**Purpose:** Alerts when agent actions diverge from original task goal.

**Schema:**
```json
{
  "timestamp": "2026-01-25T10:30:00Z",
  "task_id": "task-042",
  "planned_action": "Implement user authentication",
  "detected_drift": "Started refactoring database schema instead",
  "severity": "medium",
  "agent": "eng-001-backend-api",
  "original_goal": "Add login endpoint per OpenAPI spec",
  "drift_distance": 2
}
```

**Fields:**
- `timestamp` - ISO 8601 timestamp of detection
- `task_id` - Current task from queue
- `planned_action` - What agent intended to do
- `detected_drift` - What agent started doing instead
- `severity` - low/medium/high/critical
- `agent` - Agent ID that detected drift
- `original_goal` - Goal from `.loki/queue/current-task.json`
- `drift_distance` - How many steps off-track (1=adjacent, 3+=severe)

**Processing Rules:**

| Condition | Action |
|-----------|--------|
| Any drift detected | Return to REASON phase immediately |
| 1 drift in task | Log warning, continue with corrected action |
| 2 drifts in same task | Escalate to orchestrator for task review |
| 3+ drifts accumulated | Escalate to orchestrator, consolidate state to CONTINUITY.md |
| High/Critical severity | Pause task, dispatch opus reviewer |

**Automated Responses:**
```yaml
immediate:
  - Stop current action
  - Log to .loki/signals/DRIFT_DETECTED (append-only log)
  - Return to REASON phase
  - Re-read .loki/queue/current-task.json

accumulated_threshold: 3
accumulated_action:
  - Consolidate working memory to CONTINUITY.md
  - Escalate to orchestrator for task review
  - Rely on provider-native context management (no explicit clear signal)
```

**How to Write:**
```bash
# Agent-side: append to drift log
cat >> .loki/signals/DRIFT_DETECTED << EOF
{"timestamp":"$(date -u +%Y-%m-%dT%H:%M:%SZ)","task_id":"task-042","severity":"medium","detected_drift":"description"}
EOF
```

---

### HUMAN_REVIEW_NEEDED Signal

**Purpose:** Escalate to human when autonomous action is inappropriate.

**Schema:**
```json
{
  "timestamp": "2026-01-25T10:30:00Z",
  "reason": "security_decision",
  "task_id": "task-099",
  "context": "Requires AWS production credentials",
  "severity": "critical",
  "agent": "eng-001-infra",
  "blocking": true,
  "alternatives_considered": [
    "Use staging credentials (rejected: insufficient for test)",
    "Mock credentials (rejected: integration test requires real auth)"
  ]
}
```

**When to Create:**
- Confidence score below 0.40 on critical decision
- Security-critical operations (production credentials, key rotation)
- Irreversible operations without clear rollback
- 3+ consecutive failures on same task
- Ambiguous requirements that block progress
- Cost decisions above threshold (cloud resources > $100/hour)

**Processing:**
```yaml
immediate:
  - Stop current task (do not proceed)
  - Log to .loki/signals/HUMAN_REVIEW_NEEDED
  - Move task to blocked state
  - Continue with other unblocked tasks if available

human_action_required:
  - Review signal file
  - Make decision
  - Either:
    - Create .loki/signals/HUMAN_APPROVED with decision
    - Update task with clarification
    - Cancel task

timeout: 24 hours
timeout_action:
  - Move task to dead letter queue
  - Alert via configured notification channel
```

**How to Create:**
```bash
cat > .loki/signals/HUMAN_REVIEW_NEEDED << EOF
{
  "timestamp": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "reason": "security_decision",
  "task_id": "task-099",
  "context": "Description of what needs review",
  "severity": "high",
  "blocking": true
}
EOF
```

---

### Healing Signals (v6.67.0)

These signals support legacy system healing workflows (see `skills/healing.md`):

| Signal | Purpose | Creates | Consumes |
|--------|---------|---------|----------|
| `FRICTION_DETECTED` | New friction point found during archaeology | Healing agent | Orchestrator |
| `BEHAVIOR_CHANGE_RISK` | Code change may alter legacy behavior | Code review | Healing agent |
| `INSTITUTIONAL_KNOWLEDGE_FOUND` | Tribal knowledge extracted from code | Archaeology scan | Knowledge registry |
| `HEALING_PHASE_COMPLETE` | Component completed a healing phase | Phase gate | Orchestrator |
| `LEGACY_COMPATIBILITY_RISK` | Breaking change to legacy API detected | Adapter verification | Healing agent |

**FRICTION_DETECTED Schema:**
```json
{
  "timestamp": "2026-01-25T10:30:00Z",
  "friction_id": "friction-042",
  "location": "src/billing/invoice.py:234",
  "behavior": "Sleep 2s before committing transaction",
  "classification": "unknown",
  "agent": "eng-001-healer"
}
```

**Processing Rules:**
- `FRICTION_DETECTED`: Add to friction-map.json, do NOT remove the friction until classified
- `BEHAVIOR_CHANGE_RISK`: Pause modification, verify characterization tests exist
- `INSTITUTIONAL_KNOWLEDGE_FOUND`: Append to institutional-knowledge.md
- `HEALING_PHASE_COMPLETE`: Run phase gate hook before advancing
- `LEGACY_COMPATIBILITY_RISK`: Block if in strict mode, warn otherwise

---

### Other Workflow Signals

These signals coordinate parallel worktrees (see `skills/parallel-workflows.md`):

| Signal | Purpose | Creates | Consumes |
|--------|---------|---------|----------|
| `FEATURE_READY_{name}` | Feature ready for testing | Feature stream | Testing stream |
| `TESTS_PASSED_{name}` | Tests green for feature | Testing stream | Merge stream |
| `TESTS_FAILED_{name}` | Tests failed for feature | Testing stream | Feature stream |
| `MERGE_REQUESTED_{branch}` | Request merge to main | Testing stream | Orchestrator |
| `DOCS_NEEDED` | Documentation required | Any stream | Docs stream |
| `BLOG_POST_QUEUED` | Significant change for blog | Docs stream | Blog stream |
| `PLAN_APPROVED` | Human approved plan (plan-first mode) | Human | Orchestrator |

---

### Signal Directory Structure

```
.loki/signals/
  DRIFT_DETECTED              # Append-only log (JSON lines)
  HUMAN_REVIEW_NEEDED         # JSON with review context
  HUMAN_APPROVED              # JSON with decision
  FEATURE_READY_auth          # Worktree signal
  FEATURE_READY_api           # Worktree signal
  TESTS_PASSED_auth           # Test result signal
  MERGE_REQUESTED_auth        # Merge request signal
  PLAN_APPROVED               # Plan mode approval
```

**Cleanup:** Signals are consumed (deleted) by their processing handler. Only `DRIFT_DETECTED` persists as an append-only log for audit purposes.