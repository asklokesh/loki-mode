# Loki Mode Tool Integration

This document shows how all Loki Mode tools work together to create a unified autonomous development experience.

## Tool Overview

| Tool | Entry Point | Purpose | Communication |
|------|-------------|---------|---------------|
| **CLI** | `loki` | User interface for all operations | File-based state |
| **API** | `loki serve` | Remote control, SSE events | HTTP/REST |
| **VS Code** | Extension | IDE integration | API client |
| **MCP** | Claude tools | Claude Code integration | STDIO/MCP protocol |
| **SKILL** | SKILL.md | Autonomy rules and behavior | File reads |
| **Memory** | `memory/` | Cross-session learning | File storage |
| **Events** | `events/` | Cross-tool communication | File pub/sub |

## Data Flow Architecture

```
                    +-----------------+
                    |     User        |
                    +--------+--------+
                             |
         +-------------------+-------------------+
         |         |         |         |         |
         v         v         v         v         v
     +------+  +------+  +------+  +------+  +------+
     | CLI  |  |VSCode|  | API  |  | MCP  |  |SKILL |
     +--+---+  +--+---+  +--+---+  +--+---+  +--+---+
        |         |         |         |         |
        |         +---------+---------+---------+
        |                   |
        v                   v
    +---+---+         +-----+-----+
    |run.sh |         | Event Bus |
    +---+---+         +-----+-----+
        |                   |
        +-------------------+
                |
        +-------+-------+
        |               |
        v               v
    +---+---+     +-----+-----+
    | State |     |  Memory   |
    +-------+     +-----------+
        |               |
        +-------+-------+
                |
                v
           +----+----+
           | .loki/  |
           +---------+
```

## Integration Points

### 1. CLI -> Everything

The CLI (`autonomy/loki`) is the primary entry point and can:

```bash
# Start autonomous execution (triggers run.sh -> Memory -> Events)
loki start ./prd.md

# Control session (triggers Events)
loki pause
loki resume
loki stop

# Access memory directly
loki memory index
loki memory retrieve "authentication"

# Manage API server (enables VS Code, dashboard)
loki serve --port 8420
loki api start

# View dashboard (web UI)
loki dashboard open
```

### 2. API -> State + Events

The API server (`api/server.ts`) bridges external tools to internal state:

```
HTTP Request -> API Server -> State Files -> Response
                    |
                    +-> Event Bus -> Other Tools
```

**Key Endpoints:**
- `POST /api/sessions` - Start session (emits session:start event)
- `GET /api/events` - SSE stream (subscribes to Event Bus)
- `GET /api/memory/*` - Memory access (reads from Memory Engine)
- `POST /api/sessions/:id/input` - Inject input (writes to .loki/messages/)

### 3. VS Code -> API -> State

VS Code Extension communicates via the API:

```typescript
// extension.ts
const response = await apiRequest('/api/sessions', 'POST', {
    provider: 'claude',
    prd: '/path/to/prd.md'
});
```

**Features:**
- Session tree view (polls `/api/sessions`)
- Task list (polls `/api/tasks`)
- Status bar (subscribes to `/api/events`)
- Chat panel (uses `/api/sessions/:id/input`)

### 4. MCP -> State + Memory

MCP Server exposes Loki Mode capabilities to Claude Code:

```python
# Claude calls this tool
@mcp.tool()
async def loki_memory_retrieve(query: str, task_type: str) -> str:
    # Reads from Memory Engine
    return memory_engine.retrieve(query, task_type)

@mcp.tool()
async def loki_state_get() -> str:
    # Reads from .loki/state/
    return json.dumps(state)
```

**Tools Available to Claude:**
- `loki_memory_retrieve` - Search memories
- `loki_task_queue_list` - View tasks
- `loki_state_get` - Get current state
- `loki_consolidate_memory` - Run consolidation

### 5. Event Bus -> All Tools

The Event Bus enables real-time communication:

```python
# CLI emits event
bus.emit_simple(EventType.SESSION, EventSource.CLI, 'start', provider='claude')

# API receives it
for event in bus.subscribe(types=[EventType.SESSION]):
    broadcast_to_sse_clients(event)

# VS Code sees it via SSE
eventSource.onmessage = (e) => updateUI(JSON.parse(e.data))
```

**Event Flow Example:**

1. User runs `loki start ./prd.md`
2. CLI emits `session:start` event
3. API server picks up event, broadcasts via SSE
4. VS Code extension receives SSE, updates status bar
5. Dashboard receives SSE, adds session to list
6. MCP can query state to see session is active

### 6. Memory -> All Tools

Memory system provides cross-session learning:

```
Tool Action -> Memory Store -> Pattern Consolidation -> Tool Query
```

**Write Path:**
- Hooks store episodes after each session
- Consolidation creates semantic patterns
- Skills are learned from repeated patterns

**Read Path:**
- SKILL.md loads memory context at start
- MCP retrieves relevant memories
- API provides memory endpoints
- CLI queries via `loki memory retrieve`

## State File Ownership

| File | Primary Writer | Readers |
|------|---------------|---------|
| `.loki/state/orchestrator.json` | run.sh | All |
| `.loki/queue/*.json` | SKILL/run.sh | All |
| `.loki/CONTINUITY.md` | SKILL | SKILL, MCP |
| `.loki/memory/*` | Memory Engine | All |
| `.loki/events/*` | Event Bus | All |
| `.loki/autonomy-state.json` | run.sh | CLI, API |

## Synergy Examples

### Example 1: User Edits File in VS Code

```
1. User edits file
2. VS Code extension detects change (workspace watcher)
3. Extension emits 'user:file_edit' event via API
4. Event Bus propagates to Memory Engine
5. Memory stores as episodic trace
6. Later: MCP retrieves "user was editing auth.ts"
7. Claude prioritizes auth-related suggestions
```

### Example 2: CLI Starts Session

```
1. User runs: loki start ./prd.md
2. CLI emits 'session:start' event
3. run.sh loads SKILL.md, starts Claude
4. Hooks load memory context (session-init.sh)
5. API server sees event, updates /status
6. VS Code sees SSE event, updates tree view
7. Dashboard shows new session
```

### Example 3: Claude Queries Memory via MCP

```
1. Claude needs context about previous errors
2. Claude calls loki_memory_retrieve("authentication errors")
3. MCP server calls Memory Engine
4. Memory Engine returns relevant episodes
5. Claude uses context in response
6. Response quality improves due to memory
```

## Configuration Files

| File | Purpose | Used By |
|------|---------|---------|
| `.mcp.json` | MCP server config | Claude Code |
| `.claude/settings.json` | Hook configuration | Claude Code |
| `.loki/config/` | Provider settings | CLI, run.sh |
| `vscode-extension/package.json` | Extension settings | VS Code |

## Future Synergy (v5.18+)

Per SYNERGY-ROADMAP.md:

1. **Memory as Central Hub** - All tools query and contribute to memory
2. **Smart State Sync** - Coordinated state with conflict resolution
3. **Cross-Tool Learning** - Every interaction improves all tools
4. **Unified Dashboard** - Same experience everywhere

---

*Document Version: 1.0*
*Last Updated: 2026-02-03*
