# Dashboard

Web-based dashboard for monitoring and managing Loki Mode sessions.

---

## Overview

The Loki Mode dashboard features a dark Vercel/Linear-inspired design with purple accents and provides:

- Real-time session monitoring with overview cards
- Sidebar navigation for all views
- Kanban-style task management
- Completion Council monitoring (votes, convergence, decision log)
- Cross-project learnings view
- Log streaming with filtering
- Agent management (pause, resume, kill)
- Prometheus/OpenMetrics endpoint for monitoring systems
- TLS/HTTPS encrypted connections

---

## Starting the Dashboard

```bash
# Start dashboard server
loki dashboard start

# With custom port
loki dashboard start --port 8080

# Open in browser
loki dashboard open
```

Default URL: `http://localhost:57374`

---

## Design

The dashboard uses a dark theme inspired by Vercel and Linear:

- Dark background (`#0a0a0b`) with subtle borders (`#1a1a2e`)
- Purple accent color (`#7c3aed`) for active states and highlights
- Sidebar navigation on the left for all views
- Overview cards at the top showing session state, phase, iteration count, and agent status
- Responsive layout that works on desktop and tablet screens

---

## Dashboard Views

### Overview

Top-level overview with status cards:

| Card | Description |
|------|-------------|
| Session Status | Running, paused, stopped with color indicator |
| Current Phase | Active SDLC phase |
| Iteration | Current iteration number |
| Agents | Active agent count |

### Task Queue

Visual task management:

| Column | Description |
|--------|-------------|
| Pending | Tasks waiting to execute |
| In Progress | Active tasks |
| Done | Completed tasks |

### Logs

Real-time log streaming with filtering options.

### Memory / Learnings

Browse cross-project learnings:

- Filter by type (patterns, mistakes, successes)
- Search learnings
- View statistics

### Completion Council

Council monitoring with four tabs:

| Tab | Description |
|-----|-------------|
| **Overview** | Current council state, enabled status, vote counts |
| **Decision Log** | History of council verdicts (continue vs. complete) |
| **Convergence** | Git diff hash tracking chart showing progress stagnation |
| **Agents** | Active agent list with pause/resume/kill controls |

The council uses a 3-member voting system with 2/3 majority required for completion decisions. When all members vote unanimously, an anti-sycophancy devil's advocate review is triggered to confirm the decision.

### Context Window (v5.40.0)

Real-time context window monitoring with three tabs:

| Tab | Description |
|-----|-------------|
| **Gauge** | SVG circular progress showing context usage percentage. Green (<60%), yellow (60-80%), red (>80%). Stats: total tokens, cost, compaction count. |
| **Timeline** | Per-iteration bar chart of token usage. Compaction events shown as dashed separators. |
| **Breakdown** | Per-iteration input/output/cache stacked bars with cost breakdown. |

Provider-agnostic: works with Claude (session JSONL parsing), Codex, and Gemini (direct token reporting).

Keyboard shortcut: `Cmd+9`

### Notification Center (v5.40.0)

Dashboard-integrated notification system with two tabs:

| Tab | Description |
|-----|-------------|
| **Feed** | Chronological notification list with severity dots (red/yellow/blue), timestamps, messages, and acknowledge buttons. |
| **Triggers** | 6 configurable triggers with enable/disable toggles: budget threshold, context limits, sensitive file access, quality gate failures, stagnation detection, compaction frequency. |

Keyboard shortcut: `Cmd+0`

### Prometheus Metrics

The dashboard exposes a `/metrics` endpoint compatible with Prometheus, Grafana, and other monitoring systems. 9 metrics are available covering session status, iterations, tasks, agents, cost, events, and uptime.

```bash
# Fetch metrics
curl http://localhost:57374/metrics

# Or via CLI
loki metrics
```

See [[API Reference]] for the full metrics schema.

---

## Dashboard CLI Commands

### `loki dashboard start`

Start the dashboard server.

```bash
loki dashboard start [OPTIONS]
```

**Options:**
| Option | Default | Description |
|--------|---------|-------------|
| `--port` | 57374 | Server port |
| `--host` | 127.0.0.1 | Server host |

### `loki dashboard stop`

Stop the dashboard server.

```bash
loki dashboard stop
```

### `loki dashboard status`

Check if dashboard is running.

```bash
loki dashboard status
```

### `loki dashboard url`

Get the dashboard URL.

```bash
loki dashboard url
loki dashboard url --format json
```

### `loki dashboard open`

Open dashboard in default browser.

```bash
loki dashboard open
```

---

## Configuration

### Dashboard Settings

```yaml
# .loki/config.yaml
dashboard:
  port: 57374
  host: localhost
  auto_open: false
```

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `LOKI_DASHBOARD_PORT` | 57374 | Dashboard port |
| `LOKI_DASHBOARD_HOST` | 127.0.0.1 | Dashboard host |
| `LOKI_TLS_CERT` | - | PEM certificate path (enables HTTPS) |
| `LOKI_TLS_KEY` | - | PEM private key path (enables HTTPS) |
| `LOKI_DASHBOARD_CORS` | localhost | Comma-separated allowed CORS origins |

---

## API Integration

The dashboard uses the unified HTTP API at port 57374 for data:

```javascript
// Dashboard fetches from API
const status = await fetch('http://localhost:57374/api/status').then(r => r.json());
const logs = await fetch('http://localhost:57374/api/logs?lines=100').then(r => r.json());
```

WebSocket for real-time updates:
```javascript
const ws = new WebSocket('ws://localhost:57374/ws');
ws.onmessage = (e) => {
  const msg = JSON.parse(e.data);
  updateUI(msg);
};
```

---

## Troubleshooting

### Dashboard Won't Start

```bash
# Check if port is in use
lsof -i :57374

# Kill existing process
lsof -i :57374 | awk 'NR>1 {print $2}' | xargs kill

# Use different port
loki dashboard start --port 8080
```

### Dashboard Shows No Data

```bash
# Verify dashboard server is running
loki dashboard status

# Start dashboard server
loki dashboard start

# Check status endpoint
curl http://localhost:57374/api/status
```

### Connection Refused

```bash
# Check dashboard status
loki dashboard status

# Restart dashboard
loki dashboard stop
loki dashboard start
```

---

## See Also

- [[API Reference]] - HTTP API documentation
- [[CLI Reference]] - Dashboard CLI commands
- [[Cross-Project Learning]] - Learnings system
- [[Enterprise Features]] - TLS, OIDC, RBAC, monitoring
