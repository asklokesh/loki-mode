# Module 5 Lab: Diagnose and Troubleshoot

## Objective

Practice inspecting Loki Mode state files, interpreting circuit breaker status, examining the dead-letter queue, and using recovery procedures.

## Prerequisites

- Loki Mode installed (`npm install -g loki-mode`)
- `jq` installed for JSON inspection
- Familiarity with the `.loki/` directory structure (Module 1)

## Step 1: Create a Simulated `.loki/` State

Create a mock `.loki/` directory with sample state files to practice inspection:

```bash
mkdir -p /tmp/troubleshoot-lab && cd /tmp/troubleshoot-lab
git init

# Create the .loki directory structure
mkdir -p .loki/{state,queue,signals,memory/episodic,memory/semantic,logs}
```

Create a sample orchestrator state:

```bash
cat > .loki/state/orchestrator.json << 'EOF'
{
  "currentPhase": "DEVELOPMENT",
  "tasksCompleted": 12,
  "tasksFailed": 3,
  "totalTasks": 20,
  "startedAt": "2026-02-20T10:00:00Z",
  "lastUpdated": "2026-02-20T14:30:00Z"
}
EOF
```

Create a sample circuit breaker file:

```bash
cat > .loki/state/circuit-breakers.json << 'EOF'
{
  "api/claude": {
    "state": "CLOSED",
    "failure_count": 0,
    "success_count": 0,
    "last_failure_time": null,
    "last_state_change": "2026-02-20T10:00:00Z",
    "cooldown_until": null,
    "failure_window_start": null
  },
  "api/openai": {
    "state": "OPEN",
    "failure_count": 3,
    "success_count": 0,
    "last_failure_time": "2026-02-20T14:25:42Z",
    "last_state_change": "2026-02-20T14:25:42Z",
    "cooldown_until": "2026-02-20T14:30:42Z",
    "failure_window_start": "2026-02-20T14:24:50Z"
  },
  "api/opencode": {
    "state": "HALF_OPEN",
    "failure_count": 0,
    "success_count": 1,
    "last_failure_time": "2026-02-20T14:10:00Z",
    "last_state_change": "2026-02-20T14:15:00Z",
    "cooldown_until": null,
    "failure_window_start": null
  }
}
EOF
```

Create a sample dead-letter queue:

```bash
cat > .loki/queue/dead-letter.json << 'EOF'
{
  "tasks": [
    {
      "task_id": "task-007",
      "original_queue": "in-progress",
      "failure_count": 5,
      "first_failure": "2026-02-20T11:00:00Z",
      "last_failure": "2026-02-20T14:00:00Z",
      "error_summary": "Database migration script fails on foreign key constraint",
      "attempts": [
        {
          "attempt_number": 1,
          "timestamp": "2026-02-20T11:00:00Z",
          "approach": "Direct ALTER TABLE with constraint",
          "error_type": "validation",
          "error_message": "ERROR: cannot add foreign key constraint - referenced table not yet created",
          "agent_id": "eng-database-001"
        },
        {
          "attempt_number": 5,
          "timestamp": "2026-02-20T14:00:00Z",
          "approach": "Deferred constraint with migration ordering",
          "error_type": "validation",
          "error_message": "ERROR: circular dependency between users and organizations tables",
          "agent_id": "eng-database-001"
        }
      ],
      "recovery_strategy": "requires_human_review",
      "task_data": {
        "title": "Create database migration for user-organization relationship",
        "description": "Add foreign keys between users and organizations tables",
        "dependencies": ["task-005"],
        "priority": "high"
      }
    }
  ],
  "metadata": {
    "last_reviewed": "2026-02-20T08:00:00Z",
    "total_abandoned": 0,
    "total_recovered": 2
  }
}
EOF
```

## Step 2: Inspect Circuit Breaker State

Practice reading circuit breaker state:

```bash
# List all circuit breaker states
cat .loki/state/circuit-breakers.json | jq 'to_entries[] | {api: .key, state: .value.state}'

# Find which APIs are in OPEN state
cat .loki/state/circuit-breakers.json | jq 'to_entries[] | select(.value.state == "OPEN") | .key'

# Check the cooldown time for the OPEN circuit
cat .loki/state/circuit-breakers.json | jq '.["api/openai"].cooldown_until'

# Check how many successes the HALF_OPEN circuit needs
cat .loki/state/circuit-breakers.json | jq '.["api/opencode"].success_count'
```

**Questions to answer:**
1. Which API is currently blocked (OPEN)?
2. When does the cooldown expire?
3. How many more successes does the HALF_OPEN circuit need to return to CLOSED? (Answer: 2 more, needs 3 total)

## Step 3: Analyze the Dead-Letter Queue

```bash
# Count tasks in dead-letter
cat .loki/queue/dead-letter.json | jq '.tasks | length'

# View the error summary
cat .loki/queue/dead-letter.json | jq '.tasks[0].error_summary'

# View all attempts for the first task
cat .loki/queue/dead-letter.json | jq '.tasks[0].attempts'

# Check the recovery strategy
cat .loki/queue/dead-letter.json | jq '.tasks[0].recovery_strategy'

# Check when the queue was last reviewed
cat .loki/queue/dead-letter.json | jq '.metadata.last_reviewed'
```

**Questions to answer:**
1. What is the root cause of the failure?
2. What recovery strategy is assigned?
3. Is the `last_reviewed` timestamp more than 24 hours old? (If so, the queue should be processed before new work.)

## Step 4: Simulate Signal Files

Create signal files and understand their purpose:

```bash
# Simulate a PAUSE signal
touch .loki/signals/PAUSE
ls .loki/signals/
# In a real session, the agent would stop after the current iteration

# Remove PAUSE
rm .loki/signals/PAUSE

# Simulate a DRIFT_DETECTED signal
cat >> .loki/signals/DRIFT_DETECTED << 'EOF'
{"timestamp":"2026-02-20T14:30:00Z","task_id":"task-012","severity":"medium","detected_drift":"Started optimizing CSS instead of implementing API endpoint"}
{"timestamp":"2026-02-20T14:35:00Z","task_id":"task-012","severity":"medium","detected_drift":"Switched to refactoring tests instead of implementing API endpoint"}
EOF

# Read the drift log
cat .loki/signals/DRIFT_DETECTED | jq -s '.'

# Simulate HUMAN_REVIEW_NEEDED
cat > .loki/signals/HUMAN_REVIEW_NEEDED << 'EOF'
{
  "timestamp": "2026-02-20T14:40:00Z",
  "reason": "security_decision",
  "task_id": "task-015",
  "context": "Requires AWS production credentials for deployment",
  "severity": "critical",
  "blocking": true
}
EOF

cat .loki/signals/HUMAN_REVIEW_NEEDED | jq .
```

## Step 5: Practice Recovery Commands

Use the Loki Mode CLI recovery commands:

```bash
# Check current status
loki status

# Reset commands (these work on actual .loki/ state):
# loki reset retries    -- Reset retry counters
# loki reset failed     -- Reset failed task status
# loki reset all        -- Reset all session state

# View logs
loki logs
```

## Step 6: Inspect Orchestrator State

```bash
# View current phase
cat .loki/state/orchestrator.json | jq '.currentPhase'

# Calculate progress
cat .loki/state/orchestrator.json | jq '{
  phase: .currentPhase,
  progress: "\(.tasksCompleted)/\(.totalTasks)",
  failed: .tasksFailed
}'
```

## Verification Checklist

- [ ] You can read and interpret circuit breaker states (CLOSED, OPEN, HALF_OPEN)
- [ ] You can calculate when an OPEN circuit will transition to HALF_OPEN
- [ ] You can inspect dead-letter queue tasks and identify recovery strategies
- [ ] You understand the drift detection signal and its accumulation thresholds
- [ ] You know which signal files exist and what they trigger
- [ ] You can use `loki status`, `loki logs`, and `loki reset` for recovery

## Cleanup

```bash
cd ~
rm -rf /tmp/troubleshoot-lab
```
