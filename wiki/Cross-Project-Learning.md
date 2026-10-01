# Cross-Project Learning

Loki Mode's memory system that learns from every session and applies insights to future projects.

---

## Overview

Cross-project learning captures three types of knowledge:

| Type | Description | Example |
|------|-------------|---------|
| **Patterns** | Reusable approaches | "Use JWT with refresh tokens for auth" |
| **Mistakes** | Errors to avoid | "Don't store secrets in localStorage" |
| **Successes** | What worked well | "TDD reduced bugs by 60%" |

---

## How It Works

### Learning Extraction

At the end of each session, Loki Mode:

1. Analyzes `CONTINUITY.md` for patterns
2. Extracts learnings from session logs
3. Deduplicates using MD5 hashing (reduces 71% duplicates)
4. Stores in JSONL format for efficient append

### Learning Application

At the start of each session, Loki Mode:

1. Loads relevant learnings from global memory
2. Applies patterns to current context
3. Avoids known mistakes
4. Reuses successful approaches

---

## Storage Location

```
~/.loki/learnings/
  patterns.jsonl     # Reusable patterns
  mistakes.jsonl     # Errors to avoid
  successes.jsonl    # Successful approaches
```

### Storage Format

Each file uses JSONL (JSON Lines) format:

```json
{"version":"1.0","created":"2026-02-02T12:00:00Z"}
{"description":"Always validate user input at API boundaries","project":"auth-service","category":"security","timestamp":"2026-02-02T12:30:00Z"}
{"description":"Use connection pooling for database connections","project":"data-api","category":"performance","timestamp":"2026-02-02T14:00:00Z"}
```

---

## CLI Commands

### List Learnings

```bash
# List all learnings
loki memory list

# List specific type
loki memory show patterns
loki memory show mistakes
loki memory show successes

# With limit
loki memory show patterns --limit 10
```

### Search Learnings

```bash
# Search across all types
loki memory search "authentication"

# Output as JSON
loki memory search "database" --format json
```

### Statistics

```bash
# View statistics
loki memory stats
```

Output:
```
Cross-Project Learnings Statistics

By Category:
  patterns:  25
  mistakes:  10
  successes: 15
  Total:     50

By Project:
  auth-service:  20
  data-api:      15
  frontend:      10
  unknown:        5
```

### Export

```bash
# Export all learnings
loki memory export ./learnings-backup.json
```

### Clear Learnings

```bash
# Clear specific type
loki memory clear patterns
loki memory clear mistakes

# Clear all
loki memory clear all
```

### Deduplicate

```bash
# Remove duplicate entries
loki memory dedupe
```

---

## API Endpoints

All memory routes live under `/api/memory` on the dashboard (port 57374):

```bash
curl http://localhost:57374/api/memory/summary
curl "http://localhost:57374/api/memory/patterns?limit=10"
curl "http://localhost:57374/api/memory/search?q=authentication&collection=patterns"
curl http://localhost:57374/api/memory/stats
```

---

## CONTINUITY.md Format

Loki Mode extracts learnings from `CONTINUITY.md`:

```markdown
# Session Continuity

## Patterns Discovered
- Always validate user input at API boundaries
- Use connection pooling for database connections

## Mistakes Made
- Forgot to handle null case in user lookup
- Didn't set up proper error boundaries

## What Worked Well
- TDD approach caught 3 bugs early
- Component-first design simplified testing
```

---

## Best Practices

### Writing Good Learnings

1. **Be specific** - "Use bcrypt with cost factor 12" vs "Hash passwords"
2. **Include context** - "For REST APIs, use..." vs "Use..."
3. **Keep it actionable** - Focus on what to do/avoid

### Managing Learnings

1. **Review periodically** - Remove outdated learnings
2. **Deduplicate regularly** - Run `loki memory dedupe`
3. **Export backups** - Keep backups of valuable learnings
4. **Share selectively** - Review before sharing with team

---

## Knowledge Compounding (v5.30.0)

In addition to raw JSONL learnings, Loki Mode can extract **structured solutions** -- curated, categorized knowledge with YAML frontmatter that feeds back into future planning.

### How It Differs from Raw Learnings

| Aspect | Raw Learnings (JSONL) | Structured Solutions (MD) |
|--------|----------------------|--------------------------|
| Format | JSON lines, append-only | Markdown with YAML frontmatter |
| Structure | Flat description field | title, tags, symptoms, root_cause, prevention |
| Storage | `~/.loki/learnings/*.jsonl` | `~/.loki/solutions/{category}/*.md` |
| Retrieval | Keyword grep | Tag + symptom matching, relevance scoring |
| Categories | patterns/mistakes/successes | security/performance/architecture/testing/debugging/deployment/general |

### Solution File Format

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
[Detailed explanation of fix]

## Context
[How this was discovered]
```

### When Solutions Are Created

- After VERIFY passes with novel insight (automatic via COMPOUND phase)
- When fixing a non-obvious bug (root cause analysis)
- When discovering a reusable pattern
- When hitting a pitfall worth documenting
- Manually via `loki compound run`

### CLI Commands

```bash
# List solutions by category
loki compound list

# Show solutions in a category
loki compound show security

# Search across all solutions
loki compound search "authentication"

# Manually trigger compounding from session learnings
loki compound run

# View statistics
loki compound stats
```

### Solution Loading

At the start of each session, Loki Mode:

1. Scans `~/.loki/solutions/` subdirectories
2. Reads YAML frontmatter from each solution file
3. Matches tags and symptoms against current task context
4. Injects top 3 relevant solutions into the REASON phase context

---

## See Also

- [[API Reference]] - Memory API endpoints
- [[CLI Reference]] - Memory CLI commands
- [[Architecture]] - Memory system architecture
