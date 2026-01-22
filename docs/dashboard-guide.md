# Loki Mode Dashboard v4.1.0

A production-ready realtime dashboard for monitoring and managing Loki Mode autonomous operations.

## Overview

The Loki Mode Dashboard provides a visual interface to:
- Monitor task progress across Kanban columns
- Track active agents and their status
- View system health (RARV cycle, memory, quality gates)
- Manage human intervention (pause/stop)
- Add and organize local tasks

## Quick Start

```bash
# Start local dashboard server
cd autonomy/.loki
python3 -m http.server 8080

# Open in browser
open http://localhost:8080/dashboard/index.html
```

The dashboard automatically syncs with Loki Mode when it's running, polling `dashboard-state.json` every 2 seconds.

---

## UI Components

### 1. Sidebar (Left Panel)

The sidebar provides navigation and system status at a glance.

#### Logo & Version
- Loki Mode branding with current version (v4.1.0)
- Version updates automatically from server state

#### Theme Toggle
- Switch between light mode (Anthropic cream: #faf9f0) and dark mode (#131314)
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

### Anthropic Design Language

The dashboard follows Anthropic's design language:

**Light Mode (Default)**:
```css
--bg-primary: #faf9f0;    /* Cream background */
--bg-secondary: #f5f4eb;  /* Sidebar/cards */
--bg-card: #ffffff;       /* Card background */
--accent: #d97757;        /* Terracotta accent */
--text-primary: #1a1a1a;  /* Near black text */
```

**Dark Mode**:
```css
--bg-primary: #131314;    /* Deep dark */
--bg-secondary: #1a1a1b;  /* Card surfaces */
--bg-card: #1e1e20;       /* Elevated surfaces */
--accent: #d97757;        /* Same terracotta */
--text-primary: #f5f5f5;  /* Near white text */
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
  "version": "4.1.0",
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
| v4.1.0 | Terminal output, quick actions, GitHub import modal, config file support |
| v4.0.0 | Complete rewrite with Anthropic design, realtime sync, mobile support |
| v3.x | Basic status display (no interactivity) |

---

## Related Documentation

- [Core Workflow](../references/core-workflow.md) - RARV cycle details
- [Agent Types](../references/agent-types.md) - 37 agent definitions
- [Quality Control](../references/quality-control.md) - Quality gates system
- [Memory System](../references/memory-system.md) - Memory architecture
