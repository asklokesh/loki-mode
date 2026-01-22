# Parallel Workflows with Git Worktrees

> **Research basis:** Claude Code git worktrees pattern, Anthropic "One Feature at a Time" harness, HN production patterns on context isolation.

---

## Why Worktree-Based Parallelism

**The Problem:**
- Single Claude session = sequential work
- Feature A blocks Feature B
- Testing waits for development to finish
- Documentation waits for everything
- Context bloats with unrelated work

**The Solution:**
- Git worktrees = isolated working directories
- Multiple Claude sessions = true parallelism
- Each stream has fresh context
- Work merges back when complete

```
Main Worktree (orchestrator)
    |
    +-- ../project-feature-auth (Claude session 1)
    +-- ../project-feature-api (Claude session 2)
    +-- ../project-testing (Claude session 3)
    +-- ../project-docs (Claude session 4)
```

---

## Parallel Work Streams

| Stream | Purpose | Worktree | Triggers |
|--------|---------|----------|----------|
| **feature-N** | Implement features | `../project-feature-{name}` | PRD task breakdown |
| **testing** | Unit, integration, E2E | `../project-testing` | After feature checkpoint |
| **qa-validation** | UAT, accessibility | `../project-qa` | After tests pass |
| **documentation** | Docs, changelog | `../project-docs` | After feature merge |
| **blog** | Blog posts (if site has blog) | `../project-blog` | After significant releases |

---

## Worktree Management Commands

### Create Feature Worktree

```bash
# From main worktree
git worktree add ../project-feature-auth -b feature/auth

# Initialize environment
cd ../project-feature-auth
npm install  # or pip install, cargo build, etc.
```

### Create Testing Worktree (tracks main)

```bash
# Testing always runs against latest main
git worktree add ../project-testing main

# Pull latest before each test run
cd ../project-testing
git pull origin main
```

### Merge Completed Work

```bash
# Feature complete, merge back
cd /path/to/main/worktree
git merge feature/auth --no-ff -m "feat: User authentication"

# Remove worktree
git worktree remove ../project-feature-auth
git branch -d feature/auth
```

### List and Clean Worktrees

```bash
# List all worktrees
git worktree list

# Prune stale worktrees
git worktree prune
```

---

## Orchestrator Workflow

The main orchestrator manages parallel streams:

```yaml
orchestrator_workflow:
  1_plan:
    - Analyze PRD for parallelizable features
    - Create task breakdown with dependencies
    - Identify independent streams

  2_spawn:
    - Create worktrees for independent features
    - Launch Claude session per worktree
    - Start testing worktree (tracks main)

  3_coordinate:
    - Watch .loki/state/ in each worktree
    - Detect feature completion signals
    - Trigger testing on checkpoints
    - Queue documentation on merges

  4_merge:
    - Validate tests pass on feature branch
    - Merge to main
    - Update testing worktree (git pull)
    - Trigger documentation stream

  5_cleanup:
    - Remove completed worktrees
    - Archive session logs
    - Update main orchestrator state
```

---

## Claude Session Per Worktree

Each worktree runs an independent Claude session:

```bash
# Feature development session
cd ../project-feature-auth
claude --dangerously-skip-permissions -p "Loki Mode: Implement user authentication. Read .loki/CONTINUITY.md for context."

# Testing session (continuous)
cd ../project-testing
claude --dangerously-skip-permissions -p "Loki Mode: Run all tests. Watch for changes. Report failures to .loki/state/test-results.json"

# Documentation session
cd ../project-docs
claude --dangerously-skip-permissions -p "Loki Mode: Update documentation for recent changes. Check git log for what changed."
```

---

## Inter-Stream Communication

Streams communicate via `.loki/signals/` and shared git history:

### Signal Files

```
.loki/signals/
  FEATURE_READY_{name}      # Feature ready for testing
  TESTS_PASSED              # All tests green
  DOCS_NEEDED               # Documentation required
  BLOG_POST_QUEUED          # Blog post should be written
  MERGE_REQUESTED_{branch}  # Request merge to main
```

### Workflow Triggers

```yaml
feature_complete:
  signal: "Create .loki/signals/FEATURE_READY_{name}"
  triggers:
    - Testing stream pulls feature branch
    - Testing stream runs full suite
    - On pass: create TESTS_PASSED + MERGE_REQUESTED

merge_complete:
  signal: "Merge commit on main"
  triggers:
    - Documentation stream updates docs
    - If significant: create BLOG_POST_QUEUED
    - Testing stream pulls latest main

blog_trigger:
  signal: "BLOG_POST_QUEUED exists"
  triggers:
    - Blog stream creates post about changes
    - Removes signal when published
```

---

## Parallel Testing Strategy

### Continuous Testing Worktree

```bash
# Testing worktree watches for changes
while true; do
  # Pull latest from main
  git pull origin main 2>/dev/null

  # Check for feature branches ready to test
  for signal in .loki/signals/FEATURE_READY_*; do
    if [ -f "$signal" ]; then
      feature=$(basename "$signal" | sed 's/FEATURE_READY_//')

      # Checkout and test feature
      git checkout "feature/$feature"
      npm test

      if [ $? -eq 0 ]; then
        touch ".loki/signals/TESTS_PASSED_$feature"
        touch ".loki/signals/MERGE_REQUESTED_$feature"
      else
        touch ".loki/signals/TESTS_FAILED_$feature"
      fi

      rm "$signal"
    fi
  done

  sleep 30
done
```

### Parallel Test Execution

```yaml
test_parallelization:
  unit_tests:
    worktree: "../project-testing"
    command: "npm test -- --parallel"
    model: haiku  # Fast, cheap

  integration_tests:
    worktree: "../project-testing"
    command: "npm run test:integration"
    model: sonnet  # More complex

  e2e_tests:
    worktree: "../project-e2e"
    command: "npx playwright test"
    model: sonnet  # Browser automation

  # All can run simultaneously in different worktrees
```

---

## Documentation Stream

### Auto-Documentation Triggers

```yaml
doc_triggers:
  - New API endpoint added
  - Public function signature changed
  - README mentioned file changed
  - Configuration options added
  - Breaking changes detected

doc_workflow:
  1. Detect trigger from git diff
  2. Identify affected documentation
  3. Update docs in ../project-docs worktree
  4. Create PR or commit to main
```

### Blog Stream (if site has blog)

```yaml
blog_triggers:
  - Major feature release
  - Significant performance improvement
  - Security fix (after patch deployed)
  - Milestone reached (v1.0, 1000 users, etc.)

blog_workflow:
  1. Detect BLOG_POST_QUEUED signal
  2. Gather context from git log, CONTINUITY.md
  3. Write blog post draft
  4. Save to content/blog/ or equivalent
  5. Create PR for review (or auto-publish)
```

---

## Worktree State Tracking

### Orchestrator State Schema

```json
{
  "worktrees": {
    "main": {
      "path": "/path/to/project",
      "branch": "main",
      "status": "orchestrating",
      "claude_pid": null
    },
    "feature-auth": {
      "path": "/path/to/project-feature-auth",
      "branch": "feature/auth",
      "status": "in_progress",
      "claude_pid": 12345,
      "started_at": "2026-01-19T10:00:00Z",
      "task": "Implement user authentication"
    },
    "testing": {
      "path": "/path/to/project-testing",
      "branch": "main",
      "status": "watching",
      "claude_pid": 12346,
      "last_run": "2026-01-19T10:15:00Z"
    }
  },
  "pending_merges": ["feature/auth"],
  "active_streams": 3
}
```

### Dashboard Integration

The Loki dashboard shows worktree status:

```
Parallel Streams:
  [main]           Orchestrating          3 active streams
  [feature-auth]   In Progress (45min)    Auth implementation
  [feature-api]    Tests Running          API endpoints
  [testing]        Watching               Last run: 2 min ago
  [docs]           Idle                   Waiting for merges
```

---

## Spawn Parallel Streams Script

```bash
#!/bin/bash
# spawn-parallel.sh - Create and launch parallel work streams

PROJECT_DIR=$(pwd)
PROJECT_NAME=$(basename "$PROJECT_DIR")

# Parse features from PRD or task list
features=("auth" "api" "dashboard")  # Or read from .loki/queue/

# Create feature worktrees
for feature in "${features[@]}"; do
  worktree_path="../${PROJECT_NAME}-feature-${feature}"

  if [ ! -d "$worktree_path" ]; then
    git worktree add "$worktree_path" -b "feature/${feature}"

    # Copy .loki state
    cp -r .loki "$worktree_path/"

    # Initialize environment
    (cd "$worktree_path" && npm install 2>/dev/null)
  fi

  # Launch Claude session in background
  (
    cd "$worktree_path"
    claude --dangerously-skip-permissions \
      -p "Loki Mode: Implement ${feature}. Check .loki/CONTINUITY.md for context." \
      >> ".loki/logs/session-${feature}.log" 2>&1
  ) &

  echo "Spawned: ${feature} (PID: $!)"
done

# Create testing worktree
testing_path="../${PROJECT_NAME}-testing"
if [ ! -d "$testing_path" ]; then
  git worktree add "$testing_path" main
fi

# Create docs worktree
docs_path="../${PROJECT_NAME}-docs"
if [ ! -d "$docs_path" ]; then
  git worktree add "$docs_path" main
fi

echo "Parallel streams initialized"
git worktree list
```

---

## Optimistic Concurrency Control

> **Source:** [Cursor Scaling Learnings](../references/cursor-learnings.md) - file locking failed at scale

### The Problem with Locks

Signal files (`.loki/signals/`) can create bottlenecks similar to file locking:
- Agents wait for signals to clear
- Deadlocks if agent fails while "holding" a signal
- Throughput drops as agent count increases

### Optimistic Concurrency Pattern

```yaml
optimistic_write:
  1_read:
    action: "Read current state (no lock)"
    example: "Read .loki/state/orchestrator.json"
    capture: "state_version: 42"

  2_work:
    action: "Perform work normally"
    example: "Complete task, generate output"

  3_write_attempt:
    action: "Attempt write with version check"
    example: |
      current_version=$(jq .version .loki/state/orchestrator.json)
      if [ "$current_version" == "42" ]; then
        # Version unchanged, safe to write
        write_new_state_with_version_43
      else
        # State changed, retry from step 1
        retry_with_backoff
      fi

  benefits:
    - No waiting for locks
    - No deadlock risk
    - Failed writes are cheap (just retry)
    - Scales to 100+ agents
```

### Implementation

```bash
# Optimistic write function
optimistic_update_state() {
  local file="$1"
  local update_fn="$2"
  local max_retries=5
  local retry=0

  while [ $retry -lt $max_retries ]; do
    # Read current version
    local version=$(jq -r '.version // 0' "$file" 2>/dev/null || echo "0")

    # Apply update
    local new_content=$($update_fn "$file")

    # Attempt atomic write with version check
    local current_version=$(jq -r '.version // 0' "$file" 2>/dev/null || echo "0")

    if [ "$current_version" == "$version" ]; then
      # Version unchanged, safe to write
      echo "$new_content" | jq ".version = $((version + 1))" > "$file.tmp"
      mv "$file.tmp" "$file"
      return 0
    fi

    # Version changed, retry with backoff
    retry=$((retry + 1))
    sleep $((retry * 2))
  done

  return 1  # Failed after max retries
}
```

### When to Use

| Coordination Type | Use Case | Recommendation |
|-------------------|----------|----------------|
| Signal files | <10 agents | OK, simple |
| Signal files | 10-50 agents | Monitor for bottlenecks |
| Optimistic concurrency | 50+ agents | Required for scale |
| Git-based coordination | Cross-worktree | Use git commits as versions |

---

## Limitations and Considerations

### When NOT to Use Worktrees

- **Tightly coupled features** - If Feature A and B touch same files constantly, merge conflicts will be painful
- **Small projects** - Overhead not worth it for simple tasks
- **Single-file changes** - Task tool parallelism is sufficient

### Merge Conflict Resolution

```yaml
conflict_strategy:
  prevention:
    - Assign non-overlapping file ownership
    - Use feature flags for shared code
    - Coordinate via .loki/state/locks/

  resolution:
    - Auto-merge if changes are additive
    - For conflicts: pause feature, resolve manually
    - After resolution: checkpoint and continue
```

### Resource Considerations

```yaml
resource_limits:
  max_worktrees: 5  # More = more disk space
  max_claude_sessions: 3  # API rate limits
  max_parallel_agents: 10  # Per session
```

---

## Integration with Existing Patterns

| Existing Pattern | Worktree Enhancement |
|------------------|---------------------|
| 3 parallel reviewers | Run in testing worktree |
| Haiku parallelization | Within each worktree session |
| Batch API | Batch across all worktrees |
| Context management | Fresh context per worktree |
| CONTINUITY.md | Per-worktree continuity |

---

**v4.1.0 | Parallel Workflows Module**
