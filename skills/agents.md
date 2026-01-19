# Agent Dispatch & Structured Prompting

> **Full agent type definitions:** See `references/agents.md` for complete 37 agent role specifications across 7 swarms (Engineering, Operations, Business, Data, Product, Growth, Review).

---

## How Agents Actually Work

**Claude Code's Task tool has these subagent_types:**
- `general-purpose` - Most work (implementation, review, testing)
- `Explore` - Codebase exploration and search
- `Plan` - Architecture and planning
- `Bash` - Command execution
- `platform-orchestrator` - Deployment and service management

**The 37 agent types are ROLES defined through prompts.** Create specialized behavior:

```python
# Security reviewer = general-purpose + security-focused prompt
Task(
    subagent_type="general-purpose",
    model="opus",
    description="Security review: auth module",
    prompt="""You are a security reviewer. Focus on:
    - Authentication vulnerabilities
    - Input validation gaps
    - OWASP Top 10 issues
    Review: src/auth/*.ts"""
)

# Frontend agent = general-purpose + frontend-focused prompt
Task(
    subagent_type="general-purpose",
    model="opus",
    description="Implement login form",
    prompt="""You are a frontend developer. Implement:
    - React login form component
    - Form validation
    - Error state handling"""
)
```

---

## Structured Prompting Template

**Every Task dispatch MUST include these sections:**

```
## GOAL
[What success looks like - measurable outcome]

## CONSTRAINTS
[Hard limits - what you cannot do]

## CONTEXT
[Files to read, previous attempts, related decisions]

## OUTPUT
[Exact deliverables expected]
```

**Example:**
```python
Task(
    subagent_type="general-purpose",
    model="opus",
    description="Implement user registration API",
    prompt="""
## GOAL
Create POST /api/users endpoint that registers new users.
Success: Endpoint works, tests pass, matches OpenAPI spec.

## CONSTRAINTS
- Use bcrypt for password hashing (already in dependencies)
- No new dependencies without approval
- Response time < 200ms

## CONTEXT
- Existing auth pattern: src/auth/login.ts
- OpenAPI spec: .loki/specs/openapi.yaml
- User model: src/models/user.ts

## OUTPUT
- [ ] Endpoint implementation in src/routes/users.ts
- [ ] Unit tests in tests/users.test.ts
- [ ] Integration test in tests/integration/users.test.ts
"""
)
```

---

## Parallel Review Pattern

**Code review uses 3 parallel reviewers with different focus areas:**

```python
# Launch all 3 in ONE message (parallel execution)
Task(
    subagent_type="general-purpose",
    model="opus",
    description="Review: correctness",
    prompt="Review for bugs, logic errors, edge cases. Files: {files}"
)
Task(
    subagent_type="general-purpose",
    model="opus",
    description="Review: security",
    prompt="Review for vulnerabilities, injection, auth issues. Files: {files}"
)
Task(
    subagent_type="general-purpose",
    model="opus",
    description="Review: performance",
    prompt="Review for N+1 queries, memory leaks, slow operations. Files: {files}"
)
```

**Rules:**
- ALWAYS use opus for reviews
- ALWAYS launch all 3 in single message
- WAIT for all 3 before aggregating
- IF unanimous approval: run Devil's Advocate reviewer

---

## Confidence-Based Routing

| Confidence | Dispatch Strategy |
|------------|-------------------|
| >= 0.95 | Direct haiku execution, no review |
| 0.70-0.95 | Direct execution + async review |
| 0.40-0.70 | Supervisor orchestration, mandatory review |
| < 0.40 | Flag for human decision |

**Confidence factors:**
- Requirement clarity (30%)
- Similar past successes (20%)
- Technical complexity match (25%)
- Resource availability (15%)
- Time pressure (10%)

---

## Agent Handoffs

When one agent completes and hands off to another:

```python
# Agent A completes, hands off to Agent B
handoff_data = {
    "completed_work": "Implemented user registration endpoint",
    "files_modified": ["src/routes/users.ts", "tests/users.test.ts"],
    "decisions_made": ["Used bcrypt, not argon2", "Email validation via regex"],
    "open_questions": ["Rate limiting not implemented yet"],
    "mistakes_learned": ["First attempt had SQL injection - fixed"]
}

Task(
    subagent_type="general-purpose",
    model="sonnet",
    description="Integration testing for user registration",
    prompt=f"Previous agent completed: {handoff_data}. Now write integration tests..."
)
```

---

## Project AGENTS.md

**IF target project has AGENTS.md, read it first.** (OpenAI/AAIF standard)

Priority order for context:
1. `AGENTS.md` in current directory
2. `CLAUDE.md` project instructions
3. `.loki/CONTINUITY.md` session state

---

## A2A-Inspired Communication (Google Protocol)

**Agent Cards for capability discovery:**

```json
{
  "agent_id": "eng-backend-001",
  "capabilities": ["api-endpoint", "auth", "database"],
  "status": "available",
  "current_task": null,
  "inbox": ".loki/messages/inbox/eng-backend-001/",
  "outbox": ".loki/messages/outbox/eng-backend-001/"
}
```

**Handoff message format:**

```json
{
  "from": "eng-backend-001",
  "to": "eng-qa-001",
  "task_id": "task-123",
  "type": "handoff",
  "payload": {
    "completed_work": "POST /api/users implemented",
    "files_modified": ["src/routes/users.ts"],
    "decisions": ["bcrypt for passwords"],
    "artifacts": [".loki/artifacts/users-api-spec.json"]
  }
}
```

**Location:** `.loki/messages/` directory structure

---

## Agentic Patterns Reference (awesome-agentic-patterns)

**Patterns used in Loki Mode:**

| Pattern | Implementation |
|---------|---------------|
| Sub-Agent Spawning | Task tool with focused prompts |
| Plan-Then-Execute | Architect -> Engineer workflow |
| Dual LLM | Opus for planning, Haiku for execution |
| CI Feedback Loop | Test results injected into retry prompts |
| Self-Critique | Constitutional AI revision cycle |
| Semantic Context Filtering | Only relevant files in context |
| Episodic Memory | `.loki/memory/episodic/` traces |

**Key insight (moridinamael.github.io):** Simple orchestration beats complex frameworks. "Ralph Wiggum Mode" - basic continuation prompts work better than elaborate coordination systems.

---

## The 37 Agent Roles

See `references/agents.md` for complete specifications. Summary:

| Swarm | Agent Types | Count |
|-------|-------------|-------|
| Engineering | frontend, backend, database, mobile, api, qa, perf, infra | 8 |
| Operations | devops, sre, security, monitor, incident, release, cost, compliance | 8 |
| Business | marketing, sales, finance, legal, support, hr, investor, partnerships | 8 |
| Data | ml, eng, analytics | 3 |
| Product | pm, design, techwriter | 3 |
| Growth | hacker, community, success, lifecycle | 4 |
| Review | code, business, security | 3 |

**Spawn only what you need.** Simple project: 5-10 agents. Complex startup: 100+.
