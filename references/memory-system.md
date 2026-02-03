# Memory System Reference

Enhanced memory architecture based on 2025 research (MIRIX, A-Mem, MemGPT, AriGraph).

---

## Implementation Status (v5.15.0)

| Feature | Status | Location |
|---------|--------|----------|
| Episodic Memory | Implemented | memory/engine.py, memory/schemas.py |
| Semantic Memory | Implemented | memory/engine.py, memory/schemas.py |
| Procedural Memory | Implemented | memory/engine.py, memory/schemas.py |
| Progressive Disclosure | Implemented | memory/layers/ |
| Token Economics | Implemented | memory/token_economics.py |
| Vector Search | Implemented (optional) | memory/embeddings.py, memory/vector_index.py |
| Task-Aware Retrieval | Implemented | memory/retrieval.py |
| Consolidation Pipeline | Implemented | memory/consolidation.py |
| Zettelkasten Links | Implemented | memory/consolidation.py |
| CLI Commands | Implemented | autonomy/loki |
| API Endpoints | Implemented | api/routes/memory.ts |
| RARV Integration | Implemented | autonomy/run.sh |

---

## Core Insight: Memory Over Reasoning

> *"Your Agent's Reasoning Is Fine - Its Memory Isn't"*
> -- Cursor Scaling Blog, January 2026

**The fundamental bottleneck in production AI systems is not reasoning capability but context retrieval.**

Production incidents aren't slowed by inability to fix problems - they're slowed by fragmented context. An agent with perfect reasoning but poor memory will:
- Re-discover the same patterns repeatedly
- Miss relevant prior experiences
- Fail to apply learned anti-patterns
- Lose context across session boundaries

An agent with good reasoning and excellent memory will:
- Retrieve relevant patterns before acting
- Avoid previously-encountered failures
- Build on successful approaches
- Maintain continuity across long-running operations

**Implication for Loki Mode:** Invest heavily in memory architecture. The episodic-to-semantic consolidation pipeline, Zettelkasten linking, and CONTINUITY.md working memory are not optional optimizations - they are the core competitive advantage.

---

## Memory Hierarchy Overview

```
+------------------------------------------------------------------+
| WORKING MEMORY (CONTINUITY.md)                                    |
| - Current session state                                           |
| - Updated every turn                                              |
| - What am I doing right NOW?                                      |
+------------------------------------------------------------------+
        |
        v
+------------------------------------------------------------------+
| EPISODIC MEMORY (.loki/memory/episodic/)                         |
| - Specific interaction traces                                     |
| - Full context with timestamps                                    |
| - "What happened when I tried X?"                                 |
+------------------------------------------------------------------+
        |
        v (consolidation)
+------------------------------------------------------------------+
| SEMANTIC MEMORY (.loki/memory/semantic/)                         |
| - Generalized patterns and facts                                  |
| - Context-independent knowledge                                   |
| - "How does X work in general?"                                   |
+------------------------------------------------------------------+
        |
        v
+------------------------------------------------------------------+
| PROCEDURAL MEMORY (.loki/memory/skills/)                         |
| - Learned action sequences                                        |
| - Reusable skill templates                                        |
| - "How to do X successfully"                                      |
+------------------------------------------------------------------+
```

---

## Directory Structure

```
.loki/memory/
+-- episodic/
|   +-- 2026-01-06/
|   |   +-- task-001.json      # Full trace of task execution
|   |   +-- task-002.json
|   +-- index.json             # Temporal index for retrieval
|
+-- semantic/
|   +-- patterns.json          # Generalized patterns
|   +-- anti-patterns.json     # What NOT to do
|   +-- facts.json             # Domain knowledge
|   +-- links.json             # Zettelkasten-style connections
|
+-- skills/
|   +-- api-implementation.md  # Skill: How to implement an API
|   +-- test-writing.md        # Skill: How to write tests
|   +-- debugging.md           # Skill: How to debug issues
|
+-- ledgers/                   # Agent-specific checkpoints
|   +-- eng-001.json
|   +-- qa-001.json
|
+-- handoffs/                  # Agent-to-agent transfers
|   +-- handoff-001.json
|
+-- learnings/                 # Extracted from errors
|   +-- 2026-01-06.json

# Related: Metrics System (separate from memory)
# .loki/metrics/
# +-- efficiency/              # Task cost tracking (time, agents, retries)
# +-- rewards/                 # Outcome/efficiency/preference signals
# +-- dashboard.json           # Rolling 7-day metrics summary
# See references/tool-orchestration.md for details
```

---

## Episodic Memory Schema

Each task execution creates an episodic trace:

```json
{
  "id": "ep-2026-01-06-001",
  "task_id": "task-042",
  "timestamp": "2026-01-06T10:30:00Z",
  "duration_seconds": 342,
  "agent": "eng-001-backend",
  "context": {
    "phase": "development",
    "goal": "Implement POST /api/todos endpoint",
    "constraints": ["No third-party deps", "< 200ms response"],
    "files_involved": ["src/routes/todos.ts", "src/db/todos.ts"]
  },
  "action_log": [
    {"t": 0, "action": "read_file", "target": "openapi.yaml"},
    {"t": 5, "action": "write_file", "target": "src/routes/todos.ts"},
    {"t": 120, "action": "run_test", "result": "fail", "error": "missing return type"},
    {"t": 140, "action": "edit_file", "target": "src/routes/todos.ts"},
    {"t": 180, "action": "run_test", "result": "pass"}
  ],
  "outcome": "success",
  "errors_encountered": [
    {
      "type": "TypeScript compilation",
      "message": "Missing return type annotation",
      "resolution": "Added explicit :void to route handler"
    }
  ],
  "artifacts_produced": ["src/routes/todos.ts", "tests/todos.test.ts"],
  "git_commit": "abc123"
}
```

---

## Semantic Memory Schema

Generalized patterns extracted from episodic memory:

```json
{
  "id": "sem-001",
  "pattern": "Express route handlers require explicit return types in strict mode",
  "category": "typescript",
  "conditions": [
    "Using TypeScript strict mode",
    "Writing Express route handlers",
    "Handler doesn't return a value"
  ],
  "correct_approach": "Add `: void` to handler signature: `(req, res): void =>`",
  "incorrect_approach": "Omitting return type annotation",
  "confidence": 0.95,
  "source_episodes": ["ep-2026-01-06-001", "ep-2026-01-05-012"],
  "usage_count": 8,
  "last_used": "2026-01-06T14:00:00Z",
  "links": [
    {"to": "sem-005", "relation": "related_to"},
    {"to": "sem-012", "relation": "supersedes"}
  ]
}
```

---

## Episodic-to-Semantic Consolidation

**When to consolidate:** After task completion, during idle time, at phase boundaries.

```python
def consolidate_episodic_to_semantic():
    """
    Transform specific experiences into general knowledge.
    Based on MemGPT and Voyager research.
    """
    # 1. Load recent episodic memories
    recent_episodes = load_episodes(since=hours_ago(24))

    # 2. Group by similarity
    clusters = cluster_by_similarity(recent_episodes)

    for cluster in clusters:
        if len(cluster) >= 2:  # Pattern appears multiple times
            # 3. Extract common pattern
            pattern = extract_common_pattern(cluster)

            # 4. Validate pattern
            if pattern.confidence >= 0.8:
                # 5. Check if already exists
                existing = find_similar_semantic(pattern)
                if existing:
                    # Update existing with new evidence
                    existing.source_episodes.extend([e.id for e in cluster])
                    existing.confidence = recalculate_confidence(existing)
                    existing.usage_count += 1
                else:
                    # Create new semantic memory
                    save_semantic(pattern)

    # 6. Consolidate anti-patterns from errors
    error_episodes = [e for e in recent_episodes if e.errors_encountered]
    for episode in error_episodes:
        for error in episode.errors_encountered:
            anti_pattern = {
                "what_fails": error.type,
                "why": error.message,
                "prevention": error.resolution,
                "source": episode.id
            }
            save_anti_pattern(anti_pattern)
```

---

## Zettelkasten-Style Linking

Each memory note can link to related notes:

```json
{
  "links": [
    {"to": "sem-005", "relation": "derived_from"},
    {"to": "sem-012", "relation": "contradicts"},
    {"to": "sem-018", "relation": "elaborates"},
    {"to": "sem-023", "relation": "example_of"},
    {"to": "sem-031", "relation": "superseded_by"}
  ]
}
```

### Link Relations

| Relation | Meaning |
|----------|---------|
| `derived_from` | This pattern was extracted from that episode |
| `related_to` | Conceptually similar, often used together |
| `contradicts` | These patterns conflict - need resolution |
| `elaborates` | Provides more detail on the linked pattern |
| `example_of` | Specific instance of a general pattern |
| `supersedes` | This pattern replaces an older one |
| `superseded_by` | This pattern is outdated, use the linked one |

---

## Procedural Memory (Skills)

Reusable action sequences:

```markdown
# Skill: API Endpoint Implementation

## Prerequisites
- OpenAPI spec exists at .loki/specs/openapi.yaml
- Database schema defined

## Steps
1. Read endpoint spec from openapi.yaml
2. Create route handler in src/routes/{resource}.ts
3. Implement request validation using spec schema
4. Implement business logic
5. Add database operations if needed
6. Return response matching spec schema
7. Write contract tests
8. Run tests, verify passing

## Common Errors & Fixes
- Missing return type: Add `: void` to handler
- Schema mismatch: Regenerate types from spec

## Exit Criteria
- All contract tests pass
- Response matches OpenAPI spec
- No TypeScript errors
```

---

## Memory Retrieval

### Retrieval by Similarity

```python
def retrieve_relevant_memory(current_context):
    """
    Retrieve memories relevant to current task.
    Uses semantic similarity + temporal recency.
    """
    query_embedding = embed(current_context.goal)

    # 1. Search semantic memory first
    semantic_matches = vector_search(
        collection="semantic",
        query=query_embedding,
        top_k=5
    )

    # 2. Search episodic memory for similar situations
    episodic_matches = vector_search(
        collection="episodic",
        query=query_embedding,
        top_k=3,
        filters={"outcome": "success"}  # Prefer successful episodes
    )

    # 3. Search skills
    skill_matches = keyword_search(
        collection="skills",
        keywords=extract_keywords(current_context)
    )

    # 4. Combine and rank
    combined = merge_and_rank(
        semantic_matches,
        episodic_matches,
        skill_matches,
        weights={"semantic": 0.5, "episodic": 0.3, "skills": 0.2}
    )

    return combined[:5]  # Return top 5 most relevant
```

### Retrieval Before Task Execution

**CRITICAL:** Before executing any task, retrieve relevant memories:

```python
def before_task_execution(task):
    """
    Inject relevant memories into task context.
    """
    # 1. Retrieve relevant memories
    memories = retrieve_relevant_memory(task)

    # 2. Check for anti-patterns
    anti_patterns = search_anti_patterns(task.action_type)

    # 3. Inject into prompt
    task.context["relevant_patterns"] = [m.summary for m in memories]
    task.context["avoid_these"] = [a.summary for a in anti_patterns]
    task.context["applicable_skills"] = find_skills(task.type)

    return task
```

### Task-Aware Memory Strategy Selection

**Research Source:** arXiv 2512.18746 - MemEvolve demonstrates that task-aware memory adaptation improves agent performance by 17% compared to static retrieval weights.

**Important Clarification:** This is NOT full meta-evolution where the system learns to modify its own memory strategies over time. This is a simpler, pragmatic approach: task-type detection followed by applying pre-defined weight configurations. True meta-evolution (as in the full MemEvolve paper) would require online learning of strategy parameters - that remains future work.

#### Strategy Definitions

Different task types benefit from different memory compositions:

```yaml
task_memory_strategies:
  exploration:
    description: "Understanding codebase, researching options, investigating architecture"
    weights:
      episodic: 0.6    # Breadth of past experiences - what was tried before
      semantic: 0.3    # General patterns - how things usually work
      skills: 0.1      # Less relevant - not yet executing
    rationale: "Exploration benefits from breadth over depth"

  implementation:
    description: "Writing code, building features, creating new functionality"
    weights:
      semantic: 0.5    # Proven patterns - what works
      skills: 0.35     # Action sequences - how to do it
      episodic: 0.15   # Similar implementations - specific examples
    rationale: "Implementation needs patterns and procedures"

  debugging:
    description: "Fixing bugs, investigating issues, resolving errors"
    weights:
      anti_patterns: 0.4   # What NOT to do - critical for debugging
      episodic: 0.4        # Similar error cases - what worked before
      semantic: 0.2        # General error patterns
    rationale: "Debugging requires knowing what fails and past solutions"

  review:
    description: "Code review, quality checks, validation"
    weights:
      semantic: 0.5        # Quality patterns - standards to enforce
      episodic: 0.3        # Past review outcomes - what was caught
      anti_patterns: 0.2   # Common mistakes to flag
    rationale: "Review needs quality criteria and historical issues"

  refactoring:
    description: "Improving code structure without changing behavior"
    weights:
      semantic: 0.45   # Design patterns - target structure
      skills: 0.3      # Refactoring procedures - safe transformations
      episodic: 0.25   # Past refactoring success/failure
    rationale: "Refactoring needs clear patterns and safe procedures"
```

#### Task Type Detection

Detect task type from context using keyword signals and structural patterns:

```python
def detect_task_type(task_context):
    """
    Detect task type from context to select appropriate memory strategy.
    Uses keyword matching and structural analysis.

    Returns: One of 'exploration', 'implementation', 'debugging', 'review', 'refactoring'
    """
    goal = task_context.get("goal", "").lower()
    action = task_context.get("action_type", "").lower()
    phase = task_context.get("phase", "").lower()

    # Keyword signals for each task type
    signals = {
        "exploration": {
            "keywords": ["explore", "understand", "research", "investigate",
                        "analyze", "discover", "find", "what is", "how does",
                        "architecture", "structure", "overview"],
            "actions": ["read_file", "search", "list_files"],
            "phases": ["planning", "discovery", "research"]
        },
        "implementation": {
            "keywords": ["implement", "create", "build", "add", "write",
                        "develop", "make", "construct", "new feature"],
            "actions": ["write_file", "create_file", "edit_file"],
            "phases": ["development", "implementation", "coding"]
        },
        "debugging": {
            "keywords": ["fix", "debug", "error", "bug", "issue", "broken",
                        "failing", "crash", "exception", "investigate error"],
            "actions": ["run_test", "check_logs", "trace"],
            "phases": ["debugging", "troubleshooting", "fixing"]
        },
        "review": {
            "keywords": ["review", "check", "validate", "verify", "audit",
                        "inspect", "quality", "standards", "lint"],
            "actions": ["diff", "review_pr", "check_style"],
            "phases": ["review", "qa", "validation"]
        },
        "refactoring": {
            "keywords": ["refactor", "restructure", "reorganize", "clean up",
                        "improve structure", "extract", "rename", "move"],
            "actions": ["rename", "move_file", "extract_function"],
            "phases": ["refactoring", "cleanup", "optimization"]
        }
    }

    # Score each task type based on signal matches
    scores = {}
    for task_type, type_signals in signals.items():
        score = 0

        # Keyword matches (weight: 2)
        for keyword in type_signals["keywords"]:
            if keyword in goal:
                score += 2

        # Action matches (weight: 3)
        for action_signal in type_signals["actions"]:
            if action_signal in action:
                score += 3

        # Phase matches (weight: 4 - strongest signal)
        for phase_signal in type_signals["phases"]:
            if phase_signal in phase:
                score += 4

        scores[task_type] = score

    # Return highest scoring type, default to 'implementation'
    best_type = max(scores, key=scores.get)
    if scores[best_type] == 0:
        return "implementation"  # Default when no signals match

    return best_type
```

#### Applying Task-Aware Retrieval

Modified retrieval function that applies task-specific weights:

```python
# Strategy weight configurations
TASK_STRATEGIES = {
    "exploration": {"episodic": 0.6, "semantic": 0.3, "skills": 0.1, "anti_patterns": 0.0},
    "implementation": {"episodic": 0.15, "semantic": 0.5, "skills": 0.35, "anti_patterns": 0.0},
    "debugging": {"episodic": 0.4, "semantic": 0.2, "skills": 0.0, "anti_patterns": 0.4},
    "review": {"episodic": 0.3, "semantic": 0.5, "skills": 0.0, "anti_patterns": 0.2},
    "refactoring": {"episodic": 0.25, "semantic": 0.45, "skills": 0.3, "anti_patterns": 0.0}
}

def retrieve_task_aware_memory(current_context):
    """
    Retrieve memories with task-type-aware weighting.

    Based on MemEvolve (arXiv 2512.18746) finding that task-aware
    adaptation improves performance by 17% over static weights.

    Note: This is simple strategy selection, NOT meta-evolution.
    """
    # 1. Detect task type
    task_type = detect_task_type(current_context)
    weights = TASK_STRATEGIES[task_type]

    query_embedding = embed(current_context.goal)
    results = {}

    # 2. Search each memory type
    if weights["semantic"] > 0:
        results["semantic"] = vector_search(
            collection="semantic",
            query=query_embedding,
            top_k=int(5 * weights["semantic"] / 0.5)  # Scale top_k by weight
        )

    if weights["episodic"] > 0:
        # For debugging, don't filter to only successful episodes
        filters = {} if task_type == "debugging" else {"outcome": "success"}
        results["episodic"] = vector_search(
            collection="episodic",
            query=query_embedding,
            top_k=int(5 * weights["episodic"] / 0.5),
            filters=filters
        )

    if weights["skills"] > 0:
        results["skills"] = keyword_search(
            collection="skills",
            keywords=extract_keywords(current_context),
            top_k=int(3 * weights["skills"] / 0.3)
        )

    if weights["anti_patterns"] > 0:
        results["anti_patterns"] = search_anti_patterns(
            query=query_embedding,
            top_k=int(5 * weights["anti_patterns"] / 0.4)
        )

    # 3. Merge with task-specific weights
    combined = merge_and_rank_weighted(results, weights)

    # 4. Log strategy selection for analysis
    log_strategy_selection(
        task_type=task_type,
        weights=weights,
        results_count={k: len(v) for k, v in results.items() if v}
    )

    return combined[:5]
```

#### Integration with Existing Retrieval

Update `before_task_execution` to use task-aware retrieval:

```python
def before_task_execution_with_strategy(task):
    """
    Inject relevant memories into task context using task-aware strategy.
    Enhanced version of before_task_execution().
    """
    # 1. Detect task type for logging/debugging
    task_type = detect_task_type(task)
    task.context["detected_task_type"] = task_type

    # 2. Retrieve memories with task-aware weights
    memories = retrieve_task_aware_memory(task)

    # 3. For debugging tasks, explicitly surface anti-patterns
    if task_type == "debugging":
        anti_patterns = [m for m in memories if m.source == "anti_patterns"]
        task.context["critical_avoid"] = [a.summary for a in anti_patterns]

    # 4. Inject into prompt
    task.context["relevant_patterns"] = [m.summary for m in memories]
    task.context["applicable_skills"] = find_skills(task.type)

    return task
```

#### Limitations and Future Work

**What this IS:**
- Pre-defined strategy selection based on task type detection
- Static weight configurations applied dynamically
- Simple keyword/phase-based task classification

**What this is NOT (future work):**
- Meta-evolution: System does NOT learn to modify its own strategies
- Online learning: Weights are NOT updated based on outcomes
- Adaptive threshold adjustment: Detection thresholds are fixed
- Cross-task transfer: Learned patterns don't automatically propagate

**Future enhancements (not yet implemented):**
1. Track retrieval effectiveness per strategy -> adjust weights
2. Learn task type detection from outcomes
3. Implement full MemEvolve meta-learning loop
4. A/B test different weight configurations

---

## Ledger System (Agent Checkpoints)

Each agent maintains its own ledger:

```json
{
  "agent_id": "eng-001-backend",
  "last_checkpoint": "2026-01-06T10:00:00Z",
  "tasks_completed": 12,
  "current_task": "task-042",
  "state": {
    "files_modified": ["src/routes/todos.ts"],
    "uncommitted_changes": true,
    "last_git_commit": "abc123"
  },
  "context": {
    "tech_stack": ["express", "typescript", "sqlite"],
    "patterns_learned": ["sem-001", "sem-005"],
    "current_goal": "Implement CRUD for todos"
  }
}
```

---

## Handoff Protocol

When switching between agents:

```json
{
  "id": "handoff-001",
  "from_agent": "eng-001-backend",
  "to_agent": "qa-001-testing",
  "timestamp": "2026-01-06T11:00:00Z",
  "context": {
    "what_was_done": "Implemented POST /api/todos endpoint",
    "artifacts": ["src/routes/todos.ts"],
    "git_state": "commit abc123",
    "needs_testing": ["unit tests for validation", "contract tests"],
    "known_issues": [],
    "relevant_patterns": ["sem-001"]
  }
}
```

---

## Memory Maintenance

### Pruning Old Episodic Memories

```python
def prune_episodic_memories():
    """
    Keep episodic memories from:
    - Last 7 days (full detail)
    - Last 30 days (summarized)
    - Older: only if referenced by semantic memory
    """
    now = datetime.now()

    for episode in load_all_episodes():
        age_days = (now - episode.timestamp).days

        if age_days > 30:
            if not is_referenced_by_semantic(episode):
                archive_episode(episode)
        elif age_days > 7:
            summarize_episode(episode)
```

### Merging Duplicate Patterns

```python
def merge_duplicate_semantics():
    """
    Find and merge semantically similar patterns.
    """
    all_patterns = load_semantic_patterns()

    clusters = cluster_by_embedding_similarity(all_patterns, threshold=0.9)

    for cluster in clusters:
        if len(cluster) > 1:
            # Keep highest confidence, merge sources
            primary = max(cluster, key=lambda p: p.confidence)
            for other in cluster:
                if other != primary:
                    primary.source_episodes.extend(other.source_episodes)
                    primary.usage_count += other.usage_count
                    create_link(other, primary, "superseded_by")
            save_semantic(primary)
```

---

## Progressive Disclosure Architecture

**Research Source:** claude-mem (thedotmack) - Progressive Disclosure memory system

The Progressive Disclosure pattern reduces token usage by 60-80% by structuring memory into three layers that load progressively based on need. Instead of loading all context upfront, the system discovers what exists cheaply, then loads only what is relevant.

### The Problem

Traditional memory systems load full context every time:
- 10,000 tokens of episodic memory loaded
- Agent only needed 500 tokens of relevant context
- 9,500 tokens wasted on discovery

### Three-Layer Solution

```
+------------------------------------------------------------------+
| LAYER 1: INDEX (~100 tokens)                                      |
| .loki/memory/index.json                                           |
| What exists? Quick topic scan. Always loaded at session start.    |
+------------------------------------------------------------------+
        |
        | (load on context need)
        v
+------------------------------------------------------------------+
| LAYER 2: TIMELINE (~500 tokens)                                   |
| .loki/memory/timeline.json                                        |
| Recent compressed history. Key decisions. Active context.         |
+------------------------------------------------------------------+
        |
        | (load on specific topic need)
        v
+------------------------------------------------------------------+
| LAYER 3: FULL DETAILS (unlimited)                                 |
| .loki/memory/episodic/*.json, .loki/memory/semantic/*.json       |
| Complete context. Loaded only when specific topic needed.         |
+------------------------------------------------------------------+
```

### Layer 1: Index Layer (~100 tokens)

Always loaded at session start. Provides a quick scan of what exists in memory.

**File:** `.loki/memory/index.json`

```json
{
  "version": "1.0",
  "last_updated": "2026-01-25T10:00:00Z",
  "topics": [
    {
      "id": "auth-system",
      "summary": "JWT authentication implementation",
      "relevance_score": 0.92,
      "last_accessed": "2026-01-25T09:30:00Z",
      "token_count": 2400
    },
    {
      "id": "api-routes",
      "summary": "REST API endpoint patterns",
      "relevance_score": 0.85,
      "last_accessed": "2026-01-24T14:00:00Z",
      "token_count": 1800
    },
    {
      "id": "deployment-config",
      "summary": "Docker and CI/CD setup",
      "relevance_score": 0.71,
      "last_accessed": "2026-01-23T11:00:00Z",
      "token_count": 950
    }
  ],
  "total_memories": 47,
  "total_tokens_available": 28500
}
```

**Usage:** Scan topics to determine if relevant context exists before loading anything.

### Layer 2: Timeline Layer (~500 tokens)

Compressed recent history. Loaded when context is needed but full details are not yet required.

**File:** `.loki/memory/timeline.json`

```json
{
  "version": "1.0",
  "last_updated": "2026-01-25T10:00:00Z",
  "recent_actions": [
    {
      "timestamp": "2026-01-25T09:45:00Z",
      "action": "Implemented refresh token rotation",
      "outcome": "success",
      "topic_id": "auth-system"
    },
    {
      "timestamp": "2026-01-25T09:30:00Z",
      "action": "Fixed JWT expiration bug",
      "outcome": "success",
      "topic_id": "auth-system"
    },
    {
      "timestamp": "2026-01-25T08:00:00Z",
      "action": "Added rate limiting to /api/login",
      "outcome": "success",
      "topic_id": "api-routes"
    }
  ],
  "key_decisions": [
    {
      "decision": "Use RS256 for JWT signing",
      "rationale": "Better security for distributed verification",
      "date": "2026-01-24",
      "topic_id": "auth-system"
    },
    {
      "decision": "15-minute access token expiry",
      "rationale": "Balance security with UX",
      "date": "2026-01-24",
      "topic_id": "auth-system"
    }
  ],
  "active_context": {
    "current_focus": "auth-system",
    "blocked_by": [],
    "next_up": ["api-routes", "testing"]
  }
}
```

**Usage:** Understand recent activity and key decisions without loading full episodic traces.

### Layer 3: Full Details (Unlimited)

Complete context loaded only when a specific topic is needed.

**Files:**
- `.loki/memory/episodic/*.json` - Full interaction traces
- `.loki/memory/semantic/*.json` - Complete pattern definitions

**Usage:** Load only when working directly on a topic identified from Layer 1/2.

### Token Economics Tracking

Track the efficiency of memory access patterns:

**File:** `.loki/memory/token_economics.json`

```json
{
  "session_id": "session-2026-01-25-001",
  "metrics": {
    "discovery_tokens": 150,
    "read_tokens": 2400,
    "ratio": 0.0625,
    "savings_vs_full_load": "78%"
  },
  "breakdown": {
    "layer1_loads": 1,
    "layer1_tokens": 100,
    "layer2_loads": 1,
    "layer2_tokens_scanned": 50,
    "layer2_tokens_available": 450,
    "layer3_loads": 1,
    "layer3_tokens": 2400
  },
  "baseline_comparison": {
    "traditional_approach_tokens": 11500,
    "progressive_approach_tokens": 2550,
    "tokens_saved": 8950
  }
}
```

**Key Metrics:**

| Metric | Definition | Target |
|--------|------------|--------|
| `discovery_tokens` | Tokens spent finding what exists (L1 + L2 scanning) | Minimize |
| `read_tokens` | Tokens spent reading full context (L3) | Necessary cost |
| `ratio` | discovery_tokens / read_tokens | < 0.1 (10%) |
| `savings_vs_full_load` | % tokens saved vs loading everything | > 60% |

### Action Thresholds

When metrics exceed thresholds, take corrective action:

| Metric | Threshold | Action | Rationale |
|--------|-----------|--------|-----------|
| `ratio` | > 0.15 (15%) | Compress Layer 3 entries | Discovery overhead too high; reduce L3 volume by archiving old entries or merging related topics |
| `savings_vs_full_load` | < 50% | Review topic relevance scoring | Progressive loading not providing sufficient benefit; topic boundaries may be too broad |
| `layer3_loads` | > 3 in single task | Create specialized index | Frequent cross-topic access indicates missing abstraction; create composite topic entry |
| `discovery_tokens` | > 200 | Reorganize topic index | Layer 1 index bloated or poorly structured; prune stale topics, merge overlapping entries |
| `layer2_tokens_scanned` | > 100 per query | Split large timelines | Timeline entries too verbose or topic too broad; consider sub-topic decomposition |
| `tokens_saved` | < 1000 per session | Evaluate memory ROI | Memory system overhead may exceed benefit for this session type; consider bypass mode |

#### Evaluation Frequency

Thresholds should be evaluated at specific checkpoints rather than continuously:

| Checkpoint | Evaluation Type | Rationale |
|------------|-----------------|-----------|
| After each task completion | Lightweight check | Per-task evaluation is cheap (~10 token overhead). Catches issues early before they compound. Only checks `ratio` and `layer3_loads`. |
| At session boundaries | Full evaluation | Comprehensive check of all thresholds. Session end is natural pause point for maintenance. Evaluates all 6 metrics. |
| When Layer 3 load count exceeds 2 | Triggered check | Prevents runaway costs mid-session. If hitting L3 frequently, stop and evaluate before continuing. Checks `layer3_loads` and `ratio`. |

**Why this pattern:**
- Per-task checks are lightweight (~10 tokens overhead) and catch issues early before they compound into expensive sessions
- Session boundary checks are comprehensive but infrequent, amortizing evaluation cost across all session work
- Triggered checks act as circuit breakers, preventing runaway token costs when access patterns degrade mid-session

```python
def should_evaluate_thresholds(checkpoint_type, breakdown):
    """
    Determine evaluation scope based on checkpoint type.
    """
    if checkpoint_type == "task_complete":
        # Lightweight: only check high-impact metrics
        return ["ratio", "layer3_loads"]

    elif checkpoint_type == "session_end":
        # Full evaluation at session boundary
        return ["ratio", "savings_vs_full_load", "layer3_loads",
                "discovery_tokens", "layer2_tokens_scanned", "tokens_saved"]

    elif checkpoint_type == "triggered":
        # Mid-session triggered by high L3 access
        if breakdown.get("layer3_loads", 0) > 2:
            return ["layer3_loads", "ratio"]

    return []  # No evaluation needed
```

#### Priority Order (Multiple Thresholds)

When multiple thresholds are exceeded simultaneously, process corrective actions in this order:

| Priority | Metric | Action | Rationale |
|----------|--------|--------|-----------|
| 1 (HIGHEST) | `ratio > 0.15` | Compress Layer 3 entries | Cost control - discovery overhead directly impacts every query |
| 2 | `savings_vs_full_load < 50%` | Review topic relevance scoring | ROI validation - progressive loading must justify its complexity |
| 3 | `layer3_loads > 3` | Create specialized index | Structure issue - frequent cross-topic access indicates architectural gap |
| 4 | `discovery_tokens > 200` | Reorganize topic index | Index bloat - Layer 1 should remain lean for fast scanning |
| 5 | `layer2_tokens_scanned > 100` | Split large timelines | Timeline bloat - Layer 2 scanning becoming expensive |
| 6 (LOWEST) | `tokens_saved < 1000` | Evaluate memory ROI | Informational - may indicate memory system not needed for this session type |

**Prioritization rationale:** Cost-impacting issues (ratio, savings) take precedence over structural issues (loads, bloat). Token spend is the primary optimization target; structural improvements support that goal.

```python
# Priority-ordered threshold definitions
THRESHOLD_PRIORITY = [
    {"metric": "ratio", "threshold": 0.15, "priority": 1},
    {"metric": "savings_vs_full_load", "threshold": 50, "priority": 2},
    {"metric": "layer3_loads", "threshold": 3, "priority": 3},
    {"metric": "discovery_tokens", "threshold": 200, "priority": 4},
    {"metric": "layer2_tokens_scanned", "threshold": 100, "priority": 5},
    {"metric": "tokens_saved", "threshold": 1000, "priority": 6},
]

def prioritize_actions(actions):
    """
    Sort corrective actions by priority when multiple thresholds exceeded.
    """
    priority_map = {t["metric"]: t["priority"] for t in THRESHOLD_PRIORITY}

    def get_priority(action):
        # Extract metric from action reason
        for metric in priority_map:
            if metric in action.get("reason", ""):
                return priority_map[metric]
        return 99  # Unknown actions last

    return sorted(actions, key=get_priority)
```

**Threshold Implementation:**

```python
def check_thresholds(metrics, breakdown):
    """
    Evaluate metrics against action thresholds.
    Returns list of recommended actions.
    """
    actions = []

    if metrics["ratio"] > 0.15:
        actions.append({
            "action": "compress_layer3",
            "reason": f"Discovery ratio {metrics['ratio']:.2%} exceeds 15%",
            "priority": "high"
        })

    if float(metrics["savings_vs_full_load"].rstrip('%')) < 50:
        actions.append({
            "action": "review_topic_relevance",
            "reason": f"Savings {metrics['savings_vs_full_load']} below 50% target",
            "priority": "medium"
        })

    if breakdown["layer3_loads"] > 3:
        actions.append({
            "action": "create_specialized_index",
            "reason": f"{breakdown['layer3_loads']} L3 loads in single task",
            "priority": "medium"
        })

    if metrics["discovery_tokens"] > 200:
        actions.append({
            "action": "reorganize_topic_index",
            "reason": f"Discovery tokens ({metrics['discovery_tokens']}) exceed 200",
            "priority": "low"
        })

    return actions
```

### Compression Algorithm

Moving context from Layer 3 to Layer 2 to Layer 1:

```python
def compress_to_timeline(episodic_entry):
    """
    Layer 3 -> Layer 2: Full episodic trace to timeline entry.
    Compression ratio: ~10:1
    """
    return {
        "timestamp": episodic_entry["timestamp"],
        "action": summarize_in_10_words(episodic_entry["context"]["goal"]),
        "outcome": episodic_entry["outcome"],
        "topic_id": extract_topic(episodic_entry)
    }

def compress_to_index(topic_memories):
    """
    Layer 2 -> Layer 1: Timeline entries to index topic.
    Compression ratio: ~20:1
    """
    return {
        "id": topic_memories[0]["topic_id"],
        "summary": extract_one_line_summary(topic_memories),
        "relevance_score": calculate_relevance(topic_memories),
        "last_accessed": max(m["timestamp"] for m in topic_memories),
        "token_count": sum(m.get("token_count", 0) for m in topic_memories)
    }

def summarize_in_10_words(text):
    """
    Compress any text to ~10 words capturing core meaning.
    Uses extractive summarization, not generative.
    """
    # Extract subject-verb-object from first sentence
    # Remove adjectives and adverbs
    # Keep only action and target
    return extract_svo(text)[:10]

def extract_one_line_summary(topic_memories):
    """
    Create topic summary from multiple memories.
    """
    # Find most common action type
    # Combine with most specific target
    # Result: "JWT authentication implementation"
    actions = [m["action"] for m in topic_memories]
    return find_common_theme(actions)
```

### Progressive Loading Algorithm

```python
def load_relevant_context(query):
    """
    Load context progressively, minimizing token usage.
    """
    tokens_used = {"discovery": 0, "read": 0}

    # Step 1: Always load index (~100 tokens)
    index = load_file(".loki/memory/index.json")
    tokens_used["discovery"] += 100

    # Step 2: Find relevant topics from index
    relevant_topics = [
        t for t in index["topics"]
        if similarity(t["summary"], query) > 0.5
    ]

    if not relevant_topics:
        return None, tokens_used  # Nothing relevant found

    # Step 3: Load timeline for context (~500 tokens)
    timeline = load_file(".loki/memory/timeline.json")
    tokens_used["discovery"] += 50  # Only scan relevant entries

    # Check if timeline has enough context
    recent_for_topic = [
        a for a in timeline["recent_actions"]
        if a["topic_id"] in [t["id"] for t in relevant_topics]
    ]

    if sufficient_context(recent_for_topic, query):
        return recent_for_topic, tokens_used  # Timeline was enough

    # Step 4: Load full details only if needed
    for topic in relevant_topics[:2]:  # Limit to top 2 topics
        full_context = load_full_topic(topic["id"])
        tokens_used["read"] += topic["token_count"]

    return full_context, tokens_used
```

### Directory Structure Update

The progressive disclosure layers integrate with the existing memory structure:

```
.loki/memory/
+-- index.json              # Layer 1: Topic index (~100 tokens)
+-- timeline.json           # Layer 2: Compressed history (~500 tokens)
+-- token_economics.json    # Tracking metrics
+-- episodic/               # Layer 3: Full episodic traces
|   +-- 2026-01-06/
|   |   +-- task-001.json
|   +-- index.json          # Temporal index for retrieval
+-- semantic/               # Layer 3: Full semantic patterns
|   +-- patterns.json
|   +-- anti-patterns.json
|   +-- facts.json
|   +-- links.json          # Zettelkasten connections
+-- skills/                 # Procedural memory (separate system)
+-- ledgers/                # Agent checkpoints
+-- handoffs/               # Agent-to-agent transfers
+-- learnings/              # Extracted from errors
```

### Benefits

1. **60-80% Token Reduction:** Only load what you need
2. **Faster Discovery:** Index scan is O(1) instead of O(n)
3. **Predictable Costs:** Know token budget before loading
4. **Graceful Degradation:** Works with partial loads

---

## Modular Memory Design Space (MemEvolve)

**Research Source:** arXiv 2512.18746 - MemEvolve: Meta-Evolution of Agent Memory Systems

MemEvolve proposes a 4-component framework for decomposing and analyzing agent memory systems. This section maps the framework to Loki Mode's existing architecture.

### The Four Components

| Component | Function | Loki Mode Implementation |
|-----------|----------|--------------------------|
| **Encode** | How raw experience is structured | Episodic traces with action_log, context, artifacts |
| **Store** | How it is integrated into memory | JSON files in `.loki/memory/`, consolidation pipeline |
| **Retrieve** | How it is recalled | Similarity search, temporal index, keyword search |
| **Manage** | Offline processes | Pruning, merging duplicates, archiving |

### Encode: Structuring Raw Experience

MemEvolve identifies encoding as the first critical decision: how raw observations, actions, and outcomes are transformed into structured memory entries.

**Loki Mode Implementation:**

Episodic memory entries encode experience with:
- `action_log`: Timestamped sequence of actions taken
- `context`: Phase, goal, constraints, files involved
- `errors_encountered`: Structured error types, messages, resolutions
- `artifacts_produced`: Files created or modified
- `outcome`: Success/failure classification

```json
{
  "context": {
    "phase": "development",
    "goal": "Implement POST /api/todos endpoint",
    "constraints": ["No third-party deps", "< 200ms response"],
    "files_involved": ["src/routes/todos.ts", "src/db/todos.ts"]
  },
  "action_log": [
    {"t": 0, "action": "read_file", "target": "openapi.yaml"},
    {"t": 5, "action": "write_file", "target": "src/routes/todos.ts"}
  ],
  "artifacts_produced": ["src/routes/todos.ts", "tests/todos.test.ts"]
}
```

**MemEvolve Alignment:** Loki Mode uses structured encoding with explicit action traces. The encoding preserves temporal ordering and causal relationships between actions.

### Store: Integrating Into Memory

MemEvolve examines how encoded information is integrated and organized within the memory system.

**Loki Mode Implementation:**

1. **Primary Storage:** JSON files in `.loki/memory/` hierarchy
   - Episodic: `.loki/memory/episodic/{date}/task-{id}.json`
   - Semantic: `.loki/memory/semantic/patterns.json`, `anti-patterns.json`
   - Procedural: `.loki/memory/skills/*.md`

2. **Consolidation Pipeline:** Episodic-to-semantic transformation
   - Cluster similar episodes
   - Extract common patterns (confidence >= 0.8)
   - Update existing patterns or create new ones
   - Extract anti-patterns from error episodes

3. **Zettelkasten Linking:** Cross-references between memory entries
   - Relations: `derived_from`, `related_to`, `contradicts`, `supersedes`
   - Stored in `links.json` and embedded in pattern entries

**MemEvolve Alignment:** Loki Mode implements hierarchical storage (episodic -> semantic -> procedural) with explicit consolidation. The Zettelkasten linking provides associative structure beyond simple hierarchies.

### Retrieve: Recalling Memories

MemEvolve analyzes how memories are located and retrieved at inference time.

**Loki Mode Implementation:**

1. **Similarity Search:** Vector-based retrieval
   ```python
   semantic_matches = vector_search(
       collection="semantic",
       query=query_embedding,
       top_k=5
   )
   ```

2. **Temporal Index:** Date-based episodic retrieval
   - `.loki/memory/episodic/index.json` provides temporal navigation
   - Enables queries like "what happened last week"

3. **Keyword Search:** Skill matching by keywords
   ```python
   skill_matches = keyword_search(
       collection="skills",
       keywords=extract_keywords(current_context)
   )
   ```

4. **Progressive Disclosure:** 3-layer loading (index -> timeline -> full)
   - Minimizes token usage by loading incrementally
   - Index layer (~100 tokens) always loaded first

**MemEvolve Alignment:** Loki Mode uses multi-modal retrieval (vector, temporal, keyword). The progressive disclosure pattern optimizes retrieval cost.

### Manage: Offline Processes

MemEvolve identifies management operations that maintain memory quality over time.

**Loki Mode Implementation:**

1. **Pruning:** Time-based retention policy
   - Last 7 days: full detail
   - Last 30 days: summarized
   - Older: archived unless referenced by semantic memory

2. **Merging Duplicates:** Semantic deduplication
   ```python
   clusters = cluster_by_embedding_similarity(all_patterns, threshold=0.9)
   # Keep highest confidence, merge source episodes
   # Create superseded_by links to deprecated entries
   ```

3. **Archiving:** Move stale entries to cold storage
   - Unreferenced episodes archived after 30 days
   - Semantic patterns with low usage_count flagged for review

4. **Compression:** Layer transitions
   - Full episodic -> Timeline entry (~10:1 compression)
   - Timeline entries -> Index topic (~20:1 compression)

**MemEvolve Alignment:** Loki Mode implements standard memory hygiene (pruning, merging, archiving). Compression enables efficient long-term storage.

### Gap Analysis: Meta-Evolution

**Critical Limitation:** Loki Mode does NOT implement meta-evolution.

MemEvolve's key contribution is the meta-evolution mechanism: using search algorithms (evolutionary strategies, random search) to automatically discover optimal memory architectures for specific tasks.

| MemEvolve Feature | Loki Mode Status |
|-------------------|------------------|
| Encode component | Implemented (fixed design) |
| Store component | Implemented (fixed design) |
| Retrieve component | Implemented (fixed design) |
| Manage component | Implemented (fixed design) |
| **Meta-evolution** | **NOT IMPLEMENTED** |

**What Loki Mode lacks:**

1. **Architecture Search:** No mechanism to automatically vary memory component implementations
2. **Fitness Evaluation:** No systematic evaluation of memory architecture performance on tasks
3. **Evolutionary Optimization:** No search over the design space of possible memory configurations

**Current State:** Loki Mode's memory architecture is **static** - defined at design time and unchanged during operation. The 4 components (encode, store, retrieve, manage) are implemented but fixed.

**Potential Future Work:**

If meta-evolution were added, it could optimize:
- Encoding granularity (action-level vs. session-level traces)
- Storage hierarchy depth (2 layers vs. 3 layers)
- Retrieval weighting (semantic vs. episodic emphasis)
- Pruning thresholds (retention periods, confidence cutoffs)

However, this would require infrastructure for:
- Generating architecture variants
- Evaluating variant performance on benchmark tasks
- Selecting and propagating successful variants

This represents a significant architectural change beyond current scope.

### Meta-Evolution Roadmap (Speculative)

**Important Disclaimer:** This roadmap is speculative. Loki Mode may **NEVER** implement full meta-evolution. The pragmatic approach is to optimize the fixed architecture based on observed usage patterns rather than invest in automated architecture search. The phases below represent what *could* be built, not what *will* be built.

#### Phase 1: Strategy Logging (v6.x) - Effort: Low (~2 weeks)

**Status:** NOT PLANNED

Track which memory strategies perform best in practice without any automated adjustment.

**What it would add:**
- Log retrieval strategy used per query (vector, temporal, keyword)
- Record outcome signal (did the retrieved memory help?)
- Store success/failure rates per strategy in `.loki/metrics/memory-strategy/`

**Example logging format:**
```json
{
  "query_id": "q-20260125-001",
  "timestamp": "2026-01-25T10:30:00Z",
  "retrieval_strategies": [
    {"type": "vector", "results": 3, "latency_ms": 45},
    {"type": "temporal", "results": 2, "latency_ms": 12}
  ],
  "selected_memories": ["sem-042", "ep-2026-01-20-007"],
  "outcome": "success",
  "task_completed": true
}
```

**Value:** Data collection only. Enables manual analysis of which strategies work best for which task types. No automatic adjustment.

**Risk:** Low. Pure observability layer with no behavioral changes.

---

#### Phase 2: A/B Testing Infrastructure (v7.x) - Effort: Medium (~1-2 months)

**Status:** NOT PLANNED

Enable comparison of different weight configurations without automated selection.

**What it would add:**
- Define named weight profiles (e.g., "semantic-heavy", "episodic-heavy", "balanced")
- Randomly assign sessions to profiles for controlled comparison
- Dashboard/report comparing profile performance metrics

**Example profile definitions:**
```yaml
profiles:
  semantic-heavy:
    semantic_weight: 0.7
    episodic_weight: 0.2
    skill_weight: 0.1

  episodic-heavy:
    semantic_weight: 0.2
    episodic_weight: 0.7
    skill_weight: 0.1

  balanced:
    semantic_weight: 0.34
    episodic_weight: 0.33
    skill_weight: 0.33
```

**Metrics to compare:**
- Task completion rate per profile
- Average retrieval latency
- Context token usage
- User satisfaction signals (if available)

**Value:** Evidence-based profile selection. Humans choose best profile based on data.

**Risk:** Medium. Requires careful experiment design to avoid confounding variables.

---

#### Phase 3: Online Learning (v8.x) - Effort: High (~3-6 months)

**Status:** NOT PLANNED - SIGNIFICANT INVESTMENT

Automatically adjust retrieval weights based on observed outcomes.

**What it would add:**
- Bandit algorithm (Thompson Sampling or UCB) over weight configurations
- Gradual weight adjustment based on success signals
- Guardrails to prevent catastrophic configuration drift

**Algorithm sketch:**
```python
# Thompson Sampling over discrete weight buckets
class MemoryWeightOptimizer:
    def __init__(self):
        # Prior: Beta(1,1) = uniform for each weight bucket
        self.alpha = defaultdict(lambda: 1.0)  # success counts
        self.beta = defaultdict(lambda: 1.0)   # failure counts

    def select_weights(self):
        # Sample from posterior for each strategy
        samples = {}
        for strategy in ['semantic', 'episodic', 'skill']:
            samples[strategy] = np.random.beta(
                self.alpha[strategy],
                self.beta[strategy]
            )
        # Normalize to sum to 1
        total = sum(samples.values())
        return {k: v/total for k, v in samples.items()}

    def update(self, strategy, success: bool):
        if success:
            self.alpha[strategy] += 1
        else:
            self.beta[strategy] += 1
```

**Guardrails required:**
- Minimum exploration rate (never drop below 10% for any strategy)
- Maximum update rate (no more than 5% weight shift per day)
- Automatic rollback if task completion rate drops >20%

**Value:** Self-improving retrieval that adapts to usage patterns.

**Risk:** High. Automated adjustment could degrade performance if outcome signals are noisy or delayed. Requires robust monitoring and rollback capabilities.

---

#### Phase 4: Full Meta-Evolution (v9.x) - Effort: Very High (~6-12 months)

**Status:** NOT PLANNED - MAY NEVER BE IMPLEMENTED

True architecture search over the design space of memory configurations.

**What it would add:**
- Define architecture search space (component variants, hyperparameters)
- Evolutionary algorithm over architecture configurations
- Fitness function based on composite performance metrics
- Population-based training with crossover and mutation

**Search space dimensions:**
| Component | Variants |
|-----------|----------|
| Encoding | Action-level, Session-level, Hierarchical |
| Storage layers | 2, 3, or 4 layers |
| Retrieval modes | Vector-only, Hybrid, Graph-based |
| Pruning policy | Time-based, Usage-based, Importance-based |
| Compression | 5:1, 10:1, 20:1 ratios |

**Search space size:** ~300+ distinct configurations

**Fitness function (example):**
```python
def fitness(architecture, benchmark_tasks):
    task_score = evaluate_task_completion(architecture, benchmark_tasks)
    efficiency = 1.0 / measure_token_usage(architecture)
    latency_penalty = max(0, avg_latency - 100ms) / 1000

    return (
        0.6 * task_score +
        0.3 * efficiency -
        0.1 * latency_penalty
    )
```

**Why this may never be built:**

1. **Diminishing returns:** A well-tuned fixed architecture likely captures 90%+ of potential value. Meta-evolution chases the last 10% at 10x the engineering cost.

2. **Benchmark limitations:** MemEvolve evaluated on synthetic benchmarks (reading comprehension, trip planning). Real-world Loki Mode tasks have no clean benchmark equivalent.

3. **Evaluation cost:** Each architecture variant requires extensive testing. At 300+ configurations with multiple evaluation runs each, this becomes expensive.

4. **Complexity vs. maintainability:** Self-modifying architectures are hard to debug, reason about, and maintain.

5. **Sufficient without it:** The current fixed design handles Loki Mode's use cases well. Investment is better spent on other features.

**Honest assessment:** Full meta-evolution is academically interesting but likely not worth the investment for Loki Mode. The pragmatic path is:
- Implement Phase 1 (logging) to understand patterns
- Maybe implement Phase 2 (A/B testing) if data suggests significant improvement potential
- Stop there unless clear evidence justifies further investment

---

### Summary: Gap Mitigation Strategy

| Gap | Mitigation | Status |
|-----|------------|--------|
| No architecture search | Use well-researched fixed design | Current |
| No fitness evaluation | Observability + manual tuning | Current |
| No weight optimization | Sensible defaults from literature | Current |
| Strategy logging | Phase 1 candidate | NOT PLANNED |
| A/B testing | Phase 2 candidate | NOT PLANNED |
| Online learning | Phase 3 candidate | NOT PLANNED |
| Full meta-evolution | Phase 4 candidate | PROBABLY NEVER |

The current fixed architecture is a reasonable tradeoff. Meta-evolution would be valuable for systems with diverse, well-benchmarked task distributions. Loki Mode's primary value is in autonomous code generation, where other factors (model capability, prompt engineering, tool integration) likely dominate over memory architecture optimization.

---

## Integration with CONTINUITY.md

CONTINUITY.md is **working memory** that sits above the 3-layer progressive disclosure system:

```
+------------------------------------------------------------------+
| CONTINUITY.md (Working Memory)                                    |
| - Read/write every turn                                           |
| - Current task state, decisions, blockers                         |
| - NOT part of long-term memory system                             |
+------------------------------------------------------------------+
        |
        | (references, doesn't duplicate)
        v
+------------------------------------------------------------------+
| Progressive Disclosure Layers (Long-Term Memory)                  |
| Layer 1: index.json -> Layer 2: timeline.json -> Layer 3: full    |
+------------------------------------------------------------------+
```

### How They Work Together

1. **Session Start:** Load CONTINUITY.md (always), then load Layer 1 index.json
2. **Task Execution:** CONTINUITY.md references memory IDs (e.g., `[sem-001]`) without duplicating content
3. **Context Retrieval:** When CONTINUITY.md references a topic, progressive load from Layer 1 -> 2 -> 3
4. **Session End:** Update CONTINUITY.md with outcomes; update timeline.json with compressed entries

### CONTINUITY.md References Pattern

CONTINUITY.md references but doesn't duplicate long-term memory:

```markdown
## Relevant Memories (Auto-Retrieved)
- [sem-001] Express handlers need explicit return types
- [ep-2026-01-05-012] Similar endpoint implementation succeeded
- [skill: api-implementation] Standard API implementation flow

## Mistakes to Avoid (From Learnings)
- Don't forget return type annotations
- Run contract tests before marking complete
```

These IDs (`sem-001`, `ep-2026-01-05-012`) can be resolved via Layer 1 -> 3 lookup when full context is needed.
