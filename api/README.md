# Loki Mode API

HTTP/SSE API layer for Loki Mode autonomous agent orchestration.

## Quick Start

```bash
# Start the API server
loki serve

# Or directly
./autonomy/serve.sh

# With options
loki serve --port 9000 --host 0.0.0.0
```

## Requirements

- **Deno** 1.40+ (for running the server)
- **Loki Mode** installed and configured

Install Deno:
```bash
curl -fsSL https://deno.land/install.sh | sh
# or
brew install deno
```

## Configuration

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `LOKI_DASHBOARD_PORT` | `57374` | Server port |
| `LOKI_API_HOST` | `localhost` | Server host |
| `LOKI_API_TOKEN` | none | API token for remote access |
| `LOKI_DIR` | auto | Loki installation directory |
| `LOKI_DEBUG` | false | Enable debug output |

### Command Line Options

```
--port, -p <port>   Port to listen on
--host <host>       Host to bind to
--no-cors           Disable CORS
--no-auth           Disable authentication
--generate-token    Generate a secure API token
```

## Authentication

By default, the API only accepts requests from localhost without authentication.

For remote access:
```bash
# Generate a token
export LOKI_API_TOKEN=$(loki serve --generate-token)

# Start server allowing remote connections
loki serve --host 0.0.0.0

# Connect from another machine
curl -H "Authorization: Bearer $LOKI_API_TOKEN" http://server:8420/health
```

## API Endpoints

### Health

| Method | Path | Description |
|--------|------|-------------|
| GET | `/health` | Health check |
| GET | `/health/ready` | Readiness probe |
| GET | `/health/live` | Liveness probe |
| GET | `/api/status` | Detailed status |

### Sessions

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/sessions` | Start new session |
| GET | `/api/sessions` | List all sessions |
| GET | `/api/sessions/:id` | Get session details |
| POST | `/api/sessions/:id/stop` | Stop session |
| POST | `/api/sessions/:id/input` | Inject human input |
| DELETE | `/api/sessions/:id` | Delete session record |

### Tasks

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/sessions/:id/tasks` | List session tasks |
| GET | `/api/tasks` | List all tasks |
| GET | `/api/tasks/active` | Get running tasks |
| GET | `/api/tasks/queue` | Get queued tasks |

### Events (SSE)

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/events` | SSE event stream |
| GET | `/api/events/history` | Get event history |
| GET | `/api/events/stats` | Event statistics |

## SSE Event Types

### Session Events
- `session:started` - Session started
- `session:paused` - Session paused
- `session:resumed` - Session resumed
- `session:stopped` - Session stopped
- `session:completed` - Session completed successfully
- `session:failed` - Session failed

### Phase Events
- `phase:started` - Phase started
- `phase:completed` - Phase completed
- `phase:failed` - Phase failed

### Task Events
- `task:created` - Task created
- `task:started` - Task started
- `task:progress` - Task progress update
- `task:completed` - Task completed
- `task:failed` - Task failed

### Agent Events
- `agent:spawned` - Agent spawned
- `agent:output` - Agent output
- `agent:completed` - Agent completed
- `agent:failed` - Agent failed

### Log Events
- `log:debug` - Debug log
- `log:info` - Info log
- `log:warn` - Warning log
- `log:error` - Error log

### Other Events
- `metrics:update` - Metrics update
- `input:requested` - Human input requested
- `heartbeat` - Keep-alive heartbeat

## Usage Examples

### Start a Session

```bash
curl -X POST http://localhost:8420/api/sessions \
  -H "Content-Type: application/json" \
  -d '{"provider": "claude", "prdPath": "./docs/prd.md"}'
```

### Subscribe to Events

```javascript
const events = new EventSource('http://localhost:8420/api/events');

events.addEventListener('task:completed', (e) => {
  const event = JSON.parse(e.data);
  console.log(`Task completed: ${event.data.title}`);
});

events.addEventListener('log:error', (e) => {
  const event = JSON.parse(e.data);
  console.error(`Error: ${event.data.message}`);
});

events.onerror = (err) => {
  console.error('Connection error:', err);
};
```

### Using the TypeScript Client

```typescript
import { LokiClient } from './api/client.ts';

const client = new LokiClient('http://localhost:8420');

// Start a session
const { sessionId } = await client.startSession({
  provider: 'claude',
  prdPath: './docs/prd.md'
});

// Subscribe to events
const unsubscribe = client.subscribe((event) => {
  console.log(`${event.type}: ${JSON.stringify(event.data)}`);
});

// Get session status
const status = await client.getSession(sessionId);
console.log(`Status: ${status.session.status}`);

// Stop session
await client.stopSession(sessionId);

// Cleanup
unsubscribe();
client.close();
```

### Filter Events

```bash
# Filter by session
curl "http://localhost:8420/api/events?sessionId=session_123"

# Filter by event types
curl "http://localhost:8420/api/events?types=task:completed,task:failed"

# Filter log level
curl "http://localhost:8420/api/events?minLevel=warn"

# Replay recent history
curl "http://localhost:8420/api/events?history=50"
```

## Development

### Run Tests

```bash
deno test --allow-all api/server_test.ts
```

### Run with Hot Reload

```bash
deno run --watch --allow-all api/server.ts
```

### Type Check

```bash
deno check api/server.ts
```

## Architecture

```
api/
  server.ts           # Main HTTP server
  client.ts           # TypeScript client SDK
  mod.ts              # Module exports
  openapi.yaml        # OpenAPI specification
  routes/
    sessions.ts       # Session endpoints
    tasks.ts          # Task endpoints
    events.ts         # SSE streaming
    health.ts         # Health checks
  services/
    cli-bridge.ts     # CLI integration
    state-watcher.ts  # File system watcher
    event-bus.ts      # Event distribution
  middleware/
    auth.ts           # Authentication
    cors.ts           # CORS handling
    error.ts          # Error handling
  types/
    api.ts            # API types
    events.ts         # Event types
```

## State Synchronization

The API watches the `.loki/` directory for state changes:

- `sessions/{id}/session.json` - Session state
- `sessions/{id}/tasks.json` - Task list
- `sessions/{id}/phase.json` - Current phase
- `sessions/{id}/agents.json` - Active agents
- `state.json` - Global state

Changes are detected via file watching and emitted as SSE events.

## Error Codes

| Code | HTTP Status | Description |
|------|-------------|-------------|
| `BAD_REQUEST` | 400 | Invalid request |
| `UNAUTHORIZED` | 401 | Missing/invalid auth |
| `FORBIDDEN` | 403 | Permission denied |
| `NOT_FOUND` | 404 | Resource not found |
| `CONFLICT` | 409 | State conflict |
| `VALIDATION_ERROR` | 422 | Validation failed |
| `INTERNAL_ERROR` | 500 | Server error |
| `SESSION_NOT_FOUND` | 404 | Session not found |
| `SESSION_ALREADY_RUNNING` | 409 | Session running |
| `PROVIDER_NOT_AVAILABLE` | 503 | Provider unavailable |

## License

MIT
