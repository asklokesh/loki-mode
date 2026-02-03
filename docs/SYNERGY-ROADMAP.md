# Loki Mode Synergy Roadmap v5.17

## Executive Summary

This document outlines the architectural improvements to create **unified synergy** across all Loki Mode tools (CLI, API, VS Code Extension, MCP Server, Memory System) to establish Loki as the leader in autonomous development.

**Goal**: Every tool interaction should inform and enhance all others, creating a flywheel effect where the system becomes smarter and more efficient with each use.

---

## Current Architecture (v5.16.0)

```
                    +------------------+
                    |    User/Dev      |
                    +--------+---------+
                             |
        +--------------------+--------------------+
        |          |         |         |          |
        v          v         v         v          v
    +------+  +--------+  +------+  +-----+  +--------+
    | CLI  |  |VS Code |  | API  |  | MCP |  | SKILL  |
    +--+---+  +---+----+  +--+---+  +--+--+  +---+----+
       |          |          |        |          |
       |          v          |        |          |
       |    +---------+      |        |          |
       +--->| run.sh  |<-----+        |          |
            +----+----+               |          |
                 |                    |          |
                 v                    v          v
            +----+--------------------+----------+----+
            |              .loki/ State               |
            |  (files, queue, memory, metrics, logs)  |
            +-----------------------------------------+
```

**Problems:**
1. Each tool reads/writes .loki/ independently (no coordination)
2. No event propagation between tools
3. Memory system underutilized (only hooks use it)
4. VS Code Extension isolated from MCP context
5. No cross-tool learning or optimization

---

## Target Architecture (v5.17.0)

```
                        +------------------+
                        |    User/Dev      |
                        +--------+---------+
                                 |
            +--------------------+--------------------+
            |          |         |         |          |
            v          v         v         v          v
        +------+  +--------+  +------+  +-----+  +--------+
        | CLI  |  |VS Code |  | API  |  | MCP |  | SKILL  |
        +--+---+  +---+----+  +--+---+  +--+--+  +---+----+
           |          |          |        |          |
           +----------+----------+--------+----------+
                               |
                      +--------v--------+
                      |   Event Bus     |
                      | (State Manager) |
                      +--------+--------+
                               |
              +----------------+----------------+
              |                |                |
              v                v                v
        +-----+-----+    +-----+-----+    +-----+-----+
        |  State    |    |  Memory   |    |  Metrics  |
        |  Engine   |    |  Engine   |    |  Engine   |
        +-----------+    +-----------+    +-----------+
              |                |                |
              +----------------+----------------+
                               |
                      +--------v--------+
                      |    .loki/       |
                      | (Persistence)   |
                      +-----------------+
```

---

## Synergy Pillars

### Pillar 1: Unified Event Bus

**Current State**: No event propagation between components.

**Target State**: All tools emit and subscribe to a shared event bus.

**Implementation**:

```typescript
// events/bus.ts - Shared Event Bus
interface LokiEvent {
  type: 'state' | 'memory' | 'task' | 'metric' | 'error';
  source: 'cli' | 'api' | 'vscode' | 'mcp' | 'skill' | 'hook';
  timestamp: string;
  payload: Record<string, unknown>;
}

// File-based pub/sub for cross-process communication
// .loki/events/pending/*.json -> processed -> .loki/events/archive/
```

**Events to emit**:
| Source | Event Types |
|--------|-------------|
| CLI | session_start, session_stop, phase_change, command_executed |
| API | request_received, session_control, memory_queried |
| VS Code | user_action, file_edited, task_viewed, input_injected |
| MCP | tool_called, resource_accessed, prompt_executed |
| SKILL | rarv_cycle, task_claimed, task_completed, drift_detected |

**Benefits**:
- VS Code sees real-time updates from CLI
- Memory records all interactions across tools
- Metrics capture cross-tool usage patterns
- MCP can observe user context from VS Code

---

### Pillar 2: Memory as Central Hub

**Current State**: Memory system exists but only hooks feed it.

**Target State**: All tools query and contribute to memory.

**Memory Integration Matrix**:

| Component | Currently Uses Memory | Should Use Memory |
|-----------|----------------------|-------------------|
| CLI | Yes (hooks only) | Full (all commands) |
| API | Yes (endpoints exist) | Full (proactive suggestions) |
| VS Code | No | Yes (context panel, suggestions) |
| MCP | Yes (retrieval tool) | Full (automatic context loading) |
| SKILL | Yes (CONTINUITY.md) | Full (semantic + episodic) |

**Implementation**:

```python
# memory/unified_access.py
class UnifiedMemoryAccess:
    """Single interface for all components to access memory."""

    def get_relevant_context(self, task_type: str, query: str) -> MemoryContext:
        """Get unified context from all memory layers."""
        episodic = self.retrieval.get_episodes(query, task_type)
        semantic = self.retrieval.get_patterns(query)
        procedural = self.retrieval.get_skills(query)

        return MemoryContext(
            relevant_episodes=episodic,
            applicable_patterns=semantic,
            suggested_skills=procedural,
            token_budget=self.economics.get_budget()
        )

    def record_interaction(self, source: str, action: dict) -> None:
        """Record any interaction from any source."""
        self.storage.append_action(
            source=source,
            action=action,
            timestamp=utcnow()
        )
```

**VS Code Memory Panel**:
- Show relevant patterns for current file
- Display recent episodes from this project
- Suggest skills based on current task
- Token economics dashboard

---

### Pillar 3: Smart State Synchronization

**Current State**: Each tool reads .loki/ files independently.

**Target State**: Coordinated state with change notifications.

**Implementation**:

```typescript
// state/manager.ts - Unified State Manager
class StateManager {
  private watchers: Map<string, FSWatcher> = new Map();
  private cache: Map<string, unknown> = new Map();
  private subscribers: Set<(event: StateChange) => void> = new Set();

  // Single source of truth for all state
  async getState(key: string): Promise<unknown> {
    if (this.cache.has(key)) {
      return this.cache.get(key);
    }
    const value = await this.loadFromDisk(key);
    this.cache.set(key, value);
    return value;
  }

  // Atomic updates with broadcast
  async setState(key: string, value: unknown, source: string): Promise<void> {
    await this.writeToDisk(key, value);
    this.cache.set(key, value);
    this.broadcast({ key, value, source, timestamp: Date.now() });
  }

  // All tools subscribe to changes
  subscribe(callback: (event: StateChange) => void): Disposable {
    this.subscribers.add(callback);
    return { dispose: () => this.subscribers.delete(callback) };
  }
}
```

**Key State Files to Synchronize**:
- `.loki/state/orchestrator.json` - Phase, metrics, agent state
- `.loki/queue/*.json` - Task queue status
- `.loki/CONTINUITY.md` - Working memory
- `.loki/autonomy-state.json` - Runner status
- `.loki/memory/index.json` - Memory topics

---

### Pillar 4: Cross-Tool Learning

**Current State**: Tools don't learn from each other.

**Target State**: Every tool interaction improves all tools.

**Learning Flows**:

```
VS Code Edit -> Memory: "User prefers this pattern"
                    |
                    v
MCP Tool Call <- Memory: "Suggest this pattern"
                    |
                    v
CLI Execution -> Metrics: "Pattern success rate: 85%"
                    |
                    v
Memory Update <- Metrics: "Promote to semantic pattern"
```

**Examples**:

1. **VS Code file edits inform CLI suggestions**:
   - Track which files user edits most
   - CLI prioritizes those areas in task generation
   - Memory records "user focus areas"

2. **CLI errors improve VS Code hints**:
   - Track common errors in CLI execution
   - VS Code shows inline hints for error-prone patterns
   - Memory records "things that break"

3. **MCP tool usage informs API endpoints**:
   - Track which MCP tools get called most
   - API surfaces those as quick actions
   - Memory records "frequently needed operations"

---

### Pillar 5: Unified Dashboard

**Current State**: Separate dashboard (React) and VS Code panel.

**Target State**: Single dashboard usable everywhere.

**Implementation Options**:

1. **Web Components**: Build dashboard as reusable web components
   - Works in standalone browser
   - Embeds in VS Code webview
   - Embeds in CLI TUI (via webview bridge)

2. **API-First Dashboard**: Dashboard is just an API client
   - All state from API server
   - Multiple frontends (React, VS Code, TUI)
   - Real-time via SSE

**Unified Dashboard Features**:
- Task Kanban board
- Memory browser (episodic, semantic, procedural)
- Metrics visualization
- Real-time log streaming
- Session control (start/stop/pause)
- Provider switching
- PRD viewer/editor

---

## Implementation Phases

### Phase 1: Event Bus Foundation (v5.17.0)

**Tasks**:
1. Create `events/` module with file-based event bus
2. Add event emission to CLI commands
3. Add event emission to API routes
4. Add event subscription to VS Code extension
5. Add event emission to MCP tools

**Files to Create/Modify**:
- `events/bus.py` - Core event bus (Python)
- `events/bus.ts` - TypeScript client
- `autonomy/loki` - Add event emission
- `api/services/event-bus.ts` - Integrate with existing
- `vscode-extension/src/events/` - Subscribe to events

**Deliverable**: All components can see events from all other components.

---

### Phase 2: Memory Integration (v5.18.0)

**Tasks**:
1. Create unified memory access layer
2. Add memory context to VS Code sidebar
3. Add memory retrieval to CLI start
4. Add automatic context loading to MCP
5. Add memory-informed suggestions to API

**Files to Create/Modify**:
- `memory/unified_access.py` - Unified interface
- `vscode-extension/src/views/memoryView.ts` - Memory panel
- `autonomy/loki` - Memory-informed startup
- `mcp/server.py` - Auto-load context
- `api/routes/suggestions.ts` - Memory-based suggestions

**Deliverable**: Memory informs all tools; all tools contribute to memory.

---

### Phase 3: Smart Sync (v5.19.0)

**Tasks**:
1. Create centralized state manager
2. Replace direct file reads with state manager
3. Add optimistic updates with conflict resolution
4. Add state versioning for rollback

**Files to Create/Modify**:
- `state/manager.ts` - State manager
- `state/manager.py` - Python bindings
- All components: Use state manager

**Deliverable**: Single source of truth for all state.

---

### Phase 4: Cross-Tool Learning (v5.20.0)

**Tasks**:
1. Define learning signal types
2. Implement learning collectors in each tool
3. Create learning aggregator
4. Add learning-based suggestions
5. Add learning metrics dashboard

**Files to Create/Modify**:
- `learning/signals.py` - Signal definitions
- `learning/aggregator.py` - Aggregation logic
- All components: Emit learning signals

**Deliverable**: Tools learn from each other and improve over time.

---

### Phase 5: Unified Dashboard (v5.21.0)

**Tasks**:
1. Extract dashboard components as standalone
2. Create VS Code webview integration
3. Create CLI webview bridge (optional)
4. Unify styling and behavior

**Files to Create/Modify**:
- `dashboard/components/` - Reusable components
- `vscode-extension/src/views/dashboardView.ts` - Embed dashboard

**Deliverable**: Same dashboard experience everywhere.

---

## Success Metrics

| Metric | Current | Target |
|--------|---------|--------|
| Cross-tool event latency | N/A | <100ms |
| Memory utilization (tools using memory) | 2/5 (40%) | 5/5 (100%) |
| State sync conflicts | Unknown | <1/day |
| Learning signal coverage | 0% | 80%+ |
| Dashboard feature parity | 50% | 100% |
| User task completion time | Baseline | -30% |
| Context switching (tool changes) | Frequent | Minimal |

---

## Competitive Advantages

After implementing synergy:

| Feature | Loki Mode | claude-flow | Auto-Claude |
|---------|-----------|-------------|-------------|
| Unified memory across tools | Yes | No | No |
| Cross-tool event propagation | Yes | Partial | No |
| Smart state synchronization | Yes | No | No |
| Learning from all interactions | Yes | No | No |
| Single dashboard everywhere | Yes | No | No |
| Token economics visibility | Yes | No | No |

---

## Quick Wins (Can Implement Now)

1. **VS Code -> Memory**: Record file edits as episodes
2. **CLI -> Events**: Emit events on command execution
3. **API -> Memory**: Return relevant patterns with status
4. **MCP -> Events**: Emit tool call events
5. **Memory -> API**: Add suggestions endpoint

These quick wins can be implemented without major architectural changes and provide immediate value.

---

## Architecture Decision Records

### ADR-001: File-Based Event Bus

**Context**: Need cross-process event propagation.

**Decision**: Use file-based pub/sub (.loki/events/) with file watching.

**Rationale**:
- Works across Python, Node, Bash
- Persists events for replay
- No additional dependencies
- Natural integration with .loki/ directory

**Alternatives Considered**:
- Unix sockets (complex, not cross-platform)
- Redis (external dependency)
- HTTP polling (high overhead)

### ADR-002: Memory as Single Source of Context

**Context**: Tools need shared context but have different runtimes.

**Decision**: Memory system is the canonical context store.

**Rationale**:
- Already has Python implementation
- Supports progressive disclosure (tokens)
- Natural place for learnings
- Can serve all tools via file reads or API

**Alternatives Considered**:
- Distributed state (complex)
- Per-tool context (fragmented)
- External database (dependency)

---

## Next Steps

1. Review and approve this roadmap
2. Create GitHub issues for each phase
3. Begin Phase 1 implementation
4. Establish weekly synergy metrics review

---

*Document Version: 1.0*
*Last Updated: 2026-02-03*
*Authored by: Loki Mode Development Team*
