# Cursor Scaling Learnings

> **Source:** [Cursor Blog - Scaling Agents](https://cursor.com/blog/scaling-agents) (January 2026)
> **Context:** Cursor deployed hundreds of concurrent agents, trillions of tokens, completing 1M+ LoC projects

---

## Key Findings

### 1. Flat Coordination Fails at Scale

**What they tried:**
- Equal-status agents self-coordinating through shared files
- File-based locking mechanisms

**What happened:**
- "Twenty agents would slow down to the effective throughput of two or three"
- Most time spent waiting on locks
- Agents failed while holding locks, creating deadlocks

**Lesson:** Hierarchical coordination (planner-worker) outperforms flat coordination.

---

### 2. Integrator Roles Create Bottlenecks

**What they tried:**
- Dedicated integrator agents to coordinate and merge work
- Quality control checkpoints between workers

**What happened:**
- "Created more bottlenecks than it solved"
- Workers were already capable of handling conflicts themselves

**Lesson:** Trust workers to handle conflicts. Remove unnecessary oversight layers at scale.

**Implication for Loki Mode:** The 3-reviewer blind review system may become a bottleneck at 100+ agent scale. Consider:
- Making review optional for low-risk changes
- Allowing workers to self-merge trivial fixes
- Escalating only high-risk changes to full review

---

### 3. Optimistic Concurrency Control

**What they tried:**
- File locking (failed - deadlocks, bottlenecks)
- Optimistic concurrency (succeeded)

**How it works:**
```
1. Agent reads current state (no lock)
2. Agent performs work
3. Agent attempts write
4. IF state changed since read: Write fails, agent retries
5. IF state unchanged: Write succeeds
```

**Benefits:**
- No waiting for locks
- No deadlock risk
- Failed writes are cheap (just retry)

**Lesson:** Optimistic concurrency scales better than pessimistic locking.

---

### 4. Recursive Sub-Planners

**Pattern:**
```
Main Planner
    |
    +-- Sub-Planner (Frontend)
    |       +-- Worker (Component A)
    |       +-- Worker (Component B)
    |
    +-- Sub-Planner (Backend)
    |       +-- Worker (API)
    |       +-- Worker (Database)
    |
    +-- Sub-Planner (Testing)
            +-- Worker (Unit)
            +-- Worker (E2E)
```

**Key insight:** "Planners continuously explore the codebase and create tasks. They can spawn sub-planners for specific areas, making planning itself parallel and recursive."

**Benefits:**
- Planning scales horizontally
- Each sub-planner has focused context
- Prevents single-planner bottleneck

---

### 5. Judge Agents

**Role:** Determine whether execution cycles should continue or terminate.

**When to use:**
- After major milestones
- When workers report completion
- When detecting diminishing returns

**Implementation:**
```yaml
judge_agent:
  inputs:
    - Current state
    - Original goal
    - Recent progress
    - Resource consumption
  outputs:
    - CONTINUE: More work needed
    - COMPLETE: Goal achieved
    - ESCALATE: Human intervention needed
    - PIVOT: Change approach
```

---

### 6. Prompts Matter More Than Harness

**Cursor's finding:** "A surprising amount of the system's behavior comes down to how we prompt the agents... The harness and models matter, but the prompts matter more."

**Implication:** Don't over-engineer the coordination infrastructure. Invest in:
- Clear, specific prompts
- Role definitions
- Context injection
- Output format specifications

---

### 7. Periodic Fresh Starts Combat Drift

**Problem:** Extended autonomous operation leads to:
- Context drift
- Tunnel vision
- Accumulated assumptions

**Solution:** "We still need periodic fresh starts to combat drift and tunnel vision."

**Implementation:**
```yaml
drift_prevention:
  context_reset_interval: 25_iterations  # Already in Loki Mode
  mandatory_state_dump: true
  fresh_planner_spawn: every_major_milestone
```

---

## Scale Metrics Achieved

| Project | Scale | Duration |
|---------|-------|----------|
| Web browser | 1M+ LoC, 1,000 files | ~1 week |
| Solid-to-React migration | 266K additions, 193K deletions | 3+ weeks |
| Java LSP | 7.4K commits, 550K LoC | - |
| Windows 7 emulator | 14.6K commits, 1.2M LoC | - |
| Excel implementation | 12K commits, 1.6M LoC | - |

---

## Applying to Loki Mode

### Already Implemented (Aligned)

1. **Hierarchical coordination** - Orchestrator -> Agents
2. **Context management** - CONTINUITY.md, 25-iteration consolidation
3. **Phase-based execution** - SDLC state machine

### Should Add

1. **Recursive sub-planners** - Allow planner agents to spawn sub-planners
2. **Judge agents** - Explicit cycle continuation decisions
3. **Optimistic concurrency** - Replace signal files with optimistic writes
4. **Scale-aware review** - Adaptive review intensity based on agent count

### Should Monitor

1. **3-reviewer bottleneck** - May not scale past 50+ agents
2. **Signal file coordination** - Similar to Cursor's failed file locking
3. **Over-specification** - 37 agent types may be overkill

---

## Integration Recommendations

### Phase 1: Low Risk
- Add judge agents (new agent type)
- Document optimistic concurrency option
- Add scale considerations to quality gates

### Phase 2: Medium Risk
- Implement recursive sub-planners
- Make review intensity configurable
- Add optimistic concurrency mode

### Phase 3: Validation Required
- Test at 100+ agent scale
- Measure reviewer bottleneck impact
- Compare file signals vs optimistic concurrency

---

**v4.1.0 | Cursor Scaling Learnings**
