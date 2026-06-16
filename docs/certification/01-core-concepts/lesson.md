# Module 1: Core Concepts

## What is Loki Mode?

Loki Mode is a multi-agent autonomous system created by [Autonomi](https://www.autonomi.dev/). It takes a Product Requirements Document (PRD) and builds a fully deployed product with minimal human intervention. It supports three AI provider CLIs: Claude Code (full features), OpenAI Codex CLI (degraded mode), and Google Gemini CLI (degraded mode).

Loki Mode is installed as an npm package and invoked through the `loki` CLI or directly within Claude Code as a skill.

```bash
# Install
npm install -g loki-mode

# Verify installation
loki version

# Check system prerequisites
loki doctor

# Start with a PRD
loki start ./prd.md
```

When started, Loki Mode creates a `.loki/` directory in your project root that holds all state: task queues, session data, memory, metrics, and signals.

## The RARV Cycle

Every action in Loki Mode follows a strict four-step cycle called RARV:

1. **Reason** -- Determine the highest priority unblocked task from `.loki/queue/pending.json`
2. **Act** -- Execute the task: write code, run commands, commit atomically
3. **Reflect** -- Evaluate the outcome, log results
4. **Verify** -- Run tests, check build, validate against the specification

If verification passes, the task is marked complete and the cycle returns to Reason. If verification fails, the error is captured and the agent retries with a different approach. After 3 failures, it tries a simpler approach. After 5 failures, the task is moved to a dead-letter queue (`.loki/queue/dead-letter.json`) and the agent moves on.

```
REASON --> ACT --> REFLECT --> VERIFY
  ^                             |
  |         [PASS]              |
  +-----------------------------+
  |         [FAIL]
  +--- Retry (up to 5x) --> Dead Letter Queue
```

## Phase Transitions

Loki Mode organizes work into sequential phases. Each phase must pass all quality gates before the next begins:

```
BOOTSTRAP --> DISCOVERY --> ARCHITECTURE --> DEEPEN_PLAN --> INFRASTRUCTURE
    --> DEVELOPMENT --> QA --> DEPLOYMENT --> GROWTH
```

Not all phases run for every project. Complexity tiers determine which phases execute:

| Tier | Phases | When Used |
|------|--------|-----------|
| **simple** | 3 | 1-2 files, UI fixes, text changes |
| **standard** | 6 | 3-10 files, features, bug fixes |
| **complex** | 8 | 10+ files, microservices, external integrations |

The tier is auto-detected from the PRD or can be forced with:

```bash
loki start --simple ./prd.md    # Force simple tier
loki start --complex ./prd.md   # Force complex tier
```

Or via the environment variable `LOKI_COMPLEXITY=simple|standard|complex`.

## Agents

Loki Mode defines **41 specialized agent types** organized into **8 domains**:

| Domain | Agent Count | Examples |
|-------|-------------|----------|
| Engineering | 8 | frontend, backend, database, mobile, api, qa, perf, infra |
| Operations | 8 | devops, sre, security, monitor, incident, release, cost, compliance |
| Business | 8 | marketing, sales, finance, legal, support, hr, investor, partnerships |
| Data | 3 | ml, eng, analytics |
| Product | 3 | pm, design, techwriter |
| Growth | 4 | hacker, community, success, lifecycle |
| Review | 3 | code, business, security |
| Orchestration | 4 | (internal system agents) |

These agents are **roles defined through prompts**, not separate programs. They are implemented using the Claude Code Task tool with role-specific prompts:

```python
# Example: Creating a security reviewer agent
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
```

A simple project typically uses 5-10 agents. Complex projects use more as needed. The orchestrator spawns only the agents required for the current task.

Full agent type definitions are in `references/agent-types.md`.

## Quality Gates

Loki Mode enforces an 8-gate quality system. Code must pass all applicable gates before moving forward:

| Gate | Name | Purpose |
|------|------|---------|
| 1 | Static Analysis | CodeQL, ESLint/Pylint, type checking |
| 2 | Test Suite (pass/fail) | Red blocks; coverage % not measured this release |
| 3 | Blind Code Review (3-reviewer council + severity blocking) | 3 specialist reviewers in parallel, blind to each other; Critical/High = BLOCK; Medium/Low advisory |
| 4 | Anti-Sycophancy / Devil's Advocate | If reviewers unanimously approve, run a Devil's Advocate reviewer |
| 5 | Mock Integrity Detector | Flags tests that mock internal modules instead of real code |
| 6 | Test Mutation Detector | Detects assertion value changes alongside implementation changes |
| 7 | Documentation Coverage | README exists, docs freshness, API docs for packages |
| 8 | Magic Modules Debate | Spec-vs-implementation debate on generated Magic Modules |

A conditional backward-compatibility / legacy-healing auditor also runs in healing mode (not one of the 8 numbered gates).

The blind review system (Gate 3) selects 3 reviewers from a pool of 5 named specialists:

- **security-sentinel** -- OWASP Top 10, injection, auth, secrets
- **performance-oracle** -- N+1 queries, memory leaks, caching
- **architecture-strategist** -- SOLID, coupling, patterns (always included)
- **test-coverage-auditor** -- Missing tests, edge cases, error paths
- **dependency-analyst** -- Outdated packages, CVEs, license issues

The architecture-strategist is always one of the 3. The other 2 are selected by matching trigger keywords in the diff. Full details are in `skills/quality-gates.md`.

## Memory System

Loki Mode maintains three types of memory in the `.loki/memory/` directory:

- **Episodic** (`.loki/memory/episodic/`) -- Specific interaction traces. Records what happened during each task, including errors and decisions.
- **Semantic** (`.loki/memory/semantic/`) -- Generalized patterns and anti-patterns extracted from episodic memory. Includes `patterns.json` (what works) and `anti-patterns.json` (what to avoid).
- **Procedural** (`.loki/memory/skills/`) -- Learned skills and reusable solutions.

The memory system uses progressive disclosure with three layers: index (lightweight), timeline (moderate), and full details (heavy). This prevents loading the entire memory store into the context window.

Memory retrieval is task-aware, weighting different memory types based on the current activity:

| Task Type | Episodic Weight | Semantic Weight | Skills Weight |
|-----------|----------------|-----------------|---------------|
| Exploration | 0.6 | 0.3 | 0.1 |
| Implementation | 0.15 | 0.5 | 0.35 |
| Debugging | 0.4 | 0.2 | 0.0 (+ 0.4 anti-patterns) |

The memory engine is implemented in Python (`memory/engine.py`, `memory/retrieval.py`, `memory/storage.py`).

## Model Selection

Loki Mode maps tasks to model tiers rather than specific model names:

| Task Type | Tier | Claude | Codex | Gemini |
|-----------|------|--------|-------|--------|
| Architecture, system design | planning | opus | effort=xhigh | thinking=high |
| Feature implementation, bugs | development | opus | effort=high | thinking=medium |
| Code review | development | opus (sonnet for reviewers) | effort=high | thinking=medium |
| Unit tests, linting, docs | fast | sonnet | effort=low | thinking=low |

Claude Code has full feature support: parallel agents (up to 10 simultaneous), the Task tool, and MCP integration. Codex and Gemini run in degraded mode: sequential execution only, no Task tool, no parallel agents.

## Key Files

Every Loki Mode project uses these files in the `.loki/` directory:

| File | Purpose |
|------|---------|
| `session.json` | Current session state (pid, start time, provider, status) |
| `state/orchestrator.json` | Current phase, tasks completed/failed |
| `queue/pending.json` | Tasks waiting to be executed |
| `queue/current-task.json` | The task currently being worked on |
| `queue/dead-letter.json` | Tasks that failed 5+ times |
| `memory/index.json` | Lightweight memory index |
| `memory/timeline.json` | Memory timeline for context retrieval |
| `signals/` | Inter-process signals (PAUSE, STOP, DRIFT_DETECTED, etc.) |

## Summary

Loki Mode is an autonomous multi-agent system that follows the RARV cycle to build software from PRDs. It uses 41 agent types organized into 8 domains, enforces quality through 8 gates with blind peer review, and maintains episodic/semantic/procedural memory for continuous learning. Projects are classified into simple, standard, or complex tiers that determine the number of phases executed.
