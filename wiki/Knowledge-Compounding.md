# Knowledge Compounding

> Legacy engine note: this page documents the legacy engine (`loki start`, `LOKI_ENGINE=legacy`), which still ships in 10.6.6 and is being removed. For the current Loki 10 commands (`loki "<task>"`, `loki owner/repo#N`, `loki backlog`, `loki verify`) see [[Home]] and [docs/v10/GUIDE.md](https://github.com/asklokesh/loki-mode/blob/main/docs/v10/GUIDE.md).

Structured solution extraction and retrieval system for cross-project intelligence (v5.30.0).

---

## Overview

Knowledge Compounding goes beyond raw JSONL learnings by extracting **structured solutions** with categorization, tagging, and symptom matching. Solutions are stored as markdown files with YAML frontmatter and are automatically loaded into future sessions based on relevance.

### Key Features

- **COMPOUND phase** in the RARV+C cycle extracts solutions after VERIFY passes
- **7 categories** for organization: security, performance, architecture, testing, debugging, deployment, general
- **Tag + symptom matching** for intelligent retrieval during REASON phase
- **Deduplication** by title slug prevents duplicate solutions
- **CLI management** via `loki compound` with 6 subcommands

---

## How It Works

### Extraction (Post-VERIFY)

After a task passes verification with novel insight, the COMPOUND phase:

1. Analyzes session learnings (patterns, mistakes, successes)
2. Groups related entries by category keyword matching
3. For groups with 2+ related entries, generates a solution file
4. Deduplicates against existing solutions by title slug
5. Writes to `~/.loki/solutions/{category}/{slug}.md`

### Retrieval (REASON Phase)

At the start of each session:

1. Scans `~/.loki/solutions/` subdirectories
2. Reads YAML frontmatter from each solution file
3. Scores tags and symptoms against current task context
4. Injects top 3 relevant solutions into planning context

### When Solutions Are Created

Solutions are extracted when the task involved:
- Fixing a non-obvious bug (root cause analysis)
- Solving a problem worth documenting
- Discovering a reusable pattern
- Hitting a pitfall that others should avoid

Solutions are NOT created for:
- Trivial changes (typos, formatting)
- Standard CRUD operations
- Changes with no novel insight

---

## Solution File Format

```yaml
---
title: "Connection pool exhaustion under load"
category: performance
tags: [database, pool, timeout, postgres]
symptoms:
  - "ECONNREFUSED on database queries under load"
root_cause: "Default pool size of 10 insufficient"
prevention: "Set pool size to 2x concurrent connections"
confidence: 0.85
source_project: "auth-service"
created: "2026-02-09T12:00:00Z"
applied_count: 0
---

## Solution
Increase the connection pool size to at least 2x the expected concurrent
database connections. For PostgreSQL with pg-pool, set max to 20-50.

## Context
Discovered during auth-service load testing. Under 100 concurrent users,
the default pool of 10 connections was exhausted, causing ECONNREFUSED
errors on new database queries.
```

### Required Fields

| Field | Type | Description |
|-------|------|-------------|
| `title` | string | Descriptive title of the solution |
| `category` | string | One of 7 categories (see below) |
| `tags` | list | Keywords for matching |
| `root_cause` | string | What caused the issue |
| `prevention` | string | How to prevent it |
| `created` | string | ISO 8601 timestamp |

### Optional Fields

| Field | Type | Description |
|-------|------|-------------|
| `symptoms` | list | Observable indicators of the problem |
| `confidence` | float | 0.0-1.0 confidence score |
| `source_project` | string | Project where this was discovered |
| `applied_count` | int | Times this solution was loaded |

---

## Categories

| Category | Description | Example Topics |
|----------|-------------|----------------|
| `security` | Auth, injection, secrets, validation | OWASP, XSS, CSRF, API keys |
| `performance` | Speed, memory, caching, queries | N+1, connection pools, bundle size |
| `architecture` | Design, patterns, coupling | SOLID, abstractions, state management |
| `testing` | Test strategy, coverage, mocking | Edge cases, flaky tests, fixtures |
| `debugging` | Root cause analysis, diagnostics | Stack traces, race conditions |
| `deployment` | CI/CD, Docker, environments | Build failures, port conflicts |
| `general` | Everything else | Configuration, tooling, workflows |

---

## CLI Commands

```bash
# List all solutions by category with counts
loki compound list

# Show solutions in a specific category
loki compound show security
loki compound show performance

# Search across all solutions by keyword
loki compound search "docker"
loki compound search "authentication"

# Manually trigger compounding from current session learnings
loki compound run

# View statistics (count, newest, oldest)
loki compound stats

# Show help
loki compound help
```

---

## Deepen-Plan Phase

Knowledge Compounding also introduces the **Deepen-Plan** phase, which runs after ARCHITECTURE and before DEVELOPMENT for standard/complex tiers.

### 4 Research Agents (Parallel)

| Agent | Focus |
|-------|-------|
| **Repo Analyzer** | Reusable components, established conventions, similar implementations |
| **Dependency Researcher** | Best practices, known pitfalls, version compatibility |
| **Edge Case Finder** | Concurrency, network failures, null states, race conditions |
| **Security Threat Modeler** | Auth flows, data exposure, injection surfaces, supply chain |

### When It Runs

- After ARCHITECTURE phase, before INFRASTRUCTURE/DEVELOPMENT
- Only for standard/complex complexity tiers (skipped for simple)
- Only when using Claude provider (requires Task tool for parallel agents)

### Output

1. Architecture plan updated with findings
2. Edge cases added as explicit tasks in the queue
3. Threat model saved to `.loki/specs/threat-model.md`
4. Findings logged in CONTINUITY.md

---

## Storage Location

```
~/.loki/solutions/
  security/
    input-validation-bypass.md
    jwt-token-expiry-handling.md
  performance/
    connection-pool-exhaustion.md
    n-plus-one-query-fix.md
  architecture/
    ...
  testing/
    ...
  debugging/
    ...
  deployment/
    ...
  general/
    ...
```

---

## Relationship to Raw Learnings

Knowledge Compounding builds ON TOP of the existing JSONL learning system:

```
Session End
    |
    v
[Extract Raw Learnings]  -->  ~/.loki/learnings/*.jsonl  (existing, unchanged)
    |
    v
[Compound to Solutions]  -->  ~/.loki/solutions/**/*.md  (new, structured)
    |
    v
Session Start
    |
    v
[Load Raw Learnings]     <--  ~/.loki/learnings/*.jsonl
[Load Relevant Solutions] <-- ~/.loki/solutions/**/*.md  (top 3 by relevance)
```

Both systems work together. Raw learnings provide breadth; structured solutions provide depth.

---

## See Also

- [[Cross-Project Learning]] - Raw JSONL learning system
- [[Architecture]] - RARV+C and Deepen-Plan diagrams
- [[CLI Reference]] - Compound CLI commands
- [[Completion Council]] - Related quality assurance feature
