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
