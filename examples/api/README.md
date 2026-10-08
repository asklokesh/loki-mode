# Loki Mode API Examples

Minimal HTTP API implementations for loki-mode remote control.

## Recommended: Node.js

The production API server is at `dashboard/server.py` (FastAPI/Python).

**Why FastAPI?**
- Unified dashboard and API on a single port (57374)
- Reads directly from `.loki/` flat files
- SSE support for real-time updates
- Handles concurrent connections
- Easy to test and extend

## Quick Start (Production)

```bash
# Start dashboard/API server
loki dashboard start

# Check status
loki dashboard status

# Stop server
loki dashboard stop
```

## Comparison Matrix

| Criteria | Bash | Node.js | Python | Deno |
|----------|------|---------|--------|------|
| Lines of code | ~100 | ~150 | ~180 | ~170 |
| Dependencies | netcat | Node 14+ | Python 3.8+ | Deno 1.40+ |
| Pre-installed | Yes | Often | Yes (macOS/Linux) | No |
| SSE support | No | Yes | Limited | Yes |
| Concurrent | No | Yes | Limited | Yes |
| Testability | Hard | Easy | Easy | Easy |
| Type safety | No | No | No | Yes |

## Quick Start

```bash
# Bash (zero deps)
./api-examples/bash-api.sh

# Node.js (recommended)
node api-examples/node-api.js

# Python
python3 api-examples/python-api.py

# Deno
deno run --allow-all api-examples/deno-api.ts
```

## API Endpoints

All implementations expose the same API:

| Method | Path | Description |
|--------|------|-------------|
| GET | /health | Health check |
| GET | /status | Current session status |
| GET | /events | SSE stream (Node/Deno only) |
| GET | /logs?lines=50 | Recent log entries |
| POST | /start | Start session (body: `{"provider":"claude","prd":"path"}`) |
| POST | /stop | Stop session |
| POST | /pause | Pause after current task |
| POST | /resume | Resume paused session |

## Testing

```bash
# Health check
curl http://localhost:57374/health

# Get status
curl http://localhost:57374/status

# Start with provider
curl -X POST -H "Content-Type: application/json" \
     -d '{"provider":"claude"}' \
     http://localhost:57374/start

# Stop
curl -X POST http://localhost:57374/stop

# Pause/Resume
curl -X POST http://localhost:57374/pause
curl -X POST http://localhost:57374/resume

# SSE stream (Node/Deno)
curl -N http://localhost:57374/events

# Logs
curl http://localhost:57374/logs?lines=100
```

## Integration with run.sh

The dashboard server (`dashboard/server.py`) reads from `.loki/` flat files.
Session state is tracked in `~/.loki/state/`:

- `session.pid` - Process ID of running session
- `paused` - Marker file for pause state
- `provider` - Current provider name
- `current_project` - Active project ID
- `current_task` - Active task ID
