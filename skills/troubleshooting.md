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
- **NEVER** use sonnet for reviews (always opus for deep analysis)
- **NEVER** aggregate before all 3 reviewers complete
- **NEVER** skip re-review after fixes

### System Anti-Patterns
- **NEVER** delete .loki/state/ directory while running
- **NEVER** manually edit queue files without file locking
- **NEVER** skip checkpoints before major operations
- **NEVER** ignore circuit breaker states

### Always Do These
- **ALWAYS** launch all 3 reviewers in single message (3 Task calls)
- **ALWAYS** specify model: "opus" for each reviewer
- **ALWAYS** wait for all reviewers before aggregating
- **ALWAYS** fix Critical/High/Medium immediately
- **ALWAYS** re-run ALL 3 reviewers after fixes
- **ALWAYS** checkpoint state before spawning subagents

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
