# Model Selection & Task Tool

## Model Selection by SDLC Phase

| Model | SDLC Phases | Examples |
|-------|-------------|----------|
| **Opus 4.5** | Bootstrap, Discovery, Architecture, Development | PRD analysis, system design, feature implementation, complex bug fixes |
| **Sonnet 4.5** | QA, Deployment | Integration/E2E tests, security scanning, deployment automation |
| **Haiku 4.5** | All other operations (parallel) | Unit tests, docs, bash commands, linting, monitoring |

## Task Tool Examples

```python
# Opus for Bootstrap, Discovery, Architecture, Development
Task(subagent_type="Plan", model="opus", description="Design system architecture", prompt="...")
Task(subagent_type="general-purpose", model="opus", description="Implement API endpoint", prompt="...")

# Sonnet for QA and Deployment
Task(subagent_type="general-purpose", model="sonnet", description="Write integration tests", prompt="...")
Task(subagent_type="general-purpose", model="sonnet", description="Deploy to production", prompt="...")

# Haiku for everything else (PREFER for parallelization)
Task(subagent_type="general-purpose", model="haiku", description="Run unit tests", prompt="...")
Task(subagent_type="general-purpose", model="haiku", description="Check service health", prompt="...")
```

## Task Categories

**Opus (Bootstrap -> Development):**
- Bootstrap: Project setup, dependency analysis, environment configuration
- Discovery: PRD analysis, requirement extraction, gap identification
- Architecture: System design, technology selection, schema design, API contracts
- Development: Feature implementation, API endpoints, complex bug fixes, database migrations

**Sonnet (QA -> Deployment):**
- QA: Integration tests, E2E tests, security scanning, performance testing
- Deployment: Release automation, infrastructure provisioning, monitoring setup

**Haiku (Operations - Use Extensively in Parallel):**
- Writing/running unit tests
- Generating documentation
- Running bash commands (npm install, git operations)
- Simple bug fixes (typos, imports, formatting)
- File operations, linting, static analysis
- Monitoring, health checks, log analysis

## Parallelization Strategy

```python
# Launch 10+ Haiku agents in parallel for unit test suite
for test_file in test_files:
    Task(subagent_type="general-purpose", model="haiku",
         description=f"Run unit tests: {test_file}",
         run_in_background=True)
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
