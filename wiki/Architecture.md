# Architecture

State machines and component diagrams for Loki Mode.

---

## Session State Machine

```
                              +-------------+
                              |    IDLE     |
                              +------+------+
                                     |
                                     | loki start
                                     v
                              +------+------+
                              | INITIALIZING|
                              +------+------+
                                     |
                                     | Spec loaded (PRD/issue/YAML)
                                     v
+-------------+              +-------+-------+
|   PAUSED    |<-------------+   RUNNING     |<-----------+
+------+------+ loki pause   +-------+-------+            |
       |                             |                    |
       | loki resume                 |                    |
       +-------------------->+       | Phase complete     |
                             |       v                    |
                             | +-----+------+             |
                             | |  PHASE_N   |-------------+
                             | +-----+------+   Next phase
                             |       |
                             |       | All phases done
                             |       v
                             | +-----+------+
                             | | COMPLETING |
                             | +-----+------+
                             |       |
                             |       | Cleanup done
                             |       v
                             | +-----+------+
                             +>| COMPLETED  |
                               +------------+

Error states:
  RUNNING/PHASE_N --[error]--> FAILED --[reset]--> IDLE
  RUNNING/PHASE_N --[max retries]--> MAX_RETRIES_EXCEEDED --[reset]--> IDLE
  ANY --[loki stop]--> STOPPED --[reset]--> IDLE
```

---

## RARV+C Cycle (v5.30.0)

```
Every iteration follows: Reason -> Act -> Reflect -> Verify -> Compound

+----------+     +----------+     +----------+     +----------+
|  REASON  | --> |   ACT    | --> | REFLECT  | --> |  VERIFY  |
| Load     |     | Execute  |     | Analyze  |     | Test &   |
| context  |     | plan     |     | results  |     | validate |
+----------+     +----------+     +----------+     +----+-----+
     ^                                                   |
     |                                              PASS | FAIL
     |           +----------+                       |    |
     +-----------+ COMPOUND |<----------------------+    |
                 | Extract  |                            |
                 | solution |                            v
                 +----------+                     [Fix & retry]

COMPOUND phase (new in v5.30.0):
  - Triggered after VERIFY passes
  - Extracts structured solution if task had novel insight
  - Writes to ~/.loki/solutions/{category}/{slug}.md
  - YAML frontmatter: title, category, tags, symptoms, root_cause, prevention
  - Skips trivial changes (typos, formatting, standard CRUD)
```

---

## DEEPEN_PLAN Phase (v5.30.0)

```
                    +------------------+
                    |   ARCHITECTURE   |
                    | - System design  |
                    | - API contracts  |
                    +--------+---------+
                             |
                             | Design approved (standard/complex only)
                             v
                    +--------+---------+
                    |   DEEPEN_PLAN    |
                    | 4 parallel agents|
                    +--------+---------+
                             |
         +-------------------+-------------------+-------------------+
         |                   |                   |                   |
         v                   v                   v                   v
+--------+------+   +--------+-------+   +-------+--------+   +-----+----------+
| Repo Analyzer |   | Dependency     |   | Edge Case      |   | Security Threat|
| - Patterns    |   | Researcher     |   | Finder         |   | Modeler        |
| - Conventions |   | - Best practice|   | - Concurrency  |   | - Auth flows   |
| - Reuse       |   | - Known issues |   | - Failures     |   | - Data exposure|
+--------+------+   +--------+-------+   +-------+--------+   +-----+----------+
         |                   |                   |                   |
         +-------------------+-------------------+-------------------+
                             |
                             v
                    +--------+---------+
                    |  INFRASTRUCTURE  |
                    | - Enhanced plan  |
                    | - Edge cases     |
                    | - Threat model   |
                    +------------------+

Only runs for standard/complex tiers. Skipped for simple tier.
Requires Claude provider (needs Task tool for parallel agents).
```

---

## Specialist Review Agents (v5.30.0)

```
                         +----------------+
                         |   CODE DIFF    |
                         +-------+--------+
                                 |
                                 | Keyword analysis
                                 v
                    +------------+-------------+
                    |  SPECIALIST SELECTION     |
                    |  (3 of 5 pool)           |
                    +------------+-------------+
                                 |
         +-----------------------+-----------------------+
         |                       |                       |
         v                       v                       v
+--------+--------+    +--------+--------+    +--------+--------+
| ARCHITECTURE    |    | [SELECTED #2]   |    | [SELECTED #3]   |
| STRATEGIST      |    | By keyword match|    | By keyword match|
| (always slot 1) |    |                 |    |                 |
+-----------------+    +-----------------+    +-----------------+

Specialist Pool:
  1. architecture-strategist  (ALWAYS included - SOLID, coupling, patterns)
  2. security-sentinel        (OWASP, injection, auth, secrets)
  3. performance-oracle       (N+1, memory leaks, caching, bundle size)
  4. test-coverage-auditor    (missing tests, edge cases, error paths)
  5. dependency-analyst       (outdated packages, CVEs, bloat, licenses)

Selection rules:
  - Slot 1: architecture-strategist (always)
  - Slot 2-3: Top 2 by trigger keyword matches against diff
  - Tie-breaker: security > test-coverage > performance > dependency
  - All 3 run in parallel (blind, no cross-visibility)
  - Unanimous PASS triggers devil's advocate (anti-sycophancy)
```

---

## Task Queue State Machine

```
+------------+     queue      +------------+     pick      +------------+
|  PENDING   +--------------->|   QUEUED   +-------------->| IN_PROGRESS|
+------------+                +-----+------+               +------+-----+
                                    |                             |
                                    | timeout                     |
                                    v                             |
                              +-----+------+                      |
                              |  STALLED   |                      |
                              +-----+------+                      |
                                    |                             |
                                    | retry                       | complete
                                    v                             v
                              +-----+------+               +------+-----+
                              |  RETRYING  |               |  COMPLETED |
                              +-----+------+               +------------+
                                    |
                                    | max retries (5)
                                    v
                              +-----+------+
                              | DEAD_LETTER|
                              +------------+

Queue files:
  .loki/queue/pending.json     - Tasks waiting
  .loki/queue/current-task.json - Active task
  .loki/queue/dead-letter.json - Failed tasks
```

---

## SDLC Phase Flow

```
+------------------+
|   REQUIREMENTS   |
| - Parse spec     |
| - Extract tasks  |
+--------+---------+
         |
         v
+--------+---------+
|     PLANNING     |
| - Architecture   |
| - Task breakdown |
+--------+---------+
         |
         v
+--------+---------+
|   DEVELOPMENT    |
| - Implement code |
| - Unit tests     |
+--------+---------+
         |
         v
+--------+---------+
|     TESTING      |
| - Integration    |
| - E2E tests      |
+--------+---------+
         |
         v
+--------+---------+
|   CODE REVIEW    |
| - 3 specialists  |
| - Devil's adv.   |
+--------+---------+
         |
         v
+--------+---------+
|   DEPLOYMENT     |
| - Build          |
| - Deploy         |
+--------+---------+
         |
         v
+--------+---------+
|   VERIFICATION   |
| - Smoke tests    |
| - Monitoring     |
+--------+---------+

Complexity tiers:
  Simple:   3 phases (Requirements -> Development -> Testing)
  Standard: 7 phases (+ Planning, Deepen-Plan, Review, Deployment)
  Complex:  9 phases (+ Security, Performance, Accessibility)
```

---

## Agent Lifecycle

```
                    +------------+
                    |   SPAWN    |
                    +-----+------+
                          |
                          | Initialize
                          v
                    +-----+------+
                    |   READY    |
                    +-----+------+
                          |
                          | Receive task
                          v
+------------+      +-----+------+
|   ERROR    |<-----|  WORKING   |
+-----+------+      +-----+------+
      |                   |
      | Retry             | Complete
      v                   v
+-----+------+      +-----+------+
|  RETRYING  |----->| REPORTING  |
+------------+      +-----+------+
                          |
                          | Report sent
                          v
                    +-----+------+
                    | TERMINATED |
                    +------------+

Agent types:
  - Planning agents (Opus)
  - Development agents (Sonnet)
  - Testing agents (Haiku/Sonnet)
  - Review agents (Sonnet)
  - Documentation agents (Haiku)
```

---

## Parallel Workflow Streams

```
                         +----------------+
                         |   MAIN BRANCH  |
                         +-------+--------+
                                 |
         +-----------------------+-----------------------+
         |                       |                       |
         v                       v                       v
+--------+--------+    +--------+--------+    +--------+--------+
|  FEATURE STREAM |    |  TESTING STREAM |    |   DOCS STREAM   |
|  (worktree-feat)|    |  (worktree-test)|    |  (worktree-docs)|
+--------+--------+    +--------+--------+    +--------+--------+
         |                       |                       |
         | Develop               | Write tests           | Generate docs
         v                       v                       v
+--------+--------+    +--------+--------+    +--------+--------+
|  FEATURE DONE   |    |   TESTS DONE    |    |    DOCS DONE    |
+--------+--------+    +--------+--------+    +--------+--------+
         |                       |                       |
         +-----------+-----------+-----------+-----------+
                     |
                     v
              +------+------+
              |  AUTO-MERGE |
              +------+------+
                     |
                     v
              +------+------+
              |  MAIN BRANCH|
              +-------------+

Environment variables:
  LOKI_PARALLEL_MODE=true
  LOKI_MAX_WORKTREES=5
  LOKI_AUTO_MERGE=true
```

---

## Notification Flow

```
+------------+     Event      +-------------+
|   SESSION  +--------------->| NOTIFY_SH   |
+------------+                +------+------+
                                     |
         +---------------------------+---------------------------+
         |                           |                           |
         v                           v                           v
+--------+--------+        +---------+-------+        +----------+-------+
|  _notify_slack  |        | _notify_discord |        | _notify_webhook  |
+--------+--------+        +---------+-------+        +----------+-------+
         |                           |                           |
         | curl (background)         | curl (background)         | curl (background)
         v                           v                           v
+--------+--------+        +---------+-------+        +----------+-------+
|  SLACK WEBHOOK  |        | DISCORD WEBHOOK |        | CUSTOM ENDPOINT  |
+-----------------+        +-----------------+        +------------------+

Event types:
  - session_start (blue)
  - session_end (green)
  - task_complete (green)
  - milestone (purple)
  - error (red)
  - warning (orange)
```

---

## Memory System Architecture

```
+------------------+
|    SESSION END   |
+--------+---------+
         |
         | Extract learnings
         v
+--------+---------+
|  CONTINUITY.MD   |
+--------+---------+
         |
         +------------+------------+------------+
         |            |            |            |
         v            v            v            |
+--------+---+ +------+-----+ +----+-------+    |
|  PATTERNS  | |  MISTAKES  | |  SUCCESSES |    |
| (semantic) | | (episodic) | | (episodic) |    |
+-----+------+ +-----+------+ +-----+------+    |
      |              |              |           |
      +-------+------+-------+------+           |
              |                                 |
              v                                 |
      +-------+-------+                         |
      |  DEDUPLICATION|  (MD5 hash)             |
      +-------+-------+                         |
              |                                 |
              v                                 v
      +-------+-------+                 +-------+-------+
      | ~/.loki/      |                 | .loki/memory/ |
      | learnings/    |                 | (project)     |
      +---------------+                 +---------------+

Storage format: JSONL (append-only)
Deduplication: MD5 hash prevents 71% duplicates
```

---

## Enterprise Authentication Flow

```
+------------+     Request      +-------------+
|   CLIENT   +----------------->|  API SERVER |
+------------+                  +------+------+
                                       |
                                       | Check header
                                       v
                               +-------+-------+
                               | Authorization |
                               |    Header?    |
                               +-------+-------+
                                  |         |
                                  | No      | Yes
                                  v         v
                            +-----+---+ +---+--------+
                            |  401    | | VALIDATE   |
                            | UNAUTH  | |   TOKEN    |
                            +---------+ +---+--------+
                                            |
                            +---------------+---------------+
                            |               |               |
                            v               v               v
                      +-----+-----+   +-----+-----+   +-----+-----+
                      |  INVALID  |   |  EXPIRED  |   |   VALID   |
                      +-----+-----+   +-----+-----+   +-----+-----+
                            |               |               |
                            v               v               v
                      +-----+-----+   +-----+-----+   +-----+-----+
                      | 401 ERROR |   | 401 ERROR |   |  PROCESS  |
                      +-----------+   +-----------+   |  REQUEST  |
                                                      +-----+-----+
                                                            |
                                                            | Log to audit
                                                            v
                                                      +-----+-----+
                                                      |  RESPONSE |
                                                      +-----------+

Token storage: ~/.loki/dashboard/tokens.json
Hash: SHA256 (constant-time compare)
Audit: ~/.loki/dashboard/audit/*.jsonl
```

---

## Provider Selection Logic

```
                         +----------------+
                         | LOKI_PROVIDER  |
                         | environment    |
                         +-------+--------+
                                 |
                                 | or
                                 v
                         +-------+--------+
                         |  --provider    |
                         |  CLI flag      |
                         +-------+--------+
                                 |
                                 | or
                                 v
                         +-------+--------+
                         |  config.yaml   |
                         +-------+--------+
                                 |
                                 | or
                                 v
                         +-------+--------+
                         |   DEFAULT      |
                         |   (claude)     |
                         +-------+--------+
                                 |
         +-----------------------+-----------------------+
         |                       |                       |
         v                       v                       v
+--------+--------+    +--------+--------+    +--------+--------+
|     CLAUDE      |    |     CODEX       |    |     GEMINI      |
| Full features   |    | Degraded mode   |    | Degraded mode   |
| - Task tool     |    | - Sequential    |    | - Sequential    |
| - Parallel      |    | - No subagents  |    | - No subagents  |
| - MCP           |    | - No MCP        |    | - No MCP        |
+-----------------+    +-----------------+    +-----------------+
```

---

## Completion Council (v5.25.0)

```
                         +----------------+
                         |   ITERATION N  |
                         +-------+--------+
                                 |
                                 | Every COUNCIL_CHECK_INTERVAL iterations
                                 v
                         +-------+--------+
                         | COUNCIL CHECK  |
                         +-------+--------+
                                 |
         +-----------------------+-----------------------+
         |                       |                       |
         v                       v                       v
+--------+--------+    +--------+--------+    +--------+--------+
|   MEMBER 1      |    |   MEMBER 2      |    |   MEMBER 3      |
|   Vote: Y/N     |    |   Vote: Y/N     |    |   Vote: Y/N     |
+-----------------+    +-----------------+    +-----------------+
         |                       |                       |
         +-----------+-----------+-----------+-----------+
                     |
                     v
              +------+------+
              |  TALLY VOTES|
              +------+------+
                     |
         +-----------+-----------+
         |                       |
         v                       v
  +------+------+         +------+------+
  |  >= 2/3     |         |  < 2/3      |
  |  COMPLETE?  |         |  CONTINUE   |
  +------+------+         +-------------+
         |
         | Unanimous?
         v
  +------+------+
  | DEVIL'S     |
  | ADVOCATE    |  (Anti-sycophancy check)
  +------+------+
         |
    +----+----+
    |         |
    v         v
 CONFIRM    REJECT
 COMPLETE   CONTINUE

State: .loki/council/state.json
Votes: .loki/council/votes/
Report: .loki/council/report.md
Convergence: .loki/council/convergence.log
```

---

## Knowledge Compounding Architecture (v5.30.0)

```
+------------------+
|    SESSION END   |
+--------+---------+
         |
         | Extract learnings (existing)
         v
+--------+---------+          +------------------+
| JSONL LEARNINGS  |          | ~/.loki/solutions/|
| - patterns.jsonl |          |   security/      |
| - mistakes.jsonl |--------->|   performance/   |
| - successes.jsonl|  compound|   architecture/  |
+------------------+          |   testing/       |
                              |   debugging/     |
                              |   deployment/    |
                              |   general/       |
                              +--------+---------+
                                       |
                                       | On next session start
                                       v
                              +--------+---------+
                              | SOLUTION LOADING |
                              | - Match tags     |
                              | - Score relevance|
                              | - Top 3 injected |
                              +------------------+

Solution file format:
  ~/.loki/solutions/{category}/{slug}.md
  ---
  title: "Connection pool exhaustion"
  category: performance
  tags: [database, pool, timeout]
  symptoms: ["ECONNREFUSED under load"]
  root_cause: "Default pool size insufficient"
  prevention: "Set pool size to 2x connections"
  confidence: 0.85
  ---
  ## Solution
  [Detailed explanation]
```

---

*These diagrams are auto-generated and updated with each release.*
