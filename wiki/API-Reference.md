# API Reference

Complete REST API documentation for Loki Mode.

---

## Overview

Loki Mode provides a unified HTTP API + Dashboard server for session management, task tracking, memory, and real-time events.

| Server | Default Port | Technology | Purpose |
|--------|--------------|------------|---------|
| **Dashboard + API** | 57374 | Python/FastAPI | Session management, dashboard UI, memory, WebSocket |

---

## HTTP API Server

Start the server:
```bash
loki dashboard start
# or directly:
LOKI_DIR=.loki PYTHONPATH=/path/to/loki-mode python3 -m uvicorn dashboard.server:app --host 127.0.0.1 --port 57374
```

The server is started automatically when you run `loki start` or `./autonomy/run.sh`.

### Configuration

| Environment Variable | Default | Description |
|---------------------|---------|-------------|
| `LOKI_DASHBOARD_PORT` | `57374` | Server port |
| `LOKI_DASHBOARD_HOST` | `127.0.0.1` | Bind address (localhost-only by default) |
| `LOKI_DIR` | `.loki` | State directory |
| `LOKI_DASHBOARD_CORS` | `http://localhost:57374,http://127.0.0.1:57374` | Comma-separated allowed CORS origins |
| `LOKI_TLS_CERT` | - | PEM certificate file path (enables HTTPS) |
| `LOKI_TLS_KEY` | - | PEM private key file path (enables HTTPS) |

---

## Endpoints

### Health Check

#### `GET /health`
Basic health check.

**Response:**
```json
{
  "status": "healthy",
  "service": "loki-dashboard"
}
```

---

### Session Status

#### `GET /api/status`
Get detailed session status. Reads from `.loki/` flat files (dashboard-state.json, session.json, loki.pid).

**Response:**
```json
{
  "status": "running",
  "version": "5.38.0",
  "uptime_seconds": 1234.5,
  "active_sessions": 1,
  "running_agents": 3,
  "pending_tasks": 5,
  "database_connected": true,
  "phase": "development",
  "iteration": 12,
  "complexity": "standard",
  "mode": "autonomous",
  "provider": "claude",
  "current_task": "implement-auth"
}
```

**Status Values:**
| Status | Description |
|--------|-------------|
| `stopped` | No session running (PID not alive, session.json not running) |
| `running` | Session actively executing |
| `paused` | Session paused (PAUSE file exists) |
| `autonomous` | Running in autonomous mode |

---

### Session Control

#### `POST /api/control/pause`
Pause the current session by creating a PAUSE file.

**Response:**
```json
{
  "success": true,
  "message": "Session paused"
}
```

#### `POST /api/control/resume`
Resume a paused session by removing PAUSE/STOP files.

**Response:**
```json
{
  "success": true,
  "message": "Session resumed"
}
```

#### `POST /api/control/stop`
Stop the session by creating a STOP file and sending SIGTERM to the Loki process.

**Response:**
```json
{
  "success": true,
  "message": "Stop signal sent"
}
```

**Note:** There is no `POST /start` endpoint. Sessions are started via the CLI (`loki start`).

---

### Logs

#### `GET /api/logs`
Get recent log entries from session log files.

**Query Parameters:**
| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `lines` | number | 100 | Number of lines to return |

**Response:**
```json
[
  {
    "message": "Session started",
    "level": "info",
    "timestamp": "2026-02-02T12:00:00"
  },
  {
    "message": "Phase: requirements",
    "level": "info",
    "timestamp": "2026-02-02T12:00:01"
  }
]
```

---

### WebSocket

#### `WS /ws`
WebSocket endpoint for real-time updates. Supports ping/pong keepalive and channel subscriptions.

**Example:**
```javascript
const ws = new WebSocket('ws://localhost:57374/ws');
ws.onmessage = (e) => {
  const msg = JSON.parse(e.data);
  if (msg.type === 'connected') {
    console.log('Connected to dashboard');
  }
};
// Keepalive
setInterval(() => ws.send(JSON.stringify({type: 'ping'})), 25000);
```

**Message Types:**
| Type | Direction | Description |
|------|-----------|-------------|
| `connected` | Server->Client | Initial connection confirmation |
| `ping` | Client->Server | Keepalive request |
| `pong` | Server->Client | Keepalive response |
| `subscribe` | Client->Server | Subscribe to channel |
| `subscribed` | Server->Client | Subscription confirmation |
| `task_created` | Server->Client | Broadcast when task created |
| `task_updated` | Server->Client | Broadcast when task updated |
| `task_moved` | Server->Client | Broadcast when task moved |
| `project_created` | Server->Client | Broadcast when project created |

**Authentication (v5.37.1):**
When enterprise auth or OIDC is enabled, WebSocket connections require a token query parameter:
```javascript
const ws = new WebSocket('ws://localhost:57374/ws?token=loki_xxx...');
```
Note: Query-parameter auth is used because browsers cannot send Authorization headers on WebSocket upgrade requests. Configure reverse proxy log sanitization for the /ws path in production.

---

### Task Endpoints

#### `GET /api/tasks`
List tasks from session state files (dashboard-state.json and queue/ directory).

**Query Parameters:**
| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `status` | string | - | Filter by status (pending, in_progress, done) |

**Response:**
```json
[
  {
    "id": "task-001",
    "title": "implement-auth",
    "description": "Implement user authentication",
    "status": "in_progress",
    "priority": "medium",
    "type": "task",
    "position": 0
  }
]
```

---

### Memory Endpoints

#### `GET /api/memory/summary`
Get memory system summary.

**Response:**
```json
{
  "episodic": {"count": 10, "latestDate": "2026-02-02T12:00:00Z"},
  "semantic": {"patterns": 5, "antiPatterns": 2},
  "procedural": {"skills": 3},
  "tokenEconomics": {"discoveryTokens": 1000, "readTokens": 500, "savingsPercent": 50}
}
```

#### `GET /api/memory/episodes`
List episodic memory entries.

**Query Parameters:**
| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `limit` | number | 50 | Max entries to return |

#### `GET /api/memory/episodes/{episode_id}`
Get a specific episodic memory entry.

#### `GET /api/memory/patterns`
List semantic patterns.

#### `GET /api/memory/patterns/{pattern_id}`
Get a specific semantic pattern.

#### `GET /api/memory/skills`
List procedural skills.

#### `GET /api/memory/skills/{skill_id}`
Get a specific procedural skill.

#### `GET /api/memory/economics`
Get token usage economics.

**Response:**
```json
{
  "discoveryTokens": 1000,
  "readTokens": 500,
  "savingsPercent": 50
}
```

#### `POST /api/memory/consolidate`
Trigger memory consolidation (stub - returns current state).

#### `POST /api/memory/retrieve`
Search memories by query.

#### `GET /api/memory/index`
Get memory index (Layer 1 - lightweight discovery).

#### `GET /api/memory/timeline`
Get memory timeline (Layer 2 - progressive disclosure).

---

### Learning/Metrics Endpoints

#### `GET /api/learning/metrics`
Get learning metrics from events and metrics files.

**Query Parameters:**
| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `timeRange` | string | `7d` | Time range (e.g., `1h`, `24h`, `7d`, `30d`) |
| `signalType` | string | - | Filter by signal type |
| `source` | string | - | Filter by source |

#### `GET /api/learning/trends`
Get learning trend data grouped by hour.

#### `GET /api/learning/signals`
Get raw learning signals.

#### `GET /api/learning/aggregation`
Get latest learning aggregation result.

#### `POST /api/learning/aggregate`
Aggregate learning signals from events.jsonl into structured metrics.

#### `GET /api/learning/preferences`
Get aggregated user preferences.

#### `GET /api/learning/errors`
Get aggregated error patterns.

#### `GET /api/learning/success`
Get aggregated success patterns.

#### `GET /api/learning/tools`
Get tool efficiency rankings.

---

### Cost Visibility Endpoints

#### `GET /api/cost`
Get cost visibility data from `.loki/metrics/efficiency/` and budget.json.

**Response:**
```json
{
  "total_input_tokens": 50000,
  "total_output_tokens": 25000,
  "estimated_cost_usd": 1.25,
  "by_phase": {},
  "by_model": {},
  "budget_limit": null,
  "budget_used": null,
  "budget_remaining": null
}
```

#### `GET /api/pricing`
Get current model pricing. Reads from `.loki/pricing.json` if available, falls back to static defaults.

---

### Checkpoint Endpoints

#### `GET /api/checkpoints`
List recent checkpoints from index.jsonl, most recent first.

**Query Parameters:**
| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `limit` | number | 20 | Max checkpoints to return (1-200) |

**Example:**
```bash
curl http://localhost:57374/api/checkpoints
curl "http://localhost:57374/api/checkpoints?limit=5"
```

**Response:**
```json
[
  {
    "id": "chk-20260212-143022",
    "created_at": "2026-02-12T14:30:22+00:00",
    "git_sha": "abc1234f",
    "message": "before refactor",
    "files": ["metadata.json", "dashboard-state.json", "session.json"]
  }
]
```

#### `GET /api/checkpoints/{checkpoint_id}`
Get detailed metadata for a specific checkpoint.

**Path Parameters:**
| Parameter | Description |
|-----------|-------------|
| `checkpoint_id` | Checkpoint identifier (alphanumeric, hyphens, underscores only) |

**Example:**
```bash
curl http://localhost:57374/api/checkpoints/chk-20260212-143022
```

**Response:** Returns the full `metadata.json` content for the checkpoint.

**Errors:**
- `400` -- Invalid checkpoint_id (contains unsafe characters)
- `404` -- Checkpoint not found

#### `POST /api/checkpoints`
Create a new checkpoint capturing current state. Copies dashboard-state.json, session.json, and queue files into a timestamped directory. Enforces 50-checkpoint retention limit (oldest pruned automatically).

**Request Body (optional):**
```json
{
  "message": "Before refactoring auth module"
}
```

**Example:**
```bash
curl -X POST http://localhost:57374/api/checkpoints
curl -X POST http://localhost:57374/api/checkpoints \
  -H "Content-Type: application/json" \
  -d '{"message": "before deploy"}'
```

**Response (201 Created):**
```json
{
  "id": "chk-20260212-150105",
  "created_at": "2026-02-12T15:01:05+00:00",
  "git_sha": "def5678a",
  "message": "before deploy",
  "files": ["metadata.json", "dashboard-state.json", "session.json"]
}
```

See [[Checkpoints]] for CLI usage, directory structure, and retention policy.

---

### Completion Council Endpoints

#### `GET /api/council/state`
Get current Completion Council state including whether the council is enabled, total votes cast, and recent verdicts.

**Response:**
```json
{
  "enabled": true,
  "total_votes": 6,
  "verdicts": [
    {
      "iteration": 10,
      "result": "continue",
      "votes_complete": 1,
      "votes_continue": 2,
      "timestamp": "2026-02-02T12:00:00Z"
    }
  ]
}
```

#### `GET /api/council/verdicts`
Get council vote history (decision log).

**Query Parameters:**
| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `limit` | number | 20 | Maximum verdicts to return |

**Response:**
```json
{
  "verdicts": [],
  "details": [
    {
      "iteration": "10",
      "evidence_preview": "...",
      "members": [{"member": "member-1", "content": "..."}],
      "contrarian": "..."
    }
  ]
}
```

#### `GET /api/council/convergence`
Get convergence tracking data for visualization. Tracks git diff hashes between iterations to detect stagnation.

**Response:**
```json
{
  "dataPoints": [
    {
      "timestamp": "2026-02-02T12:00:00",
      "iteration": 5,
      "files_changed": 3,
      "no_change_streak": 0,
      "done_signals": 1
    }
  ]
}
```

#### `GET /api/council/report`
Get the final council completion report (markdown format).

**Response:**
```json
{
  "report": "# Completion Council Report\n\n## Summary\n..."
}
```

Returns `{"report": null}` if no report has been generated yet.

#### `POST /api/council/force-review`
Force an immediate council review by writing a signal file. The council will evaluate completion criteria on the next iteration.

**Response:**
```json
{
  "success": true,
  "message": "Council review requested"
}
```

---

### Agent Management Endpoints

#### `GET /api/agents`
Get all active and recent agents with their status and metadata.

**Response:**
```json
[
  {
    "id": "agent-001",
    "type": "development",
    "status": "running",
    "task": "implement-auth",
    "pid": 12345,
    "alive": true
  }
]
```

#### `POST /api/agents/{agent_id}/kill`
Kill a specific agent by ID. Sends SIGTERM to the agent process.

**Path Parameters:**
| Parameter | Description |
|-----------|-------------|
| `agent_id` | Agent identifier (alphanumeric, hyphens, underscores only) |

**Response:**
```json
{
  "success": true,
  "message": "Agent agent-001 terminated"
}
```

#### `POST /api/agents/{agent_id}/pause`
Pause a specific agent by writing a pause signal file.

**Response:**
```json
{
  "success": true,
  "message": "Pause signal sent to agent agent-001"
}
```

#### `POST /api/agents/{agent_id}/resume`
Resume a paused agent by removing the pause signal file.

**Response:**
```json
{
  "success": true,
  "message": "Resume signal sent to agent agent-001"
}
```

---

### Registry Endpoints

#### `GET /api/registry/projects`
List all registered projects.

#### `POST /api/registry/projects`
Register a new project.

#### `GET /api/registry/projects/{identifier}`
Get a registered project by ID, path, or alias.

#### `DELETE /api/registry/projects/{identifier}`
Remove a project from the registry.

#### `GET /api/registry/projects/{identifier}/health`
Check the health of a registered project.

#### `POST /api/registry/projects/{identifier}/access`
Update the last accessed timestamp for a project.

#### `GET /api/registry/discover`
Discover projects with `.loki` directories.

#### `POST /api/registry/sync`
Sync the registry with discovered projects.

#### `GET /api/registry/tasks`
Get tasks from multiple projects for unified view.

#### `GET /api/registry/learnings`
Get learnings from the global learnings database.

---

### Enterprise Endpoints

#### `GET /api/enterprise/status`
Check which enterprise features are enabled.

#### `POST /api/enterprise/tokens`
Generate a new API token (requires `LOKI_ENTERPRISE_AUTH=true`).

#### `GET /api/enterprise/tokens`
List all API tokens.

#### `DELETE /api/enterprise/tokens/{identifier}`
Revoke or delete a token.

#### `GET /api/enterprise/audit`
Query audit logs (requires `LOKI_ENTERPRISE_AUDIT=true`).

#### `GET /api/enterprise/audit/summary`
Get audit activity summary.

---

### Prometheus Metrics (v5.38.0)

#### `GET /metrics`
Prometheus/OpenMetrics compatible metrics endpoint. Returns plain text in OpenMetrics format.

**Response (text/plain):**
```
# HELP loki_session_status Current session status (0=stopped, 1=running, 2=paused)
# TYPE loki_session_status gauge
loki_session_status 1

# HELP loki_iteration_current Current iteration number
# TYPE loki_iteration_current gauge
loki_iteration_current 12

# HELP loki_iteration_max Maximum configured iterations
# TYPE loki_iteration_max gauge
loki_iteration_max 1000

# HELP loki_tasks_total Number of tasks by status
# TYPE loki_tasks_total gauge
loki_tasks_total{status="pending"} 3
loki_tasks_total{status="in_progress"} 1
loki_tasks_total{status="completed"} 8
loki_tasks_total{status="failed"} 0

# HELP loki_agents_active Number of currently active agents
# TYPE loki_agents_active gauge
loki_agents_active 2

# HELP loki_agents_total Total number of agents registered
# TYPE loki_agents_total gauge
loki_agents_total 5

# HELP loki_cost_usd Estimated total cost in USD
# TYPE loki_cost_usd gauge
loki_cost_usd 1.234567

# HELP loki_events_total Total number of events recorded
# TYPE loki_events_total counter
loki_events_total 142

# HELP loki_uptime_seconds Seconds since session started
# TYPE loki_uptime_seconds gauge
loki_uptime_seconds 3601.5
```

**Usage with Prometheus:**
```yaml
# prometheus.yml
scrape_configs:
  - job_name: 'loki-mode'
    scrape_interval: 15s
    static_configs:
      - targets: ['localhost:57374']
```

**Usage with curl:**
```bash
curl http://localhost:57374/metrics
```

---

### Context Window Endpoints (v5.42.1)

#### `GET /api/context`
Get current context window state including per-agent usage, totals, and content-type breakdown.

**Response:**
```json
{
  "total_capacity": 200000,
  "total_used": 87500,
  "usage_percent": 43.75,
  "agents": [
    {
      "id": "orchestrator",
      "tokens_used": 42000,
      "capacity": 200000,
      "usage_percent": 21.0
    }
  ],
  "breakdown": {
    "code": 35000,
    "prompts": 20000,
    "memory": 15000,
    "tool_output": 17500
  }
}
```

---

### Notification Endpoints (v5.42.1)

#### `GET /api/notifications`
List all notifications, newest first.

**Query Parameters:**
| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `severity` | string | - | Filter by severity (info, warning, critical) |
| `acknowledged` | boolean | - | Filter by acknowledgment status |
| `limit` | number | 50 | Max notifications to return |

**Response:**
```json
[
  {
    "id": "notif-001",
    "severity": "warning",
    "message": "Context usage exceeded 80% for agent backend-agent",
    "trigger": "context_threshold",
    "timestamp": "2026-02-13T10:30:00Z",
    "acknowledged": false
  }
]
```

#### `GET /api/notifications/triggers`
Get configured notification triggers.

**Response:**
```json
{
  "triggers": [
    {
      "id": "context_threshold",
      "enabled": true,
      "threshold": 80,
      "description": "Alert when context window usage exceeds threshold percent"
    },
    {
      "id": "task_failure",
      "enabled": true,
      "threshold": 3,
      "description": "Alert after N consecutive task failures"
    },
    {
      "id": "budget_limit",
      "enabled": false,
      "threshold": 90,
      "description": "Alert when budget usage exceeds threshold percent"
    }
  ]
}
```

#### `PUT /api/notifications/triggers`
Update notification trigger configuration.

**Request Body:**
```json
{
  "triggers": [
    {
      "id": "context_threshold",
      "enabled": true,
      "threshold": 75
    }
  ]
}
```

**Response:**
```json
{
  "success": true,
  "message": "Triggers updated"
}
```

#### `POST /api/notifications/{id}/acknowledge`
Acknowledge a specific notification.

**Path Parameters:**
| Parameter | Description |
|-----------|-------------|
| `id` | Notification identifier |

**Response:**
```json
{
  "success": true,
  "message": "Notification notif-001 acknowledged"
}
```

---

### Budget Endpoints (v5.37.0)

#### `GET /api/budget`
Get current budget status and cost limits.

**Response:**
```json
{
  "budget_limit": 5.00,
  "budget_used": 1.25,
  "budget_remaining": 3.75,
  "budget_exceeded": false
}
```

---

### Health Process Endpoints (v5.37.0)

#### `GET /api/health/processes`
Get process supervision and watchdog status.

**Response:**
```json
{
  "main_process": {"pid": 12345, "alive": true},
  "dashboard": {"pid": 12346, "alive": true},
  "agents": [{"pid": 12347, "status": "running"}]
}
```

---

### Secrets Endpoints (v5.37.0)

#### `GET /api/secrets/status`
Get secret management status (Docker/K8s mount detection).

**Response:**
```json
{
  "docker_secrets": false,
  "k8s_secrets": false,
  "env_secrets": ["ANTHROPIC_API_KEY"]
}
```

---

### Auth Info Endpoint (v5.37.0)

#### `GET /api/auth/info`
Get information about enabled authentication methods.

**Response:**
```json
{
  "enterprise_auth": true,
  "oidc_enabled": false,
  "oidc_issuer": null,
  "auth_methods": ["token"]
}
```

---

## CORS

CORS is restricted to localhost by default for security:
```
Access-Control-Allow-Origin: http://localhost:57374, http://127.0.0.1:57374
Access-Control-Allow-Methods: *
Access-Control-Allow-Headers: *
```

To allow additional origins, use the `LOKI_DASHBOARD_CORS` environment variable:

```bash
# Allow specific origins (comma-separated)
export LOKI_DASHBOARD_CORS="http://localhost:57374,https://dashboard.example.com"
```

| Environment Variable | Default | Description |
|---------------------|---------|-------------|
| `LOKI_DASHBOARD_CORS` | `http://localhost:57374,http://127.0.0.1:57374` | Comma-separated list of allowed CORS origins |
| `LOKI_DASHBOARD_HOST` | `127.0.0.1` | Server bind address (localhost-only by default) |

---

## Error Responses

FastAPI returns errors in this format:

```json
{
  "detail": "Description of the error"
}
```

**HTTP Status Codes:**
| Code | Description |
|------|-------------|
| 200 | Success |
| 201 | Created (POST endpoints) |
| 204 | No Content (DELETE endpoints) |
| 400 | Bad request (invalid parameters) |
| 403 | Forbidden (enterprise feature not enabled) |
| 404 | Resource not found |
| 500 | Server error |

---

## Client Examples

### curl

```bash
# Health check
curl http://localhost:57374/health

# Get status
curl http://localhost:57374/api/status

# Pause session
curl -X POST http://localhost:57374/api/control/pause

# Resume session
curl -X POST http://localhost:57374/api/control/resume

# Stop session
curl -X POST http://localhost:57374/api/control/stop

# Get logs
curl "http://localhost:57374/api/logs?lines=100"

# Get tasks
curl http://localhost:57374/api/tasks

# Get memory summary
curl http://localhost:57374/api/memory/summary

# Council state
curl http://localhost:57374/api/council/state

# Get cost data
curl http://localhost:57374/api/cost

# Create checkpoint
curl -X POST http://localhost:57374/api/checkpoints \
  -H "Content-Type: application/json" \
  -d '{"message": "before refactor"}'

# Context window state
curl http://localhost:57374/api/context

# Notifications
curl http://localhost:57374/api/notifications

# Notification triggers
curl http://localhost:57374/api/notifications/triggers

# Acknowledge a notification
curl -X POST http://localhost:57374/api/notifications/notif-001/acknowledge

# Prometheus metrics
curl http://localhost:57374/metrics

# Budget status
curl http://localhost:57374/api/budget

# Auth info
curl http://localhost:57374/api/auth/info
```

### JavaScript

```javascript
// Get status
const status = await fetch('http://localhost:57374/api/status').then(r => r.json());
console.log('Status:', status.status, 'Phase:', status.phase);

// WebSocket for real-time updates
const ws = new WebSocket('ws://localhost:57374/ws');
ws.onmessage = (e) => {
  const msg = JSON.parse(e.data);
  console.log('Event:', msg.type, msg.data);
};

// Pause session
await fetch('http://localhost:57374/api/control/pause', { method: 'POST' });
```

### Python

```python
import requests

# Get status
response = requests.get('http://localhost:57374/api/status')
status = response.json()
print(f"Status: {status['status']}, Phase: {status['phase']}")

# Get tasks
response = requests.get('http://localhost:57374/api/tasks')
tasks = response.json()
for t in tasks:
    print(f"[{t['status']}] {t['title']}")

# Get memory summary
response = requests.get('http://localhost:57374/api/memory/summary')
memory = response.json()
print(f"Episodes: {memory['episodic']['count']}, Patterns: {memory['semantic']['patterns']}")
```

---

## Enterprise Authentication

When enterprise authentication is enabled (`LOKI_ENTERPRISE_AUTH=true`), token management is available:

```bash
# Generate a token
loki enterprise token generate my-token --scopes "read,write" --expires 30

# Use token in requests
curl -H "Authorization: Bearer loki_xxx..." http://localhost:57374/api/status
```

See [[Enterprise Features]] for details.

---

## See Also

- [[Checkpoints]] - Checkpoint system documentation
- [[CLI Reference]] - Command-line interface
- [[Configuration]] - Configuration options
- [[Enterprise Features]] - Enterprise authentication and audit
