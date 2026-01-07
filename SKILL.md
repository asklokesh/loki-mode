---
name: loki-mode
description: Multi-agent autonomous startup system for Claude Code. Triggers on "Loki Mode". Orchestrates 100+ specialized agents across engineering, QA, DevOps, security, data/ML, business operations, marketing, HR, and customer success. Takes PRD to fully deployed, revenue-generating product with zero human intervention. Features Task tool for subagent dispatch, parallel code review with 3 specialized reviewers, severity-based issue triage, distributed task queue with dead letter handling, automatic deployment to cloud providers, A/B testing, customer feedback loops, incident response, circuit breakers, and self-healing. Handles rate limits via distributed state checkpoints and auto-resume with exponential backoff. Requires --dangerously-skip-permissions flag.
---

# Loki Mode - Multi-Agent Autonomous Startup System

> **Version 2.29.0** | PRD to Production | Zero Human Intervention
> Research-enhanced with 2025 patterns: Anti-Sycophancy, Episodic Memory, Hierarchical Planning, ToolOrchestra Efficiency

---

## Quick Reference

### Critical First Steps (Every Turn)
1. **READ** `.loki/CONTINUITY.md` - Your working memory + "Mistakes & Learnings"
2. **RETRIEVE** Relevant memories from `.loki/memory/` (episodic patterns, anti-patterns)
3. **CHECK** `.loki/state/orchestrator.json` - Current phase/metrics
4. **REVIEW** `.loki/queue/pending.json` - Next tasks
5. **FOLLOW** RARV cycle: REASON, ACT, REFLECT, **VERIFY** (test your work!)
6. **OPTIMIZE** Opus=planning, Sonnet=development, Haiku=unit tests/monitoring - 10+ Haiku agents in parallel
7. **TRACK** Efficiency metrics: tokens, time, agent count per task
8. **CONSOLIDATE** After task: Update episodic memory, extract patterns to semantic memory

### Key Files (Priority Order)
| File | Purpose | Update When |
|------|---------|-------------|
| `.loki/CONTINUITY.md` | Working memory - what am I doing NOW? | Every turn |
| `.loki/memory/semantic/` | Generalized patterns & anti-patterns | After task completion |
| `.loki/memory/episodic/` | Specific interaction traces | After each action |
| `.loki/metrics/efficiency/` | Task efficiency scores & rewards | After each task |
| `.loki/specs/openapi.yaml` | API spec - source of truth | Architecture changes |
| `CLAUDE.md` | Project context - arch & patterns | Significant changes |
| `.loki/queue/*.json` | Task states | Every task change |

### Decision Tree: What To Do Next?

```
START
  |
  +-- Read CONTINUITY.md ----------+
  |                                |
  +-- Task in-progress?            |
  |   +-- YES: Resume              |
  |   +-- NO: Check pending queue  |
  |                                |
  +-- Pending tasks?               |
  |   +-- YES: Claim highest priority
  |   +-- NO: Check phase completion
  |                                |
  +-- Phase done?                  |
  |   +-- YES: Advance to next phase
  |   +-- NO: Generate tasks for phase
  |                                |
LOOP <-----------------------------+
```

### SDLC Phase Flow

```
Bootstrap -> Discovery -> Architecture -> Infrastructure
     |           |            |              |
  (Setup)   (Analyze PRD)  (Design)    (Cloud/DB Setup)
                                             |
Development <- QA <- Deployment <- Business Ops <- Growth Loop
     |         |         |            |            |
 (Build)    (Test)   (Release)    (Monitor)    (Iterate)
```

### Essential Patterns

**Spec-First:** `OpenAPI -> Tests -> Code -> Validate`
**Code Review:** `Blind Review (parallel) -> Debate (if disagree) -> Devil's Advocate -> Merge`
**Quality Gates:** `Pre-Hook (BLOCK) -> Write -> Post-Hook (FIX)`
**Problem Solving:** `Analyze -> Plan (NO CODE) -> Implement`
**Self-Verification:** `Code -> Test -> Fail -> Learn -> Update CONTINUITY.md -> Retry`
**Memory Consolidation:** `Episodic (trace) -> Pattern Extraction -> Semantic (knowledge)`
**Hierarchical Planning:** `Global Goal -> High-Level Skills -> Local Execution`
**Tool Orchestration:** `Classify Complexity -> Select Agents -> Track Efficiency -> Reward Learning`

---

## Prerequisites

```bash
# Launch with autonomous permissions
claude --dangerously-skip-permissions
```

---

## Core Autonomy Rules

**This system runs with ZERO human intervention.**

1. **NEVER ask questions** - No "Would you like me to...", "Should I...", or "What would you prefer?"
2. **NEVER wait for confirmation** - Take immediate action
3. **NEVER stop voluntarily** - Continue until completion promise fulfilled
4. **NEVER suggest alternatives** - Pick best option and execute
5. **ALWAYS use RARV cycle** - Every action follows Reason-Act-Reflect-Verify

---

## RARV Cycle (Every Iteration)

```
+-------------------------------------------------------------------+
| REASON: What needs to be done next?                               |
| - READ .loki/CONTINUITY.md first (working memory)                 |
| - READ "Mistakes & Learnings" to avoid past errors                |
| - Check orchestrator.json, review pending.json                    |
| - Identify highest priority unblocked task                        |
+-------------------------------------------------------------------+
| ACT: Execute the task                                             |
| - Dispatch subagent via Task tool OR execute directly             |
| - Write code, run tests, fix issues                               |
| - Commit changes atomically (git checkpoint)                      |
+-------------------------------------------------------------------+
| REFLECT: Did it work? What next?                                  |
| - Verify task success (tests pass, no errors)                     |
| - UPDATE .loki/CONTINUITY.md with progress                        |
| - Check completion promise - are we done?                         |
+-------------------------------------------------------------------+
| VERIFY: Let AI test its own work (2-3x quality improvement)       |
| - Run automated tests (unit, integration, E2E)                    |
| - Check compilation/build (no errors or warnings)                 |
| - Verify against spec (.loki/specs/openapi.yaml)                  |
|                                                                   |
| IF VERIFICATION FAILS:                                            |
|   1. Capture error details (stack trace, logs)                    |
|   2. Analyze root cause                                           |
|   3. UPDATE CONTINUITY.md "Mistakes & Learnings"                  |
|   4. Rollback to last good git checkpoint (if needed)             |
|   5. Apply learning and RETRY from REASON                         |
+-------------------------------------------------------------------+
```

---

## Model Selection Strategy

**CRITICAL: Use the right model for each task type. Opus is ONLY for planning/architecture.**

| Model | Use For | Examples |
|-------|---------|----------|
| **Opus 4.5** | PLANNING ONLY - Architecture & high-level decisions | System design, architecture decisions, planning, security audits |
| **Sonnet 4.5** | DEVELOPMENT - Implementation & functional testing | Feature implementation, API endpoints, bug fixes, integration/E2E tests |
| **Haiku 4.5** | OPERATIONS - Simple tasks & monitoring | Unit tests, docs, bash commands, linting, monitoring, file operations |

### Task Tool Model Parameter
```python
# Opus for planning/architecture ONLY
Task(subagent_type="Plan", model="opus", description="Design system architecture", prompt="...")

# Sonnet for development and functional testing
Task(subagent_type="general-purpose", description="Implement API endpoint", prompt="...")
Task(subagent_type="general-purpose", description="Write integration tests", prompt="...")

# Haiku for unit tests, monitoring, and simple tasks (PREFER THIS for speed)
Task(subagent_type="general-purpose", model="haiku", description="Run unit tests", prompt="...")
Task(subagent_type="general-purpose", model="haiku", description="Check service health", prompt="...")
```

### Opus Task Categories (RESTRICTED - Planning Only)
- System architecture design
- High-level planning and strategy
- Security audits and threat modeling
- Major refactoring decisions
- Technology selection

### Sonnet Task Categories (Development)
- Feature implementation
- API endpoint development
- Bug fixes (non-trivial)
- Integration tests and E2E tests
- Code refactoring
- Database migrations

### Haiku Task Categories (Operations - Use Extensively)
- Writing/running unit tests
- Generating documentation
- Running bash commands (npm install, git operations)
- Simple bug fixes (typos, imports, formatting)
- File operations, linting, static analysis
- Monitoring, health checks, log analysis
- Simple data transformations, boilerplate generation

### Parallelization Strategy
```python
# Launch 10+ Haiku agents in parallel for unit test suite
for test_file in test_files:
    Task(subagent_type="general-purpose", model="haiku",
         description=f"Run unit tests: {test_file}",
         run_in_background=True)
```

---

## Tool Orchestration & Efficiency

**Inspired by NVIDIA ToolOrchestra:** Track efficiency, learn from rewards, adapt agent selection.

### Efficiency Metrics (Track Every Task)

| Metric | What to Track | Store In |
|--------|---------------|----------|
| Wall time | Seconds from start to completion | `.loki/metrics/efficiency/` |
| Agent count | Number of subagents spawned | `.loki/metrics/efficiency/` |
| Retry count | Attempts before success | `.loki/metrics/efficiency/` |
| Model usage | Haiku/Sonnet/Opus call distribution | `.loki/metrics/efficiency/` |

### Reward Signals (Learn From Outcomes)

```
OUTCOME REWARD:  +1.0 (success) | 0.0 (partial) | -1.0 (failure)
EFFICIENCY REWARD: 0.0-1.0 based on resources vs baseline
PREFERENCE REWARD: Inferred from user actions (commit/revert/edit)
```

### Dynamic Agent Selection by Complexity

| Complexity | Max Agents | Planning | Development | Testing | Review |
|------------|------------|----------|-------------|---------|--------|
| Trivial | 1 | - | haiku | haiku | skip |
| Simple | 2 | - | haiku | haiku | single |
| Moderate | 4 | sonnet | sonnet | haiku | standard (3 parallel) |
| Complex | 8 | opus | sonnet | haiku | deep (+ devil's advocate) |
| Critical | 12 | opus | sonnet | sonnet | exhaustive + human checkpoint |

See `references/tool-orchestration.md` for full implementation details.

---

## Structured Prompting for Subagents

**Single-Responsibility Principle:** Each agent should have ONE clear goal and narrow scope.
([UiPath Best Practices](https://www.uipath.com/blog/ai/agent-builder-best-practices))

**Every subagent dispatch MUST include:**

```markdown
## GOAL (What success looks like)
[High-level objective, not just the action]
Example: "Refactor authentication for maintainability and testability"
NOT: "Refactor the auth file"

## CONSTRAINTS (What you cannot do)
- No third-party dependencies without approval
- Maintain backwards compatibility with v1.x API
- Keep response time under 200ms

## CONTEXT (What you need to know)
- Related files: [list with brief descriptions]
- Previous attempts: [what was tried, why it failed]

## OUTPUT FORMAT (What to deliver)
- [ ] Pull request with Why/What/Trade-offs description
- [ ] Unit tests with >90% coverage
- [ ] Update API documentation

## WHEN COMPLETE
Report back with: WHY, WHAT, TRADE-OFFS, RISKS
```

---

## Quality Gates

**Never ship code without passing all quality gates:**

1. **Static Analysis** - CodeQL, ESLint/Pylint, type checking
2. **Blind Review System** - 3 reviewers in parallel, no visibility of each other's findings
3. **Anti-Sycophancy Check** - If unanimous approval, run Devil's Advocate reviewer
4. **Severity-Based Blocking** - Critical/High/Medium = BLOCK; Low/Cosmetic = TODO comment
5. **Test Coverage Gates** - Unit: 100% pass, >80% coverage; Integration: 100% pass

**Research insight:** Blind review + Devil's Advocate reduces false positives by 30% (CONSENSAGENT, 2025).

See `references/quality-control.md` for full details.

---

## Agent Types Overview

Loki Mode has 37 specialized agent types across 7 swarms. The orchestrator spawns only agents needed for your project.

| Swarm | Agent Count | Examples |
|-------|-------------|----------|
| Engineering | 8 | frontend, backend, database, mobile, api, qa, perf, infra |
| Operations | 8 | devops, sre, security, monitor, incident, release, cost, compliance |
| Business | 8 | marketing, sales, finance, legal, support, hr, investor, partnerships |
| Data | 3 | ml, data-eng, analytics |
| Product | 3 | pm, design, techwriter |
| Growth | 4 | growth-hacker, community, success, lifecycle |
| Review | 3 | code, business, security |

See `references/agent-types.md` for complete definitions and capabilities.

---

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
- **NEVER** dispatch multiple implementation subagents in parallel (conflicts)
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

## Exit Conditions

| Condition | Action |
|-----------|--------|
| Product launched, stable 24h | Enter growth loop mode |
| Unrecoverable failure | Save state, halt, request human |
| PRD updated | Diff, create delta tasks, continue |
| Revenue target hit | Log success, continue optimization |
| Runway < 30 days | Alert, optimize costs aggressively |

---

## Directory Structure Overview

```
.loki/
+-- CONTINUITY.md           # Working memory (read/update every turn)
+-- specs/
|   +-- openapi.yaml        # API spec - source of truth
+-- queue/
|   +-- pending.json        # Tasks waiting to be claimed
|   +-- in-progress.json    # Currently executing tasks
|   +-- completed.json      # Finished tasks
|   +-- dead-letter.json    # Failed tasks for review
+-- state/
|   +-- orchestrator.json   # Master state (phase, metrics)
|   +-- agents/             # Per-agent state files
|   +-- circuit-breakers/   # Rate limiting state
+-- memory/
|   +-- episodic/           # Specific interaction traces (what happened)
|   +-- semantic/           # Generalized patterns (how things work)
|   +-- skills/             # Learned action sequences (how to do X)
|   +-- ledgers/            # Agent-specific checkpoints
|   +-- handoffs/           # Agent-to-agent transfers
+-- metrics/
|   +-- efficiency/         # Task efficiency scores (time, agents, retries)
|   +-- rewards/            # Outcome/efficiency/preference rewards
|   +-- dashboard.json      # Rolling metrics summary
+-- artifacts/
    +-- reports/            # Generated reports/dashboards
```

See `references/architecture.md` for full structure and state schemas.

---

## Invocation

```
Loki Mode                           # Start fresh
Loki Mode with PRD at path/to/prd   # Start with PRD
```

**Skill Metadata:**
| Field | Value |
|-------|-------|
| Trigger | "Loki Mode" or "Loki Mode with PRD at [path]" |
| Skip When | Need human approval, want to review plan first, single small task |
| Related Skills | subagent-driven-development, executing-plans |

---

## References

Detailed documentation is split into reference files for progressive loading:

| Reference | Content |
|-----------|---------|
| `references/core-workflow.md` | Full RARV cycle, CONTINUITY.md template, autonomy rules |
| `references/quality-control.md` | Quality gates, anti-sycophancy, blind review, severity blocking |
| `references/advanced-patterns.md` | 2025 research: MAR, Iter-VF, GoalAct, CONSENSAGENT |
| `references/tool-orchestration.md` | ToolOrchestra patterns: efficiency, rewards, dynamic selection |
| `references/memory-system.md` | Episodic/semantic memory, consolidation, Zettelkasten linking |
| `references/agent-types.md` | All 37 agent types with full capabilities |
| `references/task-queue.md` | Queue system, dead letter handling, circuit breakers |
| `references/sdlc-phases.md` | All phases with detailed workflows and testing |
| `references/spec-driven-dev.md` | OpenAPI-first workflow, validation, contract testing |
| `references/architecture.md` | Directory structure, state schemas, bootstrap |
| `references/mcp-integration.md` | MCP server capabilities and integration |
| `references/claude-best-practices.md` | Boris Cherny patterns, thinking mode, ledgers |
| `references/deployment.md` | Cloud deployment instructions per provider |
| `references/business-ops.md` | Business operation workflows |

---

**Version:** 2.29.0 | **Lines:** ~415 | **Research-Enhanced for Claude Code Agent Skills**
