# Loki Mode Dashboard v5.40.0

A production-ready realtime dashboard for monitoring and managing Loki Mode autonomous operations. Features a dark Vercel/Linear-inspired theme with purple accents, sidebar navigation, and overview cards.

## Overview

The Loki Mode Dashboard provides a visual interface to:
- Monitor task progress across Kanban columns
- Track active agents and their status
- View system health (RARV cycle, memory, quality gates)
- View Completion Council verdicts and convergence status
- Manage human intervention (pause/stop)
- Add and organize local tasks

## Quick Start

```bash
# Start the dashboard (default port: 57374)
loki dashboard start

# Open in browser
open http://localhost:57374
```

The dashboard automatically syncs with Loki Mode when it's running, polling `dashboard-state.json` every 2 seconds.

**Ports:** The dashboard and API run on unified port **57374** (FastAPI serves both). See [INSTALLATION.md](INSTALLATION.md#ports) for details.

---

## UI Components

### 1. Sidebar (Left Panel)

The sidebar provides navigation and system status at a glance.

#### Logo & Version
- Loki Mode branding with current version (v5.40.0)
- Version updates automatically from server state

#### Theme Toggle
- Dark Vercel/Linear theme with purple accents (default)
- Switch between dark mode and light mode
- Preference saved to localStorage
- Respects system preference on first visit

#### Connection Status
- **Green pulsing dot**: Live connection, syncing every 2 seconds
- **Red dot**: Offline, showing local tasks only
- Shows last sync timestamp

#### Navigation
- **Kanban Board**: Task queue visualization
- **Active Agents**: Agent cards with status
- **System Status**: RARV, Memory, Quality Gates
- Click to smooth-scroll to section
- Active section highlighted based on scroll position

#### Status Panel
- **Mode**: AUTONOMOUS / PAUSED / STOPPED
- **Phase**: Current SDLC phase (BOOTSTRAP, DEVELOPMENT, etc.)
- **Complexity**: Auto-detected tier (simple/standard/complex)
- **Iteration**: Current RARV iteration count

#### Intervention Controls
- **PAUSE**: Instructions to create `.loki/PAUSE` file
- **STOP**: Instructions to create `.loki/STOP` file

#### Resources
- CPU usage percentage
- Memory usage percentage

---

### 2. Stats Row

Five stat cards showing:
- **Total Tasks**: Combined server + local tasks
- **In Progress**: Currently active tasks
- **Completed**: Successfully finished tasks
- **Active Agents**: Number of agents running
- **Failed**: Tasks that encountered errors

---

### 3. Kanban Board

Four-column task queue visualization:

#### Columns
| Column | Description | Header Color |
|--------|-------------|--------------|
| Pending | Tasks waiting to start | Gray |
| In Progress | Currently executing | Blue |
| In Review | Being reviewed by quality agents | Purple |
| Completed | Successfully finished | Green |

#### Task Cards

**Server Tasks** (from Loki Mode):
- Orange left border
- Non-draggable (controlled by system)
- Shows task ID, title, priority, type, agent

**Local Tasks** (user-created):
- No colored border
- Draggable between columns
- Stored in localStorage

**Priority Badges**:
- **High**: Red badge
- **Medium**: Yellow badge
- **Low**: Green badge

#### Adding Tasks
- Click "+ Add Task" at bottom of Pending column
- Or use keyboard shortcut: Cmd/Ctrl + N
- Fill in: Title, Description, Type, Priority

---

### 4. Active Agents

Grid of agent cards showing:

- **Agent ID**: e.g., orchestrator, backend-agent
- **Agent Type**: e.g., Orchestrator, Backend, Frontend
- **Model Badge**: Colored badge (Opus=amber, Sonnet=indigo, Haiku=emerald)
- **Current Task**: What the agent is working on
- **Stats**: Runtime and tasks completed
- **Status**: Active (green), Idle (gray), Error (red)

---

### 5. System Grid

Three system cards:

#### RARV Cycle
Visual representation of the Reason-Act-Reflect-Verify cycle:
- Active step highlighted with accent color
- Arrow indicators between steps
- Updates in realtime as Loki Mode progresses

#### Memory System
Progress bars for three memory types:
- **Episodic**: Specific interaction traces (blue)
- **Semantic**: Generalized patterns (purple)
- **Procedural**: Learned skills (green)

Shows count and visual progress bar for each.

#### Quality Gates
6 quality gates with status icons:
- **Static Analysis**: CodeQL/ESLint checks
- **3-Reviewer**: Parallel blind review system
- **Anti-Sycophancy**: Devil's advocate validation
- **Test Coverage**: Unit test requirements
- **Security Scan**: OWASP vulnerability check
- **Performance**: Performance regression tests

Status icons:
- Checkmark (green): Passed
- Circle (yellow): Pending
- X (red): Failed

---

## Design System

### Dark Vercel/Linear Design Language

The dashboard follows a dark Vercel/Linear-inspired design with purple accents:

**Dark Mode (Default)**:
```css
--bg-primary: #0a0a0b;    /* Deep dark background */
--bg-secondary: #141416;  /* Card surfaces */
--bg-card: #1a1a1d;       /* Elevated surfaces */
--accent: #8b5cf6;        /* Purple accent */
--text-primary: #f5f5f5;  /* Near white text */
```

**Light Mode**:
```css
--bg-primary: #faf9f0;    /* Cream background */
--bg-secondary: #f5f4eb;  /* Sidebar/cards */
--bg-card: #ffffff;       /* Card background */
--accent: #7c3aed;        /* Purple accent */
--text-primary: #1a1a1a;  /* Near black text */
```

### Typography
- **Primary font**: Inter (system font fallback)
- **Monospace**: JetBrains Mono (for IDs, code, numbers)

### Status Colors
| Status | Light Mode | Dark Mode |
|--------|-----------|-----------|
| Success | #16a34a | #22c55e |
| Warning | #ca8a04 | #eab308 |
| Error | #dc2626 | #ef4444 |
| Info | #2563eb | #3b82f6 |

---

### 6. Completion Council (v5.25.0)

The Completion Council panel provides visibility into the multi-agent definition-of-done system:

#### Overview Tab
- Current council state (active, idle, reviewing)
- Latest verdict (CONTINUE, COMPLETE, FORCE_STOP)
- Vote tally from 3 council members (2/3 majority required)

#### Decision Log Tab
- Chronological history of all council verdicts
- Per-member vote breakdown
- Anti-sycophancy devil's advocate triggers (shown when unanimous approval occurs)

#### Convergence Tab
- Git diff hash tracking between iterations
- Convergence detection (repeated identical diffs = no progress)
- Circuit breaker status (triggers after 5 consecutive no-progress iterations)

#### Agents Tab
- Council member status and assignment
- Current review focus areas

**API Endpoints:**
- `GET /api/council/state` - Current council state
- `GET /api/council/verdicts` - Decision history
- `GET /api/council/convergence` - Convergence metrics
- `POST /api/council/force-review` - Trigger manual review

**CLI Commands:**
```bash
loki council status         # Current state
loki council verdicts       # Decision history
loki council convergence    # Convergence data
loki council force-review   # Trigger review
loki council report         # Generate report
```

---

### 7. Context Window (v5.40.0)

The Context Window panel provides real-time visibility into context window utilization across agents:

#### Gauge View
- Circular gauge showing current context usage as a percentage
- Color-coded thresholds: green (<60%), yellow (60-80%), red (>80%)
- Displays tokens used vs. total capacity

#### Timeline View
- Historical context usage over time
- Per-iteration token consumption trend
- Helps identify context-heavy phases or runaway agents

#### Breakdown View
- Per-agent context allocation and usage
- Categorized by content type (code, prompts, memory, tool output)
- Highlights largest context consumers

**API Endpoints:**
- `GET /api/context` - Current context window state (per-agent usage, totals, breakdown)

---

### 8. Notifications (v5.40.0)

The Notifications panel provides a feed of system events and configurable trigger management:

#### Feed View
- Chronological list of notification events
- Severity levels: info, warning, critical
- Click to acknowledge and dismiss
- Auto-generated from context thresholds, task failures, council verdicts, and budget alerts

#### Trigger Management View
- Configure notification triggers (context threshold, task failure count, budget limit, etc.)
- Enable/disable individual triggers
- Set custom thresholds per trigger type

**API Endpoints:**
- `GET /api/notifications` - List all notifications (supports query filters)
- `GET /api/notifications/triggers` - Get configured notification triggers
- `PUT /api/notifications/triggers` - Update notification trigger configuration
- `POST /api/notifications/{id}/acknowledge` - Acknowledge a specific notification

---

## Security Hardening (v5.25.0)

The dashboard includes several security measures:

| Fix | Description |
|-----|-------------|
| **Path traversal prevention** | `storage.py` validates all file paths to prevent directory traversal attacks |
| **XSS protection** | Log stream output is sanitized to prevent cross-site scripting |
| **Memory leak fix** | Session control properly cleans up resources on disconnect |
| **Python injection fix** | `completion-council.sh` sanitizes inputs to prevent code injection |
| **CORS configuration** | Configurable via `LOKI_DASHBOARD_CORS` environment variable (default: localhost only) |

---

## Technical Architecture

### File-Based Sync

The dashboard uses a polling-based sync mechanism:

```
run.sh                     Dashboard
   |                           |
   |-- writes every 2s -->     |
   |                           |
   v                           v
dashboard-state.json       fetch() + render
```

**State File Structure** (`dashboard-state.json`):
```json
{
  "timestamp": "2026-01-21T10:30:00Z",
  "version": "5.25.0",
  "mode": "autonomous",
  "phase": "DEVELOPMENT",
  "complexity": "standard",
  "iteration": 5,
  "tasks": {
    "pending": [...],
    "inProgress": [...],
    "review": [...],
    "completed": [...],
    "failed": [...]
  },
  "agents": [...],
  "metrics": {
    "tasksCompleted": 12,
    "tasksFailed": 0,
    "cpuUsage": 45,
    "memoryUsage": 62
  },
  "rarv": {
    "currentStep": 1,
    "stages": ["reason", "act", "reflect", "verify"]
  },
  "memory": {
    "episodic": 12,
    "semantic": 8,
    "procedural": 5
  },
  "qualityGates": {
    "staticAnalysis": "passed",
    "codeReview": "in_progress",
    "antiSycophancy": "pending",
    "testCoverage": "passed",
    "securityScan": "passed",
    "performance": "pending"
  }
}
```

### Local Storage

Local tasks persist in browser localStorage:
- Key: `loki-dashboard-local`
- Survives browser refresh
- Independent of server state

Theme preference:
- Key: `loki-theme`
- Values: `light` or `dark`

---

## Responsive Design

The dashboard adapts to different screen sizes:

| Breakpoint | Behavior |
|------------|----------|
| > 1400px | Full layout, 5 stat cards |
| 1200-1400px | 3 stat cards, 2 system cards |
| 1024-1200px | Sidebar hidden, mobile header visible |
| < 768px | Single column layout |

### Mobile Header
On small screens, a mobile header appears with:
- Loki Mode logo
- Connection status
- Theme toggle

---

## Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| Cmd/Ctrl + N | Open Add Task modal |
| Escape | Close modal |

---

## Export

Click "Export" button to download JSON containing:
- Current server state snapshot
- All local tasks
- Export timestamp

Useful for:
- Debugging
- Sharing session state
- Backup before making changes

---

## Troubleshooting

### Dashboard Shows "Offline"
1. Ensure Loki Mode is running: `./autonomy/run.sh`
2. Check that `dashboard-state.json` exists in `.loki/`
3. Verify HTTP server is running on correct port

### Tasks Not Updating
1. Check polling interval (default: 2 seconds)
2. Clear browser cache
3. Check browser console for fetch errors

### Theme Not Saving
1. Check localStorage is enabled
2. Clear `loki-theme` key and refresh

### Local Tasks Disappeared
1. Check localStorage is enabled
2. Different browser/profile will have separate local storage
3. Export tasks before clearing browser data

---

## Version History

| Version | Changes |
|---------|---------|
| v5.40.0 | Context Window tracking panel (gauge, timeline, breakdown), Notification Triggers panel (feed, trigger management) |
| v5.39.0 | Prometheus /metrics endpoint, branch protection, agent audit trail, log integrity, OpenClaw bridge |
| v5.37.0 | TLS/HTTPS, OIDC/SSO, RBAC roles, WebSocket auth, syslog forwarding, budget controls |
| v5.36.0 | Auth wiring on destructive endpoints, rate limiting, salted hashing, non-root Docker |
| v5.35.0 | CONTINUITY.md, 5-specialist code review, checkpoint VSCode UI |
| v5.34.0 | Checkpoint system with git SHA tracking |
| v5.30.0 | Knowledge compounding, deepen-plan phase, specialist reviewers |
| v5.25.0 | Completion Council panel, dark Vercel/Linear theme with purple accents, enterprise security hardening |
| v5.23.0 | Dashboard reads from .loki/ flat files, all web components functional |
| v4.1.0 | Terminal output, quick actions, GitHub import modal, config file support |
| v4.0.0 | Complete rewrite with Anthropic design, realtime sync, mobile support |
| v3.x | Basic status display (no interactivity) |

---

## Related Documentation

- [Core Workflow](../references/core-workflow.md) - RARV cycle details
- [Agent Types](../references/agent-types.md) - 41 agent definitions
- [Quality Control](../references/quality-control.md) - Quality gates system
- [Memory System](../references/memory-system.md) - Memory architecture
