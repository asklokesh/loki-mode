# Model Selection & Task Tool

## Multi-Provider Support (v5.0.0)

Loki Mode supports three AI providers. Claude has full features; Codex and Gemini run in **degraded mode** (sequential execution only, no Task tool, no parallel agents).

| Provider | Full Features | Degraded | CLI Flag |
|----------|---------------|----------|----------|
| **Claude Code** | Yes | No | `--provider claude` (default) |
| **OpenAI Codex CLI** | No | Yes | `--provider codex` |
| **Google Gemini CLI** | No | Yes | `--provider gemini` |

**Degraded mode limitations:**
- No Task tool (cannot spawn subagents)
- No parallel execution (sequential RARV cycle only)
- No MCP server integration (Codex has MCP support but not yet integrated with Loki)
- Single model with parameter adjustment (effort/thinking level)

---

## Abstract Model Tiers

**Default (v5.3.0):** Haiku disabled for quality. All tasks use Opus or Sonnet.

| Tier | Purpose | Claude (default) | Claude (--allow-haiku) | Codex | Gemini |
|------|---------|------------------|------------------------|-------|--------|
| **planning** | PRD analysis, architecture, system design | opus | opus | effort=xhigh | thinking=high |
| **development** | Feature implementation, complex bugs, tests | opus | sonnet | effort=high | thinking=medium |
| **fast** | Unit tests, docs, linting, simple tasks | sonnet | haiku | effort=low | thinking=low |

### Enabling Haiku

To enable Haiku for fast-tier tasks (cost optimization at potential quality trade-off):

```bash
# Via environment variable
LOKI_ALLOW_HAIKU=true ./autonomy/run.sh ./prd.md

# Via CLI flag
./autonomy/run.sh --allow-haiku ./prd.md

# Via loki CLI wrapper
loki start --allow-haiku ./prd.md
```

When Haiku is enabled:
- Development tier uses Sonnet (instead of Opus)
- Fast tier uses Haiku (instead of Sonnet)
- Planning tier always uses Opus (unchanged)

---

## Model Selection by SDLC Phase

| Tier | SDLC Phases | Examples |
|------|-------------|----------|
| **planning** | Bootstrap, Discovery, Architecture | PRD analysis, system design, technology selection, API contracts |
| **development** | Development, QA, Deployment | Feature implementation, complex bugs, integration/E2E tests, code review, deployment |
| **fast** | All other operations (parallel for Claude) | Unit tests, docs, bash commands, linting, monitoring |

**Claude-specific model names:** opus, sonnet, haiku (haiku requires --allow-haiku flag)
**Codex effort levels:** xhigh, high, medium, low
**Gemini thinking levels:** high, medium, low

## Task Tool Examples (Claude Only)

**NOTE:** Task tool is Claude-specific. Codex and Gemini run in degraded mode without subagents.

```python
# Planning tier (opus) for Bootstrap, Discovery, Architecture
Task(subagent_type="Plan", model="opus", description="Design system architecture", prompt="...")
Task(subagent_type="Plan", model="opus", description="Analyze PRD requirements", prompt="...")

# Development tier (sonnet) for Development, QA, and Deployment
Task(subagent_type="general-purpose", model="sonnet", description="Implement API endpoint", prompt="...")
Task(subagent_type="general-purpose", model="sonnet", description="Write integration tests", prompt="...")
Task(subagent_type="general-purpose", model="sonnet", description="Deploy to production", prompt="...")

# Fast tier (haiku) for everything else (PREFER for parallelization)
Task(subagent_type="general-purpose", model="haiku", description="Run unit tests", prompt="...")
Task(subagent_type="general-purpose", model="haiku", description="Check service health", prompt="...")
```

### Provider Detection in Code

```bash
# In run.sh, check provider before using Task tool
if [ "${PROVIDER_HAS_TASK_TOOL:-false}" = "true" ]; then
    # Claude: Use Task tool with parallel agents
    Task(model="haiku", description="Run tests", prompt="...")
else
    # Codex/Gemini: Run sequentially without subagents
    # Execute RARV cycle in main thread
fi
```

## Task Categories

**Opus (Bootstrap -> Architecture - Planning ONLY):**
- Bootstrap: Project setup, dependency analysis, environment configuration
- Discovery: PRD analysis, requirement extraction, gap identification
- Architecture: System design, technology selection, schema design, API contracts

**Sonnet (Development -> Deployment):**
- Development: Feature implementation, API endpoints, complex bug fixes, database migrations
- QA: Integration tests, E2E tests, security scanning, performance testing, code review
- Deployment: Release automation, infrastructure provisioning, monitoring setup

**Haiku (Operations - Use Extensively in Parallel):**
- Writing/running unit tests
- Generating documentation
- Running bash commands (npm install, git operations)
- Simple bug fixes (typos, imports, formatting)
- File operations, linting, static analysis
- Monitoring, health checks, log analysis

## Parallelization Strategy (Claude Only)

**NOTE:** Parallelization requires Task tool, which is Claude-specific. Codex and Gemini run sequentially.

```python
# Claude: Launch 10+ Haiku agents in parallel for unit test suite
for test_file in test_files:
    Task(subagent_type="general-purpose", model="haiku",
         description=f"Run unit tests: {test_file}",
         run_in_background=True)

# Codex/Gemini: Run tests sequentially (no parallelization)
for test_file in test_files:
    run_test(test_file)  # Sequential execution
```

## Extended Thinking Mode

**Use thinking prefixes for complex planning:**

| Prefix | When to Use | Example |
|--------|-------------|---------|
| `"think"` | Standard planning | Architecture outlines, feature scoping |
| `"think hard"` | Complex decisions | System design, trade-off analysis |
| `"ultrathink"` | Critical/ambiguous | Multi-service architecture, security design |

```python
Task(
    subagent_type="Plan",
    model="opus",
    description="Design auth architecture",
    prompt="think hard about the authentication architecture. Consider OAuth vs JWT..."
)
```

**When to use:** Discovery, Architecture, Critical decisions
**When NOT to use:** Haiku tasks, repetitive work, obvious implementations

### Claude Adaptive Thinking (Effort Parameter)

Claude models support an `effort` parameter that controls reasoning depth without requiring thinking prefixes. This is separate from extended thinking and applies at the API level.

| Effort Level | When to Use | Token Impact |
|--------------|-------------|--------------|
| `low` | Simple, well-defined tasks | Minimal reasoning tokens |
| `medium` | Standard tasks (default) | Balanced reasoning |
| `high` | Complex multi-step tasks | Extended reasoning |
| `max` | Critical decisions, architecture | Maximum reasoning depth |

**Note:** The effort parameter and thinking prefixes serve different purposes. Effort controls the model's internal reasoning budget; thinking prefixes guide the structure of the response.

### Codex --full-auto Flag

Codex CLI v0.98.0 supports `--full-auto` as the recommended autonomous mode flag, replacing the verbose `exec --dangerously-bypass-approvals-and-sandbox` invocation:

```bash
# Recommended (v0.98.0+)
codex --full-auto "$prompt"

# Legacy (still supported)
codex exec --dangerously-bypass-approvals-and-sandbox "$prompt"
```

## Prompt Repetition for Haiku

**For Haiku on structured tasks, repeat prompts 2x to improve accuracy 4-5x.**

```python
base_prompt = "Run unit tests in tests/ directory and report results"
repeated_prompt = f"{base_prompt}\n\n{base_prompt}"  # 2x repetition
Task(model="haiku", description="Run unit tests", prompt=repeated_prompt)
```

**Research:** Accuracy improves from 21.33% to 97.33% (arXiv 2512.14982v1)

**When to apply:** Unit tests, linting, parsing, list operations
**When NOT to apply:** Opus/Sonnet, creative tasks, complex reasoning

## Advanced Parameters

**Background Agents:**
```python
Task(description="Long analysis task", run_in_background=True, prompt="...")
# Returns immediately with output_file path
```

**Agent Resumption:**
```python
result = Task(description="Complex refactor", prompt="...")
# Later: resume with agent_id
Task(resume="agent-abc123", prompt="Continue from where you left off")
```

## Confidence-Based Routing

| Confidence | Tier | Behavior |
|------------|------|----------|
| >= 0.95 | Auto-Approve | Direct execution, no review |
| 0.70-0.95 | Direct + Review | Execute then validate |
| 0.40-0.70 | Supervisor Mode | Full coordination with review |
| < 0.40 | Human Escalation | Too uncertain |

```python
# Simple tasks -> Direct dispatch to Haiku
Task(model="haiku", description="Fix import in utils.py", prompt="...")

# Complex tasks -> Supervisor orchestration
Task(description="Implement user authentication with OAuth", prompt="...")
```

## Tiered Agent Escalation Triggers

*Inspired by [oh-my-claudecode](https://github.com/Yeachan-Heo/oh-my-claudecode) tiered architecture.*

**Tier Mapping:** LOW=fast=Haiku, MEDIUM=development=Sonnet, HIGH=planning=Opus. This section uses LOW/MEDIUM/HIGH for clarity in escalation context.

Explicit signals that determine when to escalate from one tier to another. These triggers enable automatic tier selection based on task characteristics and runtime conditions.

### Tier Definitions

| Tier | Model | Cost | Speed | Use Case |
|------|-------|------|-------|----------|
| **LOW** | Haiku | Lowest | Fastest | Simple, repetitive, well-defined tasks |
| **MEDIUM** | Sonnet | Medium | Balanced | Complex implementation, testing, debugging |
| **HIGH** | Opus | Highest | Slowest | Critical decisions, architecture, security |

### Automatic Escalation Triggers

#### LOW -> MEDIUM Escalation

Escalate from Haiku to Sonnet when:

| Trigger | Threshold | Rationale |
|---------|-----------|-----------|
| Error count | > 2 consecutive failures | Haiku struggling with complexity |
| File count | > 5 files modified | Cross-cutting changes need context |
| Lines changed | > 200 lines | Large changes need careful review |
| Test failures | > 3 failing tests | Need deeper debugging |
| Dependency changes | Any package.json/requirements.txt | Dependency resolution is complex |
| Retry attempts | > 1 retry on same task | Task too complex for current tier |

```python
# Example: Auto-escalate on repeated failures
if task.error_count > 2:
    task.escalate(to="sonnet", reason="Multiple failures indicate complexity")
```

#### MEDIUM -> HIGH Escalation

Escalate from Sonnet to Opus when:

| Trigger | Threshold | Rationale |
|---------|-----------|-----------|
| Error count | > 3 consecutive failures | Even Sonnet struggling |
| Complexity score | > 15 cyclomatic | Highly complex logic needs planning |
| Architecture files | Any changes to core/* | Architecture decisions are critical |
| Breaking changes | API contract modifications | Need careful impact analysis |
| Performance issues | > 2x baseline regression | Need optimization strategy |
| Integration scope | > 3 services affected | Cross-service coordination |

```python
# Example: Auto-escalate for architecture changes
if "core/" in modified_files or "architecture" in task.tags:
    task.escalate(to="opus", reason="Architecture changes require planning tier")
```

#### HIGH -> HUMAN Escalation (Terminal)

When even Opus fails, escalate to human intervention:

| Trigger | Threshold | Action |
|---------|-----------|--------|
| Error count | > 5 consecutive at HIGH tier | Create `.loki/signals/HUMAN_REVIEW_NEEDED` |
| Ambiguous requirements | Cannot determine correct behavior | Create signal with specific questions |
| External dependencies | Blocked on third-party API/service | Document blocker, pause task |
| Ethical concerns | Task may violate principles | Halt immediately, document concern |

```python
# Terminal escalation - no automated recovery
if task.tier == "opus" and task.error_count > 5:
    create_signal(".loki/signals/HUMAN_REVIEW_NEEDED", {
        "task_id": task.id,
        "reason": "5+ failures at planning tier",
        "attempts": task.attempt_log,
        "recommendation": "Manual investigation required"
    })
    task.status = "blocked_on_human"
```

### Threshold Rationale

Why these specific thresholds? Each value is grounded in research or proven heuristics:

| Threshold | Value | Justification |
|-----------|-------|---------------|
| **Error count > 2** (LOW->MEDIUM) | 3 attempts | "Two strikes" principle: first failure may be transient (network, timeout), second suggests genuine complexity. Third attempt warrants escalation to capable tier. |
| **Error count > 3** (MEDIUM->HIGH) | 4 attempts | Sonnet has significantly more capability than Haiku, so allow one additional attempt before expensive Opus escalation. Balances cost vs. success rate. |
| **Error count > 5** (HIGH->HUMAN) | 6 attempts | Planning tier (Opus) exhausted all automated reasoning options. Further attempts unlikely to succeed; human judgment required. |
| **File count > 5** | 6+ files | Cross-cutting changes affecting 5+ files require holistic understanding of system interactions. Research on code review effectiveness shows reviewer accuracy drops with multi-file changes. |
| **Lines changed > 200** | 200 LOC | Studies on code review effectiveness (Cisco, SmartBear) show review quality degrades significantly above 200-400 LOC. Microsoft's internal research suggests 200 LOC as optimal review size. |
| **Cyclomatic complexity > 15** | McCabe threshold | Industry standard since McCabe (1976). NIST considers >15 "high risk." Many static analysis tools default to this threshold. |
| **Test failures > 3** | 4+ failures | Distinguishes isolated flakiness from systemic issues. Single test failure may be flaky; 3+ indicates deeper problems requiring debugging capability. |
| **Retry attempts > 1** | 2+ retries | First retry accounts for transient issues. Second retry at same tier signals fundamental mismatch between task complexity and model capability. |
| **5+ successful tasks** (de-escalation) | Success streak | Sustained success indicates task complexity has reduced or model has adapted. Safe to try lower-cost tier with quick re-escalation if needed. |

**References:**
- McCabe, T.J. (1976). "A Complexity Measure." IEEE Transactions on Software Engineering.
- Cisco Code Review Study: Optimal review size 200-400 LOC for defect detection.
- SmartBear "Best Kept Secrets of Peer Code Review": Review effectiveness drops 50% above 400 LOC.

### Always-HIGH Triggers (No Escalation Path)

These tasks ALWAYS start at HIGH tier (Opus):

| Category | Examples | Rationale |
|----------|----------|-----------|
| **Security** | Auth, encryption, secrets, RBAC | Security cannot be compromised |
| **Architecture** | System design, service boundaries, data models | Foundation decisions |
| **Breaking Changes** | API versioning, schema migrations, deprecations | High blast radius |
| **Production Incidents** | Outage response, data corruption, rollback | Critical impact |
| **Compliance** | GDPR, HIPAA, SOC2 implementations | Regulatory requirements |
| **Cost Decisions** | Infrastructure scaling, vendor selection | Financial impact |

```python
# Example: Security tasks always use Opus
ALWAYS_HIGH_PATTERNS = [
    r"(auth|security|encrypt|secret|credential|token|password)",
    r"(architecture|system.design|schema.migration)",
    r"(production|incident|outage|rollback)",
    r"(compliance|gdpr|hipaa|soc2|pci)",
]

if any(re.search(p, task.description, re.I) for p in ALWAYS_HIGH_PATTERNS):
    task.tier = "HIGH"  # No escalation, start at Opus
```

### De-escalation Triggers (Cost Optimization)

De-escalate to lower tier when conditions improve:

| Trigger | Action | Rationale |
|---------|--------|-----------|
| 5+ successful tasks at tier | Consider de-escalation | Complexity resolved |
| Single-file changes | Use LOW for isolated fixes | Simple scope |
| Test-only changes | Use LOW for unit tests | Well-defined output |
| Documentation | Use LOW for docs/comments | Low risk |

```python
# Example: De-escalate when task becomes routine
if task.success_streak >= 5 and task.scope == "single_file":
    task.deescalate(to="haiku", reason="Task scope is simple and stable")
```

### Escalation Flow Diagram

```
                    +------------------+
                    |   Task Arrives   |
                    +--------+---------+
                             |
                    +--------v---------+
                    | Check ALWAYS_HIGH |
                    +--------+---------+
                             |
              +--------------+--------------+
              |                             |
        [matches]                     [no match]
              |                             |
     +--------v--------+           +--------v--------+
     |   START: HIGH   |           |   START: LOW    |
     |    (Opus)       |           |    (Haiku)      |
     +-----------------+           +--------+--------+
                                            |
                                   +--------v--------+
                                   |  Execute Task   |
                                   +--------+--------+
                                            |
                              +-------------+-------------+
                              |                           |
                        [success]                   [failure]
                              |                           |
                    +---------v---------+       +---------v---------+
                    | Continue at tier  |       | Check thresholds  |
                    +-------------------+       +---------+---------+
                                                          |
                                              +-----------+-----------+
                                              |                       |
                                        [under limit]           [over limit]
                                              |                       |
                                     +--------v--------+     +--------v--------+
                                     |  Retry at tier  |     | ESCALATE tier   |
                                     +-----------------+     +-----------------+
```

### Implementation in Provider Context

For Claude (full features):
```python
# Task tool with tier awareness
Task(
    model=determine_tier(task),  # Returns "opus", "sonnet", or "haiku"
    description=task.description,
    prompt=task.prompt,
    metadata={"escalation_count": task.escalation_count}
)
```

For Codex/Gemini (degraded mode):
```python
# Map tiers to effort/thinking levels
TIER_MAPPING = {
    "codex": {"HIGH": "xhigh", "MEDIUM": "high", "LOW": "low"},
    "gemini": {"HIGH": "high", "MEDIUM": "medium", "LOW": "low"},
}
effort_level = TIER_MAPPING[provider][determine_tier(task)]
```

### Metrics for Tier Optimization

Track these metrics to tune escalation thresholds:

| Metric | Purpose | Target |
|--------|---------|--------|
| Escalation rate | How often tasks escalate | < 20% |
| First-tier success | Tasks completed without escalation | > 80% |
| Cost per task | Average token cost by tier | Minimize |
| Time to completion | Including escalation delays | Minimize |
| Quality score | Post-completion review score | > 4.0/5.0 |

```python
# Log escalation events for analysis
log_escalation(
    task_id=task.id,
    from_tier=current_tier,
    to_tier=new_tier,
    trigger=trigger_reason,
    error_count=task.error_count,
    timestamp=now()
)
```
