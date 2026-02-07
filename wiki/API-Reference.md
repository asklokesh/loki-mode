# API Reference

Complete REST API documentation for Loki Mode.

---

## Overview

Loki Mode provides an HTTP API server for session management and real-time events.

| Server | Default Port | Technology | Purpose |
|--------|--------------|------------|---------|
| **HTTP API** | 9898 | Node.js | Session management, events, memory |

---

## HTTP API Server

Start the server:
```bash
loki serve
# or
node autonomy/api-server.js --port 9898
```

### Configuration

| Environment Variable | Default | Description |
|---------------------|---------|-------------|
| `LOKI_API_PORT` | 9898 | API server port |
| `LOKI_DIR` | `.loki` | State directory |
| `CORS_ALLOWED_ORIGINS` | `*` | Comma-separated allowed CORS origins |

---

## Endpoints

### Health Check

#### `GET /health`
Basic health check.

**Response:**
```json
{
  "status": "ok",
  "version": "5.26.0"
}
```

---

### Session Status

#### `GET /status`
Get detailed session status.

**Response:**
```json
{
  "state": "running",
  "pid": 12345,
  "statusText": "PHASE: development | TASK: implement-auth",
  "currentPhase": "development",
  "currentTask": "implement-auth",
  "pendingTasks": 5,
  "provider": "claude",
  "version": "5.26.0",
  "lokiDir": "/path/to/project/.loki",
  "timestamp": "2026-02-02T12:00:00.000Z"
}
```

**State Values:**
| State | Description |
|-------|-------------|
| `stopped` | No session running |
| `running` | Session actively executing |
| `paused` | Session paused (PAUSE file exists) |
| `stopping` | Graceful shutdown in progress |

---

### Session Control

#### `POST /start`
Start a new session.

**Request Body:**
```json
{
  "prd": "path/to/prd.md",
  "provider": "claude",
  "parallel": false,
  "background": true
}
```

**Fields:**
| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `prd` | string | - | Path to PRD file |
| `provider` | string | `claude` | AI provider (claude, codex, gemini) |
| `parallel` | boolean | `false` | Enable parallel mode |
| `background` | boolean | `true` | Run in background |

**Response:**
```json
{
  "started": true,
  "pid": 12345,
  "provider": "claude",
  "args": ["--provider", "claude", "--bg", "path/to/prd.md"]
}
```

**Error (409 - Session already running):**
```json
{
  "error": "Session already running",
  "pid": 12345
}
```

#### `POST /stop`
Stop the current session.

**Response:**
```json
{
  "stopped": true
}
```

#### `POST /pause`
Pause after current task completes.

**Response:**
```json
{
  "paused": true
}
```

#### `POST /resume`
Resume a paused session.

**Response:**
```json
{
  "resumed": true
}
```

---

### Logs

#### `GET /logs`
Get recent session log lines.

**Query Parameters:**
| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `lines` | number | 50 | Number of lines to return |

**Response:**
```json
{
  "logs": [
    "[2026-02-02 12:00:00] Session started",
    "[2026-02-02 12:00:01] Phase: requirements"
  ],
  "total": 150
}
```

---

### Server-Sent Events (SSE)

#### `GET /events`
Real-time event stream using Server-Sent Events.

**Example:**
```javascript
const events = new EventSource('http://localhost:9898/events');
events.onmessage = (e) => {
  const status = JSON.parse(e.data);
  console.log('State:', status.state);
  console.log('Phase:', status.currentPhase);
};
```

**Event Data:**
Sends status updates every 2 seconds containing the full status object (same as `GET /status`).

---

### Memory/Learnings Endpoints

#### `GET /memory`
Get summary of cross-project learnings.

**Response:**
```json
{
  "patterns": 25,
  "mistakes": 10,
  "successes": 15,
  "location": "/Users/you/.loki/learnings"
}
```

#### `GET /memory/{type}`
Get learnings by type (patterns, mistakes, successes).

**Path Parameters:**
| Parameter | Values |
|-----------|--------|
| `type` | `patterns`, `mistakes`, `successes` |

**Query Parameters:**
| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `limit` | number | 50 | Max entries to return |
| `offset` | number | 0 | Pagination offset |

**Response:**
```json
{
  "type": "patterns",
  "entries": [
    {
      "description": "Always run tests before committing",
      "project": "my-app",
      "timestamp": "2026-02-01T10:00:00Z"
    }
  ],
  "total": 25,
  "limit": 50,
  "offset": 0
}
```

#### `GET /memory/search`
Search across all learnings.

**Query Parameters:**
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `q` | string | Yes | Search query |

**Response:**
```json
{
  "query": "authentication",
  "results": [
    {
      "type": "patterns",
      "description": "Use JWT for authentication",
      "project": "auth-service"
    }
  ],
  "count": 3
}
```

#### `GET /memory/stats`
Get statistics about learnings.

**Response:**
```json
{
  "byCategory": {
    "patterns": 25,
    "mistakes": 10,
    "successes": 15
  },
  "byProject": {
    "my-app": 20,
    "auth-service": 15,
    "unknown": 15
  }
}
```

#### `DELETE /memory/{type}`
Clear learnings of a specific type.

**Path Parameters:**
| Parameter | Values |
|-----------|--------|
| `type` | `patterns`, `mistakes`, `successes` |

**Response:**
```json
{
  "cleared": "patterns"
}
```

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
  "verdicts": [
    {
      "iteration": 10,
      "result": "continue",
      "votes_complete": 1,
      "votes_continue": 2
    }
  ],
  "details": []
}
```

#### `GET /api/council/convergence`
Get convergence tracking data for visualization. Tracks git diff hashes between iterations to detect stagnation.

**Response:**
```json
{
  "dataPoints": [
    {
      "iteration": 5,
      "hash": "abc123",
      "changed": true
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
  "message": "Force review signal written"
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
    "alive": true,
    "started": "2026-02-02T12:00:00Z"
  }
]
```

#### `POST /api/agents/{agent_id}/kill`
Kill a specific agent by ID. Sends SIGTERM to the agent process.

**Path Parameters:**
| Parameter | Description |
|-----------|-------------|
| `agent_id` | Agent identifier |

**Response:**
```json
{
  "success": true,
  "message": "Agent killed"
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

## CORS

All endpoints include CORS headers. By default, all origins are allowed:
```
Access-Control-Allow-Origin: *
Access-Control-Allow-Methods: GET, POST, PUT, DELETE, OPTIONS
Access-Control-Allow-Headers: *
```

For production deployments, restrict CORS origins using the `CORS_ALLOWED_ORIGINS` environment variable:

```bash
# Allow specific origins (comma-separated)
export CORS_ALLOWED_ORIGINS="https://myapp.example.com,https://dashboard.example.com"
```

| Environment Variable | Default | Description |
|---------------------|---------|-------------|
| `CORS_ALLOWED_ORIGINS` | `*` | Comma-separated list of allowed CORS origins |

---

## Error Responses

All error responses use this format:

```json
{
  "error": "Description of the error"
}
```

**HTTP Status Codes:**
| Code | Description |
|------|-------------|
| 200 | Success |
| 400 | Bad request (missing required parameters) |
| 404 | Endpoint not found |
| 409 | Conflict (e.g., session already running) |
| 500 | Server error |

---

## Client Examples

### curl

```bash
# Health check
curl http://localhost:9898/health

# Get status
curl http://localhost:9898/status

# Start session
curl -X POST http://localhost:9898/start \
  -H "Content-Type: application/json" \
  -d '{"prd": "./prd.md", "provider": "claude"}'

# Stop session
curl -X POST http://localhost:9898/stop

# Get logs
curl "http://localhost:9898/logs?lines=100"

# Search memory
curl "http://localhost:9898/memory/search?q=authentication"
```

### JavaScript

```javascript
// Start session
const response = await fetch('http://localhost:9898/start', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    prd: './my-prd.md',
    provider: 'claude',
    parallel: true
  })
});
const result = await response.json();
console.log('Started with PID:', result.pid);

// SSE for real-time updates
const events = new EventSource('http://localhost:9898/events');
events.onmessage = (e) => {
  const status = JSON.parse(e.data);
  if (status.state === 'running') {
    console.log(`Phase: ${status.currentPhase}, Task: ${status.currentTask}`);
  }
};
```

### Python

```python
import requests

# Get status
response = requests.get('http://localhost:9898/status')
status = response.json()
print(f"State: {status['state']}, Phase: {status['currentPhase']}")

# Start session
response = requests.post('http://localhost:9898/start', json={
    'prd': './prd.md',
    'provider': 'claude'
})
result = response.json()
print(f"Started with PID: {result['pid']}")

# Search learnings
response = requests.get('http://localhost:9898/memory/search', params={'q': 'auth'})
results = response.json()
for r in results['results']:
    print(f"[{r['type']}] {r['description']}")
```

---

## Enterprise Authentication (Planned)

When enterprise authentication is enabled (`LOKI_ENTERPRISE_AUTH=true`), all endpoints will require a Bearer token:

```bash
curl -H "Authorization: Bearer loki_xxx..." http://localhost:9898/status
```

Token management will be available via the `loki enterprise token` CLI commands.

---

## See Also

- [[CLI Reference]] - Command-line interface
- [[Configuration]] - Configuration options
- [[Enterprise Features]] - Enterprise authentication and audit
