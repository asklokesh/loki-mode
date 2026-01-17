---
name: loki-mode
description: Multi-agent autonomous startup system for Claude Code. Triggers on "Loki Mode". Orchestrates 100+ specialized agents across engineering, QA, DevOps, security, data/ML, business operations, marketing, HR, and customer success. Takes PRD to fully deployed, revenue-generating product with zero human intervention. Features Task tool for subagent dispatch, parallel code review with 3 specialized reviewers, severity-based issue triage, distributed task queue with dead letter handling, automatic deployment to cloud providers, A/B testing, customer feedback loops, incident response, circuit breakers, and self-healing. Handles rate limits via distributed state checkpoints and auto-resume with exponential backoff. Requires --dangerously-skip-permissions flag.
---

# Loki Mode - Multi-Agent Autonomous Startup System

> **Version 2.36.6** | PRD to Production | Zero Human Intervention
> Research-enhanced: OpenAI SDK, DeepMind, Anthropic, AWS Bedrock, Agent SDK, HN Production (2025)

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
**Guardrails:** `Input Guard (BLOCK) -> Execute -> Output Guard (VALIDATE)` (OpenAI SDK)
**Tripwires:** `Validation fails -> Halt execution -> Escalate or retry`
**Fallbacks:** `Try primary -> Model fallback -> Workflow fallback -> Human escalation`
**Explore-Plan-Code:** `Research files -> Create plan (NO CODE) -> Execute plan` (Anthropic)
**Self-Verification:** `Code -> Test -> Fail -> Learn -> Update CONTINUITY.md -> Retry`
**Constitutional Self-Critique:** `Generate -> Critique against principles -> Revise` (Anthropic)
**Memory Consolidation:** `Episodic (trace) -> Pattern Extraction -> Semantic (knowledge)`
**Hierarchical Reasoning:** `High-level planner -> Skill selection -> Local executor` (DeepMind)
**Tool Orchestration:** `Classify Complexity -> Select Agents -> Track Efficiency -> Reward Learning`
**Debate Verification:** `Proponent defends -> Opponent challenges -> Synthesize` (DeepMind)
**Handoff Callbacks:** `on_handoff -> Pre-fetch context -> Transfer with data` (OpenAI SDK)
**Narrow Scope:** `3-5 steps max -> Human review -> Continue` (HN Production)
**Context Curation:** `Manual selection -> Focused context -> Fresh per task` (HN Production)
**Deterministic Validation:** `LLM output -> Rule-based checks -> Retry or approve` (HN Production)
**Routing Mode:** `Simple task -> Direct dispatch | Complex task -> Supervisor orchestration` (AWS Bedrock)
**E2E Browser Testing:** `Playwright MCP -> Automate browser -> Verify UI features visually` (Anthropic Harness)

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
6. **NEVER edit `autonomy/run.sh` while running** - Editing a running bash script corrupts execution (bash reads incrementally, not all at once). If you need to fix run.sh, note it in CONTINUITY.md for the next session.
7. **ONE FEATURE AT A TIME** - Work on exactly one feature per iteration. Complete it, commit it, verify it, then move to the next. Prevents over-commitment and ensures clean progress tracking. (Anthropic Harness Pattern)

### Protected Files (Do Not Edit While Running)

These files are part of the running Loki Mode process. Editing them will crash the session:

| File | Reason |
|------|--------|
| `~/.claude/skills/loki-mode/autonomy/run.sh` | Currently executing bash script |
| `.loki/dashboard/*` | Served by active HTTP server |

If bugs are found in these files, document them in `.loki/CONTINUITY.md` under "Pending Fixes" for manual repair after the session ends.

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

### Prompt Repetition for Haiku (2026 Research - arXiv 2512.14982v1)

**For Haiku agents on structured tasks, repeat prompts 2x to improve accuracy 4-5x with zero latency cost.**

```python
# Haiku agents benefit from prompt repetition on structured tasks
base_prompt = "Run unit tests in tests/ directory and report results"
repeated_prompt = f"{base_prompt}\n\n{base_prompt}"  # 2x repetition

Task(model="haiku", description="Run unit tests", prompt=repeated_prompt)
```

**Research Finding:** Accuracy improves from 21.33% → 97.33% on position-dependent tasks (Gemini 2.0 Flash-Lite benchmark).

**When to apply:**
- Unit tests, linting, formatting (structured tasks)
- Parsing, extraction, list operations
- Position-dependent operations

**When NOT to apply:**
- Opus/Sonnet (reasoning models see no benefit)
- Creative/open-ended tasks
- Complex reasoning or planning

See `references/prompt-repetition.md` and `agent-skills/prompt-optimization/` for full implementation.

### Advanced Task Tool Parameters

**Background Agents:**
```python
# Launch background agent - returns immediately with output_file path
Task(description="Long analysis task", run_in_background=True, prompt="...")
# Output truncated to 30K chars - use Read tool to check full output file
```

**Agent Resumption (for interrupted/long-running tasks):**
```python
# First call returns agent_id
result = Task(description="Complex refactor", prompt="...")
# agent_id from result can resume later
Task(resume="agent-abc123", prompt="Continue from where you left off")
```

**When to use `resume`:**
- Context window limits reached mid-task
- Rate limit recovery
- Multi-session work on same task
- Checkpoint/restore for critical operations

### Routing Mode Optimization (Enhanced with Confidence-Based Routing)

**Four-tier routing based on confidence scores - optimizes speed vs safety:**

| Confidence | Tier | Behavior |
|------------|------|----------|
| **>= 0.95** | Auto-Approve | Fastest: direct execution, no review |
| **0.70-0.95** | Direct + Review | Fast with safety net: execute then validate |
| **0.40-0.70** | Supervisor Mode | Full coordination with mandatory review |
| **< 0.40** | Human Escalation | Too uncertain, requires human decision |

**Confidence Calculation:**
```python
confidence = weighted_average({
    "requirement_clarity": 0.30,      # How clear are the requirements?
    "technical_feasibility": 0.25,    # Can we do this with known patterns?
    "resource_availability": 0.15,    # Do we have APIs, agents, budget?
    "historical_success": 0.20,       # How often do similar tasks succeed?
    "complexity_match": 0.10          # Does complexity match agent capability?
})
```

**Decision Logic:**
```
Task Received → Calculate Confidence → Route by Tier

Tier 1 (>= 0.95): "Run linter" → Auto-execute with Haiku
Tier 2 (0.70-0.95): "Add CRUD endpoint" → Direct + automated review
Tier 3 (0.40-0.70): "Design auth architecture" → Full supervisor orchestration
Tier 4 (< 0.40): "Choose payment provider" → Escalate to human
```

See `references/confidence-routing.md` and `agent-skills/confidence-routing/` for full implementation.

**Direct Routing Examples (Skip Orchestration):**
```python
# Simple tasks -> Direct dispatch to Haiku
Task(model="haiku", description="Fix import in utils.py", prompt="...")       # Direct
Task(model="haiku", description="Run linter on src/", prompt="...")           # Direct
Task(model="haiku", description="Generate docstring for function", prompt="...")  # Direct

# Complex tasks -> Supervisor orchestration (default Sonnet)
Task(description="Implement user authentication with OAuth", prompt="...")    # Supervisor
Task(description="Refactor database layer for performance", prompt="...")     # Supervisor
```

**Context Depth by Routing Mode:**
- **Direct Routing:** Minimal context - just the task and relevant file(s)
- **Supervisor Mode:** Full context - CONTINUITY.md, architectural decisions, dependencies

> "Keep in mind, complex task histories might confuse simpler subagents." - AWS Best Practices

### E2E Testing with Playwright MCP (Anthropic Harness Pattern)

**Critical:** Features are NOT complete until verified via browser automation.

```python
# Enable Playwright MCP for E2E testing
# In settings or via mcp_servers config:
mcp_servers = {
    "playwright": {"command": "npx", "args": ["@playwright/mcp@latest"]}
}

# Agent can then automate browser to verify features work visually
```

**E2E Verification Flow:**
1. Feature implemented and unit tests pass
2. Start dev server via init script
3. Use Playwright MCP to automate browser
4. Verify UI renders correctly
5. Test user interactions (clicks, forms, navigation)
6. Only mark feature complete after visual verification

> "Claude mostly did well at verifying features end-to-end once explicitly prompted to use browser automation tools." - Anthropic Engineering

**Note:** Playwright cannot detect browser-native alert modals. Use custom UI for confirmations.

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

## Code Transformation Agent (Amazon Q Pattern)

**Dedicated workflows for legacy modernization - narrow scope, deterministic verification.**

```yaml
transformation_agent:
  purpose: "Autonomous code migration without human intervention"
  trigger: "/transform or PRD mentions migration/upgrade/modernization"

  workflows:
    language_upgrade:
      steps:
        1. Analyze current version and dependencies
        2. Identify deprecated APIs and breaking changes
        3. Generate migration plan with risk assessment
        4. Apply transformations incrementally
        5. Run compatibility tests after each change
        6. Validate performance benchmarks
      examples:
        - "Java 8 to Java 21"
        - "Python 2 to Python 3"
        - "Node 16 to Node 22"

    database_migration:
      steps:
        1. Schema diff analysis (source vs target)
        2. SQL dialect conversion rules
        3. Data type mapping
        4. Generate migration scripts
        5. Run verification queries
        6. Validate data integrity
      examples:
        - "Oracle to PostgreSQL"
        - "MySQL to PostgreSQL"
        - "MongoDB to PostgreSQL"

    framework_modernization:
      steps:
        1. Dependency audit and compatibility matrix
        2. Breaking change detection
        3. Code pattern updates (deprecated -> modern)
        4. Test suite adaptation
        5. Performance regression testing
      examples:
        - "Angular to React"
        - ".NET Framework to .NET Core"
        - "Express to Fastify"

  success_criteria:
    - All existing tests pass
    - No regression in performance (< 5% degradation)
    - Static analysis clean
    - API compatibility maintained (or documented breaks)
```

**Why this fits autonomous operation:**
- Narrow scope with clear boundaries
- Deterministic success criteria (tests pass, benchmarks met)
- No subjective judgment required
- High value, repetitive tasks

---

## Artifact Generation (Antigravity Pattern)

**Auto-generate verifiable deliverables for audit trail without human intervention.**

```yaml
artifact_generation:
  purpose: "Prove autonomous work without line-by-line code review"
  location: ".loki/artifacts/{date}/{phase}/"

  triggers:
    on_phase_complete:
      - verification_report: "Summary of tests passed, coverage, static analysis"
      - architecture_diff: "Mermaid diagram showing changes from previous state"
      - decision_log: "Key decisions made with rationale (from CONTINUITY.md)"

    on_feature_complete:
      - screenshot: "Key UI states captured via Playwright"
      - api_diff: "OpenAPI spec changes highlighted"
      - test_summary: "Unit, integration, E2E results"

    on_deployment:
      - release_notes: "Auto-generated from commit history"
      - rollback_plan: "Steps to revert if issues detected"
      - monitoring_baseline: "Expected metrics post-deploy"

  artifact_types:
    verification_report:
      format: "markdown"
      contents:
        - Phase name and duration
        - Tasks completed (from queue)
        - Quality gate results (7 gates)
        - Coverage metrics
        - Known issues / TODOs

    architecture_diff:
      format: "mermaid diagram"
      contents:
        - Components added/modified/removed
        - Dependency changes
        - Data flow changes

    screenshot_gallery:
      format: "png + markdown index"
      capture:
        - Critical user flows
        - Error states
        - Before/after comparisons
```

**Why this matters for autonomous operation:**
- Creates audit trail without human during execution
- Enables async human review if needed later
- Proves work quality through outcomes, not code inspection
- Aligns with "outcome verification" over "line-by-line auditing"

---

## Quality Gates

**Never ship code without passing all quality gates:**

1. **Input Guardrails** - Validate scope, detect injection, check constraints (OpenAI SDK pattern)
2. **Static Analysis** - CodeQL, ESLint/Pylint, type checking
3. **Blind Review System** - 3 reviewers in parallel, no visibility of each other's findings
4. **Anti-Sycophancy Check** - If unanimous approval, run Devil's Advocate reviewer
5. **Output Guardrails** - Validate code quality, spec compliance, no secrets (tripwire on fail)
6. **Severity-Based Blocking** - Critical/High/Medium = BLOCK; Low/Cosmetic = TODO comment
7. **Test Coverage Gates** - Unit: 100% pass, >80% coverage; Integration: 100% pass

**Guardrails Execution Modes:**
- **Blocking**: Guardrail completes before agent starts (use for expensive operations)
- **Parallel**: Guardrail runs with agent (use for fast checks, accept token loss risk)

**Research insight:** Blind review + Devil's Advocate reduces false positives by 30% (CONSENSAGENT, 2025).
**OpenAI insight:** "Layered defense - multiple specialized guardrails create resilient agents."

See `references/quality-control.md` and `references/openai-patterns.md` for details.

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
- **NEVER** dispatch multiple implementation subagents in parallel WITHOUT worktree isolation (use git worktrees for safe parallel development - see Git Worktree Isolation section)
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

**Based on OpenAI Agent Safety Patterns:**

### Model-Level Fallbacks
```
opus -> sonnet -> haiku (if rate limited or unavailable)
```

### Workflow-Level Fallbacks
```
Full workflow fails -> Simplified workflow -> Decompose to subtasks -> Human escalation
```

### Human Escalation Triggers

| Trigger | Action |
|---------|--------|
| retry_count > 3 | Pause and escalate |
| domain in [payments, auth, pii] | Require approval |
| confidence_score < 0.6 | Pause and escalate |
| wall_time > expected * 3 | Pause and escalate |
| tokens_used > budget * 0.8 | Pause and escalate |

See `references/openai-patterns.md` for full fallback implementation.

---

## AGENTS.md Integration

**Read target project's AGENTS.md if exists** (OpenAI/AAIF standard):

```
Context Priority:
1. AGENTS.md (closest to current file)
2. CLAUDE.md (Claude-specific)
3. .loki/CONTINUITY.md (session state)
4. Package docs
5. README.md
```

---

## Constitutional AI Principles (Anthropic)

**Self-critique against explicit principles, not just learned preferences.**

### Loki Mode Constitution

```yaml
core_principles:
  - "Never delete production data without explicit backup"
  - "Never commit secrets or credentials to version control"
  - "Never bypass quality gates for speed"
  - "Always verify tests pass before marking task complete"
  - "Never claim completion without running actual tests"
  - "Prefer simple solutions over clever ones"
  - "Document decisions, not just code"
  - "When unsure, reject action or flag for review"
```

### Self-Critique Workflow

```
1. Generate response/code
2. Critique against each principle
3. Revise if any principle violated
4. Only then proceed with action
```

See `references/lab-research-patterns.md` for Constitutional AI implementation.

---

## Debate-Based Verification (DeepMind)

**For critical changes, use structured debate between AI critics.**

```
Proponent (defender)  -->  Presents proposal with evidence
         |
         v
Opponent (challenger) -->  Finds flaws, challenges claims
         |
         v
Synthesizer           -->  Weighs arguments, produces verdict
         |
         v
If disagreement persists --> Escalate to human
```

**Use for:** Architecture decisions, security-sensitive changes, major refactors.

See `references/lab-research-patterns.md` for debate verification details.

---

## Property-Based Testing (Kiro Pattern)

**Auto-generate edge case tests from specifications.**

```yaml
property_based_testing:
  purpose: "Verify code meets spec constraints with hundreds of random inputs"
  tools: "fast-check (JS/TS), hypothesis (Python), QuickCheck (Haskell)"

  extract_properties_from:
    - OpenAPI schema: "minLength, maxLength, pattern, enum, minimum, maximum"
    - Business rules: "requirements.md invariants"
    - Data models: "TypeScript interfaces, DB constraints"

  examples:
    - "email field always matches email regex"
    - "price is never negative"
    - "created_at <= updated_at always"
    - "array length never exceeds maxItems"

  integration:
    phase: "QA (after unit tests, before integration tests)"
    command: "npm run test:property"
    failure_action: "Add to Mistakes & Learnings, fix, re-run"
```

**When to use:**
- After implementing API endpoints (validate against OpenAPI)
- After data model changes (validate invariants)
- Before deployment (edge case regression)

---

## Event-Driven Hooks (Kiro Pattern)

**Trigger quality checks on file operations, not just at phase boundaries.**

```yaml
hooks_system:
  location: ".loki/hooks/"
  purpose: "Catch issues during implementation, not after"

  triggers:
    on_file_write:
      - lint: "npx eslint --fix {file}"
      - typecheck: "npx tsc --noEmit"
      - secrets_scan: "detect-secrets scan {file}"

    on_task_complete:
      - contract_test: "npm run test:contract"
      - spec_lint: "spectral lint .loki/specs/openapi.yaml"

    on_phase_complete:
      - memory_consolidate: "Extract patterns to semantic memory"
      - metrics_update: "Log efficiency scores"
      - checkpoint: "git commit with phase summary"

  benefits:
    - "Catches issues 5-10x earlier than phase-end review"
    - "Reduces rework cycles"
    - "Aligns with Constitutional AI (continuous self-critique)"
```

**Implementation:**
```bash
# After writing any file, run quality hooks
echo "Running on_file_write hooks..."
npx eslint --fix "$MODIFIED_FILE"
npx tsc --noEmit
detect-secrets scan "$MODIFIED_FILE" || echo "ALERT: Potential secret detected"
```

---

## Review-to-Memory Learning (Kiro Pattern)

**Pipe code review findings into semantic memory to prevent repeat mistakes.**

```yaml
review_learning:
  trigger: "After every code review cycle"
  purpose: "Convert review findings into persistent anti-patterns"

  workflow:
    1. Complete 3-reviewer blind review
    2. Aggregate findings by severity
    3. For each Critical/High/Medium finding:
       - Extract pattern description
       - Document prevention strategy
       - Save to .loki/memory/semantic/anti-patterns/
    4. Link to episodic memory for traceability

  output_format:
    pattern: "Using any instead of proper TypeScript types"
    category: "type-safety"
    severity: "high"
    prevention: "Always define explicit interfaces for API responses"
    source: "review-2026-01-15-auth-endpoint"
    confidence: 0.9

  query_before_implementation:
    - "Check anti-patterns before writing new code"
    - "Prompt repetition includes recent learnings"
```

**Why this matters for autonomous operation:**
- Same mistakes don't repeat (continuous improvement)
- Review findings are high-signal learning opportunities
- Builds institutional knowledge without human curation

---

## Production Patterns (HN 2025)

**Battle-tested insights from practitioners building real systems.**

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

### Confidence-Based Routing

```
confidence >= 0.95  -->  Auto-approve with audit log
confidence >= 0.70  -->  Quick human review
confidence >= 0.40  -->  Detailed human review
confidence < 0.40   -->  Escalate immediately
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

### Proactive Context Management (OpenCode Pattern)

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
    - Old tool outputs -> summary in CONTINUITY.md
    - Verbose file reads -> key findings only
    - Debugging attempts -> learnings extracted

  signal: ".loki/signals/CONTEXT_CLEAR_REQUESTED"
  result: "Wrapper resets context, injects ledger state"
```

**When to request context reset:**
1. After 25+ iterations without reset
2. Multiple large file reads in session
3. Extensive debugging with many retries
4. Before starting new SDLC phase

**How to reset safely:**
1. Update CONTINUITY.md with current state
2. Extract any learnings to `.loki/memory/learnings/`
3. Save ledger at `.loki/memory/ledgers/LEDGER-orchestrator.md`
4. Create `.loki/signals/CONTEXT_CLEAR_REQUESTED`
5. Wrapper handles reset and re-injects essential state

### Sub-Agents for Context Isolation

**Use sub-agents to prevent token waste on noisy subtasks:**

```
Main agent (focused) --> Sub-agent (file search)
                     --> Sub-agent (test running)
                     --> Sub-agent (linting)
```

See `references/production-patterns.md` for full practitioner patterns.

### Git Worktree Isolation (Cursor Pattern)

**Enable safe parallel development with isolated worktrees:**

```yaml
worktree_isolation:
  purpose: "Allow multiple implementation agents to work in parallel without conflicts"
  max_parallel_agents: 4

  workflow:
    1_create: "git worktree add .loki/worktrees/agent-{id} -b agent-{id}-feature"
    2_implement: "Agent works in isolated worktree directory"
    3_test: "Run tests within worktree (isolated from main)"
    4_merge: "If tests pass: git checkout main && git merge agent-{id}-feature"
    5_cleanup: "git worktree remove .loki/worktrees/agent-{id} && git branch -d agent-{id}-feature"

  on_failure:
    - "git worktree remove .loki/worktrees/agent-{id}"
    - "git branch -D agent-{id}-feature"
    - "No impact on main branch"
```

**When to use worktree isolation:**
- Multiple independent features/fixes to implement
- Tasks that touch different files/modules
- When parallelization provides 2x+ speedup

**When NOT to use:**
- Tasks that modify same files (still conflicts)
- Quick single-file fixes (overhead not worth it)
- When worktree creation time > task time

**Parallel implementation example:**
```python
# Create isolated worktrees for parallel agents
agents = []
for task in independent_tasks[:4]:  # Max 4 parallel
    worktree_id = f"agent-{uuid4().hex[:8]}"
    # Agent will work in .loki/worktrees/{worktree_id}/
    Task(
        subagent_type="general-purpose",
        model="sonnet",
        description=f"Implement {task.name} in worktree",
        prompt=f"Work in .loki/worktrees/{worktree_id}/. {task.spec}",
        run_in_background=True
    )
    agents.append(worktree_id)

# After all complete: merge successful ones to main
```

### Atomic Checkpoint/Rollback (Cursor Pattern)

**Formalized checkpoint strategy for safe task execution:**

```yaml
checkpoint_strategy:
  before_task:
    - "git stash create 'checkpoint-{task_id}'"
    - "Save stash hash to .loki/state/checkpoints.json"

  on_success:
    - "git add -A && git commit -m 'Complete: {task_name}'"
    - "Clear checkpoint from checkpoints.json"

  on_failure:
    - "git stash pop (restore to checkpoint)"
    - "Log failure to .loki/memory/learnings/"
    - "Retry with learned context"

  rollback_command: "git checkout -- . && git clean -fd"
```

**Checkpoint before risky operations:**
1. Large refactors (10+ files)
2. Database migrations
3. Configuration changes
4. Dependency updates

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
| `references/openai-patterns.md` | OpenAI Agents SDK: guardrails, tripwires, handoffs, fallbacks |
| `references/lab-research-patterns.md` | DeepMind + Anthropic: Constitutional AI, debate, world models |
| `references/production-patterns.md` | HN 2025: What actually works in production, context engineering |
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

**Version:** 2.36.6 | **Lines:** ~1050 | **Research-Enhanced: 2026 Patterns (arXiv, HN, Labs, OpenCode, Cursor, Devin, Codex, Kiro, Antigravity, Amazon Q, RLM)**
