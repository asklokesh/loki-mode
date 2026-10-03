# Loki Mode Dashboard V2 - Implementation Checklist

> **Historical:** this describes the classic dashboard, removed in Loki Mode 10.8. The Control Plane is the only UI; see [control-plane-migration.md](control-plane-migration.md).

## Overview
Enterprise-grade Kanban dashboard with FastAPI backend, cross-project support, and CLI integration.

**Target Version:** v6.0.0
**Status:** Planning Complete

---

## Phase 1: Backend Foundation

### 1.1 FastAPI Server Setup
- [ ] Create `dashboard/server.py` with FastAPI app
- [ ] Add SQLite database with SQLAlchemy models
- [ ] Implement health check endpoint `/health`
- [ ] Add CORS middleware for frontend
- [ ] Create Dockerfile for dashboard

### 1.2 Database Models
- [ ] Project model (id, name, path, alias, status)
- [ ] Session model (id, project_id, status, started_at)
- [ ] Task model (id, title, status, priority, type, project_id)
- [ ] Agent model (id, session_id, type, model, status)
- [ ] Log model (id, session_id, level, message, timestamp)

### 1.3 Core API Endpoints
- [ ] GET/POST `/api/projects` - Project management
- [ ] GET/POST/PUT/DELETE `/api/tasks` - Task CRUD
- [ ] POST `/api/tasks/{id}/move` - Move task between columns
- [ ] GET `/api/status` - System status
- [ ] GET `/api/agents` - Active agents

### 1.4 WebSocket/SSE
- [ ] WebSocket endpoint `/ws` for real-time updates
- [ ] Event types: task:*, session:*, agent:*, log:*
- [ ] Heartbeat mechanism
- [ ] Reconnection handling

---

## Phase 2: CLI Integration

### 2.1 Dashboard Commands
- [ ] `loki dashboard start [--port] [--host]`
- [ ] `loki dashboard stop`
- [ ] `loki dashboard status`
- [ ] `loki dashboard url [--format json|text]`
- [ ] `loki dashboard open`

### 2.2 Project Commands
- [ ] `loki projects list`
- [ ] `loki projects add [path] [--alias]`
- [ ] `loki projects remove [alias|path]`
- [ ] `loki projects select`

### 2.3 State Synchronization
- [ ] Update run.sh to notify dashboard on events
- [ ] Implement dashboard-state.json writer
- [ ] Add file watcher for .loki/ changes
- [ ] Bidirectional task sync

---

## Phase 3: Frontend (React + Vite)

### 3.1 Project Setup
- [ ] Initialize Vite + React + TypeScript
- [ ] Add TailwindCSS with Anthropic design tokens
- [ ] Configure build for embedding in Python package
- [ ] Add Zustand for state management

### 3.2 Layout Components
- [ ] Sidebar navigation (260px desktop, off-canvas mobile)
- [ ] Top header with status bar
- [ ] Project selector dropdown
- [ ] Theme toggle (light/dark)

### 3.3 Kanban Board
- [ ] 5 columns: Backlog, Pending, In Progress, Review, Done
- [ ] Drag-and-drop with @dnd-kit
- [ ] Task cards with priority badges
- [ ] Column WIP limits
- [ ] Filter and sort controls

### 3.4 Task Management
- [ ] Task detail modal
- [ ] New task form
- [ ] Edit task inline
- [ ] Delete with confirmation
- [ ] GitHub issue import

### 3.5 Control Panel
- [ ] Start/Stop/Pause/Resume buttons
- [ ] Status indicators (mode, phase, RARV step)
- [ ] Quality gates display
- [ ] Memory system bars

### 3.6 Additional Views
- [ ] Agents monitor grid
- [ ] Log viewer (terminal style)
- [ ] Memory/Learnings browser
- [ ] Settings page

---

## Phase 4: Session Control

### 4.1 Control Endpoints
- [ ] POST `/api/control/start` - Start Loki Mode
- [ ] POST `/api/control/stop` - Stop execution
- [ ] POST `/api/control/pause` - Pause execution
- [ ] POST `/api/control/resume` - Resume execution
- [ ] POST `/api/control/input` - Inject human input

### 4.2 Process Management
- [ ] Spawn run.sh from dashboard
- [ ] Track PID and monitor process
- [ ] Handle graceful shutdown
- [ ] Support background mode

---

## Phase 5: Cross-Project Features

### 5.1 Project Registry
- [ ] Store projects in ~/.loki/dashboard/projects.json
- [ ] Auto-discover .loki directories
- [ ] Project health monitoring
- [ ] Last accessed tracking

### 5.2 Unified Views
- [ ] Cross-project task list
- [ ] Combined activity feed
- [ ] Aggregated metrics
- [ ] Global search

### 5.3 Memory Integration
- [ ] Display cross-project learnings
- [ ] Search patterns/mistakes/successes
- [ ] Export learnings
- [ ] Learning statistics by project

---

## Phase 6: Enterprise Features

### 6.1 Authentication
- [ ] Token-based auth for remote access
- [ ] `loki dashboard token generate/revoke/list`
- [ ] Bearer token validation middleware
- [ ] Optional OIDC/SAML support

### 6.2 Audit & Logging
- [ ] Audit trail in audit.jsonl
- [ ] Action logging (start, stop, task changes)
- [ ] User attribution
- [ ] Log retention policy

### 6.3 Deployment
- [ ] Docker Compose with PostgreSQL
- [ ] Environment variable configuration
- [ ] TLS/HTTPS support
- [ ] Reverse proxy compatibility

---

## Phase 7: Testing & Documentation

### 7.1 Backend Tests
- [ ] Unit tests for API endpoints
- [ ] Integration tests for WebSocket
- [ ] Database migration tests
- [ ] Authentication tests

### 7.2 Frontend Tests
- [ ] Component tests with Vitest
- [ ] E2E tests with Playwright
- [ ] Accessibility tests
- [ ] Mobile responsive tests

### 7.3 CLI Tests
- [ ] Command parsing tests
- [ ] Integration with dashboard server
- [ ] Error handling tests

### 7.4 Documentation
- [ ] API documentation (OpenAPI/Swagger)
- [ ] CLI command reference
- [ ] Deployment guide
- [ ] User guide with screenshots

---

## Dependencies

### Backend
- Python 3.11+
- FastAPI
- SQLAlchemy 2.0
- Uvicorn
- Pydantic

### Frontend
- React 18
- Vite
- TailwindCSS
- @dnd-kit (drag-and-drop)
- Zustand (state)
- Lucide React (icons)

### Build
- Docker
- Node.js 18+ (for frontend build)

---

## Success Metrics

- [ ] Dashboard loads in < 2 seconds
- [ ] WebSocket updates in < 100ms
- [ ] Support 10+ concurrent projects
- [ ] Mobile-friendly (responsive)
- [ ] WCAG AA accessibility
- [ ] Zero npm dependencies in backend

---

## Timeline

| Phase | Duration | Status |
|-------|----------|--------|
| Phase 1: Backend | 1 week | Not Started |
| Phase 2: CLI | 3 days | Not Started |
| Phase 3: Frontend | 2 weeks | Not Started |
| Phase 4: Session Control | 3 days | Not Started |
| Phase 5: Cross-Project | 1 week | Not Started |
| Phase 6: Enterprise | 1 week | Not Started |
| Phase 7: Testing | 1 week | Not Started |

**Total: ~6 weeks**
