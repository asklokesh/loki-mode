# Loki Mode - State Machine Reference

Comprehensive state machine diagrams for every stateful component in the codebase.
Intended for Claude agents to reference in context for navigation and understanding.

**Format**: Each section contains an ASCII state diagram, a state table with
triggers and persistence, and source file references (file:line).

---

## Verification status

**Last verified:** 2026-03-03 against v6.6.1 codebase (council-reviewed, merged via PR #49).

**Current codebase:** v7.5.7 (2026-04-29). This document has NOT been re-verified
end-to-end against v7.5.x. Treat shape/semantics as authoritative; treat line
numbers as approximate. See "Known drift" and "Known additions" sections below
before relying on any specific `file:line` reference.

This is a council-reviewed document. Per the audit guidance (2026-04-29), line
numbers are NOT being silently rewritten throughout. Drift is recorded here so
readers can spot-check before trusting a citation.

### Known additions since last verify (v6.7.0 -> v7.5.7)

These components exist in v7.5.x but are NOT yet documented in the sections
below. They should be added when this doc is next re-verified end-to-end:

- **Phase 1 override council** (v7.5.x). Specialized council that fires when a
  Phase 1 (archaeology / planning) gate would otherwise block, allowing a
  reviewed override path. Belongs in section 7 (Quality Gates) or alongside
  section 3 (Completion Council).
- **File-lock primitive** (`atomic.ts withFileLockSync`, v7.5.x). Atomic
  filesystem coordination primitive used by the Bun runtime. Belongs in section
  1 (Master State File Index) -- documents the locking contract for all `.loki/`
  state files.
- **Gate-failure escalation ladder** (v7.5.x). Multi-tier escalation when a
  quality gate fails repeatedly. Belongs in section 7 (Quality Gates).

### Known drift (line numbers, sampled 2026-04-29 against v7.5.7)

Sampled spot-checks against the live source. The function/file is correct in
every case below; only the line number drifted. Verify with `grep -n` before
citing.

| Section | Citation in doc | Actual location (v7.5.7) | Delta |
|---|---|---|---|
| 2.1 | `run.sh:7380` (`run_autonomous`) | `run.sh:10253` | +2873 |
| 2.2 | `run.sh:1325` (`get_rarv_tier`) | `run.sh:1484` | +159 |
| 2.4 | `run.sh:8059` / `run.sh:10419` (`check_human_intervention`) | `run.sh:11262` | +843 to +3203 |
| 3.1 | `completion-council.sh:1359` (`council_should_stop`) | `completion-council.sh:1605` | +246 |
| 13 | `run.sh:6464` (`create_checkpoint`) | `run.sh:6943` | +479 |
| 14 | `run.sh:1229` (`detect_complexity`) | `run.sh:1338` | +109 |

Drift trend: `autonomy/run.sh` and `autonomy/completion-council.sh` have grown
roughly 800-3000 lines per minor release. **For navigation, prefer `grep -n
'^<function_name>()'` over the line numbers below.** The function names and
file paths in this document remain authoritative.

Note: a meaningful share of orchestration logic now lives in the Bun runtime
under `loki-ts/src/` (Phases 4-5 of ADR-001). This document still describes the
bash route, which is the legacy fallback gated behind `LOKI_LEGACY_BASH=1`.
When Phase 6 ships (bash sunset), this document will need to be re-pointed at
the TypeScript implementation.

---

## Table of Contents

1. [Master State File Index](#1-master-state-file-index)
2. [Core Orchestration](#2-core-orchestration)
3. [Completion Council](#3-completion-council)
4. [Provider System](#4-provider-system)
5. [Memory System](#5-memory-system)
6. [Task Queue](#6-task-queue)
7. [Quality Gates](#7-quality-gates)
8. [Dashboard](#8-dashboard)
9. [Event System](#9-event-system)
10. [MCP Server](#10-mcp-server)
11. [Autonomy Utilities](#11-autonomy-utilities)
12. [Parallel Workflows](#12-parallel-workflows)
13. [Checkpoint System](#13-checkpoint-system)
14. [Complexity Detection](#14-complexity-detection)

---

## 1. Master State File Index

All runtime state lives under `.loki/` in the project root. This is the
filesystem-based communication bus between all components.

```
.loki/
  state.json                    # Runner state (iteration, status, exit_code)
  session.json                  # Active session metadata
  dashboard-state.json          # Dashboard polling state (written every 2s)
  generated-prd.md              # Auto-generated PRD when none provided
  continuity.md                 # Cross-iteration context for agent handoff

  queue/
    pending.json                # Task queue entries
    .bmad-populated             # Marker: BMAD queue already loaded

  council/
    convergence.log             # Git diff hashes per iteration
    votes/
      round-N.json              # Vote results per round
    prd-requirements.json       # Extracted PRD requirements
    verdicts.jsonl              # Historical council verdicts

  memory/
    episodic/                   # Episode trace JSON files
    semantic/
      patterns/                 # Extracted patterns
    skills/                     # Procedural skills
    index.json                  # Memory index (L1 layer)
    timeline.json               # Memory timeline (L2 layer)

  events/
    pending/                    # Unprocessed event JSON files
    archive/                    # Processed events (for replay)
    processed.json              # Set of processed event IDs

  context/
    tracking.json               # Token usage per iteration
    last_offset.txt             # Session JSONL parse offset

  notifications/
    triggers.json               # Notification trigger definitions
    active.json                 # Fired notifications

  checkpoints/
    checkpoint-NAME/            # Snapshot directories

  quality/
    reviews/                    # Code review results

  metrics/
    efficiency/                 # Tool efficiency data
    rewards/                    # Outcome/efficiency signals

  app-runner/
    state.json                  # App runner status
    restart-signal              # Signal file: trigger restart
    stop-signal                 # Signal file: trigger stop

  PAUSE                         # Signal file: pause execution
  STOP                          # Signal file: stop execution
  INPUT                         # Signal file: human input pending
  RESUME                        # Signal file: resume from pause
```

---

## 2. Core Orchestration

### 2.1 Autonomous Iteration Loop

The main execution loop in `run.sh`. Each iteration invokes the LLM provider,
then runs post-iteration checks (checklist, app runner, playwright, code review,
council).

Source: `autonomy/run.sh:7380-8047`

```
                        +------------------+
                        |   INITIALIZED    |
                        | (run_autonomous) |
                        +--------+---------+
                                 |
                     build_prompt(), invoke provider
                                 |
                                 v
                    +------------+-------------+
                    |         RUNNING          |
                    | (provider process active)|
                    +------------+-------------+
                                 |
                     provider exits (exit_code)
                                 |
            +--------------------+--------------------+
            |                                         |
      exit_code == 0                           exit_code != 0
            |                                         |
            v                                         v
   +--------+---------+                    +----------+---------+
   | ITERATION_SUCCESS|                    |   ITERATION_FAIL   |
   | save_state       |                    | store_episode_trace|
   | "exited" exit=0  |                    | ("failure")        |
   +--------+---------+                    +----------+---------+
            |                                         |
   +--------+--------+--------+              detect_rate_limit()
   |        |        |        |                       |
   v        v        v        v              +--------+--------+
 perp.   council  promise  default           |                 |
 mode    check    check    continue     rate_limited      backoff
   |        |        |        |              |                 |
   v        v        v        v              v                 v
[CONT]  [COUNCIL  [PROMISE [CONT]      [WAIT_RATE     [WAIT_BACKOFF
         APPROVED] FULFILLED]            _LIMIT]        retry++]
                                             |                 |
                                             +---------+-------+
                                                       |
                                                       v
                                                    [CONT]
                                                       |
                                      (retry > MAX_RETRIES?)
                                             |              |
                                            yes             no
                                             |              |
                                             v              v
                                        [FAILED]        [RUNNING]
                                     max retries       next iteration
                                      exceeded
```

| State | Value in state.json | Trigger In | Trigger Out | Source |
|-------|---------------------|------------|-------------|--------|
| running | `"running"` | Provider invoked | Provider exits | `run.sh:7380` |
| exited | `"exited"` | Provider exit | Post-iteration checks | `run.sh:7380` |
| council_approved | `"council_approved"` | Council votes COMPLETE | Loop returns 0 | `run.sh:7380` |
| completion_promise_fulfilled | `"completion_promise_fulfilled"` | Promise text found in output | Loop returns 0 | `run.sh:7380` |
| failed | `"failed"` | MAX_RETRIES exceeded | Loop returns 1 | `run.sh:8047` |

Persistence: `.loki/state.json` via `save_state()` at `run.sh:6911-6952`

### 2.2 RARV Cycle

Every iteration maps to a phase based on `iteration % 4`.

Source: `autonomy/run.sh:1325-1359`

```
  iteration % 4:

  0: REASON ──> 1: ACT ──> 2: REFLECT ──> 3: VERIFY ──> 0: REASON ...
     |              |           |               |
     v              v           v               v
  planning      development  development     fast
  (opus)        (sonnet)     (sonnet)        (haiku)
```

| Phase | iteration % 4 | Model Tier | Purpose |
|-------|---------------|------------|---------|
| REASON | 0 | planning (opus) | Architecture, system design, high-level decisions |
| ACT | 1 | development (sonnet) | Implementation, writing code |
| REFLECT | 2 | development (sonnet) | Code review, analysis |
| VERIFY | 3 | fast (haiku) | Unit tests, validation, monitoring |

Source: `get_rarv_tier()` at `run.sh:1325-1347`, `get_rarv_phase_name()` at `run.sh:1349-1359`

### 2.3 CLI Session Control

The `loki` CLI manages session lifecycle through signal files.

Source: `autonomy/loki:485` (cmd_start), `autonomy/run.sh:10419` (check_human_intervention)

```
                   +----------+
                   |  IDLE    |
                   | (no .loki|
                   |  session)|
                   +----+-----+
                        |
                  loki start
                        |
                        v
                   +----+-----+
                   | RUNNING  |<─────────────────────+
                   | session  |                      |
                   | active   |                      |
                   +----+-----+              RESUME file
                        |                    detected
                   +----+----+----+              |
                   |         |    |              |
              PAUSE file  STOP file  Ctrl+C      |
              detected    detected   (SIGINT)    |
                   |         |         |         |
                   v         v         v         |
              +----+----+  +-+------+  +--+------+--+
              | PAUSED  |  |STOPPED |  |INTERRUPTED |
              | waiting |  |cleanup |  | 1st=pause  |
              | RESUME  |  |exit    |  | 2nd=stop   |
              +----+----+  +--------+  +-----+------+
                   |                         |
                   +-------------------------+
                   (RESUME file or re-run)
```

Signal files (checked by `check_human_intervention` at `run.sh:8059`):

| File | Effect | Created By |
|------|--------|------------|
| `.loki/PAUSE` | Pause after current iteration | Dashboard, user, `loki pause` |
| `.loki/STOP` | Stop execution entirely | Dashboard, user, `loki stop` |
| `.loki/INPUT` | Wait for human input | Dashboard (contains directive text) |
| `.loki/RESUME` | Resume from pause | Dashboard, user, `loki resume` |

Interrupt handling (Ctrl+C): `run.sh:8261` (cleanup function)
- `INTERRUPT_COUNT=0`, first Ctrl+C sets `PAUSED=true`
- Second Ctrl+C within window triggers full stop

### 2.4 Human Intervention

Source: `autonomy/run.sh:10419` (check_human_intervention)

```
  check_human_intervention()
         |
         +──> PAUSE file exists? ──yes──> handle_pause() ──> return 1 (paused)
         |                                 (in perpetual mode: auto-clear unless budget-triggered)
         |
         +──> PAUSE_AT_CHECKPOINT file exists? ──yes──> (checkpoint mode) pause ──> return 1
         |
         +──> HUMAN_INPUT.md exists? ──yes──> read directive ──> inject into prompt
         |    (security: no symlinks, 1MB limit, LOKI_PROMPT_INJECTION must be true)
         |
         +──> signals/COUNCIL_REVIEW_REQUESTED? ──yes──> force council vote
         |
         +──> STOP file exists? ──yes──> return 2 (stop) ──> exit loop
         |
         +──> (none) ──> return 0 ──> continue normally
```

---

## 3. Completion Council

Multi-agent voting system that decides when a project is truly complete.
Prevents infinite loops and premature stops.

Source: `autonomy/completion-council.sh`

### 3.1 Council Voting Pipeline

Source: `completion-council.sh:1359` (council_should_stop), `completion-council.sh:1308` (council_evaluate)

```
  council_should_stop()  [line 1311]
         |
         +──> council disabled? ──yes──> return 1 (CONTINUE)
         |
         +──> iteration < MIN_ITERATIONS? ──yes──> return 1
         |
         +──> council_circuit_breaker_triggered()? [line 198]
         |    (stagnation detection, checked every time)
         |    sets circuit_triggered flag
         |
         +──> circuit_triggered OR iteration % CHECK_INTERVAL == 0?
         |    neither? ──> return 1
         |
         v
  council_evaluate()  [line 1260]
         |
    Phase 1: Reverify Checklist
         +──> council_reverify_checklist()  [line 550]
         |    (refresh checklist data before evaluation)
         |
    Phase 2: Checklist Hard Gate
         +──> council_checklist_gate()  [line 563]
         |    critical checklist items failing? ──yes──> return 1 (CONTINUE)
         |
    Phase 3: Council Voting
         +──> council_aggregate_votes()  [line 1057]
              |
              +──> result == "COMPLETE"?
                   |          |
                  yes         no ──> return 1 (CONTINUE)
                   |
                   v
              unanimous? (complete_count == COUNCIL_SIZE && COUNCIL_SIZE >= 3)
                   |          |
                  yes         no ──> return 0 (COMPLETE)
                   |
                   v
    Phase 4: Devil's Advocate (anti-sycophancy)
              council_devils_advocate_review()  [line 1156]
                   |
              +────+────+
              |         |
          OVERRIDE    ALLOW
          CONTINUE    COMPLETE
              |         |
              v         v
          return 1   return 0
         (CONTINUE) (COMPLETE)

  (back in council_should_stop)
         |
    council_evaluate returned 0 (COMPLETE)?
         yes──> write COMPLETED marker, council_write_report ──> return 0 (STOP)
         no ──> if circuit_triggered: log warning
                if stagnation >= 2x STAGNATION_LIMIT: FORCE STOP (safety valve)
                else ──> return 1 (CONTINUE)
```

| State | Persistence | Source |
|-------|-------------|--------|
| convergence.log | `.loki/council/convergence.log` | Git diff hashes per iteration |
| votes/round-N.json | `.loki/council/votes/round-N.json` | Per-round vote tallies |
| prd-requirements.json | `.loki/council/prd-requirements.json` | Extracted requirements |
| verdicts.jsonl | `.loki/council/verdicts.jsonl` | Historical verdicts |

### 3.2 Circuit Breaker

Detects stagnation (no git changes across iterations).

Source: `completion-council.sh` (council_circuit_breaker, council_track_iteration)

```
  council_track_iteration()
         |
         v
  compute git diff hash (staged + unstaged)
         |
         +──> same as LAST_DIFF_HASH?
              |          |
             yes         no
              |          |
              v          v
  CONSECUTIVE_NO_CHANGE++   CONSECUTIVE_NO_CHANGE=0
              |                     |
              v                     v
  append "no_change" to      append hash to
  convergence.log             convergence.log
              |
              v
  count > STAGNATION_LIMIT (default 5)?
         |          |
        yes         no
         |          |
         v          v
  CIRCUIT_BREAK   CONTINUE
  (force stop)
```

### 3.3 Devil's Advocate (Anti-Sycophancy)

Based on CONSENSAGENT (ACL 2025). Runs when council votes are unanimous.

Source: `completion-council.sh:1204` (council_devils_advocate_review)

```
  Unanimous COMPLETE vote detected
         |
         v
  council_devils_advocate_review(iteration)
         |
    Spawn adversarial review agent:
    "Challenge this completion claim.
     Find what's missing or broken."
         |
         +──> Finds issues? ──yes──> return "OVERRIDE_CONTINUE"
         |
         +──> No issues ──> return "ALLOW_COMPLETE"
```

Configuration:
- `COUNCIL_SIZE`: Number of members (default 3)
- `COUNCIL_THRESHOLD`: Votes for completion (default 2)
- `COUNCIL_CHECK_INTERVAL`: Check every N iterations (default 5)
- `COUNCIL_MIN_ITERATIONS`: Minimum before checking (default 3)
- `COUNCIL_STAGNATION_LIMIT`: Max no-change iterations (default 5)
- `COUNCIL_SEVERITY_THRESHOLD`: Blocking severity level (default "low")
- `COUNCIL_ERROR_BUDGET`: Fraction of issues tolerated (default 0.0)

---

## 4. Provider System

### 4.1 Provider Lifecycle

Source: `providers/loader.sh:14-62`

```
  [UNINITIALIZED]
         |
    load_provider(name)
         |
         v
  validate_provider(name)
         |
    +----+----+
    |         |
  valid    invalid
    |         |
    v         v
  [VALIDATED] [ERROR: Unknown provider]
    |
    v
  bash -n config_file (syntax check)
    |
    +──> syntax error? ──> [ERROR: Syntax error]
    |
    v
  source config_file
    |
    +──> source failed? ──> [ERROR: Failed to source]
    |
    v
  validate_provider_config()
    |
    +──> missing vars? ──> [ERROR: Config incomplete]
    |
    v
  [READY]
  (8 required vars set)
```

Required provider variables (`loader.sh:65-83`):

| Variable | Example (Claude) |
|----------|------------------|
| PROVIDER_NAME | `"claude"` |
| PROVIDER_DISPLAY_NAME | `"Claude Code"` |
| PROVIDER_CLI | `"claude"` |
| PROVIDER_AUTONOMOUS_FLAG | `"-p"` |
| PROVIDER_PROMPT_POSITIONAL | `"false"` |
| PROVIDER_HAS_SUBAGENTS | `"true"` |
| PROVIDER_HAS_PARALLEL | `"true"` |
| PROVIDER_DEGRADED | `"false"` |

Supported providers: `claude`, `codex`, `gemini`, `cline`, `aider`

### 4.2 Model Tier Selection

Each provider maps the 3 RARV tiers to provider-specific model settings via
`provider_get_tier_param()`.

Source: `providers/claude.sh:101`, `providers/codex.sh:106`, `providers/gemini.sh:132`,
`providers/cline.sh:102`, `providers/aider.sh:109`

```
  RARV Tier     Claude (model)     Codex (effort)   Gemini (thinking)   Cline           Aider
  ---------     --------------     --------------   -----------------   -----           -----
  planning      opus               xhigh            high                single model*   single model**
  development   opus (upgraded)    high             medium              single model*   single model**
  fast          sonnet (upgraded)  low              low                 single model*   single model**

  * Cline: returns LOKI_CLINE_MODEL (default: "default"), single externally-configured model
  ** Aider: returns LOKI_AIDER_MODEL (default: "claude-3.7-sonnet"), single externally-configured model

  Note: Claude default tier mapping upgrades development->opus and fast->sonnet.
  With LOKI_ALLOW_HAIKU=true: planning=opus, development=sonnet, fast=haiku (original mapping).
```

### 4.3 Degradation States

Source: `providers/claude.sh`, `providers/codex.sh`, `providers/gemini.sh`,
`providers/cline.sh`, `providers/aider.sh`

```
  Tier 1: Full                Tier 2: Partial             Tier 3: Degraded
  +------------------+        +-------------------+       +-------------------+
  | Claude (Full)    |        | Cline             |       | Codex             |
  | - Subagents      |        | - Subagents       |       | (Degraded)        |
  | - Parallel exec  |        | - MCP support     |       | - Sequential only |
  | - Task tool      |        | - No parallel     |       | - MCP support     |
  | - MCP support    |        | - Not degraded    |       | - No subagents    |
  | - -p flag prompt |        | - Single model    |       | - Positional prompt|
  +------------------+        +-------------------+       +-------------------+

                                                          +-------------------+
                                                          | Gemini            |
                                                          | (Degraded)        |
                                                          | - Sequential only |
                                                          | - No MCP          |
                                                          | - No subagents    |
                                                          | - Positional prompt|
                                                          +-------------------+

                                                          +-------------------+
                                                          | Aider             |
                                                          | (Degraded)        |
                                                          | - Sequential only |
                                                          | - No MCP          |
                                                          | - No subagents    |
                                                          | - Single model    |
                                                          +-------------------+
```

Provider capability matrix:

| Provider | Subagents | Parallel | MCP | Degraded |
|----------|-----------|----------|-----|----------|
| Claude   | true      | true     | true| false    |
| Cline    | true      | false    | true| false    |
| Codex    | false     | false    | true| true     |
| Gemini   | false     | false    | false| true    |
| Aider    | false     | false    | false| true    |

When `PROVIDER_DEGRADED=true`:
- `build_prompt()` generates simplified prompts (no RARV/SDLC injection)
- Sequential execution only (no parallel worktrees)
- No subagent dispatch
- Prompt size limited to ~4000 chars of PRD content

### 4.4 Rate Limit Recovery

Source: `autonomy/run.sh:6134-6173` (parse_retry_after, calculate_rate_limit_backoff, detect_rate_limit)

```
  Provider returns error
         |
         v
  detect_rate_limit(log_file)
         |
    +----+----+
    |         |
  detected  not detected
    |         |
    v         v
  parse_retry_after()    calculate_wait(retry)
  or calculate_rate_     (exponential backoff)
  limit_backoff()
         |
         v
  [WAIT_RATE_LIMIT]
  countdown with progress
         |
         v
  [RETRY]
```

---

## 5. Memory System

### 5.1 Episode Lifecycle

Source: `memory/schemas.py:292-319` (EpisodeTrace)

```
  [CREATE]
  EpisodeTrace.create()
         |
    Set fields:
    - id: "ep-YYYY-MM-DD-NNN"
    - timestamp: UTC ISO 8601
    - phase: REASON|ACT|REFLECT|VERIFY
    - outcome: (pending)
         |
         v
  [ACTIVE]
  Agent executes task
  - action_log appended
  - errors_encountered appended
  - files_read/modified tracked
         |
         v
  [COMPLETE]
  outcome set:
         |
    +----+----+----+
    |         |    |
 success  failure  partial
    |         |    |
    v         v    v
  [STORED]
  engine.store_episode(trace)
  -> storage.save_episode()
  -> .loki/memory/episodic/ep-ID.json
         |
         v
  [INDEXED]
  Importance score assigned (0.0-1.0)
  last_accessed updated on retrieval
  access_count incremented on retrieval
         |
         v
  (Eventually consolidated -> semantic pattern)
```

Episode outcome values: `success`, `failure`, `partial`
RARV phases: `REASON`, `ACT`, `REFLECT`, `VERIFY` (defined at `schemas.py:254`)
Link relations: `derived_from`, `related_to`, `contradicts`, `elaborates`,
`example_of`, `supersedes`, `superseded_by`, `supports` (defined at `schemas.py:159-168`)

### 5.2 Progressive Disclosure Layers

Source: `memory/layers/` directory, `memory/retrieval.py`

```
  Memory Request
         |
         v
  +------+------+
  | L1: INDEX   |  ~100 tokens
  | Topic names |  .loki/memory/index.json
  | + counts    |
  +------+------+
         |
    Is topic relevant?
    (keyword/embedding match)
         |
    +----+----+
    |         |
   yes        no ──> skip topic
    |
    v
  +------+-------+
  | L2: TIMELINE |  ~500 tokens
  | Summaries    |  .loki/memory/timeline.json
  | + dates      |
  | + outcomes   |
  +------+-------+
         |
    Need full detail?
    (high relevance score)
         |
    +----+----+
    |         |
   yes        no ──> return L2 summary
    |
    v
  +------+------+
  | L3: FULL    |  variable tokens
  | Complete    |  .loki/memory/episodic/*.json
  | episode     |  .loki/memory/semantic/patterns/*.json
  | traces      |
  +-------------+
```

Token budget: L1 is always loaded. L2 loaded if topic relevant. L3 loaded
only if high relevance and token budget allows.

### 5.3 Consolidation Pipeline

Transforms episodic memories into semantic patterns.

Source: `memory/consolidation.py`

```
  consolidate(since_hours=24)
         |
         v
  +------+---------+
  | LOAD_EPISODES  |
  | storage.list_  |
  | episodes()     |
  | filter by time |
  +------+---------+
         |
         v
  +------+---------+
  | CLUSTER        |
  | Group similar  |
  | episodes by:   |
  | - task type    |
  | - outcome      |
  | - files touched|
  | (numpy if avail|
  |  else keyword) |
  +------+---------+
         |
         v
  +------+----------+
  | EXTRACT_PATTERNS|
  | Per cluster:    |
  | - success ratio |
  | - common actions|
  | - error types   |
  | Create Semantic |
  | Pattern objects |
  +------+----------+
         |
         v
  +------+------+
  | MERGE       |
  | Deduplicate |
  | with existing|
  | patterns    |
  | Update      |
  | confidence  |
  | Create links|
  +------+------+
         |
         v
  ConsolidationResult {
    patterns_created,
    patterns_merged,
    anti_patterns_created,
    links_created,
    episodes_processed,
    duration_seconds
  }
```

Persistence:
- Input: `.loki/memory/episodic/*.json`
- Output: `.loki/memory/semantic/patterns/*.json`
- Links: Zettelkasten-style (stored inline in pattern JSON)

### 5.4 Token Economics

Tracks memory access efficiency to optimize retrieval.

Source: `memory/token_economics.py:29-58`

```
  Memory Access
         |
    Track tokens:
    - discovery_tokens (indexing new memories)
    - read_tokens (retrieving existing)
    - layer loads (L1, L2, L3 counts)
    - cache hits/misses
         |
         v
  Evaluate Thresholds
         |
    +----+----+----+----+
    |         |    |    |
    v         v    v    v
  ratio>0.15  savings  L3>3   discovery
  (discovery/ <50%     loads  tokens>200
   read)
    |         |    |    |
    v         v    v    v
  compress_   review_  create_  reorganize_
  layer3      topic_   special  topic_
              relevance ized_   index
                       index
```

| Threshold | Metric | Operator | Value | Action | Priority |
|-----------|--------|----------|-------|--------|----------|
| 1 | ratio (discovery/read) | > | 0.15 | compress_layer3 | 1 |
| 2 | savings_percent | < | 50 | review_topic_relevance | 2 |
| 3 | layer3_loads | > | 3 | create_specialized_index | 3 |
| 4 | discovery_tokens | > | 200 | reorganize_topic_index | 4 |

Persistence: `.loki/memory/` (tracked inline with access metadata)

### 5.5 Storage Locking

Source: `memory/storage.py`

```
  File Operation Request
         |
         v
  Acquire Lock
    +----+----+
    |         |
  read op   write op
    |         |
    v         v
  LOCK_SH   LOCK_EX
  (shared)  (exclusive)
    |         |
    v         v
  Read file  Write to temp file
    |         |
    v         v
  Release    Atomic rename
  lock       (temp -> target)
              |
              v
           Release lock
```

Locking uses `fcntl.flock()` (POSIX file locking).
Atomic writes: write to tempfile, then `os.rename()` to target path.
Namespace isolation: each memory type has its own subdirectory.

### 5.6 Retrieval Strategies

Task-aware memory retrieval with weighted strategies.

Source: `memory/retrieval.py:1-16`

```
  Retrieval Request (task_type, query)
         |
         v
  Select Strategy Weights
         |
    +----+----+----+----+----+
    |    |    |    |    |    |
    v    v    v    v    v    |
  explor impl debug review refactor
    |    |    |    |    |
    v    v    v    v    v

  exploration:    episodic=0.6  semantic=0.3  skills=0.1
  implementation: episodic=0.15 semantic=0.5  skills=0.35
  debugging:      episodic=0.4  semantic=0.2  skills=0.0  anti_patterns=0.4
  review:         episodic=0.3  semantic=0.5  skills=0.2
  refactoring:    episodic=0.25 semantic=0.45 skills=0.3
         |
         v
  Weighted merge of results
  -> Score, rank, token-budget trim
  -> Return context block
```

---

## 6. Task Queue

### 6.1 Task Lifecycle

Source: `.loki/queue/pending.json`

```
  [PENDING]
  Task created (from PRD, BMAD, dashboard, or MCP)
      |
      v
  [IN_PROGRESS]
  Agent claims task
      |
      +────────+────────+
      |        |        |
   success   failure  timeout
      |        |        |
      v        v        v
  [COMPLETED] [FAILED] [DEAD_LETTER]
                        (after max
                         retries)
```

Queue entry format:
```json
{
  "id": "task-NNN",
  "title": "...",
  "description": "...",
  "status": "pending|in_progress|completed|failed",
  "priority": "low|medium|high|critical",
  "created_at": "ISO 8601",
  "epic": "..." (optional, from BMAD)
}
```

BMAD population: `run.sh:7270-7372` -- runs once, writes `.loki/queue/.bmad-populated` marker.

### 6.2 Checklist Verification

PRD requirements are extracted and verified against the codebase on interval.

Source: `run.sh:7880-7881` (checklist_should_verify, checklist_verify)

```
  [UNINITIALIZED]
  No checklist extracted yet
         |
    PRD provided at start
         |
         v
  [INITIALIZED]
  Requirements extracted to
  .loki/council/prd-requirements.json
         |
    checklist_should_verify()
    returns true (on interval)
         |
         v
  [VERIFYING]
  Each requirement checked
  against codebase/tests
         |
         v
  [VERIFIED]
  Results stored, injected
  into next prompt as
  $checklist_status
```

---

## 7. Quality Gates

### 7.1 Nine-Gate Pipeline

Source: `skills/quality-gates.md`

```
  Code Change
      |
      v
  Gate 1: Static Analysis (CodeQL, ESLint)
      |──BLOCK (critical findings)──> [REJECTED]
      v
  Gate 2: Type Check (tsc --noEmit)
      |──BLOCK──> [REJECTED]
      v
  Gate 3: Unit Tests (>80% coverage, 100% pass)
      |──BLOCK──> [REJECTED]
      v
  Gate 4: Integration Tests
      |──BLOCK──> [REJECTED]
      v
  Gate 5: 3-Reviewer Blind Review (see 7.3)
      |──BLOCK (Critical/High severity)──> [REJECTED]
      v
  Gate 6: Anti-Sycophancy Check
      |──BLOCK (devil's advocate finds issues)──> [REJECTED]
      v
  Gate 7: Security Scan
      |──BLOCK──> [REJECTED]
      v
  Gate 8: Performance Check
      |──BLOCK──> [REJECTED]
      v
  Gate 9: E2E / Playwright
      |──BLOCK──> [REJECTED]
      v
  [APPROVED]
```

Gate status values: `passed`, `failed`, `skipped`
Persistence: `.loki/dashboard-state.json` field `qualityGates`
Severity levels: `critical`, `high`, `medium`, `low`
Blocking threshold: Critical and High always block; Medium blocks by default.

### 7.2 Model Escalation

Source: `skills/model-selection.md`

```
  Issue Detected
      |
      v
  [LOW]
  Haiku handles
  (unit tests, simple fixes)
      |
  Cannot resolve?
      |
      v
  [MEDIUM]
  Sonnet handles
  (implementation, integration)
      |
  Cannot resolve?
      |
      v
  [HIGH]
  Opus handles
  (architecture, complex bugs)
      |
  Cannot resolve?
      |
      v
  [HUMAN]
  Human intervention required
  (.loki/INPUT signal file)
```

### 7.3 Code Review (3-Reviewer Blind)

Source: `run.sh:5844` (run_code_review)

```
  Code changes committed
         |
         v
  Spawn 3 independent reviewers (parallel)
  Each reviews blindly (no access to other reviews)
         |
    +----+----+----+
    |    |    |    |
    R1   R2   R3
    |    |    |    |
    v    v    v    v
  Collect verdicts
         |
    +----+----+
    |         |
  2/3 APPROVE  <2/3 APPROVE
    |         |
    v         v
  [APPROVED]  [REJECTED]
              Issues logged to
              .loki/quality/reviews/
```

---

## 8. Dashboard

### 8.1 Task Status State Machine

Source: `dashboard/models.py:29-35`

```
  [BACKLOG] ──promote──> [PENDING] ──claim──> [IN_PROGRESS]
                                                    |
                                               +----+----+
                                               |         |
                                           complete    stuck
                                               |         |
                                               v         v
                                           [REVIEW]   (stays
                                               |     IN_PROGRESS)
                                          +----+----+
                                          |         |
                                       approve    reject
                                          |         |
                                          v         v
                                       [DONE]  [IN_PROGRESS]
```

Values: `backlog`, `pending`, `in_progress`, `review`, `done`
DB column: `tasks.status` (SQLAlchemy Enum)

### 8.2 Agent Status State Machine

Source: `dashboard/models.py:46-51`

```
  [IDLE] ──task assigned──> [RUNNING]
    ^                          |
    |                     +----+----+
    |                     |         |
    |                  pause     exception
    |                     |         |
    |                     v         v
    |                 [PAUSED]   [ERROR]
    |                     |         |
    +──resume─────────────+    +----+
    +──error cleared───────────+
```

Values: `idle`, `running`, `paused`, `error`
DB column: `agents.status` (SQLAlchemy Enum)

### 8.3 Session Status State Machine

Source: `dashboard/models.py:54-59`

```
  [ACTIVE] ──────────────────+──────────────+
      |                      |              |
  /api/control/pause    RARV complete   council_should_stop
      |                      |           returns failure
      v                      v              |
  [PAUSED]              [COMPLETED]         v
      |                                 [FAILED]
  /api/control/resume
      |
      v
  [ACTIVE]
```

Values: `active`, `completed`, `failed`, `paused`
DB column: `sessions.status` (SQLAlchemy Enum)
API endpoints: `POST /api/control/pause`, `POST /api/control/resume`, `POST /api/control/stop`

### 8.4 WebSocket Connection Lifecycle

Source: `dashboard/server.py:1070-1145`

```
  Client connects to /ws
         |
         v
  [RATE_CHECK]
  _read_limiter.check()
         |
    +----+----+
    |         |
  pass      fail
    |         |
    v         v
  [AUTH]    [REJECTED]
  (if OIDC   close code 1008
   enabled)
    |
    +──> token invalid? ──> [REJECTED] close 1008
    |
    v
  [CONNECTED]
  manager.connect(ws)
  send {"type": "connected"}
         |
         v
  [LISTENING]  <─────────────+
  wait for message (30s)     |
         |                   |
    +----+----+              |
    |    |    |              |
  timeout "ping" "subscribe" |
    |    |    |              |
    v    v    v              |
  send  send  send           |
  ping  pong  subscribed     |
    |    |    |              |
    +----+----+--------------+
         |
  WebSocketDisconnect
         |
         v
  [DISCONNECTED]
  manager.disconnect(ws)
```

Max connections: 100 (configurable via `LOKI_MAX_WS_CONNECTIONS`)
Keep-alive timeout: 30 seconds
Message types: `connected`, `ping`, `pong`, `subscribe`, `subscribed`

### 8.5 Dashboard State File

Written atomically every 2 seconds by `run.sh` to `.loki/dashboard-state.json`.

```json
{
  "status": "running|paused|stopped",
  "phase": "understand|guardrail|migrate|verify|...",
  "iteration": 0,
  "complexity": "simple|standard|complex",
  "mode": "autonomous|interactive",
  "provider": "claude|codex|gemini|cline|aider",
  "current_task": "...",
  "budget": {"limit": 0.0, "used": 0.0, "remaining": 0.0},
  "qualityGates": {"gate_name": {"status": "passed|failed"}}
}
```

### 8.6 Dashboard Crash Recovery

Source: `autonomy/run.sh:6809` (handle_dashboard_crash)

```
  Dashboard process exits unexpectedly
         |
         v
  handle_dashboard_crash()
         |
    +----+----+
    |         |
  _DASHBOARD  dashboard
  _RESTARTING disabled
  == true     (guard)
    |         |
    v         v
  return 0   return 0
  (prevent
   recursive
   restart)
         |
    (normal path)
         |
         v
  Check PID file exists + process gone
         |
         v
  Restart dashboard silently
  (no pause handler trigger)
```

---

## 9. Event System

### 9.1 Event Lifecycle

Source: `events/bus.py:86-415`, `events/bus.ts:118-408`, `events/emit.sh`

```
  Event Created
  (emit() or emit_simple())
         |
         v
  [PENDING]
  Written to .loki/events/pending/TIMESTAMP_ID.json
  (atomic write with fcntl.flock / file lock)
         |
         v
  Background processor polls (every 0.5s)
  get_pending_events()
         |
         v
  [PROCESSING]
  For each subscriber:
    if types match: callback(event)
    (errors caught, don't break chain)
         |
         v
  mark_processed(event)
         |
    +----+----+
    |         |
  archive   no archive
  =true     =false
    |         |
    v         v
  [ARCHIVED] [DELETED]
  Moved to    Removed from
  archive/    pending/
         |
         v
  event.id added to processed_ids set
  (max 1000, LRU prune)
```

File format: `TIMESTAMP_ID.json` (e.g., `2026-03-02T14-30-45.123Z_a1b2c3d4.json`)

### 9.2 Event Types and Sources

Source: `events/bus.py:21-44`

Event Types:

| Type | Value | Description |
|------|-------|-------------|
| STATE | `"state"` | Phase changes, status updates |
| MEMORY | `"memory"` | Memory store/retrieve operations |
| TASK | `"task"` | Task lifecycle (claim, complete, fail) |
| METRIC | `"metric"` | Token usage, timing data |
| ERROR | `"error"` | Errors and failures |
| SESSION | `"session"` | Session start/stop/pause |
| COMMAND | `"command"` | CLI command execution |
| USER | `"user"` | User actions (VS Code, dashboard) |

Event Sources:

| Source | Value | Description |
|--------|-------|-------------|
| CLI | `"cli"` | `loki` CLI commands |
| API | `"api"` | Dashboard REST API |
| VSCODE | `"vscode"` | VS Code extension |
| MCP | `"mcp"` | MCP server tools |
| SKILL | `"skill"` | Skill module execution |
| HOOK | `"hook"` | Git/lifecycle hooks |
| DASHBOARD | `"dashboard"` | Dashboard UI actions |
| MEMORY | `"memory"` | Memory system operations |
| RUNNER | `"runner"` | run.sh orchestrator |

### 9.3 Event Data Structure

Source: `events/bus.py:46-84`

```json
{
  "id": "a1b2c3d4",
  "type": "state|memory|task|metric|error|session|command|user",
  "source": "cli|api|vscode|mcp|skill|hook|dashboard|memory|runner",
  "timestamp": "2026-03-02T14:30:45.123Z",
  "payload": {"action": "...", ...},
  "version": "1.0"
}
```

### 9.4 Background Processing States

Source: `events/bus.py` (_running flag), `events/bus.ts` (running + pollInterval)

```
  EventBus created
         |
         v
  [IDLE]
  _running = false
  No polling
         |
    start_background_processing(interval=0.5)
         |
         v
  [PROCESSING]
  _running = true
  Daemon thread/setInterval polls pending/
         |
    stop_background_processing()
         |
         v
  [STOPPED]
  _running = false
  Thread joined (2s timeout) / clearInterval
```

### 9.5 Bash Event Emission

Source: `events/emit.sh:1-93`

```
  ./emit.sh <type> <source> <action> [key=value ...]
         |
         v
  Generate EVENT_ID (8 hex chars from /dev/urandom)
         |
         v
  Generate TIMESTAMP (ISO 8601 UTC)
  Try: GNU date -> python3 fallback -> basic date
         |
         v
  Build payload JSON
  {"action": "<action>", "key1": "val1", ...}
  (json_escape for \, ", \t, \r)
         |
         v
  Write to $EVENTS_DIR/TIMESTAMP_ID.json
         |
         v
  Rotate events.jsonl if > 50MB
  (rename to events.jsonl.1, keep 1 backup)
         |
         v
  Output event ID to stdout
```

---

## 10. MCP Server

### 10.1 Tool Call Lifecycle

Source: `mcp/server.py:473-1403`

```
  MCP client sends tool invocation
         |
         v
  [RECEIVED]
  Parse tool name + arguments
         |
         v
  _emit_tool_event_async(tool, "start")
  Record start_time in _tool_call_start_times
         |
         v
  [EXECUTING]
  Tool function runs:
  - Validate paths (security check)
  - Read/write .loki/ state files
  - Return result
         |
    +----+----+
    |         |
  success   error
    |         |
    v         v
  [COMPLETE] [ERROR]
  _emit_      Return error
  learning_   message
  signal()
         |
         v
  _emit_tool_event_async(tool, "end")
```

14 registered tools + 3 resources:

**Tools** (`@mcp.tool()`):

| Tool | Purpose | State Read | State Write | Line |
|------|---------|------------|-------------|------|
| loki_memory_retrieve | Retrieve memories | episodic/, semantic/ | -- | 472 |
| loki_memory_store_pattern | Store semantic pattern | -- | semantic/patterns/ | 537 |
| loki_task_queue_list | List tasks | queue.json | -- | 597 |
| loki_task_queue_add | Add task | -- | queue.json | 641 |
| loki_task_queue_update | Update task status | queue.json | queue.json | 717 |
| loki_state_get | Get autonomy state | state.json | -- | 788 |
| loki_metrics_efficiency | Get efficiency data | metrics/efficiency/ | -- | 842 |
| loki_consolidate_memory | Run consolidation | episodic/ | semantic/ | 888 |
| loki_start_project | Start RARV execution | -- | spawns run.sh | 992 |
| loki_project_status | Get project status | state.json, dashboard-state | -- | 1044 |
| loki_agent_metrics | Agent performance | Dashboard DB | -- | 1094 |
| loki_checkpoint_restore | Restore checkpoint | checkpoints/ | (various) | 1132 |
| loki_quality_report | Quality gate status | council/verdicts.jsonl | -- | 1182 |
| loki_code_search | Search codebase | (ChromaDB) | -- | 1255 |
| loki_code_search_stats | ChromaDB index stats | (ChromaDB) | -- | 1343 |

**Resources** (`@mcp.resource()`):

| Resource URI | Function | State Read | Line |
|-------------|----------|------------|------|
| loki://state/continuity | get_continuity | continuity.md | 928 |
| loki://memory/index | get_memory_index | memory/index.json | 941 |
| loki://queue/pending | get_pending_tasks | queue.json | 963 |

### 10.2 Path Security Validation

Source: `mcp/server.py:109-150`

```
  Path received from MCP client
         |
         v
  Canonicalize (resolve symlinks)
         |
         v
  Check: is path within allowed base?
  Allowed bases: [".loki", "memory"]
         |
    +----+----+
    |         |
  within    outside
    |         |
    v         v
  [SAFE]   [BLOCKED]
  Proceed   Raise
  with op   PathTraversalError
```

Safe functions: `safe_path_join()`, `safe_open()`, `safe_makedirs()`, `safe_exists()`

---

## 11. Autonomy Utilities

### 11.1 Context Window Tracking

Source: `autonomy/context-tracker.py`

```
  update_tracking() called after each iteration
         |
         v
  Load .loki/context/tracking.json
  (or initialize empty)
         |
         v
  Find session file
  Claude: ~/.claude/projects/<slug>/*.jsonl
  Codex/Gemini: --tokens-input/--tokens-output args
         |
         v
  Parse new entries from last_offset
  (stored in .loki/context/last_offset.txt)
         |
         v
  Detect compactions
  (message contains "being continued from a previous conversation")
         |
         v
  Calculate iteration cost (provider-specific pricing)
         |
         v
  Evaluate context_window_pct
         |
    +----+----+----+
    |    |         |
  0-80%  80-90%  90%+
    |    |         |
    v    v         v
  [NORMAL] [WARNING] [CRITICAL]
                      Triggers notification
```

Provider pricing (USD per million tokens):

| Provider | Input | Output | Cache Read | Cache Creation |
|----------|-------|--------|------------|----------------|
| Claude | $3.00 | $15.00 | $0.30 | $3.75 |
| Codex | $2.00 | $8.00 | -- | -- |
| Gemini | $1.25 | $5.00 | -- | -- |

Context window sizes: Claude=200K, Codex=200K, Gemini=1M

Persistence: `.loki/context/tracking.json` (atomic write via temp+rename)

### 11.2 Notification Triggers

Source: `autonomy/notification-checker.py:24-72`

```
  check_triggers(loki_dir, iteration)
         |
         v
  Load triggers from .loki/notifications/triggers.json
  (create with defaults if missing)
         |
         v
  Load active notifications from .loki/notifications/active.json
         |
         v
  For each trigger (if enabled):
         |
    +----+----+
    |         |
  already    not fired
  fired for  this iteration
  this iter
    |         |
    v         v
  [SKIP]   Evaluate condition
              |
         +----+----+
         |         |
       fired     not fired
         |         |
         v         v
  Append to     [SKIP]
  notifications[]
         |
         v
  Save .loki/notifications/active.json
  (max 100 notifications, prune oldest)
```

6 trigger types:

| Trigger ID | Type | Condition | Severity | Default |
|------------|------|-----------|----------|---------|
| budget-80pct | budget_threshold | budget.used/limit >= 80% | warning | enabled |
| context-90pct | context_threshold | context_window_pct >= 90% | critical | enabled |
| sensitive-file | file_access | regex match on .env/.pem/.key/secret | critical | enabled |
| quality-gate-fail | quality_gate | qualityGates[gate].status == "failed" | warning | enabled |
| stuck-iteration | stagnation | 3+ consecutive "no_change" in convergence.log | warning | enabled |
| compaction-freq | compaction_frequency | 3+ compactions in last hour | warning | enabled |

Notification data structure:
```json
{
  "id": "notif-TIMESTAMP-TRIGGER_ID",
  "trigger_id": "...",
  "severity": "critical|warning|info",
  "message": "...",
  "timestamp": "ISO 8601",
  "iteration": 0,
  "acknowledged": false,
  "data": {}
}
```

Duplicate prevention: `already_fired(trigger_id, iteration)` -- won't re-fire
same trigger for same iteration.

### 11.3 Budget Limit

Source: `autonomy/run.sh:7418` (check_budget_limit)

```
  Before each iteration
         |
         v
  check_budget_limit()
         |
    Read budget from .loki/dashboard-state.json
    or environment LOKI_BUDGET_LIMIT
         |
    +----+----+
    |         |
  within    exceeded
  budget    limit
    |         |
    v         v
  [CONTINUE] [BUDGET_EXCEEDED]
              save_state "budget_exceeded"
              return 1 (stop loop)
```

---

## 12. Parallel Workflows

### 12.1 Git Worktree Lifecycle

Source: `skills/parallel-workflows.md`

```
  Main branch (running)
         |
    Task requires parallel execution
    (Claude provider only, PROVIDER_HAS_PARALLEL=true)
         |
         v
  [CREATE_WORKTREE]
  git worktree add .loki/worktrees/<stream-id> -b <branch>
         |
         v
  [ACTIVE]
  Agent works in isolated worktree
  Independent file system, shared git history
         |
    +----+----+
    |         |
  complete   error
    |         |
    v         v
  [MERGE]   [CLEANUP]
  Auto-merge  Remove worktree
  to main     git worktree remove
    |
    +──> conflict?
         |         |
        yes        no
         |         |
         v         v
  [CONFLICT]    [MERGED]
  Signal to      git worktree remove
  main agent     cleanup
  for resolution
```

### 12.2 Inter-Stream Signal Protocol

```
  Stream A                      Stream B
     |                             |
     +──write SIGNAL file──>       |
     |                             |
     |      <──read SIGNAL file────+
     |                             |
  Signal files in .loki/worktrees/<id>/signals/:
    - COMPLETE: stream finished
    - BLOCKED: stream waiting on dependency
    - ERROR: stream encountered error
    - MERGE_READY: stream ready for merge
```

---

## 13. Checkpoint System

### 13.1 Checkpoint Creation/Rollback

Source: `autonomy/run.sh:6464` (create_checkpoint)

```
  create_checkpoint(description, tag)
         |
         v
  [SNAPSHOT]
  Copy current state files:
    - .loki/state.json
    - .loki/queue/
    - .loki/council/
    - .loki/context/
    - git stash (if uncommitted changes)
         |
         v
  Write to .loki/checkpoints/checkpoint-TAG/
  Include metadata:
    - timestamp
    - iteration
    - description
    - git_ref
         |
         v
  [STORED]
```

Checkpoints are created:
- After each successful iteration (inside `run_autonomous()`)
- After each failed iteration (inside `run_autonomous()`)

Rollback via MCP tool `loki_checkpoint_restore` or CLI.

---

## 14. Complexity Detection

### 14.1 Auto-Detected Tiers

Source: `autonomy/run.sh:1229` (detect_complexity), `run.sh:1322` (get_complexity_phases),
`run.sh:1340` (get_phase_names)

```
  detect_complexity(prd_path)  [line 1196]
         |
         v
  Count source files (excluding node_modules, .git, vendor, dist, build, __pycache__)
  Check for external integrations (OAuth, SAML, OIDC, Stripe, Twilio, AWS, Google Cloud, Azure)
  Check for microservices (docker-compose.yml/yaml, k8s/ directory)
  Analyze PRD word count + feature count (markdown headers/checkboxes or JSON arrays)
         |
    +----+----+----+
    |    |         |
    v    v         v

  [SIMPLE]        [STANDARD]       [COMPLEX]
  <=5 files       6-50 files       >50 files
  No external     (default tier)   External integrations
  integrations                     OR microservices
  PRD <200 words                   OR PRD complex
  + <5 features
    |              |                |
    v              v                v
  Phases (3):    Phases (6):      Phases (8):
  IMPLEMENT      RESEARCH         RESEARCH
  TEST           DESIGN           ARCHITECTURE
  DEPLOY         IMPLEMENT        DESIGN
                 TEST             IMPLEMENT
                 REVIEW           TEST
                 DEPLOY           REVIEW
                                  SECURITY
                                  DEPLOY
```

| Tier | File Count | External Deps | Microservices | PRD | Phase Count |
|------|-----------|---------------|---------------|-----|-------------|
| simple | <=5 | no | no | <200 words + <5 features | 3 |
| standard | 6-50 | (default) | no | 200-1000 words | 6 |
| complex | >50 | yes | yes | >1000 words or >15 features | 8 |

Persistence: `.loki/dashboard-state.json` field `complexity`
Override: `COMPLEXITY_TIER` environment variable (bypasses auto-detection)

---

## Cross-Reference: Component Communication

```
  loki CLI ──exec──> run.sh ──source──> completion-council.sh
     |                  |                       |
     |                  +──source──> providers/loader.sh
     |                  |               +──source──> claude.sh|codex.sh|gemini.sh|cline.sh|aider.sh
     |                  |
     |                  +──python3──> memory/{engine,storage,retrieval,consolidation}.py
     |                  |
     |                  +──python3──> autonomy/context-tracker.py
     |                  |
     |                  +──python3──> autonomy/notification-checker.py
     |                  |
     |                  +──bash──> events/emit.sh
     |                  |
     |                  +──spawn──> dashboard/server.py (FastAPI)
     |                                  |
     |                                  +──import──> dashboard/models.py
     |                                  |
     |                                  +──WebSocket──> VS Code / Browser
     |
     +──────────────────> mcp/server.py (MCP protocol)
                              |
                              +──import──> memory/*.py
                              +──import──> events/bus.py

  All components communicate via .loki/ filesystem state files.
  Events provide async notification; filesystem provides state persistence.
```
