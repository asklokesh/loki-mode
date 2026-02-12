# Loki Mode Dashboard V2 Architecture

**Status:** Design Phase
**Version:** 0.1.0 (Draft)
**Date:** 2026-02-01
**Author:** Claude Code

---

## Executive Summary

This document outlines the architecture for a new enterprise-grade Loki Mode Dashboard with Python FastAPI backend, real-time updates, and cross-codebase project management. The new dashboard replaces the current static HTML/file-based approach with a proper database-backed, event-driven system.

---

## 1. Current State Analysis

### 1.1 Existing Components

| Component | Location | Description | Limitations |
|-----------|----------|-------------|-------------|
| Static Dashboard | `autonomy/.loki/dashboard/index.html` | Single-file HTML/CSS/JS (~2000 lines) | No persistence, file-polling for updates |
| Node.js API (legacy) | `autonomy/api-server.js` | Simple HTTP server (zero deps) - replaced by FastAPI | SSE polling, no database, single project |
| Deno API | `api/server.ts` | TypeScript HTTP/SSE server | File-based state, no cross-project |
| State Files | `.loki/dashboard-state.json` | JSON state written by run.sh | 2-second polling, no real-time |

### 1.2 Current Data Flow

```
run.sh --> .loki/dashboard-state.json --> Python HTTP server --> Static HTML
     \                                                              |
      \--> .loki/queue/pending.json                                 |
                                                                    v
                                              JavaScript polling (2s interval)
```

### 1.3 Key Limitations to Address

1. **No Database**: All state is JSON files - no history, no relationships
2. **Single Project**: Dashboard only shows current working directory
3. **File Polling**: 2-second intervals, not truly real-time
4. **No Authentication**: API endpoints have no auth for remote access
5. **No Cross-Project**: Cannot manage multiple codebases simultaneously
6. **No Persistence**: Task history lost when session ends

---

## 2. Proposed Architecture

### 2.1 High-Level Overview

```
                                    +-------------------+
                                    |   Frontend SPA    |
                                    |   (React + Vite)  |
                                    +--------+----------+
                                             |
                                             | WebSocket + REST
                                             v
+------------------+              +--------------------+
|   CLI Client     |   REST API   |   FastAPI Server   |
| (loki dashboard) +------------->|   (Python 3.11+)   |
+------------------+              +----------+---------+
                                             |
                    +------------------------+------------------------+
                    |                        |                        |
                    v                        v                        v
           +----------------+       +----------------+       +----------------+
           |   SQLite/      |       |   WebSocket    |       |   File System  |
           |   PostgreSQL   |       |   Broadcast    |       |   Watcher      |
           +----------------+       +----------------+       +----------------+
                    |                        |                        |
                    v                        v                        v
           +----------------+       +----------------+       +----------------+
           | Projects, Tasks|       | Real-time UI   |       | .loki/ dirs    |
           | Sessions, Logs |       | Updates        |       | (per project)  |
           +----------------+       +----------------+       +----------------+
```

### 2.2 Technology Stack

| Layer | Technology | Rationale |
|-------|------------|-----------|
| Backend | Python 3.11+ FastAPI | Async-first, type hints, auto-docs |
| Database | SQLite (default) / PostgreSQL | Zero-config local, scale to enterprise |
| ORM | SQLAlchemy 2.0 + Alembic | Async support, migrations |
| Real-time | WebSockets (native FastAPI) | True real-time, not polling |
| Frontend | React 18 + Vite + TailwindCSS | Fast dev, existing Anthropic design |
| State | Zustand | Lightweight, no boilerplate |
| CLI | Click (Python) | Integrate with existing `loki` CLI |

---

## 3. Database Schema Design

### 3.1 Core Tables

```sql
-- Projects: Cross-codebase support
CREATE TABLE projects (
    id          TEXT PRIMARY KEY,           -- UUID
    name        TEXT NOT NULL,              -- e.g., "my-saas-app"
    path        TEXT NOT NULL UNIQUE,       -- /Users/lokesh/git/my-saas-app
    git_remote  TEXT,                       -- origin URL
    git_branch  TEXT DEFAULT 'main',
    provider    TEXT DEFAULT 'claude',      -- claude, codex, gemini
    created_at  TIMESTAMP DEFAULT NOW(),
    updated_at  TIMESTAMP DEFAULT NOW(),
    config      JSON                        -- project-specific settings
);

-- Sessions: Each autonomous run
CREATE TABLE sessions (
    id          TEXT PRIMARY KEY,           -- UUID
    project_id  TEXT REFERENCES projects(id),
    prd_path    TEXT,                       -- path to PRD file
    status      TEXT NOT NULL,              -- starting, running, paused, stopped, failed, completed
    phase       TEXT,                       -- bootstrap, planning, development, testing, deployment
    provider    TEXT DEFAULT 'claude',
    pid         INTEGER,                    -- OS process ID
    started_at  TIMESTAMP DEFAULT NOW(),
    ended_at    TIMESTAMP,
    exit_code   INTEGER,
    config      JSON                        -- session-specific config
);

-- Tasks: Kanban items
CREATE TABLE tasks (
    id          TEXT PRIMARY KEY,           -- UUID or LOKI-001 format
    session_id  TEXT REFERENCES sessions(id),
    project_id  TEXT REFERENCES projects(id),
    parent_id   TEXT REFERENCES tasks(id),  -- subtasks support

    -- Core fields
    title       TEXT NOT NULL,
    description TEXT,
    status      TEXT DEFAULT 'pending',     -- pending, in_progress, review, completed, failed
    priority    TEXT DEFAULT 'medium',      -- low, medium, high, critical
    type        TEXT DEFAULT 'engineering', -- engineering, qa, ops, security, docs

    -- Kanban ordering
    column_order INTEGER DEFAULT 0,

    -- Agent assignment
    agent_type  TEXT,                       -- e.g., "backend-dev", "tester"
    agent_model TEXT,                       -- opus, sonnet, haiku

    -- Timestamps
    created_at  TIMESTAMP DEFAULT NOW(),
    started_at  TIMESTAMP,
    completed_at TIMESTAMP,

    -- Output
    output      TEXT,
    error       TEXT,

    -- Metadata
    labels      JSON DEFAULT '[]',          -- ["bug", "enhancement"]
    github_issue INTEGER,                   -- linked GitHub issue #
    metadata    JSON
);

-- Agents: Active and historical agents
CREATE TABLE agents (
    id          TEXT PRIMARY KEY,
    session_id  TEXT REFERENCES sessions(id),
    task_id     TEXT REFERENCES tasks(id),

    name        TEXT NOT NULL,              -- e.g., "agent_001"
    type        TEXT,                       -- e.g., "backend-dev"
    model       TEXT,                       -- opus, sonnet, haiku
    status      TEXT DEFAULT 'pending',     -- pending, running, completed, failed

    started_at  TIMESTAMP,
    ended_at    TIMESTAMP,

    tokens_used INTEGER DEFAULT 0,
    cost        REAL DEFAULT 0.0,

    output      TEXT
);

-- Logs: Session output
CREATE TABLE logs (
    id          SERIAL PRIMARY KEY,
    session_id  TEXT REFERENCES sessions(id),
    timestamp   TIMESTAMP DEFAULT NOW(),
    level       TEXT,                       -- debug, info, warn, error
    source      TEXT,                       -- e.g., "agent:backend", "system"
    message     TEXT NOT NULL,
    metadata    JSON
);

-- Cross-Project Learnings (existing functionality)
CREATE TABLE learnings (
    id          TEXT PRIMARY KEY,
    type        TEXT NOT NULL,              -- patterns, mistakes, successes
    project_id  TEXT REFERENCES projects(id),
    category    TEXT,
    description TEXT NOT NULL,
    context     JSON,
    created_at  TIMESTAMP DEFAULT NOW()
);

-- Indexes
CREATE INDEX idx_sessions_project ON sessions(project_id);
CREATE INDEX idx_sessions_status ON sessions(status);
CREATE INDEX idx_tasks_session ON tasks(session_id);
CREATE INDEX idx_tasks_status ON tasks(status);
CREATE INDEX idx_tasks_project ON tasks(project_id);
CREATE INDEX idx_logs_session ON logs(session_id);
CREATE INDEX idx_logs_timestamp ON logs(timestamp);
```

### 3.2 Database Location

```
~/.loki/
    dashboard.db          # SQLite database (default)
    config.yaml           # Dashboard configuration
    learnings/            # Existing global learnings (migrate to DB)
```

---

## 4. API Design

### 4.1 REST Endpoints

```yaml
# Health & Status
GET  /health                        # Health check
GET  /api/status                    # Detailed system status

# Projects (Cross-codebase)
GET  /api/projects                  # List all projects
POST /api/projects                  # Register a new project
GET  /api/projects/{id}             # Get project details
PUT  /api/projects/{id}             # Update project
DELETE /api/projects/{id}           # Remove project

# Sessions
GET  /api/sessions                  # List sessions (filterable by project)
POST /api/sessions                  # Start new session
GET  /api/sessions/{id}             # Get session details
POST /api/sessions/{id}/stop        # Stop session
POST /api/sessions/{id}/pause       # Pause session
POST /api/sessions/{id}/resume      # Resume session
POST /api/sessions/{id}/input       # Inject human input

# Tasks (Kanban)
GET  /api/tasks                     # List tasks (filterable)
POST /api/tasks                     # Create task
GET  /api/tasks/{id}                # Get task
PUT  /api/tasks/{id}                # Update task
DELETE /api/tasks/{id}              # Delete task
PUT  /api/tasks/{id}/move           # Move task (column/order)
POST /api/tasks/bulk                # Bulk operations

# Agents
GET  /api/agents                    # List agents
GET  /api/agents/active             # Currently running agents

# Logs
GET  /api/logs                      # Get logs (paginated, filterable)
GET  /api/logs/stream               # SSE log stream

# Learnings (Cross-Project)
GET  /api/learnings                 # List learnings
POST /api/learnings                 # Add learning
GET  /api/learnings/search          # Search learnings

# WebSocket (alternative to SSE)
WS  /ws                             # WebSocket connection for real-time
```

### 4.2 WebSocket Events

```typescript
// Client -> Server
interface WSClientMessage {
  type: 'subscribe' | 'unsubscribe' | 'ping';
  channels?: string[];  // e.g., ['project:abc', 'session:xyz']
}

// Server -> Client
interface WSServerMessage {
  type: EventType;
  channel: string;
  timestamp: string;
  data: any;
}

// Event Types (matching existing SSE events)
type EventType =
  | 'session:started' | 'session:paused' | 'session:stopped' | 'session:completed'
  | 'phase:started' | 'phase:completed'
  | 'task:created' | 'task:updated' | 'task:moved' | 'task:completed'
  | 'agent:spawned' | 'agent:completed'
  | 'log:entry'
  | 'heartbeat';
```

### 4.3 Authentication

```yaml
# Local access (default)
- No auth required for localhost
- Bearer token required for remote access

# Token generation
loki dashboard token generate        # Generate API token
loki dashboard token revoke          # Revoke token

# Environment variable
LOKI_DASHBOARD_TOKEN=<token>

# Request header
Authorization: Bearer <token>
```

---

## 5. Frontend Architecture

### 5.1 Component Structure

```
dashboard/
  src/
    main.tsx                    # Entry point
    App.tsx                     # Root with router

    # Feature-based organization
    features/
      projects/
        ProjectList.tsx
        ProjectCard.tsx
        ProjectSelector.tsx
      kanban/
        KanbanBoard.tsx
        KanbanColumn.tsx
        TaskCard.tsx
        TaskModal.tsx
        DragDropProvider.tsx
      agents/
        AgentGrid.tsx
        AgentCard.tsx
      terminal/
        TerminalOutput.tsx
        LogViewer.tsx
      system/
        SystemStatus.tsx
        RarvCycle.tsx
        MemoryBars.tsx
        QualityGates.tsx

    # Shared
    components/
      Layout/
        Sidebar.tsx
        Header.tsx
        MobileNav.tsx
      ui/                       # shadcn/ui components
        Button.tsx
        Card.tsx
        Dialog.tsx
        ...

    # State management
    stores/
      projectStore.ts           # Zustand store
      sessionStore.ts
      taskStore.ts
      websocketStore.ts

    # API client
    api/
      client.ts                 # Axios/fetch wrapper
      projects.ts
      sessions.ts
      tasks.ts

    # Hooks
    hooks/
      useWebSocket.ts           # WebSocket connection
      useTasks.ts               # Task CRUD with optimistic updates
      useProject.ts

    # Utilities
    lib/
      websocket.ts              # WebSocket manager
      dragDrop.ts               # @dnd-kit helpers
```

### 5.2 State Management

```typescript
// stores/taskStore.ts
import { create } from 'zustand';

interface TaskStore {
  tasks: Task[];
  columns: {
    pending: string[];
    in_progress: string[];
    review: string[];
    completed: string[];
  };

  // Actions
  fetchTasks: (projectId: string) => Promise<void>;
  moveTask: (taskId: string, toColumn: string, order: number) => Promise<void>;
  updateTask: (taskId: string, updates: Partial<Task>) => void;

  // Optimistic updates
  applyOptimisticMove: (taskId: string, toColumn: string) => void;
  revertOptimisticMove: (taskId: string) => void;
}

// WebSocket integration
const useWebSocketSync = () => {
  const { ws, lastMessage } = useWebSocket('/ws');
  const taskStore = useTaskStore();

  useEffect(() => {
    if (lastMessage?.type === 'task:updated') {
      taskStore.updateTask(lastMessage.data.id, lastMessage.data);
    }
  }, [lastMessage]);
};
```

### 5.3 Kanban Implementation

```typescript
// features/kanban/KanbanBoard.tsx
import { DndContext, closestCenter } from '@dnd-kit/core';
import { SortableContext, verticalListSortingStrategy } from '@dnd-kit/sortable';

const columns = ['pending', 'in_progress', 'review', 'completed'];

export function KanbanBoard({ projectId }: { projectId: string }) {
  const { tasks, moveTask } = useTaskStore();

  const handleDragEnd = async (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over) return;

    const taskId = active.id as string;
    const toColumn = over.data.current?.column;
    const toOrder = over.data.current?.order;

    // Optimistic update
    useTaskStore.getState().applyOptimisticMove(taskId, toColumn);

    try {
      await moveTask(taskId, toColumn, toOrder);
    } catch (error) {
      // Revert on failure
      useTaskStore.getState().revertOptimisticMove(taskId);
    }
  };

  return (
    <DndContext collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
      <div className="grid grid-cols-4 gap-4">
        {columns.map(column => (
          <KanbanColumn
            key={column}
            column={column}
            tasks={tasks.filter(t => t.status === column)}
          />
        ))}
      </div>
    </DndContext>
  );
}
```

---

## 6. CLI Integration

### 6.1 New CLI Commands

```bash
# Dashboard management
loki dashboard start              # Start dashboard server
loki dashboard stop               # Stop dashboard server
loki dashboard status             # Show dashboard status
loki dashboard open               # Open in browser

# With options
loki dashboard start --port 57374  # Custom port
loki dashboard start --host 0.0.0.0  # Allow remote access
loki dashboard start --db postgresql://...  # Use PostgreSQL

# Token management
loki dashboard token generate     # Generate API token
loki dashboard token list         # List tokens
loki dashboard token revoke <id>  # Revoke token

# Project management (cross-codebase)
loki projects list                # List all registered projects
loki projects add /path/to/repo   # Register a project
loki projects remove <id>         # Unregister project
loki projects switch <id>         # Set active project
```

### 6.2 CLI Implementation

```python
# cli/dashboard.py
import click
import subprocess
import signal
from pathlib import Path

@click.group()
def dashboard():
    """Manage the Loki Mode Dashboard."""
    pass

@dashboard.command()
@click.option('--port', default=57374, help='Port to listen on')
@click.option('--host', default='127.0.0.1', help='Host to bind to')
@click.option('--db', default=None, help='Database URL')
@click.option('--foreground', '-f', is_flag=True, help='Run in foreground')
def start(port: int, host: str, db: str, foreground: bool):
    """Start the dashboard server."""
    pid_file = Path.home() / '.loki' / 'dashboard.pid'

    if pid_file.exists():
        click.echo("Dashboard already running. Use 'loki dashboard stop' first.")
        return

    env = os.environ.copy()
    env['LOKI_DASHBOARD_PORT'] = str(port)
    env['LOKI_DASHBOARD_HOST'] = host
    if db:
        env['LOKI_DATABASE_URL'] = db

    if foreground:
        # Run in foreground
        subprocess.run(['uvicorn', 'loki_dashboard.main:app', '--host', host, '--port', str(port)], env=env)
    else:
        # Daemonize
        proc = subprocess.Popen(
            ['uvicorn', 'loki_dashboard.main:app', '--host', host, '--port', str(port)],
            env=env,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            start_new_session=True
        )
        pid_file.write_text(str(proc.pid))
        click.echo(f"Dashboard started on http://{host}:{port} (PID: {proc.pid})")

        # Open in browser
        import webbrowser
        webbrowser.open(f'http://{host}:{port}')

@dashboard.command()
def stop():
    """Stop the dashboard server."""
    pid_file = Path.home() / '.loki' / 'dashboard.pid'

    if not pid_file.exists():
        click.echo("Dashboard is not running.")
        return

    pid = int(pid_file.read_text().strip())
    try:
        os.kill(pid, signal.SIGTERM)
        pid_file.unlink()
        click.echo("Dashboard stopped.")
    except ProcessLookupError:
        pid_file.unlink()
        click.echo("Dashboard was not running (stale PID file cleaned up).")
```

---

## 7. File System Integration

### 7.1 Watcher Service

The dashboard needs to monitor `.loki/` directories across all registered projects.

```python
# services/file_watcher.py
import asyncio
from watchfiles import awatch, Change
from pathlib import Path
from typing import Dict, Set

class ProjectWatcher:
    def __init__(self, db: AsyncSession, broadcast: BroadcastManager):
        self.db = db
        self.broadcast = broadcast
        self.watchers: Dict[str, asyncio.Task] = {}

    async def watch_project(self, project_id: str, path: Path):
        """Start watching a project's .loki directory."""
        loki_dir = path / '.loki'
        if not loki_dir.exists():
            loki_dir.mkdir(parents=True, exist_ok=True)

        async for changes in awatch(loki_dir):
            for change_type, change_path in changes:
                await self.handle_change(project_id, change_type, Path(change_path))

    async def handle_change(self, project_id: str, change_type: Change, path: Path):
        """Handle a file change in a project's .loki directory."""
        relative = path.name

        if relative == 'dashboard-state.json':
            # Session state update
            state = json.loads(path.read_text())
            await self.sync_session_state(project_id, state)
            await self.broadcast.send(f'project:{project_id}', {
                'type': 'session:updated',
                'data': state
            })

        elif relative == 'pending.json' and 'queue' in str(path):
            # Task queue update
            queue = json.loads(path.read_text())
            await self.sync_tasks(project_id, queue.get('tasks', []))
            await self.broadcast.send(f'project:{project_id}', {
                'type': 'tasks:updated',
                'data': {'count': len(queue.get('tasks', []))}
            })

        elif relative == 'agents.json' and 'state' in str(path):
            # Agents update
            agents = json.loads(path.read_text())
            await self.broadcast.send(f'project:{project_id}', {
                'type': 'agents:updated',
                'data': agents
            })
```

### 7.2 Bidirectional Sync

The dashboard can both read from and write to `.loki/` directories:

```python
# services/cli_bridge.py
class CLIBridge:
    """Bridge between dashboard and CLI-controlled .loki directories."""

    async def inject_task(self, project: Project, task: Task) -> None:
        """Add a task to the project's queue file."""
        queue_file = Path(project.path) / '.loki' / 'queue' / 'pending.json'
        queue_file.parent.mkdir(parents=True, exist_ok=True)

        if queue_file.exists():
            queue = json.loads(queue_file.read_text())
        else:
            queue = {'tasks': []}

        queue['tasks'].append({
            'id': task.id,
            'title': task.title,
            'description': task.description,
            'priority': task.priority,
            'type': task.type,
            'source': 'dashboard'
        })

        queue_file.write_text(json.dumps(queue, indent=2))

    async def send_control_signal(self, project: Project, signal: str) -> None:
        """Send control signal (PAUSE, STOP, RESUME) to running session."""
        loki_dir = Path(project.path) / '.loki'

        if signal == 'PAUSE':
            (loki_dir / 'PAUSE').touch()
        elif signal == 'STOP':
            (loki_dir / 'STOP').touch()
        elif signal == 'RESUME':
            (loki_dir / 'PAUSE').unlink(missing_ok=True)
            (loki_dir / 'STOP').unlink(missing_ok=True)

    async def inject_human_input(self, project: Project, input_text: str) -> None:
        """Inject human input via HUMAN_INPUT.md."""
        input_file = Path(project.path) / '.loki' / 'HUMAN_INPUT.md'
        input_file.write_text(input_text)
```

---

## 8. Deployment Architecture

### 8.1 Local Development (Default)

```
loki dashboard start
  |
  +-- uvicorn (FastAPI) on localhost:57374
  |     |
  |     +-- SQLite: ~/.loki/dashboard.db
  |     |
  |     +-- File watchers for registered projects
  |
  +-- Opens browser to http://localhost:57374
```

### 8.2 Standalone Server Mode

```bash
# Run dashboard server for team access
loki dashboard start --host 0.0.0.0 --port 57374 --db postgresql://user:pass@host/loki

# Or via Docker
docker run -d \
  -p 57374:57374 \
  -v ~/.loki:/root/.loki \
  -e LOKI_DATABASE_URL=postgresql://... \
  asklokesh/loki-dashboard
```

### 8.3 Enterprise Deployment

```yaml
# docker-compose.yml
version: '3.8'
services:
  dashboard:
    image: asklokesh/loki-dashboard:latest
    ports:
      - "57374:57374"
    environment:
      - LOKI_DATABASE_URL=postgresql://postgres:postgres@db/loki
      - LOKI_DASHBOARD_HOST=0.0.0.0
    volumes:
      - loki-data:/root/.loki
    depends_on:
      - db

  db:
    image: postgres:15-alpine
    environment:
      - POSTGRES_DB=loki
      - POSTGRES_USER=postgres
      - POSTGRES_PASSWORD=postgres
    volumes:
      - postgres-data:/var/lib/postgresql/data

volumes:
  loki-data:
  postgres-data:
```

---

## 9. Migration Path

### 9.1 Phase 1: Backend Foundation (Week 1-2)

1. Create `dashboard/` directory with FastAPI structure
2. Implement SQLite database with SQLAlchemy
3. Create basic REST endpoints (projects, sessions, tasks)
4. Implement WebSocket broadcast
5. Add file watcher service

### 9.2 Phase 2: Frontend (Week 3-4)

1. Scaffold React app with Vite
2. Port existing CSS (Anthropic design language)
3. Implement Kanban board with @dnd-kit
4. Connect WebSocket for real-time updates
5. Build project switcher

### 9.3 Phase 3: Integration (Week 5)

1. Add CLI commands (loki dashboard start/stop)
2. Implement bidirectional file sync
3. Migrate existing learnings to database
4. Add authentication for remote access

### 9.4 Phase 4: Polish (Week 6)

1. Performance optimization
2. Error handling and recovery
3. Documentation
4. Testing
5. Release

---

## 10. Open Questions

1. **PostgreSQL Support**: Should we include PostgreSQL from the start or add later?
   - Recommendation: SQLite default, PostgreSQL optional via env var

2. **Authentication**: OAuth/SSO or token-only?
   - Recommendation: Token-only initially, OAuth as future enhancement

3. **Multi-tenancy**: Support multiple users?
   - Recommendation: Single-user initially, multi-user as enterprise feature

4. **Mobile Support**: Native mobile app or responsive web only?
   - Recommendation: Responsive web only (existing design already supports)

5. **Offline Mode**: Support offline task management?
   - Recommendation: Not for V1, consider for V2

---

## 11. Success Metrics

| Metric | Current | Target |
|--------|---------|--------|
| Update latency | 2000ms (polling) | <100ms (WebSocket) |
| Projects supported | 1 | Unlimited |
| Task persistence | Session only | Permanent |
| Cross-codebase | No | Yes |
| Remote access | Limited | Full API |

---

## 12. Appendix

### A. Directory Structure

```
dashboard/
  backend/
    loki_dashboard/
      __init__.py
      main.py                 # FastAPI app
      config.py               # Settings
      database.py             # SQLAlchemy setup
      models/
        __init__.py
        project.py
        session.py
        task.py
        agent.py
        log.py
      routes/
        __init__.py
        projects.py
        sessions.py
        tasks.py
        agents.py
        logs.py
        websocket.py
      services/
        __init__.py
        file_watcher.py
        cli_bridge.py
        broadcast.py
      migrations/
        versions/
          001_initial.py
    pyproject.toml
    requirements.txt

  frontend/
    src/
      ...                     # See Section 5.1
    package.json
    vite.config.ts
    tailwind.config.js

  Dockerfile
  docker-compose.yml
```

### B. Related Files

- Current static dashboard: `/Users/lokesh/git/claudeskill-loki-mode/autonomy/.loki/dashboard/index.html`
- Production API: `/Users/lokesh/git/claudeskill-loki-mode/dashboard/server.py` (unified FastAPI, port 57374)
- Legacy Node.js API: `/Users/lokesh/git/claudeskill-loki-mode/autonomy/api-server.js`
- Legacy Deno API: `/Users/lokesh/git/claudeskill-loki-mode/api/server.ts`
- OpenAPI spec: `/Users/lokesh/git/claudeskill-loki-mode/api/openapi.yaml`
- Run script: `/Users/lokesh/git/claudeskill-loki-mode/autonomy/run.sh`

### C. References

- FastAPI: https://fastapi.tiangolo.com/
- SQLAlchemy 2.0: https://docs.sqlalchemy.org/
- watchfiles: https://watchfiles.helpmanual.io/
- @dnd-kit: https://dndkit.com/
- Zustand: https://zustand-demo.pmnd.rs/

---

*End of Architecture Document*
