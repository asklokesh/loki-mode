---
name: checkpoint-mode
description: Pause for review every N tasks - selective autonomy pattern
agent_types: [orchestrator]
research_source: timdettmers.com
activation: configurable
---

# Checkpoint Mode Skill

## Overview

Implements **selective autonomy** - shorter bursts of autonomous work with feedback loops.

**Research Source:** "Use Agents or Be Left Behind" by Tim Dettmers

---

## Philosophy

> "More than 90% of code should be written by agents, but iteratively design systems with shorter bursts of autonomy with feedback loops."
> - Tim Dettmers, 2026

**Problem with Perpetual Autonomy:**
- Can waste resources on wrong approach
- No opportunity for course correction
- User feels disconnected from progress

**Solution:**
- Pause after N tasks or M minutes
- Generate summary of accomplishments
- Wait for explicit approval to continue

---

## When to Use

### Use Checkpoint Mode For:
- **Novel projects** where approach may need adjustment
- **High-cost operations** (expensive API calls, cloud resources)
- **Learning phases** where user wants to guide direction
- **Regulated environments** requiring audit trail

### Use Perpetual Mode For:
- **Well-defined PRDs** with clear requirements
- **Established patterns** with high confidence
- **Overnight builds** where interruption isn't desired
- **CI/CD pipelines** requiring full automation

---

## Configuration

```bash
# Enable checkpoint mode
LOKI_AUTONOMY_MODE=checkpoint

# Pause frequency
LOKI_CHECKPOINT_FREQUENCY=10  # tasks
LOKI_CHECKPOINT_TIME=60  # minutes

# Always pause after these phases
LOKI_CHECKPOINT_PHASES="architecture,deployment"
```

---

## Checkpoint Workflow

```
[Work on 10 tasks] → [Pause] → [Generate Summary] → [Wait for Approval]
                                                           ↓
                                              [User reviews and approves]
                                                           ↓
                                                    [Resume work]
```

### On Checkpoint:

1. **Generate Summary**
   ```markdown
   # Checkpoint Summary

   ## Tasks Completed (10)
   - Implemented POST /api/todos endpoint
   - Added unit tests (95% coverage)
   - Set up CI/CD pipeline
   - ...

   ## Next Actions
   - Deploy to staging
   - Run integration tests
   - Security audit

   ## Resources Used
   - 15 minutes elapsed
   - 3 Haiku agents, 2 Sonnet agents
   - Estimated cost: $0.45
   ```

2. **Create Approval Signal**
   ```bash
   # System writes:
   .loki/signals/CHECKPOINT_SUMMARY_2026-01-14-10-30.md

   # User reviews and creates:
   .loki/signals/CHECKPOINT_APPROVED
   ```

3. **Wait for Approval**
   - Orchestrator pauses execution
   - Monitors for approval signal
   - Resumes when signal detected

---

## Agent Instructions (Orchestrator)

When `LOKI_AUTONOMY_MODE=checkpoint`:

```python
completed_tasks = load_completed_tasks()
tasks_since_checkpoint = completed_tasks - last_checkpoint_count

if tasks_since_checkpoint >= CHECKPOINT_FREQUENCY:
    # Pause and generate summary
    summary = generate_checkpoint_summary()
    write_signal("CHECKPOINT_SUMMARY", summary)

    # Wait for approval
    log_info("Waiting for checkpoint approval...")
    while not signal_exists("CHECKPOINT_APPROVED"):
        sleep(5)

    # Resume work
    remove_signal("CHECKPOINT_APPROVED")
    log_info("Checkpoint approved. Resuming work...")
    last_checkpoint_count = completed_tasks
```

---

## Comparison with Other Modes

| Mode | Best For | Approval Frequency | Use Case |
|------|----------|-------------------|----------|
| **Perpetual** | Overnight builds | Never | Fully automated CI/CD |
| **Checkpoint** | Novel projects | Every 10 tasks | Learning new domain |
| **Supervised** | Critical systems | Every task | Production deployments |

---

## Metrics

Track checkpoint effectiveness:

```json
{
  "checkpoint_id": "cp-2026-01-14-001",
  "tasks_completed": 10,
  "time_elapsed_minutes": 15,
  "approval_time_seconds": 45,
  "course_corrections": 0,
  "user_satisfaction": "approved_without_changes"
}
```

Storage: `.loki/metrics/checkpoint-mode/`

---

## References

- `references/production-patterns.md` - HN production insights
- [timdettmers.com/use-agents-or-be-left-behind](https://timdettmers.com/2026/01/13/use-agents-or-be-left-behind/)

---

**Version:** 1.0.0
