# Checkpoints

Session state snapshots for rollback safety and state preservation (v5.34.0).

---

## Overview

Checkpoints capture a point-in-time snapshot of your Loki Mode session state alongside the current git SHA. They provide a safety net during autonomous runs, allowing you to restore session state if something goes wrong without losing progress.

### Key Features

- **Git SHA tracking** -- every checkpoint records the exact commit hash
- **State file snapshots** -- copies orchestrator state, task queues, and session data
- **Automatic creation** -- checkpoints are created on session end
- **Pre-rollback safety** -- a snapshot is always taken before restoring a previous checkpoint
- **Retention policy** -- 50 max checkpoints with automatic pruning of oldest
- **CLI and API access** -- manage checkpoints from the command line or HTTP API

---

## How It Works

When a checkpoint is created, Loki Mode:

1. Records the current git SHA and branch
2. Copies critical `.loki/` state files into a checkpoint directory
3. Writes a `metadata.json` file with context (timestamp, iteration, task description, provider, phase)
4. Appends an entry to `index.jsonl` for fast listing
5. Prunes checkpoints beyond the 50-checkpoint retention limit

Checkpoints are lightweight -- they capture session orchestration state, not the full `.loki/` directory or git working tree.

### What Gets Captured

The files captured depend on how the checkpoint is created:

**CLI (`loki checkpoint create`) and API (`POST /api/checkpoints`):**

| Source | Description |
|--------|-------------|
| `session.json` | Session metadata |
| `dashboard-state.json` | Dashboard state snapshot |
| `queue/` | Task queue directory (pending, completed, in-progress) |
| `memory/` | Memory system data (CLI only) |
| `metrics/` | Efficiency and reward metrics (CLI only) |
| `council/` | Completion council state (CLI only) |
| Git SHA | Commit hash at time of checkpoint |
| Git branch | Active branch name |

**Automatic (`create_checkpoint` in run.sh, called at task completion):**

| Source | Description |
|--------|-------------|
| `state/orchestrator.json` | Current SDLC phase, iteration count, metrics |
| `queue/pending.json` | Tasks waiting to execute |
| `queue/completed.json` | Completed tasks |
| `queue/in-progress.json` | Currently active tasks |
| `queue/current-task.json` | The specific task being worked on |
| Git SHA | Commit hash at time of checkpoint |
| Git branch | Active branch name |

---

## Automatic Checkpoints

Loki Mode creates checkpoints automatically in two situations:

### Session End

When an autonomous session completes (success or failure), a checkpoint is created with the message `session end (iterations=N)`. The checkpoint ID follows the format `cp-{iteration}-{epoch}` (e.g., `cp-12-1739345422`). This preserves the final session state for post-mortem analysis.

### Pre-Rollback Safety

Before restoring a previous checkpoint via `rollback_to_checkpoint`, a safety snapshot is created with the message `pre-rollback snapshot`. The checkpoint ID follows the same `cp-{iteration}-{epoch}` format. This ensures you can always recover the state that existed before the rollback.

---

## CLI Reference

```bash
loki checkpoint <command> [args]
loki cp <command> [args]       # short alias
```

### `loki checkpoint list`

List recent checkpoints (default command).

```bash
loki checkpoint list
loki cp ls
```

**Output:**

```
Checkpoints

  cp-20260212-143022  2026-02-12 14:30:22  abc1234f  before refactor
  cp-20260212-150105  2026-02-12 15:01:05  def5678a  session end (iterations=12)

  Showing 2 of 2 checkpoints
```

### `loki checkpoint create`

Create a new checkpoint with an optional description message.

```bash
loki checkpoint create
loki checkpoint create 'before refactor'
loki cp create 'switching to new approach'
```

**Output:**

```
Creating checkpoint...

  Checkpoint: cp-20260212-143022
  Git SHA:    abc1234f
  Message:    before refactor
  Files:      4 state items copied
  Location:   .loki/state/checkpoints/cp-20260212-143022

  Restore with: loki checkpoint rollback cp-20260212-143022
```

### `loki checkpoint show`

Show detailed metadata for a specific checkpoint.

```bash
loki checkpoint show cp-20260212-143022
loki cp show cp-20260212-143022
```

### `loki checkpoint rollback`

Restore session state from a previous checkpoint. A safety checkpoint is created automatically before the rollback proceeds.

```bash
loki checkpoint rollback cp-20260212-143022
loki cp rollback cp-20260212-143022
```

**Important:** Rollback restores `.loki/` session state files only. Your code (git working tree) is not modified. To also roll back code to the checkpoint's git state, the command will suggest:

```bash
git reset --hard <sha>
```

### `loki checkpoint help`

Show usage information.

```bash
loki checkpoint help
loki cp help
```

---

## API Reference

The dashboard server exposes checkpoint endpoints on port 57374.

### List Checkpoints

```
GET /api/checkpoints?limit=20
```

Returns an array of checkpoint entries, most recent first.

**Parameters:**

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `limit` | integer | 20 | Max checkpoints to return (1-200) |

**Example:**

```bash
curl http://localhost:57374/api/checkpoints
curl http://localhost:57374/api/checkpoints?limit=5
```

**Response:**

```json
[
  {
    "id": "chk-20260212-143022",
    "created_at": "2026-02-12T14:30:22+00:00",
    "git_sha": "abc1234f",
    "message": "before refactor",
    "files": ["metadata.json", "dashboard-state.json", "session.json"]
  }
]
```

### Get Checkpoint Details

```
GET /api/checkpoints/{checkpoint_id}
```

Returns the full `metadata.json` for a specific checkpoint.

**Example:**

```bash
curl http://localhost:57374/api/checkpoints/chk-20260212-143022
```

**Response:**

```json
{
  "id": "chk-20260212-143022",
  "created_at": "2026-02-12T14:30:22+00:00",
  "git_sha": "abc1234f",
  "message": "before refactor",
  "files": ["metadata.json", "dashboard-state.json", "session.json"]
}
```

### Create Checkpoint

```
POST /api/checkpoints
```

Creates a new checkpoint capturing current session state.

**Request Body (optional):**

```json
{
  "message": "before deploying to production"
}
```

**Example:**

```bash
# Create with default message
curl -X POST http://localhost:57374/api/checkpoints

# Create with custom message
curl -X POST http://localhost:57374/api/checkpoints \
  -H "Content-Type: application/json" \
  -d '{"message": "before deploying to production"}'
```

**Response (201 Created):**

```json
{
  "id": "chk-20260212-150105",
  "created_at": "2026-02-12T15:01:05+00:00",
  "git_sha": "def5678a",
  "message": "before deploying to production",
  "files": ["metadata.json", "dashboard-state.json", "session.json"]
}
```

---

## Dashboard

The dashboard web UI includes a checkpoint viewer that displays checkpoint history with timestamps, git SHAs, and descriptions. Access it through the dashboard at `http://localhost:57374`.

---

## Directory Structure

Checkpoints are stored under `.loki/state/checkpoints/`:

```
.loki/state/checkpoints/
  index.jsonl                          # Fast-lookup index (one JSON object per line)
  cp-20260212-143022/                  # CLI-created checkpoint (loki checkpoint create)
    metadata.json                      # Checkpoint metadata
    session.json                       # Session data snapshot
    dashboard-state.json               # Dashboard state snapshot
    queue/                             # Task queue directory copy
      pending.json
      completed.json
      in-progress.json
      current-task.json
    memory/                            # Memory system data
    metrics/                           # Efficiency and reward metrics
    council/                           # Council state
  cp-12-1739345422/                    # Auto-created checkpoint (run.sh create_checkpoint)
    metadata.json                      # Checkpoint metadata
    state/
      orchestrator.json                # Orchestrator state snapshot
    queue/
      pending.json                     # Pending tasks snapshot
      completed.json                   # Completed tasks snapshot
      in-progress.json                 # In-progress tasks snapshot
      current-task.json                # Current task snapshot
  chk-20260212-150105/                 # API-created checkpoint (POST /api/checkpoints)
    metadata.json                      # Checkpoint metadata
    dashboard-state.json               # Dashboard state snapshot
    session.json                       # Session data snapshot
    queue/                             # Queue directory copy
      ...
```

**ID prefixes by source:**
- `cp-YYYYMMDD-HHMMSS` -- CLI (`loki checkpoint create`)
- `cp-{iteration}-{epoch}` -- Automatic (run.sh `create_checkpoint`)
- `chk-YYYYMMDD-HHMMSS` -- API (`POST /api/checkpoints`)

All are listed by `loki checkpoint list` and the `/api/checkpoints` endpoint.

---

## Retention Policy

Loki Mode enforces a maximum of 50 checkpoints at all times:

- After creating a new checkpoint, the system counts existing checkpoint directories
- If the count exceeds 50, the oldest checkpoints are deleted
- The `index.jsonl` file is rebuilt from remaining checkpoint metadata
- This applies to both automatic and manual checkpoints

---

## Troubleshooting

### No Checkpoints Found

```bash
# Verify .loki directory exists (requires an active or previous session)
ls -la .loki/state/checkpoints/

# Create a checkpoint manually
loki checkpoint create 'test checkpoint'
```

### Rollback Did Not Change Code

Checkpoint rollback only restores `.loki/` state files (task queues, orchestrator state). It does not modify your git working tree. To also revert code:

```bash
# Show the checkpoint's git SHA
loki checkpoint show <id>

# Reset code to that commit (destructive -- use with caution)
git reset --hard <sha>
```

### Checkpoint Directory Missing Files

Some state files may not exist at the time of checkpoint creation (e.g., if no tasks are in progress). Only files that exist are copied. This is expected behavior.

### API Returns Empty List

```bash
# Check if the LOKI_DIR environment variable is set
echo $LOKI_DIR

# Verify index file exists
cat .loki/state/checkpoints/index.jsonl

# Check dashboard is running
curl http://localhost:57374/api/checkpoints
```

---

## See Also

- [[CLI Reference]] - Full CLI command reference
- [[API Reference]] - HTTP API documentation
- [[Dashboard]] - Dashboard features and usage
- [[Architecture]] - System architecture overview
