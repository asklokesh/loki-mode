# Production Patterns

## HN 2025 Battle-Tested Patterns

### Narrow Scope Wins

```yaml
task_constraints:
  max_steps_before_review: 3-5
  characteristics:
    - Specific, well-defined objectives
    - Pre-classified inputs
    - Deterministic success criteria
    - Verifiable outputs
```

### Deterministic Outer Loops

**Wrap agent outputs with rule-based validation (NOT LLM-judged):**

```
1. Agent generates output
2. Run linter (deterministic)
3. Run tests (deterministic)
4. Check compilation (deterministic)
5. Only then: human or AI review
```

### Context Engineering

```yaml
principles:
  - "Less is more" - focused beats comprehensive
  - Manual selection outperforms automatic RAG
  - Fresh conversations per major task
  - Remove outdated information aggressively

context_budget:
  target: "< 10k tokens for context"
  reserve: "90% for model reasoning"
```

---

## Proactive Context Management (OpenCode Pattern)

**Prevent context overflow in long autonomous sessions:**

```yaml
compaction_strategy:
  trigger: "Every 25 iterations OR context feels heavy"

  preserve_always:
    - CONTINUITY.md content (current state)
    - Current task specification
    - Recent Mistakes & Learnings (last 5)
    - Active queue items

  consolidate:
    - Completed task summaries -> semantic memory
    - Resolved errors -> anti-patterns
    - Successful patterns -> procedural memory

  discard:
    - Verbose tool outputs
    - Intermediate reasoning
    - Superseded plans
```

---

## Sub-Agents for Context Isolation

**Run expensive explorations in isolated contexts:**

```python
# Heavy analysis that would bloat main context
Task(
    subagent_type="Explore",
    model="haiku",
    description="Find all auth-related files",
    prompt="Search codebase for authentication patterns. Return only file paths."
)
# Main context stays clean; only results return
```

---

## Git Worktree Isolation (Cursor Pattern)

**Use git worktrees for parallel implementation agents:**

```bash
# Create isolated worktree for feature
git worktree add ../project-feature-auth feature/auth

# Agent works in isolated worktree
cd ../project-feature-auth
# ... implement feature ...

# Merge back when complete
git checkout main
git merge feature/auth
git worktree remove ../project-feature-auth
```

**Benefits:**
- Multiple agents can work in parallel without conflicts
- Each agent has clean, isolated file state
- Merges happen explicitly, not through file racing

---

## Atomic Checkpoint/Rollback (Cursor Pattern)

```yaml
checkpoint_strategy:
  when:
    - Before spawning any subagent
    - Before any destructive operation
    - After completing a task successfully

  how:
    - git commit -m "CHECKPOINT: before {operation}"
    - Record commit hash in CONTINUITY.md

  rollback:
    - git reset --hard {checkpoint_hash}
    - Update CONTINUITY.md with rollback reason
    - Add to Mistakes & Learnings
```

---

## CI/CD Automation (Zencoder Patterns)

### CI Failure Analysis and Auto-Resolution

```yaml
ci_failure_workflow:
  1. Detect CI failure (webhook or poll)
  2. Parse error logs for root cause
  3. Classify failure type:
     - Test failure: Fix code, re-run tests
     - Lint failure: Auto-fix with --fix flag
     - Build failure: Check dependencies, configs
     - Flaky test: Mark and investigate separately
  4. Apply fix and push
  5. Monitor CI result
  6. If still failing after 3 attempts: escalate
```

### Automated Review Comment Resolution

```yaml
pr_comment_workflow:
  trigger: "New review comment on PR"

  workflow:
    1. Parse comment for actionable feedback
    2. Classify: bug, style, question, suggestion
    3. For bugs/style: implement fix
    4. For questions: add code comment or respond
    5. For suggestions: evaluate and implement if beneficial
    6. Push changes and mark comment resolved
```

### Continuous Dependency Management

```yaml
dependency_workflow:
  schedule: "Weekly or on security advisory"

  workflow:
    1. Run npm audit / pip-audit / cargo audit
    2. Classify vulnerabilities by severity
    3. For Critical/High: immediate update
    4. For Medium: schedule update
    5. Run full test suite after updates
    6. Create PR with changelog
```

---

## Batch Processing (Claude API)

**50% cost reduction for large-scale async operations.**

### When to Use Batch API

| Use Case | Batch? | Reasoning |
|----------|--------|-----------|
| Single code review | No | Immediate feedback needed |
| Review 100+ files | Yes | 50% savings, async OK |
| Generate tests for all modules | Yes | Bulk operation |
| Interactive development | No | Need real-time responses |
| Large-scale evaluations | Yes | Cost-critical at scale |
| QA phase bulk analysis | Yes | Can wait for results |

### Batch API Limits

```yaml
limits:
  max_requests: 100,000 per batch
  max_size: 256 MB per batch
  processing_time: Most < 1 hour (max 24h)
  results_available: 29 days

pricing:
  discount: 50% on all tokens
  stacks_with: Prompt caching (30-98% cache hits)
```

### Implementation Pattern

```python
import anthropic
from anthropic.types.message_create_params import MessageCreateParamsNonStreaming
from anthropic.types.messages.batch_create_params import Request

client = anthropic.Anthropic()

# Batch all code review requests
def batch_code_review(files: list[str]) -> str:
    requests = [
        Request(
            custom_id=f"review-{i}-{file.replace('/', '-')}",
            params=MessageCreateParamsNonStreaming(
                model="claude-sonnet-4-6",
                max_tokens=2048,
                messages=[{
                    "role": "user",
                    "content": f"Review this code for bugs, security, performance:\n\n{open(file).read()}"
                }]
            )
        )
        for i, file in enumerate(files)
    ]

    batch = client.messages.batches.create(requests=requests)
    return batch.id  # Poll for results later

# Poll for completion
def wait_for_batch(batch_id: str):
    while True:
        batch = client.messages.batches.retrieve(batch_id)
        if batch.processing_status == "ended":
            return batch
        time.sleep(60)

# Stream results
def process_results(batch_id: str):
    for result in client.messages.batches.results(batch_id):
        if result.result.type == "succeeded":
            # Process successful review
            handle_review(result.custom_id, result.result.message)
        elif result.result.type == "errored":
            # Retry or log error
            handle_error(result.custom_id, result.result.error)
```

### Batch + Prompt Caching

**Stack discounts for maximum savings:**

```python
# All requests share cached system prompt
SHARED_SYSTEM = [
    {"type": "text", "text": "You are a code reviewer..."},
    {"type": "text", "text": CODING_STANDARDS,  # Large shared context
     "cache_control": {"type": "ephemeral"}}
]

requests = [
    Request(
        custom_id=f"review-{file}",
        params=MessageCreateParamsNonStreaming(
            model="claude-sonnet-4-6",
            max_tokens=2048,
            system=SHARED_SYSTEM,  # Identical across all requests
            messages=[{"role": "user", "content": f"Review: {code}"}]
        )
    )
    for file, code in files_with_code
]
```

**Cost math:**
- Base: $3/MTok input, $15/MTok output (Sonnet)
- Batch discount: 50% -> $1.50/$7.50
- Cache hit: 90% reduction on cached tokens
- Combined: Up to 95% savings on large batches
